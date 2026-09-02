#!/usr/bin/env node
/**
 * Yente. One process.
 *
 * Everything she is, in a single supervised unit:
 *
 *   DESK          ingest -> propose -> veto deadlines -> drain outbox   (the tick)
 *   LISTEN        IMAP -> evidence -> job, then get out of the way
 *   UNDERSTAND    drain the job queue through Muse, bounded concurrency
 *   CONNECT       score the graph for complementary intent, queue for review
 *   WEB           the landing page, the admin, and the graph manager, one port
 *
 * WHY THIS FILE EXISTS
 *
 * Because there were three ways to run her and none of them was "her". The desk
 * ran the member state machine and served the site; the listener ran the graph
 * and served a manager on another port; and the two could not see each other. The
 * landing page counted subscribers in one database while the listener accumulated
 * people in another, so the site could advertise a founding network the listener
 * had never met — not a display bug, two populations.
 *
 * THE THING THAT MADE IT LOOK IMPOSSIBLE WAS MY OWN CODE
 *
 * `openDatabase` threw on a second directory, with a confident comment
 * explaining that the engine's exclusive lock made one-process-two-stores
 * impossible. It doesn't: the lock is per DIRECTORY, and `NedbCore.open("/a")`
 * followed by `NedbCore.open("/b")` both succeed and both stay writable
 * (measured, not assumed). One OWNER per directory is the real rule, and a
 * single process is allowed to own several. So the store now holds a handle per
 * path, and reads across the two directories happen in memory with no protocol
 * between them.
 *
 * WHAT STILL RUNS SEPARATELY, AND WHY THAT IS FINE
 *
 * `bin/daemon.mjs` and `bin/graph.mjs` still work and now compose the same
 * modules this file does — `createDesk`, `createGraphLoops`, `createMailFromEnv`.
 * They are the halves, for when you want to run one without the other. They
 * cannot drift from this file because none of them owns an implementation.
 *
 * THE SHUTDOWN ORDER IS THE CAREFUL PART
 *
 * Stop accepting HTTP first, then abort the graph loops, then let the desk's
 * in-flight tick finish, then flush BOTH stores. A decision accepted through the
 * manager must not be written to a store that is mid-flush, and a tick killed
 * between recording a message and marking it \\Seen is how a message gets read
 * twice or never.
 *
 *   YENTE_DATA_PATH=./data            the desk (members, outbox, subscribers)
 *   YENTE_GRAPH_DATA_PATH=./data/graph the listener (evidence, observations)
 *   YENTE_PORT=7688 YENTE_HOST=127.0.0.1
 *   YENTE_MAIL_HOST / YENTE_MAIL_USER / YENTE_MAIL_PASS / YENTE_IMAP_PORT
 *   YENTE_MODEL_DOCUMENT=GLM-4-32B  YENTE_INTELLIGENCE_PROVIDER=pin
 *   YENTE_OPERATOR=mark              whose name goes on a decision
 *   YENTE_DESK=0                     listener only
 *   YENTE_HTTP=0                     no web surface
 */

import process from "node:process";
import { createServer } from "node:http";

import {
  openDatabase,
  closeDatabase,
  createRepositories,
  createRuntime,
  createMailTransport,
  assertTransport,
  registerDocumentParsers,
} from "../src/index.js";
import { openDatabases , COLLECTIONS } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { buildDirectory } from "../src/graph/directory.js";
import { createLlmClients } from "../src/llm/providers.js";
import { openWaitlistRepository } from "../src/waitlist/repository.js";
import { claimSeatFromInbound } from "../src/waitlist/inbound.js";
import { createSiteHandler } from "../web/server.js";
import { createLanes, pooledObserver, pooledCompleter } from "../src/runtime/lanes.js";
import { renderManager, handleManagerRequest } from "../web/manager.js";
import { createDesk } from "../src/runtime/desk.js";
import { createGraphLoops } from "../src/graph/loops.js";
import { subjectForAddress } from "../src/graph/identity.js";
import { createMailFromEnv, mailConfigFromEnv } from "../src/mail/from-env.js";
import { createGraphManager } from "../src/graph/manager.js";
import { drainConfirmedIntroductions } from "../src/graph/introductions.js";
import { drainPartyConsent } from "../src/graph/consent.js";
import { renderFile } from "../src/graph/file.js";
import {
  createIntelligenceProvider,
  resolveIntelligenceConfig,
} from "../src/intelligence/provider.js";
import { createLogger } from "../src/log.js";

const logger = createLogger({ quiet: process.env.YENTE_QUIET === "1" });
const { log, begin, end } = logger;

const on = (name, dflt = "1") => String(process.env[name] ?? dflt) === "1";

/* --- two directories, one owner ---------------------------------------- */

const deskPath = process.env.YENTE_DATA_PATH || "./data";
const graphPath = process.env.YENTE_GRAPH_DATA_PATH || "./data/graph";

if (deskPath === graphPath) {
  // Not a style objection. The desk's collections and the graph's are different
  // shapes with different invariants, and merging them by accident — because two
  // env vars happened to agree — would interleave a mutable member ledger with
  // append-only evidence in one namespace.
  log("error", "same_data_path", {
    path: deskPath,
    note: "YENTE_DATA_PATH and YENTE_GRAPH_DATA_PATH must differ. The desk's "
      + "ledger and the graph's evidence are separate datasets; one process can "
      + "own both, but they do not share a namespace.",
  });
  process.exit(1);
}

// Checked BEFORE the desk is built. Without a mailbox the desk's very first act
// is to dial IMAP on a default host and fail, once every interval, forever —
// which is noise that looks like a fault. No mailbox, no desk; the graph loops
// still run and can drain a backlog.
const mailConfigured = Boolean(process.env.YENTE_MAIL_HOST && process.env.YENTE_MAIL_USER);

let deskStore = null;
let graphStore = null;
try {
  graphStore = openDatabase(graphPath);
  if (on("YENTE_DESK") && mailConfigured) deskStore = openDatabase(deskPath);
} catch (error) {
  log("error", "store_open_failed", { error: String(error?.message ?? error) });
  process.exit(1);
}

const graph = createGraphRepositories(graphStore);

// A process that died mid-inference leaves jobs RUNNING and nothing else will
// ever move them — mail ingested, meaning silently lost.
const requeued = graph.jobs.requeueStranded(new Date().toISOString());
if (requeued > 0) log("warn", "requeued_stranded_jobs", { count: requeued });

/* --- the desk ---------------------------------------------------------- */

let desk = null;
let waitlist = null;
let transport = null;

/* --------------------------------------------------- the supervisor lanes */
//
// "Main thread connects to nedb and dispatches workers." This process is the
// supervisor: it alone holds the store locks, listens to mail, applies
// verified results, and runs matching (always on, nudged per understanding).
// The model work — reading documents, writing to people — runs on worker
// threads, one pool per seat, each sized by its own variable:
//
//   YENTE_INGEST_WORKERS  lanes reading evidence (the document seat)
//   YENTE_VOICE_WORKERS   lanes writing to people (the message seat)
//
// 0 (the default) keeps that seat in-process — same behaviour as before the
// supervisor existed, and the safe setting on a box that has not planned its
// GPU budget in lanes yet. 2/1, 1/2, 2/3: an env decision, not a deploy.
const laneCount = (name) => {
  const n = Number(process.env[name] ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const laneStream = (event, meta) => log(
  event?.phase === "rejected" ? "warn" : "info",
  "model_stream",
  { ...event, ...(meta?.evidence ? { evidence: meta.evidence } : {}) },
);
const ingestLaneCount = laneCount("YENTE_INGEST_WORKERS");
const voiceLaneCount = laneCount("YENTE_VOICE_WORKERS");
const ingestLanes = ingestLaneCount > 0
  ? createLanes({ size: ingestLaneCount, name: "ingest", log, onEvent: laneStream,
    workerData: { seat: "ingest", provider: process.env.YENTE_INTELLIGENCE_PROVIDER
      || process.env.YENTE_LLM_PROVIDER || "pin" } })
  : null;
const voiceLanes = voiceLaneCount > 0
  ? createLanes({ size: voiceLaneCount, name: "voice", log,
    workerData: { seat: "voice", provider: process.env.YENTE_INTELLIGENCE_PROVIDER
      || process.env.YENTE_LLM_PROVIDER || "pin" } })
  : null;

if (deskStore) {
  // WITHOUT THIS, EVERY ATTACHMENT IS UNREADABLE. The extractor registry starts
  // empty and parsers register themselves; production once had none at all, so
  // every file came back UNSUPPORTED_TYPE for support that already existed.
  const parserTypes = registerDocumentParsers();

  const repositories = createRepositories(deskStore);
  waitlist = openWaitlistRepository({ store: deskStore });

  // Reconcile the capacity ledger from durable inbound evidence on every boot.
  // Idempotent subscriber ids make this cheap: old messages claim any missing
  // seats once, already-counted senders are untouched, and a deploy does not
  // require people to email again just to move the website counter.
  let backfilledSeats = 0;
  for (const evidence of graph.evidence.all()) {
    if (evidence.kind !== "message") continue;
    try {
      const claimed = claimSeatFromInbound({ repository: waitlist, message: evidence.meta });
      if (claimed?.created) backfilledSeats += 1;
    } catch (error) {
      log("warn", "seat_claim_failed", {
        from: evidence.meta?.from,
        subject: evidence.meta?.subject,
        error: String(error?.message ?? error),
      });
    }
  }
  if (backfilledSeats > 0) log("info", "seats_backfilled", { count: backfilledSeats });

  // The desk sends mail but must NOT race the graph's LISTEN loop for the same
  // INBOX. The graph's MailSource owns the single IMAP read path with its
  // durable cursor; the desk consumes what the graph has already durably
  // recorded. Two separate IMAP connections to the same mailbox was the
  // resume-attachment bug: whichever loop fired first won the message and
  // the other never saw it. A resume that reached the desk got a letter
  // but never entered the graph as evidence; a resume that reached the
  // graph got understood but never got profile facts extracted or a reply.
  transport = null;
  try {
    transport = assertTransport(createMailTransport(mailConfigFromEnv()));
  } catch (error) {
    // The desk without a transport can still ingest, extract and match; it just
    // cannot send. That is a degraded desk, not a dead one, and it must not take
    // the listener down with it.
    log("error", "transport_failed", {
      error: String(error?.message ?? error),
      note: "the desk will ingest and match but cannot send; the listener is unaffected",
    });
  }

  if (transport) {
    const llm = createLlmClients({ log });
    // The desk's voice renders on the voice lanes when they exist — same
    // client contract, the completion just runs off the main thread.
    const deskEmailClient = voiceLanes
      ? pooledCompleter({ lanes: voiceLanes, baseClient: llm.emailClient })
      : llm.emailClient;
    const runtime = createRuntime({
      repositories,
      transport,
      extractionClient: llm.extractionClient,
      emailClient: deskEmailClient,
      graphEvidence: graph.evidence,
      // "yente should be able to report to a user what data yente has on
      // file for themselves" — the member's own graph card, handed to the
      // voice so every reply is grounded in their complete record.
      profileCardFor: (address) => {
        try {
          // The member's own file: deduped card, stats, proposals, match
          // counts — resolved through identity, so a folded alias still
          // finds its record.
          return renderFile(graph, subjectForAddress(address)) || null;
        } catch {
          return null;
        }
      },
    });
    desk = createDesk({
      store: deskStore, runtime, log, mode: "yente",
      // THE BRIDGE. When the desk qualifies a member — its whole policy:
      // documents read, facts verified, intent stated, profile confirmed back
      // to the person — the graph's lifecycle advances to QUALIFIED through
      // its legal transitions, and matching can finally see them. Intake is
      // autonomous per Mark's directive; the HITL stays where it belongs, on
      // the INTRODUCTION review queue, which every match still passes through.
      onQualified: (address) => {
        const subject = subjectForAddress(address);
        const order = ["received", "drafted", "awaiting_approval", "qualified"];
        let state = manager.profileStateOf(subject);
        // A person who DECLINED said no. The desk re-qualifying them on a new
        // document must not silently override that — consent comes back only
        // through the lifecycle's own door, not through this bridge.
        if (state === "declined") return;
        for (const next of order.slice(order.indexOf(state) + 1)) {
          manager.setProfileState({
            subject, state: next,
            quote: `desk qualification for ${address}`,
          });
          state = next;
        }
        log("info", "graph_qualified", { subject, via: "desk" });
        loops.nudgeConnect();   // a new candidate is exactly what connect waits for
      },
    });
    log("info", "desk", { parsers: parserTypes.length, llm: llm.describe?.provider ?? "?" });
  }
}

/* --- the interpreter --------------------------------------------------- */

const intelligenceConfig = resolveIntelligenceConfig();
const { provider: providerName } = intelligenceConfig;
// THE TWO SEATS, resolved inside createLlmClients: extractionClient runs
// YENTE_MODEL_DOCUMENT (ingestion — every observe job), emailClient runs
// YENTE_MODEL_MESSAGE (the voice — everything Yente writes to people).
// There is no per-evidence-kind model split; the split is by AUDIENCE.
const clients = createLlmClients({ provider: providerName, log });
// The voice, pooled onto the voice lanes when they exist. One client serves
// every place Yente speaks: desk replies AND graph introductions.
const voiceClient = voiceLanes
  ? pooledCompleter({ lanes: voiceLanes, baseClient: clients.emailClient })
  : clients.emailClient;
const localObserver = createIntelligenceProvider({
  client: clients.extractionClient,
  provider: providerName,
  model: clients.describe.model,
  // The terminal is the operator console. Show the stream here rather than
  // hiding it inside the HTTP adapter: reasoning proves liveness, content shows
  // the exact Sentinel text the parser will receive, and a rejection names the
  // internal retry that otherwise looks like one multi-minute hang.
  onStream: (event) => log(
    event.phase === "rejected" ? "warn" : "info",
    "model_stream",
    event,
  ),
});
// With ingest lanes, observe() crosses to a worker thread; the drain never
// learns the difference — same result shape, same error codes, and the
// stream telemetry above still arrives (forwarded across the boundary).
const observer = ingestLanes
  ? pooledObserver({ lanes: ingestLanes, describe: localObserver.describe })
  : localObserver;

// Read ONCE, here, and passed down. The previous version read this env var in
// the log line and again inside drainIntelligence — so the boot line reported
// intent while the drain used its own copy, and a setting that failed to take
// looked exactly like a setting that worked.
// With ingest lanes, the lanes ARE the concurrency: one observation per lane,
// which is the unit the GPU budget was planned in.
const concurrency = ingestLanes
  ? ingestLanes.size
  : Number(process.env.YENTE_INTELLIGENCE_CONCURRENCY || 3);

// Prompt v6 keeps quoted copies of Yente's prior email out of the model's
// analysis view while preserving the complete message in NEDB evidence. Requeue
// every DONE job produced by an older/unknown
// prompt exactly once; the finished job records this version so empty evidence
// does not loop forever.
// Jobs that finished with ZERO claims re-open once — see
// requeueEmptyUnderstandings for the night that made this necessary: a
// failing model consumed 27 messages producing nothing, and the work stayed
// sealed while its replacement would have read the same mail correctly.
// Historical standalone attachment jobs — the letter reads the document now,
// and a re-opened attachment job is a context-free double-read that wanders.
const retired = graph.jobs.retireAttachmentJobs(new Date().toISOString());
if (retired > 0) log("info", "attachment_jobs_retired", { jobs: retired });

const emptyRequeued = graph.jobs.requeueEmptyUnderstandings(new Date().toISOString());
if (emptyRequeued > 0) {
  log("info", "empty_understandings_requeued", { jobs: emptyRequeued });
}

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
  // From the CLIENT, not from the environment. `process.env.YENTE_MODEL || "..."`
  // prints the default when the var is unset, which is a guess about what the
  // provider chose rather than a report of it.
  model: clients.describe.model,
  concurrency,
  third_party: clients.describe.thirdParty,
});

// BOTH PARTIES SAY YES (default on): operator confirmation mails each party
// the other's evidenced profile card and waits for two legible approvals —
// the document model reads the replies. YENTE_PARTY_APPROVAL=0 restores the
// operator-only instant introduction.
const partyApproval = String(process.env.YENTE_PARTY_APPROVAL ?? "1") === "1";
const manager = createGraphManager({ graph, partyApproval });
const strandedIntroductions = graph.matches.requeueStrandedIntroductions(new Date().toISOString());
const strandedPreviews = graph.matches.releaseStrandedPartyPreviews();
if (strandedPreviews > 0) log("warn", "stranded_previews_released", { count: strandedPreviews });
if (strandedIntroductions > 0) {
  log("warn", "introductions_requeued", { count: strandedIntroductions });
}

/* --- the loops --------------------------------------------------------- */

let stopping = false;
const abort = new AbortController();

const { source, imap, mailbox, configured } = createMailFromEnv({ graph, log });

// BACKFILL: members the desk qualified BEFORE the bridge existed. The
// onQualified hook fires on the tick where qualification HAPPENS — members
// already QUALIFIED or ACTIVE in the desk store would otherwise stay
// unmatchable forever, which is the gate-with-no-writer bug reborn one layer
// up. Idempotent: setProfileState re-asserting a state is a legal no-op, and
// a DECLINED graph lifecycle is never overridden.
{
  const deskMembers = deskStore
    ? deskStore.query(`FROM ${COLLECTIONS.MEMBERS}`)
    : [];
  let bridged = 0;
  for (const member of deskMembers) {
    if (member.state !== "QUALIFIED" && member.state !== "ACTIVE") continue;
    const address = member.address ?? member.email ?? null;
    if (!address) continue;
    const subject = subjectForAddress(address);
    if (manager.profileStateOf(subject) === "qualified") continue;
    if (manager.profileStateOf(subject) === "declined") continue;
    const order = ["received", "drafted", "awaiting_approval", "qualified"];
    let state = manager.profileStateOf(subject);
    for (const next of order.slice(order.indexOf(state) + 1)) {
      manager.setProfileState({ subject, state: next, quote: `backfill: desk ${member.state} for ${address}` });
      state = next;
    }
    bridged += 1;
  }
  if (bridged > 0) log("info", "qualified_backfilled", { members: bridged });
}

const loops = createGraphLoops({
  graph, source, observer, manager, log, begin, end,
  emailClient: voiceClient,
  consentClient: clients.extractionClient,
  autoQualify: String(process.env.YENTE_AUTOQUALIFY ?? "1") === "1",
  signal: abort.signal,
  isStopping: () => stopping,
  concurrency,
  transport,
  onMessage: waitlist
    ? (message) => {
        const claimed = claimSeatFromInbound({ repository: waitlist, message });
        if (claimed?.created) {
          log("info", "seat_claimed", {
            email: claimed.subscriber.email,
            cohort: claimed.subscriber.cohort,
            remaining: claimed.capacity.cohorts[
              claimed.subscriber.cohort === "founder_developer"
                ? "foundersDevelopers" : "investorsEmployers"
            ].remaining,
          });
        }
      }
    : null,
});
const { health } = loops;

/**
 * The desk's own loop. Separate from the graph's because it is a TICK, not a
 * drain: it must never run two at once (a second ingest over the same unseen
 * mail is how a message gets processed twice), so it waits for itself and then
 * sleeps, rather than firing on an interval.
 */
const DESK_INTERVAL_MS = Number(process.env.YENTE_POLL_INTERVAL_MS || 30_000);
let ticking = false;

async function deskLoop() {
  if (!desk) return;
  while (!stopping) {
    ticking = true;
    begin("store", "desk:tick", "desk tick");
    try {
      const r = await desk.tick();
      if (r.ingested > 0 || r.sent > 0 || r.proposed > 0 || r.advanced > 0 || r.answered > 0) {
        log("info", "tick", r);
      }
    } catch (error) {
      // A failed tick must never end the loop. Mailbox down, TLS hiccup, one
      // malformed message: recorded, and the next tick runs.
      log("error", "tick_failed", { error: String(error?.message ?? error).slice(0, 300) });
    } finally {
      ticking = false;
      end("desk:tick");
    }
    await loops.sleep(DESK_INTERVAL_MS);
  }
}

/* --- one port, both surfaces ------------------------------------------- */

/**
 * TWO LISTENERS, ONE PROCESS — and the distinction matters.
 *
 * What was expensive about the split was never the ports; it was the two
 * PROCESSES, the two locks, and the two populations neither could see. Those are
 * gone. What remains is that the site and the manager each root their links,
 * forms and redirects at "/", so they are two URL spaces and cannot share one.
 * Mounting the manager under /manager would mean rewriting every href, every
 * form action and every 303 in it — a change with real breakage risk, for
 * nothing an operator would notice.
 *
 * So: the site answers on YENTE_PORT (nginx proxies this one), the manager on
 * YENTE_GRAPH_PORT, loopback by default because it is the surface that can act
 * on somebody's behalf. One thing to start, one thing to stop, one log.
 */
let siteServer = null;
let managerServer = null;

const bind = (server, port, host, onListen) => {
  server.listen(port, host, onListen);
  // A port already in use must not kill her. Mail and matching do not depend on
  // any web surface, and losing them because a stale process holds a port would
  // be a worse outage than losing a page.
  server.on("error", (error) => {
    log("error", "http_failed", {
      port,
      error: String(error?.message ?? error),
      note: "she keeps running without this surface",
    });
  });
};

if (on("YENTE_HTTP")) {
  const host = process.env.YENTE_HOST || "127.0.0.1";

  if (waitlist) {
    siteServer = createServer(createSiteHandler({
      repository: waitlist,
      adminUsername: process.env.YENTE_ADMIN_USERNAME,
      adminPassword: process.env.YENTE_ADMIN_PASSWORD,
      trustProxy: process.env.YENTE_TRUST_PROXY === "1",
      // The number the page has never been able to show: people whose own words
      // Yente has actually read, as opposed to seats somebody claimed. Both go
      // out; the front end decides which to lead with. Reporting only the
      // flattering one is the rounding-up this product refuses.
      graphStats: () => ({
        people: manager.subjects().length,
        observations: graph.observations.all().length,
        queued: graph.jobs.counts().READY ?? 0,
      }),
      // The resume directory: Yente's verified read of every resume, one
      // deduped card per resolved person, searchable — pure NEDB lookups
      // over the same graph the desk writes.
      directory: (query) => buildDirectory({ graph }, { query }),
    }));
    const port = Number(process.env.YENTE_PORT || 7688);
    bind(siteServer, port, host, () => {
      log("info", "http", { site: `http://${host}:${port}` });
    });
  }

  managerServer = createServer(async (req, res) => {
    try {
      const handled = await handleManagerRequest({
        req, res, manager, graph, health,
        onConfirmed: async () => {
          // A confirm click should act NOW, not a connect-interval later:
          // send the party previews (or, with approval off, the joint
          // introduction) in the same request's wake.
          await drainPartyConsent({
            graph, manager, transport, consentClient: clients.extractionClient, log,
          });
          await drainConfirmedIntroductions({
            graph, manager, transport, emailClient: voiceClient, log,
          });
        },
      });
      if (handled) return;
      const html = renderManager({
        manager, health, mailSilenceMinutes: loops.mailSilenceMinutes(),
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      log("error", "http_failed", { error: String(error?.message ?? error) });
      if (!res.headersSent) res.writeHead(500);
      res.end("error\n");
    }
  });
  const managerPort = Number(process.env.YENTE_GRAPH_PORT || 3767);
  bind(managerServer, managerPort, process.env.YENTE_GRAPH_HOST || "127.0.0.1", () => {
    log("info", "manager", {
      url: `http://${process.env.YENTE_GRAPH_HOST || "127.0.0.1"}:${managerPort}`,
      operator: manager.actor,
    });
  });
}

/* --- run --------------------------------------------------------------- */

log("info", "started", {
  data: `${deskStore ? deskPath + " + " : ""}${graphPath}`,
  mailbox: configured ? mailbox : "(none)",
  desk: Boolean(desk),
  jobs: JSON.stringify(graph.jobs.counts()),
  subjects: manager.subjects().length,
});

const heartbeatMs = Number(process.env.YENTE_HEARTBEAT_MS || 30_000);
const pulse = setInterval(() => {
  logger.heartbeat({
    graph, health, mailConfigured, concurrency,
    mailSilenceMinutes: loops.mailSilenceMinutes(),
  });
}, heartbeatMs);
pulse.unref();

const running = Promise.all([
  loops.listen(), loops.understand(), loops.connect(), deskLoop(),
]);

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(pulse);
  log("info", "shutting_down", { signal, mid_tick: ticking });

  // Stop accepting first, then flush. An accepted decision must not be written
  // to a closing store.
  await Promise.all([siteServer, managerServer]
    .filter(Boolean)
    .map((server) => new Promise((resolve) => server.close(resolve))));
  abort.abort();

  // The desk's tick gets a bounded chance to finish. Killing it between
  // recording a message and marking it \\Seen is how a message gets read twice.
  await Promise.race([running, loops.sleep(Number(process.env.YENTE_SHUTDOWN_MS || 15_000))]);
  if (ticking) log("error", "shutdown_timeout", { note: "desk tick still running" });

  await imap?.close().catch(() => {});
  await transport?.close?.().catch(() => {});
  // Lanes before stores: a worker mid-task holds no store handle (that is the
  // whole design), so terminating them cannot corrupt anything — but the
  // in-flight tasks reject as transient and their jobs stay READY for the
  // next boot.
  await ingestLanes?.shutdown().catch(() => {});
  await voiceLanes?.shutdown().catch(() => {});
  for (const store of openDatabases()) closeDatabase(store);
  log("info", "stopped", { ticks: JSON.stringify(health.ticks) });
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { error: String(reason).slice(0, 300) });
});
process.on("uncaughtException", (error) => {
  log("error", "uncaught_exception", { error: String(error?.message ?? error).slice(0, 300) });
});

await running;
