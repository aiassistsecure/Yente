#!/usr/bin/env node
/**
 * Yente, the listener. Three loops, one process, one database.
 *
 *   LISTEN        IMAP -> evidence -> job, then get out of the way
 *   UNDERSTAND    drain the job queue through Muse, bounded concurrency
 *   CONNECT       score the graph for complementary intent, queue for review
 *
 * WHY A SEPARATE ENTRY POINT FROM bin/daemon.mjs
 *
 * `daemon.mjs` runs the old desk: the member state machine, qualification, the
 * veto clock, the outbox. That product still works and people's data is in it.
 * Retrofitting a different data model into a working system, for a slice whose
 * shape we are still learning, is how you end up with neither.
 *
 * So this is its own process against its own data directory. Nothing is
 * migrated: the mailbox is the source of truth and every message is still on the
 * server, so a cold start replays real mail through the real pipeline — which is
 * also the only honest test of the thing.
 *
 * THE LOOPS RUN AT DIFFERENT SPEEDS ON PURPOSE
 *
 * Listening is cheap and wants to be immediate. Understanding is expensive
 * (40-75s per message through PIN, and the variance is not ours to control) and
 * wants to be steady. Matching is cheap but pointless to run more often than the
 * graph changes. Sharing one interval would pace all three to the slowest.
 *
 * IDLE, NOT POLLING
 *
 * The old poller opened a connection every 30 seconds. Over eight days that is
 * ~23,000 connections from one IP, and Mail-in-a-Box's fail2ban eventually
 * rejected us with ECONNREFUSED — which then read as an outage for two days
 * because nothing surfaced "I have not read mail since Tuesday". This waits on
 * IDLE, and reports mail silence as a first-class number.
 *
 *   YENTE_GRAPH_DATA_PATH=./data/graph
 *   YENTE_MAIL_HOST / YENTE_MAIL_USER / YENTE_MAIL_PASS / YENTE_IMAP_PORT
 *   YENTE_MODEL=muse-local:latest  YENTE_INTELLIGENCE_PROVIDER=pin
 *   YENTE_INTELLIGENCE_CONCURRENCY=3
 *   YENTE_GRAPH_PORT=3767
 */

import { createServer } from "node:http";

import { openDatabase, closeDatabase } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { createImapClient } from "../src/mail/imap-client.js";
import { createMailSource } from "../src/mail/source.js";
import { ingestMail } from "../src/graph/ingest.js";
import { drainIntelligence } from "../src/intelligence/queue.js";
import { proposeIntroductions } from "../src/graph/matching.js";
import { createGraphManager } from "../src/graph/manager.js";
import { createIntelligenceProvider, resolveIntelligenceConfig } from "../src/intelligence/provider.js";
import { createLlmClients } from "../src/llm/providers.js";
import { renderManager, handleManagerRequest } from "../web/manager.js";

const log = (level, event, meta = {}) => {
  const bits = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  console.log(`[yente:${level}] ${event}${bits.length ? " " + bits.join(" ") : ""}`);
};

/* --- one database ------------------------------------------------------- */

const dataPath = process.env.YENTE_GRAPH_DATA_PATH || "./data/graph";
const store = openDatabase(dataPath);
const graph = createGraphRepositories(store);

// A process that died mid-inference leaves jobs RUNNING and nothing else will
// ever move them — mail ingested, meaning silently lost.
const requeued = graph.jobs.requeueStranded(new Date().toISOString());
if (requeued > 0) log("warn", "requeued_stranded_jobs", { count: requeued });

/* --- the sensor -------------------------------------------------------- */

const mailbox = process.env.YENTE_MAILBOX || "INBOX";
const imapConfigured = Boolean(process.env.YENTE_MAIL_HOST && process.env.YENTE_MAIL_USER);

let source = null;
let imap = null;
if (imapConfigured) {
  imap = createImapClient({
    imap: {
      host: process.env.YENTE_MAIL_HOST,
      port: Number(process.env.YENTE_IMAP_PORT || 993),
      secure: true,
      auth: {
        user: process.env.YENTE_MAIL_USER,
        pass: process.env.YENTE_MAIL_PASS,
      },
    },
    mailbox,
    log,
  });

  source = createMailSource({
    client: imap,
    cursors: graph.cursors,
    mailbox,
    // postal-mime: zero dependencies, actively maintained, and mailparser's own
    // README now points at it. Imported lazily so a box without it can still run
    // the other two loops.
    parse: async (raw) => {
      const { default: PostalMime } = await import("postal-mime");
      const parsed = await PostalMime.parse(raw);
      return {
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: Array.isArray(parsed.references) ? parsed.references : undefined,
        from: parsed.from?.address ?? null,
        to: (parsed.to ?? []).map((a) => a.address),
        cc: (parsed.cc ?? []).map((a) => a.address),
        subject: parsed.subject,
        text: parsed.text ?? parsed.html ?? "",
        date: parsed.date,
        attachments: parsed.attachments ?? [],
      };
    },
    log,
  });
} else {
  log("warn", "mail_not_configured", {
    note: "YENTE_MAIL_HOST/USER unset — the intelligence and matching loops still "
      + "run over whatever is already in the graph, so a backlog can be worked "
      + "without a mailbox.",
  });
}

/* --- the interpreter --------------------------------------------------- */

const { provider: providerName } = resolveIntelligenceConfig();
const clients = createLlmClients({ provider: providerName, log });
const observer = createIntelligenceProvider({
  client: clients.extractionClient,
  provider: providerName,
  model: clients.describe.model,
});
log("info", "intelligence", {
  provider: providerName,
  model: clients.describe.model,
  concurrency: Number(process.env.YENTE_INTELLIGENCE_CONCURRENCY || 3),
  third_party: clients.describe.thirdParty,
});

const manager = createGraphManager({ graph });

/* --- health that answers the question nobody asked ---------------------- */

const health = {
  startedAt: new Date().toISOString(),
  lastMailAt: null,
  lastMailError: null,
  consecutiveMailFailures: 0,
  ticks: { listen: 0, understand: 0, connect: 0 },
};

/**
 * "I have not successfully read mail in N hours."
 *
 * The failure that cost two days was not that IMAP broke — it was that nothing
 * said so. A listener has exactly one job and its silence is indistinguishable
 * from a quiet mailbox unless it reports the difference itself.
 */
function mailSilenceMinutes() {
  const since = health.lastMailAt ?? health.startedAt;
  return Math.round((Date.now() - new Date(since).getTime()) / 60_000);
}

/* --- LISTEN ------------------------------------------------------------- */

let stopping = false;
const abort = new AbortController();

async function listenLoop() {
  if (!source) return;
  while (!stopping) {
    try {
      const summary = await ingestMail({ source, graph, log });
      health.lastMailAt = new Date().toISOString();
      health.consecutiveMailFailures = 0;
      health.lastMailError = null;
      health.ticks.listen += 1;

      // Something arrived: come straight back rather than idling, in case the
      // batch was capped.
      if (summary.fetched > 0) continue;
    } catch (error) {
      health.consecutiveMailFailures += 1;
      health.lastMailError = String(error?.message ?? error);
      log("error", "listen_failed", {
        error: health.lastMailError,
        consecutive: health.consecutiveMailFailures,
        silent_for_min: mailSilenceMinutes(),
      });

      // Back off hard and say it plainly. ECONNREFUSED repeated for a week is
      // how we got banned in the first place; grinding at a closed port is not
      // persistence, it is the thing that caused the problem.
      const backoffMs = Math.min(30 * 60_000, 30_000 * 2 ** Math.min(6, health.consecutiveMailFailures));
      if (health.consecutiveMailFailures === 3) {
        log("error", "mail_unreachable", {
          note: "three consecutive failures. If this is ECONNREFUSED, check "
            + "fail2ban on the mail server before anything else.",
        });
      }
      await sleep(backoffMs);
      continue;
    }

    // Nothing new: wait for the server to tell us, rather than asking again.
    const arrived = await source.waitForMail({ timeoutMs: 15 * 60_000, signal: abort.signal });
    if (!arrived && !stopping) await sleep(30_000);
  }
}

/* --- UNDERSTAND -------------------------------------------------------- */

async function understandLoop() {
  while (!stopping) {
    try {
      const summary = await drainIntelligence({
        graph, observer, log, signal: abort.signal,
      });
      health.ticks.understand += 1;
      if (summary.claimed > 0) {
        log("info", "understood", { ...summary, backlog: graph.jobs.counts().READY });
        continue;   // keep going while there is a backlog
      }
    } catch (error) {
      // The whole drain failing is different from one job failing; the drain
      // already handles the latter. This is a bug or a dead gateway.
      log("error", "understand_failed", { error: String(error?.message ?? error) });
    }
    await sleep(15_000);
  }
}

/* --- CONNECT ----------------------------------------------------------- */

async function connectLoop() {
  while (!stopping) {
    try {
      const observations = graph.observations
        .all()
        // §20: an excluded subject is not a matching candidate. Read here rather
        // than filtered at write time so the exclusion stays reversible.
        .filter((row) => manager.isEligible(row.subject));

      const proposals = proposeIntroductions({ observations });
      let queued = 0;
      for (const proposal of proposals) {
        const { decided } = graph.matches.propose({
          ...proposal, at: new Date().toISOString(),
        });
        // A match a person already ruled on is never re-opened. Without this the
        // review queue is a treadmill.
        if (!decided) queued += 1;
      }
      health.ticks.connect += 1;
      if (queued > 0) log("info", "proposed", { queued, pending: manager.pendingMatches().length });
    } catch (error) {
      log("error", "connect_failed", { error: String(error?.message ?? error) });
    }
    await sleep(60_000);
  }
}

/* --- the manager surface ----------------------------------------------- */

const port = Number(process.env.YENTE_GRAPH_PORT || 3767);
const host = process.env.YENTE_GRAPH_HOST || "127.0.0.1";

const httpServer = createServer(async (req, res) => {
  try {
    const handled = await handleManagerRequest({ req, res, manager, graph, health });
    if (handled) return;
    const html = renderManager({ manager, health, mailSilenceMinutes: mailSilenceMinutes() });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (error) {
    log("error", "http_failed", { error: String(error?.message ?? error) });
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  }
});

httpServer.on("error", (error) => {
  // A dead port must not take the desk down. Mail and matching do not depend on
  // the web surface, and losing them because something else holds 3767 would be
  // a worse outage than losing the page.
  log("error", "http_failed", { error: String(error?.message ?? error), port });
});
httpServer.listen(port, host, () => {
  log("info", "manager", { url: `http://${host}:${port}`, operator: manager.actor });
});

/* --- run --------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

log("info", "started", {
  data: dataPath,
  mailbox: imapConfigured ? mailbox : "(none)",
  pid: process.pid,
  jobs: JSON.stringify(graph.jobs.counts()),
  subjects: manager.subjects().length,
});

const loops = Promise.all([listenLoop(), understandLoop(), connectLoop()]);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutting_down", { signal });
  abort.abort();

  // Stop accepting first, then flush. An accepted decision must not be written
  // to a closing store.
  await new Promise((resolve) => httpServer.close(resolve));
  await Promise.race([loops, sleep(10_000)]);
  await imap?.close().catch(() => {});
  closeDatabase(store);
  log("info", "stopped", { ticks: JSON.stringify(health.ticks) });
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await loops;
