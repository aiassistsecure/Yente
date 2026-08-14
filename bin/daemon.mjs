#!/usr/bin/env node
/**
 * Yente's desk, running. Long-lived process, polls the mailbox on an interval.
 *
 *   node bin/daemon.mjs
 *
 * Nobody runs a tick by hand. systemd starts this once with Restart=always and
 * it keeps reading the inbox until stopped.
 *
 * WHY A DAEMON AND NOT A TIMER
 *
 * The embedded engine holds an exclusive lock on its data directory for the life
 * of the process, and exposes no close. A one-shot tick therefore pays a full
 * cold open every run — measured at 3.8s on the box, most of it the store, for
 * work that took milliseconds. Holding the store open across ticks removes that
 * entirely, and since the lock is per-process anyway, a long-lived owner is the
 * shape the engine actually wants.
 *
 * WHAT A DAEMON HAS TO GET RIGHT THAT A ONE-SHOT DOES NOT
 *
 * A one-shot process gets crash-safety for free: it dies, systemd runs it again,
 * and nothing is carried over. A daemon has to earn the same properties:
 *
 *  - AN ERROR MUST NOT KILL THE LOOP. A single failed tick — mailbox down, TLS
 *    hiccup, one malformed message — is caught, recorded, and the next tick runs.
 *    A daemon that exits on the first transient error is strictly worse than a
 *    timer, because the gap is however long until someone notices.
 *  - REPEATED FAILURE MUST BACK OFF. A dead mailbox should not be hammered every
 *    few seconds; the interval grows to a ceiling and returns to normal on the
 *    first success.
 *  - TICKS MUST NOT OVERLAP THEMSELVES. The loop is sequential by construction —
 *    it waits for the tick to finish, then sleeps. No setInterval, which would
 *    happily start a second tick on top of a slow one.
 *  - SHUTDOWN MUST FINISH THE TICK. SIGTERM sets a flag; the current tick runs
 *    to completion, the store flushes, then the process exits. Killing a process
 *    mid-tick is exactly how a message gets recorded and never marked \\Seen, or
 *    an outbox row gets reserved and never sent.
 *  - AN UNHANDLED REJECTION MUST NOT SILENTLY ZOMBIE IT. Node's default is to
 *    exit, which is survivable, but the reason has to reach the log first.
 *
 * Idempotence is unchanged and still not this file's doing: the runtime marks
 * \\Seen only after recordInbound, dedupe is by RFC Message-ID, and the outbox
 * owns its own attempts. Those hold whether the caller is a timer or a loop.
 */

import process from "node:process";
import {
  openDatabase,
  closeDatabase,
  createRepositories,
  createRuntime,
  createMailTransport,
  assertTransport,
  registerDocumentParsers,
} from "../src/index.js";
import { createLlmClients } from "../src/llm/providers.js";
import { openWaitlistRepository } from "../src/waitlist/repository.js";
import { createYenteServer } from "../web/server.js";
import { buildProfileView } from "../src/store/profile-view.js";
import { COLLECTIONS } from "../src/store/db.js";

const POLL_RUNS = "poll_runs";

const INTERVAL_MS = Number(process.env.YENTE_POLL_INTERVAL_MS || 30_000);
const MAX_BACKOFF_MS = Number(process.env.YENTE_MAX_BACKOFF_MS || 300_000);
const JSON_LOG = String(process.env.YENTE_LOG_JSON || "") === "1";

function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function log(level, event, fields = {}) {
  const at = new Date().toISOString();
  if (JSON_LOG) {
    console.log(JSON.stringify({ at, level, event, ...fields }));
    return;
  }
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  const line = `[yente] ${event}${parts.length ? " " + parts.join(" ") : ""}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function mailConfig() {
  const host = env("YENTE_MAIL_HOST");
  const user = env("YENTE_MAIL_USER");
  const pass = env("YENTE_MAIL_PASS");
  return {
    imap: { host, port: Number(process.env.YENTE_IMAP_PORT || 993),
            secure: true, auth: { user, pass } },
    // secure:false on 587 means "upgrade via STARTTLS", not plaintext.
    smtp: { host, port: Number(process.env.YENTE_SMTP_PORT || 587),
            secure: false, requireTLS: true, auth: { user, pass } },
    from: process.env.YENTE_FROM || `Yente <${user}>`,
    mailbox: process.env.YENTE_MAILBOX || "INBOX",
  };
}

/* ------------------------------------------------------------------ startup */

// ONE DATA DIRECTORY. ONE PROCESS. THE LOCK WAS TELLING US THIS ALL ALONG.
//
// There used to be two: YENTE_DATA_PATH for the member ledger (this daemon) and
// YENTE_WAITLIST_DATA_PATH for subscribers (a separate web process). Two
// databases because the engine takes an exclusive lock per directory and exposes
// no close — so a second process physically cannot share one.
//
// The cost was not operational tidiness, it was product: somebody who joined on
// the website was a `subscriber` in one database, somebody who emailed was a
// `member` in the other, and NOTHING connected them. The landing page's funnel
// did not reach the desk. It is also why src/sequence/founding.mjs sat orphaned
// — a weekly letter has to read subscribers AND write to the outbox, which lived
// in different databases owned by different processes.
//
// The lock does not want two processes; it wants ONE OWNER. So this process owns
// the directory and serves the BFF from inside the same lock.
if (process.env.YENTE_WAITLIST_DATA_PATH
    && process.env.YENTE_WAITLIST_DATA_PATH !== process.env.YENTE_DATA_PATH) {
  log("error", "split_data_path", {
    waitlist: process.env.YENTE_WAITLIST_DATA_PATH,
    ledger: process.env.YENTE_DATA_PATH,
    note: "there is one database now. Unset YENTE_WAITLIST_DATA_PATH, and if the "
      + "old directory holds real subscribers migrate them first: "
      + "node bin/migrate-waitlist.mjs <old-waitlist-dir>",
  });
  process.exit(1);
}

let store;
try {
  store = openDatabase(env("YENTE_DATA_PATH", "./data/yente"));
} catch (error) {
  log("error", "store_open_failed", { error: String(error?.message ?? error) });
  process.exit(1);
}

// WITHOUT THIS, EVERY ATTACHMENT IS UNREADABLE. The extractor registry starts
// empty and parsers register themselves; until now only the test suite called
// this, so production had no parsers at all and every file — including the DOCX
// mammoth has always handled — came back UNSUPPORTED_TYPE:
//   "Yente cannot read application/vnd.openxmlformats-...wordprocessingml.document yet"
// The support existed the whole time; nothing wired it up.
const parserTypes = registerDocumentParsers();

const repositories = createRepositories(store);

let transport;
try {
  transport = assertTransport(createMailTransport(mailConfig()));
} catch (error) {
  log("error", "transport_failed", { error: String(error?.message ?? error) });
  closeDatabase(store);
  process.exit(1);
}

// WITHOUT THE MODEL CLIENTS, SHE INGESTS AND SAYS NOTHING. createRuntime
// defaults extractionClient and emailClient to null, and runtime/yente.js gates
// the whole extraction block on `if (extractionClient)` — so with neither, a
// resume is stored verbatim, no facts come out, nothing is queued, and every
// tick reports ingested=1 sent=0 with no error anywhere. That is exactly what
// the box showed: outcomes={"intake":1} three ticks running, silence to the
// sender. I wrote this call and passed `store`, which createRuntime does not
// even take, while omitting the two arguments that make her able to reply.
const llm = createLlmClients({ log });
log("info", "llm", llm.describe);

const runtime = createRuntime({
  repositories,
  transport,
  extractionClient: llm.extractionClient,
  emailClient: llm.emailClient,
});

/* ------------------------------------------------------------------- the BFF */

// The web server on the SAME store, in the SAME process. `openWaitlistRepository`
// already took an injected store and `createYenteServer` already took an injected
// repository — the seam existed; nothing had used it. Subscribers and members are
// now one dataset, which is what lets the sequence reach the outbox at all.
const waitlist = openWaitlistRepository({ store });

let httpServer = null;
if (String(process.env.YENTE_HTTP ?? "1") === "1") {
  httpServer = createYenteServer({
    repository: waitlist,
    adminUsername: process.env.YENTE_ADMIN_USERNAME,
    adminPassword: process.env.YENTE_ADMIN_PASSWORD,
    trustProxy: process.env.YENTE_TRUST_PROXY === "1",
  });
  const host = process.env.YENTE_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.YENTE_PORT || "3000", 10);
  httpServer.listen(port, host, () => {
    log("info", "http", { host, port, admin: Boolean(process.env.YENTE_ADMIN_PASSWORD) });
  });
  // A port already in use must not kill the desk. Mail and matching do not
  // depend on the BFF, and losing them because a stale process holds 3000 would
  // be a worse outage than losing the landing page.
  httpServer.on("error", (error) => {
    log("error", "http_failed", {
      error: String(error?.message ?? error),
      note: "the desk keeps running without the web surface",
    });
    httpServer = null;
  });
}

/* ------------------------------------------------------------------ the loop */

let stopping = false;
let ticking = false;
let backoff = 0;
let consecutiveFailures = 0;
const stats = { ticks: 0, ingested: 0, sent: 0, failures: 0 };
let wake = null;   // resolves the current sleep so shutdown is prompt

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
}

async function tick() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = `poll_${startedAt}_${process.pid}`;

  // Written BEFORE the work, so a tick that dies is visible by its missing
  // finished_at rather than by nothing at all. Observability must never block
  // the tick, hence the swallow.
  try {
    store.put(POLL_RUNS, runId, {
      started_at: startedAt, finished_at: null, pid: process.pid, mode: "daemon",
    });
  } catch { /* ignore */ }

  const now = new Date();
  const ingested = await runtime.ingest(now);
  const outcomes = {};
  // Extraction totals, and the reasons it produced nothing. `ingested=1 sent=0`
  // was true of at least four different states and distinguished none of them:
  // no source stored, a source with no facts, facts with an empty outbox, or a
  // queued letter that failed to send. Recovering the difference took a separate
  // tool re-running extraction by hand. The counts belong in the tick.
  let facts = 0;
  let rejected = 0;
  const failures = [];
  for (const r of ingested) {
    const key = r?.outcome ?? "unknown";
    outcomes[key] = (outcomes[key] || 0) + 1;
    facts += r?.facts ?? 0;
    rejected += r?.rejected ?? 0;
    for (const f of r?.failures ?? []) failures.push(f);
  }

  // A failure here is not a failed tick — the message is durably recorded and
  // she may simply have had nothing to say — so it is logged at its own level
  // rather than thrown. Silent is the one thing it must not be.
  for (const f of failures) {
    log("error", "extraction_failed", { code: f.code, error: String(f.message).slice(0, 300) });
  }
  if (rejected > 0) {
    log("warn", "facts_rejected", {
      rejected,
      note: "the model quoted evidence that is not in the document — grounding "
        + "refused it (INV-5). Not an error; a fact she declined to believe.",
    });
  }

  // MATCHING, WHICH NOTHING IN PRODUCTION USED TO CALL.
  //
  // `proposeMatches` and `advanceDeadlines` were exported by the runtime and
  // invoked by nothing outside the test suite. D8 drives the whole chain — match,
  // two private previews, veto window, one joint introduction — and proves it
  // works. No live process drove any of it, so the desk could take somebody in
  // and then never do the thing it exists to do.
  //
  // Ordering matters. Propose first so a new match opens its window in this same
  // tick; advance deadlines second so a window that expired while we were asleep
  // closes before the outbox drains, and the introduction it authorises goes out
  // now rather than a tick later.
  let proposed = 0;
  let advanced = 0;
  try {
    // The profile view is the materialisation of §6.1 — built from span-verified
    // facts, not handed in. Only ACTIVE members are offered: matchability is a
    // separate gate from qualification (§7.2), and it is enforced here by whose
    // profile is even built.
    const profiles = {};
    for (const member of store.query(`FROM ${COLLECTIONS.MEMBERS}`)) {
      if (member.state !== "ACTIVE") continue;
      const address = member.address ?? member._id;
      profiles[address] = buildProfileView(store, address);
    }
    proposed = (runtime.proposeMatches({ profiles, now }) ?? []).length;
    advanced = (runtime.advanceDeadlines(now) ?? []).length;
  } catch (error) {
    // Matching must not cost us the inbox. A message is already durably recorded
    // by this point and the outbox still has to drain; a bad policy or one
    // malformed opportunity should not strand either.
    log("error", "matching_failed", { error: String(error?.message ?? error).slice(0, 300) });
  }

  const drained = await runtime.drainOutbox(now);
  const sent = Array.isArray(drained)
    ? drained.filter((d) => d?.status === "sent" || d?.sent).length
    : Number(drained?.sent ?? 0);

  try {
    store.put(POLL_RUNS, runId, {
      started_at: startedAt, finished_at: new Date().toISOString(),
      pid: process.pid, mode: "daemon", status: "ok",
      ingested: ingested.length, sent, outcomes,
      facts, rejected, failures: failures.length, proposed, advanced,
    });
  } catch { /* ignore */ }

  return {
    ingested: ingested.length, sent, outcomes,
    facts, rejected, failures: failures.length, proposed, advanced,
    ms: Date.now() - t0,
  };
}

async function loop() {
  log("info", "started", {
    interval_ms: INTERVAL_MS,
    // Printed on purpose: a silently empty parser registry is what made every
    // resume unreadable, and one line in the journal makes that impossible to
    // miss next time.
    parsers: parserTypes.join(","),
    mailbox: process.env.YENTE_MAILBOX || "INBOX",
    data: process.env.YENTE_DATA_PATH || "./data/yente",
    pid: process.pid,
  });

  while (!stopping) {
    ticking = true;
    try {
      const r = await tick();
      stats.ticks += 1;
      stats.ingested += r.ingested;
      stats.sent += r.sent;
      consecutiveFailures = 0;
      backoff = 0;
      // Quiet ticks are the normal case; do not narrate them.
      if (r.ingested || r.sent || r.proposed || r.advanced) {
        log("info", "tick", {
          ingested: r.ingested, sent: r.sent, outcomes: r.outcomes,
          // Printed even when zero: `facts=0` after a resume arrived is the
          // single most useful thing the line can say, and its absence is what
          // made the silence unreadable.
          facts: r.facts, rejected: r.rejected || undefined,
          failures: r.failures || undefined,
          proposed: r.proposed || undefined, advanced: r.advanced || undefined,
          ms: r.ms,
        });
      }
    } catch (error) {
      // A failed tick must never end the loop. That is the whole difference
      // between a daemon and a script that happens to run in a loop.
      stats.failures += 1;
      consecutiveFailures += 1;
      backoff = Math.min(
        MAX_BACKOFF_MS,
        backoff ? backoff * 2 : INTERVAL_MS,
      );
      log("error", "tick_failed", {
        error: String(error?.message ?? error).slice(0, 300),
        consecutive: consecutiveFailures,
        next_in_ms: backoff,
      });
    } finally {
      ticking = false;
    }

    if (stopping) break;
    await sleep(backoff || INTERVAL_MS);
  }

  log("info", "stopped", stats);
}

/* ---------------------------------------------------------------- shutdown */

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("info", "shutting_down", { signal, mid_tick: ticking });
  if (wake) wake();          // cut the sleep short; the tick itself finishes

  // Stop accepting HTTP first. A subscriber POST arriving mid-shutdown would
  // otherwise write to a store that is about to close, and the signup would be
  // acknowledged to somebody's browser without being durable. Closing the
  // listener refuses new connections while in-flight requests finish.
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    log("info", "http_closed", {});
  }

  // Give the in-flight tick a bounded chance to complete. Killing it between
  // recording a message and marking it \Seen, or between reserving an outbox
  // row and sending it, is the failure this wait exists to avoid.
  const deadline = Date.now() + 30_000;
  while (ticking && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ticking) log("error", "shutdown_timeout", { note: "tick still running" });

  try { await transport.close?.(); } catch { /* nothing to do */ }
  closeDatabase(store);      // flush; the engine lock releases with the pid
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });

// Default Node behaviour on an unhandled rejection is to exit. Survivable under
// Restart=always, but only if the reason reaches the log first.
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", {
    error: String(reason?.message ?? reason).slice(0, 300),
  });
});
process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", {
    error: String(error?.message ?? error).slice(0, 300),
  });
  closeDatabase(store);
  process.exit(1);
});

await loop();
