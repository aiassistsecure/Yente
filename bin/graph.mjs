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
import { createMailFromEnv } from "../src/mail/from-env.js";
import { createGraphLoops } from "../src/graph/loops.js";
import { createGraphManager } from "../src/graph/manager.js";
import { createIntelligenceProvider, resolveIntelligenceConfig } from "../src/intelligence/provider.js";
import { createLlmClients } from "../src/llm/providers.js";
import { renderManager, handleManagerRequest } from "../web/manager.js";
import { createLogger } from "../src/log.js";

/**
 * The narrator.
 *
 * Not decoration. Three loops interleave in one stream against a model that
 * takes most of a minute, so the two questions you actually have — "is it
 * alive" and "which loop is the slow one" — are unanswerable from uniform grey
 * text. A colour per loop answers the second at a glance; the heartbeat below
 * answers the first without you having to attach a debugger.
 */
const logger = createLogger({ quiet: process.env.YENTE_QUIET === "1" });
const { log, begin, end } = logger;

/* --- one database ------------------------------------------------------- */

const dataPath = process.env.YENTE_GRAPH_DATA_PATH || "./data/graph";
const store = openDatabase(dataPath);
const graph = createGraphRepositories(store);

// A process that died mid-inference leaves jobs RUNNING and nothing else will
// ever move them — mail ingested, meaning silently lost.
const requeued = graph.jobs.requeueStranded(new Date().toISOString());
if (requeued > 0) log("warn", "requeued_stranded_jobs", { count: requeued });

/* --- the sensor -------------------------------------------------------- */

// Built by src/mail/from-env.js, which bin/yente.mjs also uses. Two entry points
// deriving the same IMAP config by hand is how a mailbox ends up configured
// slightly differently in each, and that difference shows up as a silence rather
// than as an error.
const { source, imap, mailbox, configured: imapConfigured } =
  createMailFromEnv({ graph, log });

/* --- the interpreter --------------------------------------------------- */

const { provider: providerName } = resolveIntelligenceConfig();
const clients = createLlmClients({ provider: providerName, log });
const observer = createIntelligenceProvider({
  client: clients.extractionClient,
  provider: providerName,
  model: clients.describe.model,
  onStream: (event) => log(
    event.phase === "rejected" ? "warn" : "info",
    "model_stream",
    event,
  ),
});
const promptRequeued = graph.jobs.requeueForPrompt(
  observer.describe().promptVersion,
  new Date().toISOString(),
);
if (promptRequeued > 0) {
  log("info", "prompt_jobs_requeued", {
    count: promptRequeued,
    prompt: observer.describe().promptVersion,
  });
}
log("info", "intelligence", {
  provider: providerName,
  model: clients.describe.model,
  concurrency: Number(process.env.YENTE_INTELLIGENCE_CONCURRENCY || 3),
  third_party: clients.describe.thirdParty,
});

const manager = createGraphManager({ graph });

/* --- the loops --------------------------------------------------------- */

// createGraphLoops owns LISTEN / UNDERSTAND / CONNECT and the health record. It
// lives in src/ so bin/yente.mjs can run these same three loops beside the desk
// in one process; a loop that exists in two files is a loop that gets fixed once.
let stopping = false;
const abort = new AbortController();

const loops = createGraphLoops({
  graph, source, observer, manager, log, begin, end,
  signal: abort.signal,
  isStopping: () => stopping,
  concurrency,
});
const { health } = loops;
const mailSilenceMinutes = () => loops.mailSilenceMinutes();

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

const sleep = (ms) => loops.sleep(ms);

log("info", "started", {
  data: dataPath,
  mailbox: imapConfigured ? mailbox : "(none)",
  pid: process.pid,
  jobs: JSON.stringify(graph.jobs.counts()),
  subjects: manager.subjects().length,
});

/**
 * The heartbeat. Unconditional, on its own clock.
 *
 * Deliberately NOT driven by the loops: a heartbeat that only prints when work
 * completes is silent in precisely the situation you need it — everything
 * wedged. `unref()` so it can never be the reason the process refuses to exit.
 */
const heartbeatMs = Number(process.env.YENTE_HEARTBEAT_MS || 30_000);
const pulse = setInterval(() => {
  logger.heartbeat({
    graph, health, mailConfigured: imapConfigured, concurrency,
    mailSilenceMinutes: mailSilenceMinutes(),
  });
}, heartbeatMs);
pulse.unref();

const running = Promise.all([loops.listen(), loops.understand(), loops.connect()]);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(pulse);
  log("info", "shutting_down", { signal });
  abort.abort();

  // Stop accepting first, then flush. An accepted decision must not be written
  // to a closing store.
  await new Promise((resolve) => httpServer.close(resolve));
  await Promise.race([running, sleep(10_000)]);
  await imap?.close().catch(() => {});
  closeDatabase(store);
  log("info", "stopped", { ticks: JSON.stringify(health.ticks) });
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await running;
