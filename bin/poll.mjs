#!/usr/bin/env node
/**
 * One tick of the desk. Open the mailbox, ingest what is unseen, drain the
 * outbox, record what happened, flush, exit.
 *
 * Run it from a systemd timer or cron. It is a one-shot process rather than a
 * daemon on purpose: a crash is a missed minute instead of a silently wedged
 * long-lived IMAP connection, and there is no reconnect logic to get wrong.
 *
 *   node bin/poll.mjs            # one tick
 *   node bin/poll.mjs --dry-run  # connect, count, change nothing
 *   node bin/poll.mjs --json     # machine-readable, for the timer's logs
 *
 * ── IDEMPOTENCE ───────────────────────────────────────────────────────────
 *
 * Three layers, none of which is this file being careful:
 *
 * 1. `\Seen` is set by the RUNTIME, only after `recordInbound` has durably
 *    stored the message. If this process dies mid-tick the message stays
 *    unseen, the next tick refetches it, and `recordInbound` returns
 *    `duplicate` — so it is recorded once and acted on once. Marking on read
 *    would instead lose that email permanently.
 * 2. Dedupe is by RFC Message-ID, not UID. UIDs are per-mailbox and reset on
 *    UIDVALIDITY change; the Message-ID is the message. The transport already
 *    drops anything without one, because a message that cannot be deduplicated
 *    would reprocess on every single tick forever.
 * 3. The outbox owns its own attempt counting and backoff, so a tick that dies
 *    mid-send does not double-send on the next one.
 *
 * ── MUTUAL EXCLUSION ──────────────────────────────────────────────────────
 *
 * There is no lock file here, and deliberately so. `openDatabase` takes an
 * exclusive lock on its data directory and the engine exposes no close, so a
 * second concurrent tick physically cannot open the same path — the OS is the
 * mutex. A lock built on top of the database would live *inside* the thing
 * already locked, which is both redundant and a second source of truth.
 *
 * So an overlapping tick is not an error to report, it is the expected outcome
 * of a tick running long: this exits 0 with `status: "busy"`. A timer that
 * treats normal overlap as failure trains everyone to ignore its alerts.
 *
 * ── PERSISTENCE ───────────────────────────────────────────────────────────
 *
 * Every tick appends a `poll_runs` row — started, finished, counts, and any
 * error — so "is she actually reading the inbox" is answerable from the data
 * rather than from log scrollback. A tick that dies leaves its row without a
 * `finished_at`, which is exactly how you find the crash.
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

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const AS_JSON = ARGS.has("--json");

const POLL_RUNS = "poll_runs";

function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function mailConfig() {
  const host = env("YENTE_MAIL_HOST");
  const user = env("YENTE_MAIL_USER");
  const pass = env("YENTE_MAIL_PASS");
  return {
    // 993 is implicit TLS, so secure: true.
    imap: {
      host,
      port: Number(process.env.YENTE_IMAP_PORT || 993),
      secure: true,
      auth: { user, pass },
    },
    // 587 is submission: secure:false means "upgrade with STARTTLS", NOT
    // plaintext. Setting it true here makes the connection hang, and the
    // naming is confusing enough that it is worth saying so out loud.
    smtp: {
      host,
      port: Number(process.env.YENTE_SMTP_PORT || 587),
      secure: false,
      requireTLS: true,
      auth: { user, pass },
    },
    from: process.env.YENTE_FROM || `Yente <${user}>`,
    mailbox: process.env.YENTE_MAILBOX || "INBOX",
  };
}

/** A lock error from the engine means another tick owns the directory. */
function isBusy(error) {
  const m = String(error?.message ?? error).toLowerCase();
  return m.includes("already open") || m.includes("lock");
}

function report(payload, code = 0) {
  if (AS_JSON) {
    console.log(JSON.stringify(payload, null, 1));
  } else {
    const parts = [`status ${payload.status}`];
    if (payload.ingested !== undefined) parts.push(`ingested ${payload.ingested}`);
    if (payload.duplicates !== undefined) parts.push(`duplicates ${payload.duplicates}`);
    if (payload.sent !== undefined) parts.push(`sent ${payload.sent}`);
    if (payload.ms !== undefined) parts.push(`${payload.ms}ms`);
    console.log(`[yente] ${parts.join("  ")}`);
    if (payload.outcomes) {
      for (const [k, n] of Object.entries(payload.outcomes)) {
        console.log(`    ${k}: ${n}`);
      }
    }
    if (payload.error) console.error(`    error: ${payload.error}`);
  }
  process.exit(code);
}

const startedAt = new Date().toISOString();
const t0 = Date.now();

let store;
try {
  store = openDatabase(env("YENTE_DATA_PATH", "./data/yente"));
} catch (error) {
  // Expected whenever a tick runs long. Not a failure.
  if (isBusy(error)) {
    report({ status: "busy", started_at: startedAt,
             note: "another tick holds the data directory" }, 0);
  }
  report({ status: "error", started_at: startedAt,
           error: String(error?.message ?? error) }, 1);
}

// WITHOUT THIS, EVERY ATTACHMENT IS UNREADABLE. The extractor registry starts
// empty and parsers register themselves; until now only the test suite called
// this, so production had no parsers at all and every file — including the DOCX
// mammoth has always handled — came back UNSUPPORTED_TYPE:
//   "Yente cannot read application/vnd.openxmlformats-...wordprocessingml.document yet"
// The support existed the whole time; nothing wired it up.
const parserTypes = registerDocumentParsers();

const repositories = createRepositories(store);
let runId = null;

/** Append the run row up front, so a crashed tick is visible by its absence
 *  of a finished_at rather than by nothing at all. */
function beginRun() {
  runId = `poll_${startedAt}_${process.pid}`;
  try {
    store.put(POLL_RUNS, runId, {
      started_at: startedAt, finished_at: null, pid: process.pid,
      dry_run: DRY_RUN, host: process.env.HOSTNAME || null,
    });
  } catch { runId = null; }   // observability must never block the tick
}

function endRun(patch) {
  if (!runId) return;
  try {
    store.put(POLL_RUNS, runId, {
      started_at: startedAt, finished_at: new Date().toISOString(),
      pid: process.pid, dry_run: DRY_RUN, ...patch,
    });
  } catch { /* same */ }
}

let transport;
try {
  transport = assertTransport(createMailTransport(mailConfig()));
} catch (error) {
  endRun({ status: "error", error: String(error?.message ?? error) });
  closeDatabase(store);
  report({ status: "error", started_at: startedAt,
           error: `mail transport: ${String(error?.message ?? error)}` }, 1);
}

beginRun();

try {
  if (DRY_RUN) {
    // Prove the credentials and the mailbox without changing anything: no
    // ingest, so nothing is recorded, nothing is marked seen, nothing is sent.
    const unseen = await transport.fetchUnseen({ limit: 50 });
    endRun({ status: "dry_run", unseen: unseen.length });
    await transport.close?.();
    closeDatabase(store);
    report({
      status: "dry_run", started_at: startedAt, unseen: unseen.length,
      ms: Date.now() - t0,
      from: unseen.slice(0, 10).map((m) => ({ from: m.from, subject: m.subject,
        attachments: m.attachments?.length ?? 0 })),
    });
  }

  // WITHOUT THE MODEL CLIENTS, SHE INGESTS AND SAYS NOTHING. createRuntime
// defaults extractionClient and emailClient to null, and runtime/yente.js gates
// the whole extraction block on `if (extractionClient)` — so with neither, a
// resume is stored verbatim, no facts come out, nothing is queued, and every
// tick reports ingested=1 sent=0 with no error anywhere. That is exactly what
// the box showed: outcomes={"intake":1} three ticks running, silence to the
// sender. I wrote this call and passed `store`, which createRuntime does not
// even take, while omitting the two arguments that make her able to reply.
const llm = createLlmClients({
  log: (level, event, fields) =>
    console.error(`[yente] ${event} ${JSON.stringify(fields || {})}`),
});


const runtime = createRuntime({
  repositories,
  transport,
  extractionClient: llm.extractionClient,
  emailClient: llm.emailClient,
});
  const now = new Date();

  const ingested = await runtime.ingest(now);
  const outcomes = {};
  for (const r of ingested) {
    const key = r?.outcome ?? "unknown";
    outcomes[key] = (outcomes[key] || 0) + 1;
  }

  const drained = await runtime.drainOutbox(now);
  const sent = Array.isArray(drained)
    ? drained.filter((d) => d?.status === "sent" || d?.sent).length
    : Number(drained?.sent ?? 0);

  endRun({ status: "ok", ingested: ingested.length,
           duplicates: outcomes.duplicate || 0, sent, outcomes });

  await transport.close?.();
  closeDatabase(store);      // flush before exit; the lock releases with the pid

  report({
    status: "ok", started_at: startedAt, ms: Date.now() - t0,
    ingested: ingested.length, duplicates: outcomes.duplicate || 0,
    sent, outcomes,
  });
} catch (error) {
  const message = String(error?.message ?? error);
  endRun({ status: "error", error: message.slice(0, 400) });
  try { await transport.close?.(); } catch { /* nothing left to do */ }
  closeDatabase(store);
  report({ status: "error", started_at: startedAt, ms: Date.now() - t0,
           error: message }, 1);
}
