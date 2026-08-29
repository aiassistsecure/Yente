/**
 * The graph, the queue, the matcher, and the human who outranks all three.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 *
 * Not "does the code run". Every case below is a specific way this system could
 * quietly become wrong, drawn from ways it already has been:
 *
 *   - a mutable current-value row silently discarding the second thing you learn
 *     (the old profile_views collapse)
 *   - a cursor rewinding and re-ingesting the same mail forever
 *   - a UID compared across a UIDVALIDITY change, which fails as an EMPTY
 *     mailbox rather than an error
 *   - a model run overriding a person's explicit correction because it happened
 *     to be newer
 *   - a match that is really just "both emails mentioned AI"
 *   - a crash mid-inference leaving mail ingested but meaningless
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import {
  createGraphRepositories, AUTHORITY, JOB_STATES, MATCH_STATES, MATCH_ORIGIN,
  matchPairKey,
} from "../src/store/graph.js";
import { createMailSource, normalizeMessage, contentHashOf } from "../src/mail/source.js";
import { observationsFrom, drainIntelligence } from "../src/intelligence/queue.js";
import { proposeIntroductions, explainIntroduction } from "../src/graph/matching.js";
import { createGraphManager, CORRECTION } from "../src/graph/manager.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { drainConfirmedIntroductions } from "../src/graph/introductions.js";

function fresh() {
  const store = openInMemory();
  return { store, graph: createGraphRepositories(store) };
}

const T0 = "2026-08-25T10:00:00.000Z";
const T1 = "2026-08-25T11:00:00.000Z";

/* --- evidence and observations ------------------------------------------ */

test("evidence is content-addressed, so re-ingesting writes no second row", () => {
  const { graph } = fresh();
  const first = graph.evidence.record({
    kind: "message", contentHash: "abc", text: "hello", receivedAt: T0,
  });
  const again = graph.evidence.record({
    kind: "message", contentHash: "abc", text: "hello", receivedAt: T1,
  });

  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true,
    "idempotency is a property of addressing, not of a guard we might forget");
  assert.equal(graph.evidence.all().length, 1,
    "startup reconciliation can enumerate durable inbox history");
});

test("observations append; the second thing you learn does not destroy the first", () => {
  // The exact failure of the old profile_views row: scalars were first-writer-
  // wins, so a person who was raising in August and hiring in December could
  // only ever be one of those.
  const { graph } = fresh();
  const common = { subject: "person:sarah@acme.com", evidenceId: "e1", quote: "q" };

  graph.observations.append({
    ...common, predicate: "intent:FUNDRAISING", object: "seed round", observedAt: T0,
  });
  graph.observations.append({
    ...common, predicate: "intent:HIRING", object: "backend engineer", observedAt: T1,
  });

  const history = graph.observations.forSubject("person:sarah@acme.com");
  assert.equal(history.length, 2, "both are historically true");
  const current = graph.observations.project("person:sarah@acme.com");
  assert.equal(current.length, 2, "and both are current — they are different predicates");
});

test("caused_by carries the evidence hash, so provenance is traversable", () => {
  const { graph } = fresh();
  const { observation } = graph.observations.append({
    subject: "person:a@b.c", predicate: "is_person", object: "A",
    evidenceId: "evidence-123", quote: "q", observedAt: T0,
  });
  // The engine traces `caused_by` and treats `_caused_by` as inert data. Getting
  // this name wrong is silent — the trace just stops.
  assert.deepEqual(observation.caused_by, ["evidence-123"]);
});

test("a user correction outranks a newer model claim", () => {
  // §19: "Never silently fight explicit user corrections with later AI guesses."
  // Enforced in the projection sort, not at each write site.
  const { graph } = fresh();
  const common = { subject: "person:x@y.z", predicate: "works_at", object: "org:acme" };

  graph.observations.append({
    ...common, evidenceId: "e1", quote: "user says so", observedAt: T0,
    authority: AUTHORITY.USER_CORRECTION, model: "human",
  });
  graph.observations.append({
    ...common, evidenceId: "e2", quote: "model says so", observedAt: T1,
    authority: AUTHORITY.MODEL_VERIFIED, model: "muse-local",
  });

  const [held] = graph.observations.project("person:x@y.z");
  assert.equal(held.authority, AUTHORITY.USER_CORRECTION,
    "the newer model claim must not win on recency");
  assert.equal(held.model, "human");
});

test("identical evidence and model produce one observation, not a duplicate per replay", () => {
  const { graph } = fresh();
  const claim = {
    subject: "person:a@b.c", predicate: "intent:HIRING", object: "engineer",
    evidenceId: "e1", quote: "hiring an engineer", observedAt: T0,
    model: "muse-local:latest", schemaVersion: "obs_v1",
  };
  assert.equal(graph.observations.append(claim).duplicate, false);
  assert.equal(graph.observations.append({ ...claim, observedAt: T1 }).duplicate, true,
    "a replay after a crash must cost nothing");
});

test("a new schema version lands BESIDE the old interpretation, not on top of it", () => {
  // This is what makes "re-analyse everything when Muse improves" a query
  // instead of a migration.
  const { graph } = fresh();
  const claim = {
    subject: "person:a@b.c", predicate: "intent:HIRING", object: "engineer",
    evidenceId: "e1", quote: "q", observedAt: T0, model: "muse-local:latest",
  };
  graph.observations.append({ ...claim, schemaVersion: "obs_v1" });
  graph.observations.append({ ...claim, schemaVersion: "obs_v2" });

  const rows = graph.observations.forSubject("person:a@b.c");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.schemaVersion).sort(), ["obs_v1", "obs_v2"]);
});

/* --- the mailbox cursor -------------------------------------------------- */

test("the cursor only moves forward", () => {
  // A retry or an out-of-order batch must not rewind it, or the same mail is
  // ingested forever.
  const { graph } = fresh();
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 7, lastUid: 100, at: T0 });
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 7, lastUid: 40, at: T1 });
  assert.equal(graph.cursors.read("INBOX").lastUid, 100);
});

test("a UIDVALIDITY change resets the UID rather than comparing across epochs", () => {
  // The dangerous one: a stored UID compared across a UIDVALIDITY change points
  // at a different message, and the failure looks like an empty mailbox.
  const { graph } = fresh();
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 7, lastUid: 100, at: T0 });
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 8, lastUid: 3, at: T1 });

  const held = graph.cursors.read("INBOX");
  assert.equal(held.uidValidity, 8);
  assert.equal(held.lastUid, 3, "the old 100 means nothing under the new epoch");
  assert.equal(held.resyncedAt, T1, "and the resync is recorded, not inferred");
});

test("fetchNew resyncs from zero on a UIDVALIDITY change and says so", async () => {
  const { graph } = fresh();
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 7, lastUid: 100, at: T0 });

  const asked = [];
  const warnings = [];
  const source = createMailSource({
    graph,
    cursors: graph.cursors,
    client: {
      async status() { return { uidValidity: 9 }; },
      async fetchSince(args) { asked.push(args); return []; },
    },
    log: (level, event, meta) => warnings.push({ level, event, meta }),
  });

  const out = await source.fetchNew();
  assert.equal(out.resynced, true);
  assert.equal(asked[0].sinceUid, 0, "start over — every stored UID is void");
  assert.equal(warnings[0].event, "mail_uidvalidity_changed");
  assert.equal(warnings[0].level, "warn", "silent would be the dangerous version");
});

test("fetchNew asks only for mail after the cursor", async () => {
  const { graph } = fresh();
  graph.cursors.advance({ mailbox: "INBOX", uidValidity: 7, lastUid: 42, at: T0 });

  const asked = [];
  const source = createMailSource({
    cursors: graph.cursors,
    client: {
      async status() { return { uidValidity: 7 }; },
      async fetchSince(args) { asked.push(args); return []; },
    },
  });

  await source.fetchNew();
  assert.equal(asked[0].sinceUid, 42);
});

test("a mailbox with no UIDVALIDITY is refused, not guessed at", async () => {
  const { graph } = fresh();
  const source = createMailSource({
    cursors: graph.cursors,
    client: { async status() { return {}; }, async fetchSince() { return []; } },
  });
  await assert.rejects(() => source.fetchNew(), /NO_UIDVALIDITY|meaningless/);
});

test("one unparseable message does not stop the batch", async () => {
  // §22: "One poisoned PDF must never stop mailbox ingestion."
  const { graph } = fresh();
  const logs = [];
  const source = createMailSource({
    cursors: graph.cursors,
    client: {
      async status() { return { uidValidity: 1 }; },
      async fetchSince() {
        return [
          { uid: 1, raw: "good" },
          { uid: 2, raw: "poison" },
          { uid: 3, raw: "also good" },
        ];
      },
    },
    parse: async (raw) => {
      if (raw === "poison") throw new Error("malformed MIME");
      return { messageId: `<${raw}@x>`, text: raw, from: "a@b.c" };
    },
    log: (level, event, meta) => logs.push({ event, meta }),
  });

  const { messages } = await source.fetchNew();
  assert.equal(messages.length, 2, "the survivors are kept");
  assert.equal(logs[0].event, "mail_parse_failed");
  assert.equal(logs[0].meta.uid, 2, "and the casualty is named");
});

test("a message with no Message-ID is kept, identified by content hash", () => {
  // The old adapter DISCARDED these to protect its dedupe key. Throwing away
  // evidence to protect a hash is the wrong trade.
  const normalized = normalizeMessage({
    uid: 5, raw: "raw bytes", parsed: { text: "hello", from: "a@b.c" }, receivedAt: T0,
  });
  assert.equal(normalized.identityKind, "content_hash");
  assert.equal(normalized.identity, contentHashOf("raw bytes"));
  assert.equal(normalized.rfcMessageId, null);
});

test("a Message-ID is preferred and its angle brackets are transport, not identity", () => {
  const normalized = normalizeMessage({
    uid: 5, raw: "x", parsed: { messageId: "<abc@host>", text: "hi" }, receivedAt: T0,
  });
  assert.equal(normalized.identityKind, "message_id");
  assert.equal(normalized.identity, "abc@host");
});

test("the message's own Date is carried, because 'last month' needs an anchor", () => {
  const normalized = normalizeMessage({
    uid: 1, raw: "x",
    parsed: { messageId: "<a@b>", date: "2026-08-20T09:00:00Z", text: "we closed last month" },
    receivedAt: T0,
  });
  assert.equal(normalized.sentAt, "2026-08-20T09:00:00.000Z");
});

/* --- the queue ----------------------------------------------------------- */

test("enqueueing the same evidence twice is one job", () => {
  const { graph } = fresh();
  assert.equal(graph.jobs.enqueue({ evidenceId: "e1", at: T0 }).duplicate, false);
  assert.equal(graph.jobs.enqueue({ evidenceId: "e1", at: T1 }).duplicate, true,
    "inference is the expensive part; a redelivery must not pay for it twice");
});

test("only one worker can claim a job", () => {
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  assert.ok(graph.jobs.start("e1", T0));
  assert.equal(graph.jobs.start("e1", T1), null, "the second claim finds it RUNNING");
});

test("a transient failure NEVER gives up, and backs off exponentially", () => {
  // Marking a gateway timeout FAILED after five tries throws away a real email's
  // meaning because the network had a bad afternoon. Transient failures retry
  // indefinitely; the delay grows and is STORED, so it survives a restart.
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });

  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    graph.jobs.start("e1", T0);
    const after = graph.jobs.fail("e1", { at: T0, error: new Error("gateway 503") });
    assert.equal(after.state, JOB_STATES.READY, `attempt ${i + 1} must stay retryable`);
    delays.push(after.retryInMs);
  }

  assert.match(graph.jobs.ready(10, T0).length === 0 ? "deferred" : "due", /deferred/,
    "and it is NOT due immediately — that is what stops a hot retry loop");
  assert.deepEqual(delays.slice(0, 4), [30_000, 60_000, 120_000, 240_000],
    "exponential");
  assert.equal(delays.at(-1), 3_600_000, "capped at an hour, so recovery is picked up within one");
});

test("the retry reason is stored where the inspector reads it", () => {
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  const after = graph.jobs.fail("e1", { at: T0, error: new Error("gateway 503") });
  // `lastError`, not `last_error`. A diagnostic that reads a different name than
  // the store writes is how an SMTP timeout stayed invisible for a day.
  assert.match(after.lastError, /gateway 503/);
  assert.equal(after.lastErrorAt, T0);
});

test("a deterministic failure stops immediately", () => {
  // Evidence with no text will not acquire any by being asked again.
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  const after = graph.jobs.fail("e1", {
    at: T0, error: "no extractable text", transient: false,
  });
  assert.equal(after.state, JOB_STATES.FAILED);
  assert.equal(after.availableAt, null);
});

test("a deferred job is invisible to ready() until it is due", () => {
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  graph.jobs.fail("e1", { at: T0, error: "boom" });

  assert.equal(graph.jobs.ready(10, T0).length, 0, "not due yet");
  // 30s later.
  const later = new Date(Date.parse(T0) + 31_000).toISOString();
  assert.equal(graph.jobs.ready(10, later).length, 1, "due now, and picked up");
});

test("backoff survives a restart, because it is a stored timestamp", () => {
  // A timer in a process that may not exist tomorrow is not a retry policy.
  const { store, graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  graph.jobs.fail("e1", { at: T0, error: "boom" });

  const reopened = createGraphRepositories(store);
  assert.equal(reopened.jobs.ready(10, T0).length, 0, "still deferred after a reopen");
  assert.ok(reopened.jobs.ready(10, new Date(Date.parse(T0) + 31_000).toISOString()).length === 1);
});

test("a job stranded by a crash is due immediately, not penalised with a backoff", () => {
  // A process that died mid-inference is not evidence that the work is failing.
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  graph.jobs.requeueStranded(T1);
  assert.equal(graph.jobs.ready(10, T1).length, 1);
});

test("jobs stranded RUNNING by a crash are requeued on restart", () => {
  // Mail ingested, meaning lost, and nothing else would ever move them.
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  assert.equal(graph.jobs.requeueStranded(T1), 1);
  assert.equal(graph.jobs.counts().READY, 1);
});

test("a prompt bump requeues each old completed job exactly once", () => {
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  graph.jobs.finish("e1", { at: T1, claims: 0, promptVersion: "obs_prompt_v3" });

  assert.equal(graph.jobs.requeueForPrompt("obs_prompt_v4", T1), 1);
  assert.equal(graph.jobs.counts().READY, 1);
  graph.jobs.start("e1", T1);
  graph.jobs.finish("e1", { at: T1, claims: 0, promptVersion: "obs_prompt_v4" });
  assert.equal(graph.jobs.requeueForPrompt("obs_prompt_v4", T1), 0,
    "an honest zero-claim message must not loop forever");
});

test("the drain writes observations and never lets one bad job stop the others", async () => {
  const { graph } = fresh();
  for (const id of ["e1", "e2", "e3"]) {
    graph.evidence.record({ kind: "message", contentHash: id, text: `text ${id}`, receivedAt: T0 });
    graph.jobs.enqueue({ evidenceId: `message:${id}`, at: T0 });
  }

  const observer = {
    describe: () => ({}),
    async observe({ sources }) {
      if (sources[0].id === "message:e2") throw new Error("upstream exploded");
      return {
        verified: {
          entities: [{
            ref: "p1", kind: "PERSON", name: "Sarah", emailAddress: "sarah@acme.com",
            title: null, evidence: "Sarah", confidence: 0.9, explicit: true,
            sourceId: sources[0].id,
          }],
          intents: [], relationships: [], opportunities: [], observations: [],
        },
        rejected: [], failures: [], cached: false, recovered: null,
        provenance: { model: "m", schemaVersion: "obs_v1", contentHash: "h", elapsedMs: 1 },
      };
    },
  };

  const summary = await drainIntelligence({
    graph, observer, concurrency: 2, now: () => T1,
  });

  assert.equal(summary.observed, 2, "two succeeded");
  assert.equal(summary.failed, 1, "one failed and was recorded");
  assert.equal(summary.claims, 2);
  assert.equal(graph.jobs.counts().READY, 1, "the failure is retryable, not lost");
});

test("the observer sees the current reply but not quoted Yente history", async () => {
  const { graph } = fresh();
  const text = [
    "From: founder@example.com",
    "To: yente@ccme.network",
    "",
    "I’m looking for investors.",
    "> On Aug 14, 2026, Yente <yente@ccme.network> wrote:",
    "> Role: Founder & Systems Architect",
    "> Works with: Rust, Python, TypeScript",
  ].join("\n");
  const evidence = graph.evidence.record({
    kind: "message", contentHash: "thread", text, receivedAt: T0,
  }).evidence;
  graph.jobs.enqueue({ evidenceId: evidence.id, at: T0 });
  let seen = null;
  const observer = {
    async observe({ sources }) {
      seen = sources[0].text;
      return {
        verified: { entities: [], intents: [], relationships: [], opportunities: [], observations: [] },
        rejected: [], cached: false, recovered: null,
        provenance: {
          model: "m", schemaVersion: "obs_v1", promptVersion: "obs_prompt_v6",
          contentHash: "h", elapsedMs: 1,
        },
      };
    },
  };
  await drainIntelligence({ graph, observer, now: () => T1 });
  assert.match(seen, /looking for investors/);
  assert.doesNotMatch(seen, /Role: Founder|Works with: Rust/,
    "Yente's prior summary is stored in evidence but never re-extracted as new truth");
  assert.match(graph.evidence.get(evidence.id).text, /Role: Founder/,
    "canonical NEDB evidence remains complete");
});

test("resume facts and full text land on the covering sender's manager profile", async () => {
  const { graph } = fresh();
  const parent = graph.evidence.record({
    kind: "message", contentHash: "cover", text: "From: dev@interchained.org\nResume attached",
    meta: { from: "dev@interchained.org" }, receivedAt: T0,
  }).evidence;
  const resume = graph.evidence.record({
    kind: "attachment", contentHash: "resume", receivedAt: T0,
    text: "Mark Evans\nSystems architect with ten years of infrastructure experience.",
    meta: { filename: "Mark_Evans_Resume.docx", messageEvidenceId: parent.id },
  }).evidence;
  // Deliberately old shape: no subjectHint on the job. The parent-message fallback
  // must repair attachments already stored before this field existed.
  graph.jobs.enqueue({ evidenceId: resume.id, subjectHint: null, at: T0 });

  const observer = {
    async observe() {
      return {
        verified: {
          entities: [{
            ref: "p1", kind: "PERSON", name: "Mark Evans", emailAddress: null,
            title: "Systems architect", evidence: "Mark Evans", confidence: 1,
            explicit: true, sourceId: resume.id,
          }],
          intents: [{
            actorRef: "p1", type: "OFFERING", object: "infrastructure experience",
            attributes: {}, evidence: "ten years of infrastructure experience",
            confidence: 1, explicit: true, sourceId: resume.id,
          }],
          relationships: [], opportunities: [], observations: [],
        },
        rejected: [], cached: false, recovered: null,
        provenance: {
          model: "muse-local:latest", schemaVersion: "obs_v1",
          promptVersion: "obs_prompt_v5", contentHash: "h", elapsedMs: 1,
        },
      };
    },
  };

  const summary = await drainIntelligence({ graph, observer, now: () => T1 });
  assert.equal(summary.claims, 3, "identity + intent + deterministic alias");
  const manager = createGraphManager({ graph });
  const profile = manager.subject("person:dev@interchained.org");
  assert.equal(profile.name, "Mark Evans");
  assert.equal(profile.intents[0].object, "infrastructure experience");
  assert.equal(profile.evidence[0].id, resume.id);
  assert.match(profile.evidence[0].text, /ten years of infrastructure experience/,
    "the complete extracted résumé text is available in the manager Documents view");
  assert.equal(manager.subject("person:name:mark evans").id, profile.id,
    "the old name-derived orphan resolves onto the sender's member identity");
});

test("evidence with no text fails permanently instead of retrying against nothing", async () => {
  const { graph } = fresh();
  graph.evidence.record({ kind: "message", contentHash: "e9", text: null, receivedAt: T0 });
  graph.jobs.enqueue({ evidenceId: "message:e9", at: T0 });

  const summary = await drainIntelligence({
    graph, observer: { async observe() { throw new Error("should not be called"); } },
    now: () => T1,
  });
  assert.equal(summary.failed, 1);
  assert.equal(graph.jobs.counts().FAILED, 1, "not READY — there is nothing to retry");
});

test("observationsFrom keys people by address, because a name is not an identity", () => {
  const claims = observationsFrom({
    verified: {
      entities: [
        { ref: "p1", kind: "PERSON", name: "Sarah Chen", emailAddress: "sarah@acme.com",
          title: "Founder", evidence: "Sarah Chen, Founder", confidence: 1 },
        { ref: "o1", kind: "ORGANIZATION", name: "Acme Systems", emailAddress: null,
          title: null, evidence: "Acme Systems", confidence: 1 },
      ],
      intents: [{
        actorRef: "p1", type: "HIRING", object: "backend engineer",
        attributes: { skills: ["Rust"] }, evidence: "hiring a backend engineer", confidence: 1,
      }],
      relationships: [], opportunities: [], observations: [],
    },
    evidenceId: "ev1",
    provenance: { model: "m", schemaVersion: "obs_v1", contentHash: "c" },
    observedAt: T1,
    sentAt: "2026-08-20T00:00:00.000Z",
  });

  const person = claims.find((c) => c.predicate === "is_person");
  assert.equal(person.subject, "person:sarah@acme.com");
  const intent = claims.find((c) => c.predicate === "intent:HIRING");
  assert.equal(intent.subject, "person:sarah@acme.com", "attached to the entity its ref named");
  assert.deepEqual(intent.attributes.skills, ["Rust"]);
  // validFrom comes from the message date, not from when we processed it.
  assert.equal(intent.validFrom, "2026-08-20T00:00:00.000Z");
  assert.equal(intent.observedAt, T1);
});

/* --- sender-anchored facts ------------------------------------------------ */

test("a nameless sender's intent lands on the transport-given subject", () => {
  // The redesign of 2026-08-28: identity from transport, attributes from the
  // model. The sender never stated a name, so there is no entity — and the
  // intent still reaches the graph, attached to the ref Yente supplied.
  const claims = observationsFrom({
    verified: {
      entities: [],
      intents: [{
        actorRef: "sender", type: "SEEKING", object: "confirmation of resume receipt",
        attributes: {}, evidence: "Did you get my resume?", confidence: 0.9,
      }],
      relationships: [], disclosures: [],
    },
    evidenceId: "ev-msg",
    provenance: { model: "m", schemaVersion: "obs_v2", contentHash: "c" },
    observedAt: T1,
    sentAt: "2026-08-28T00:00:00.000Z",
    senderSubject: "person:founders@vibecode-101.com",
  });

  const intent = claims.find((c) => c.predicate === "intent:SEEKING");
  assert.ok(intent, "the fact must reach the graph despite no entity being declared");
  assert.equal(intent.subject, "person:founders@vibecode-101.com");
});

test("without a sender subject, a 'sender' ref still attaches nothing", () => {
  // Back-compat and honesty: if Yente could not resolve who sent it, the
  // reserved ref maps to nobody, and the claim is dropped here the same way a
  // dangling ref always was — not attached to a guess.
  const claims = observationsFrom({
    verified: {
      entities: [],
      intents: [{
        actorRef: "sender", type: "SEEKING", object: "anything",
        attributes: {}, evidence: "quote", confidence: 0.9,
      }],
      relationships: [], disclosures: [],
    },
    evidenceId: "ev-msg",
    provenance: { model: "m", schemaVersion: "obs_v2", contentHash: "c" },
    observedAt: T1,
    sentAt: null,
  });
  assert.equal(claims.length, 0);
});

test("a model entity reusing the sender ref keys to the transport identity", () => {
  // The sender later states their name. The model may now declare a PERSON
  // reusing the reserved ref — the name becomes a fact — but the subject KEY
  // stays the transport identity, so the contact accumulates rather than
  // forking into a name-keyed twin.
  const claims = observationsFrom({
    verified: {
      entities: [{
        ref: "sender", kind: "PERSON", name: "Mark Evans",
        emailAddress: null, title: null,
        evidence: "I am Mark Evans", confidence: 0.95,
      }],
      intents: [], relationships: [], disclosures: [],
    },
    evidenceId: "ev-msg2",
    provenance: { model: "m", schemaVersion: "obs_v2", contentHash: "c" },
    observedAt: T1,
    sentAt: null,
    senderSubject: "person:founders@vibecode-101.com",
  });
  const person = claims.find((c) => c.predicate === "is_person");
  assert.equal(person.subject, "person:founders@vibecode-101.com",
    "transport identity wins the key; the stated name is the fact, not the key");
  assert.equal(person.object, "Mark Evans");
});

test("ingesting a message mints a deterministic contact for its sender", async () => {
  const { graph } = fresh();
  const source = {
    async fetchNew() {
      return {
        messages: [normalizeMessage({
          uid: 9, raw: "raw", receivedAt: T0,
          parsed: { messageId: "<mint@t>", text: "Did you get my resume?",
            from: "founders@vibecode-101.com" },
        })],
        uidValidity: 3, resynced: false,
      };
    },
    commit: () => {},
  };

  const { ingestMail } = await import("../src/graph/ingest.js");
  await ingestMail({ source, graph, now: () => T1 });

  const rows = graph.observations.forSubject("person:founders@vibecode-101.com");
  const contact = rows.find((r) => r.predicate === "email_address");
  assert.ok(contact, "the contact exists before any model has run");
  assert.equal(contact.object, "founders@vibecode-101.com");
  assert.equal(contact.authority, AUTHORITY.DETERMINISTIC);
  assert.match(contact.quote, /^From: /,
    "the quote is the message's own From line, findable in the evidence text");
});

/* --- matching ------------------------------------------------------------ */

const HIRING = {
  subject: "person:sarah@acme.com", predicate: "intent:HIRING",
  object: "backend engineer with Rust experience",
  attributes: { skills: ["Rust"] },
  quote: "I'm hiring a backend engineer with Rust experience", evidenceId: "ev1",
};
const OFFERING = {
  subject: "person:david@dev.io", predicate: "intent:OFFERING",
  object: "backend engineering, Rust and infrastructure",
  attributes: { skills: ["Rust"] },
  quote: "I specialise in Rust and infrastructure and I'm available this month",
  evidenceId: "ev2",
};

test("complementary intent across two people is a match, with both quotes", () => {
  const [match] = proposeIntroductions({ observations: [HIRING, OFFERING] });
  assert.ok(match, "a real pairing must be found");
  assert.equal(match.seeker, HIRING.subject);
  assert.equal(match.offerer, OFFERING.subject);
  assert.equal(match.matchType, "HIRING_x_OFFERING");
  assert.ok(match.confidence > 0.5);

  // §13: the user clicks Why? and gets evidence from BOTH sides.
  assert.equal(match.evidence.length, 2);
  assert.match(match.evidence[0].quote, /hiring a backend engineer/);
  assert.match(match.evidence[1].quote, /Rust and infrastructure/);
  assert.ok(match.reasons.some((r) => r.id === "attribute_match"),
    "the specifics agreeing is what separates this from a thematic match");
});

test("a subject is never introduced to itself", () => {
  // Two intents on one person is a profile, not a match — and without this a
  // single chatty sender generates a page of imaginary introductions.
  const matches = proposeIntroductions({
    observations: [HIRING, { ...OFFERING, subject: HIRING.subject }],
  });
  assert.equal(matches.length, 0);
});

test("'both mentioned AI' does not clear the bar, and the reason is recorded", () => {
  const vagueA = {
    subject: "person:a@x.com", predicate: "intent:SEEKING", object: "AI",
    attributes: {}, quote: "we are interested in AI", evidenceId: "e1",
  };
  const vagueB = {
    subject: "person:b@y.com", predicate: "intent:OFFERING", object: "consulting",
    attributes: {}, quote: "we offer consulting", evidenceId: "e2",
  };
  const matches = proposeIntroductions({ observations: [vagueA, vagueB], threshold: 0.5 });
  assert.equal(matches.length, 0, "predicate shape alone is not a match");

  // Below threshold, but the refusal is legible when the threshold is dropped.
  const [thin] = proposeIntroductions({ observations: [vagueA, vagueB], threshold: 0.1 });
  assert.ok(thin.conflicts.some((c) => c.id === "no_shared_specifics"));
});

test("non-complementary intents produce nothing whatever else they share", () => {
  const both = [
    { ...HIRING, predicate: "intent:HIRING" },
    { ...OFFERING, predicate: "intent:HIRING", subject: "person:other@z.com" },
  ];
  assert.equal(proposeIntroductions({ observations: both }).length, 0);
});

test("fundraising pairs with investing, and the explanation is built from the reasons", () => {
  const raising = {
    subject: "person:sarah@acme.com", predicate: "intent:FUNDRAISING",
    object: "seed round for infrastructure tooling", attributes: { stage: "seed" },
    quote: "we are raising a seed round", evidenceId: "e1",
  };
  const investing = {
    subject: "person:vc@fund.com", predicate: "intent:INVESTING",
    object: "seed stage infrastructure companies", attributes: { stage: "seed" },
    quote: "we invest at seed in infrastructure", evidenceId: "e2",
  };
  const [match] = proposeIntroductions({ observations: [raising, investing] });
  assert.equal(match.matchType, "FUNDRAISING_x_INVESTING");

  const sentence = explainIntroduction(match);
  assert.match(sentence, /seed/);
  assert.match(sentence, /confidence/);
  // Built from the reasons, so what a person reads cannot drift from what the
  // scorer decided.
  for (const reason of match.reasons) assert.ok(sentence.includes(reason.detail));
});

/* --- the manager: a person outranks the machine -------------------------- */

function seeded() {
  const { store, graph } = fresh();
  for (const claim of [HIRING, OFFERING]) {
    graph.observations.append({
      ...claim, observedAt: T0, model: "muse-local:latest", schemaVersion: "obs_v1",
    });
  }
  const manager = createGraphManager({ graph, actor: "mark", now: () => T1 });
  return { store, graph, manager };
}

test("the scorer's proposals land in the review queue, best first", () => {
  const { graph, manager } = seeded();
  for (const p of proposeIntroductions({ observations: graph.observations.all() })) {
    graph.matches.propose({ ...p, at: T0 });
  }
  const pending = manager.pendingMatches();
  assert.ok(pending.length >= 1);
  assert.equal(pending[0].state, MATCH_STATES.PROPOSED);
  assert.equal(pending[0].origin, MATCH_ORIGIN.SCORER);
  assert.equal(pending[0].thin, false, "this one has real specifics");
});

test("a decided match is never re-opened by a later scorer pass", () => {
  // The HITL contract. Without this, the review queue is a treadmill: say no,
  // and the next tick asks again forever.
  const { graph, manager } = seeded();
  const [proposal] = proposeIntroductions({ observations: graph.observations.all() });
  const { match } = graph.matches.propose({ ...proposal, at: T0 });
  const id = matchPairKey(match);

  manager.rejectMatch({ matchId: id, note: "he's already engaged elsewhere" });

  const again = graph.matches.propose({ ...proposal, at: T1 });
  assert.equal(again.decided, true);
  assert.equal(again.match.state, MATCH_STATES.REJECTED, "still rejected");
  assert.equal(manager.pendingMatches().length, 0, "and gone from the queue");
});

test("a human match is the same object with origin human, not a parallel table", () => {
  // One collection means one renderer, one explainer, one export. Three of those
  // would have drifted within a month.
  const { graph, manager } = seeded();
  const match = manager.createMatch({
    seeker: "person:sarah@acme.com",
    offerer: "person:david@dev.io",
    note: "met them both at the meetup, obvious pairing",
  });

  assert.equal(match.origin, MATCH_ORIGIN.HUMAN);
  assert.equal(match.confidence, 1);
  assert.equal(match.reasons[0].id, "curated");
  assert.match(match.reasons[0].detail, /meetup/);
  // And it still carries evidence from the graph, so a curated match is as
  // explainable as a scored one.
  assert.equal(match.evidence.length, 2);
  assert.match(match.evidence[0].quote, /hiring a backend engineer/);
  assert.equal(graph.matches.all().length, 1, "same collection as the scorer's");
});

test("a scorer pass cannot downgrade a human match to a machine one", () => {
  const { graph, manager } = seeded();
  manager.createMatch({
    seeker: "person:sarah@acme.com", offerer: "person:david@dev.io", matchType: "curated",
  });
  graph.matches.propose({
    seeker: "person:sarah@acme.com", offerer: "person:david@dev.io", matchType: "curated",
    confidence: 0.6, reasons: [], conflicts: [], evidence: [], at: T1,
  });
  assert.equal(graph.matches.all()[0].origin, MATCH_ORIGIN.HUMAN);
});

test("confirming and rejecting are recorded as decisions, with who and why", () => {
  const { graph, manager } = seeded();
  const [proposal] = proposeIntroductions({ observations: graph.observations.all() });
  const { match } = graph.matches.propose({ ...proposal, at: T0 });
  const id = matchPairKey(match);

  const confirmed = manager.confirmMatch({ matchId: id, note: "send it" });
  assert.equal(confirmed.state, MATCH_STATES.CONFIRMED);
  assert.equal(confirmed.decidedBy, "mark");

  const [decision] = graph.decisions.forTarget(id);
  assert.equal(decision.verdict, MATCH_STATES.CONFIRMED);
  assert.equal(decision.by, "mark");
  assert.equal(decision.detail.note, "send it");
});

test("a confirmed graph match sends one autonomous introduction and stops", async () => {
  const { graph, manager } = seeded();
  const [proposal] = proposeIntroductions({ observations: graph.observations.all() });
  const { match } = graph.matches.propose({ ...proposal, at: T0 });
  const id = matchPairKey(match);
  manager.confirmMatch({ matchId: id, note: "approved" });

  const transport = createMemoryTransport();
  const first = await drainConfirmedIntroductions({
    graph, manager, transport, now: () => T1,
  });
  const again = await drainConfirmedIntroductions({
    graph, manager, transport, now: () => T1,
  });

  assert.equal(first.sent, 1);
  assert.equal(again.sent, 0, "an introduced match is terminal and cannot send twice");
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0].to.sort(), ["david@dev.io", "sarah@acme.com"]);
  assert.match(transport.sent[0].text, /I’m stepping out/);
  assert.match(transport.sent[0].text, /— Yente/);
  assert.match(transport.sent[0].messageId, /^<yente-introduction-/);
  assert.equal(graph.matches.get(id).state, MATCH_STATES.INTRODUCED);
  assert.equal(manager.summary().matches.introduced, 1);
});

test("an interrupted introduction is requeued after restart", () => {
  const { graph, manager } = seeded();
  const [proposal] = proposeIntroductions({ observations: graph.observations.all() });
  const { match } = graph.matches.propose({ ...proposal, at: T0 });
  const id = matchPairKey(match);
  manager.confirmMatch({ matchId: id });
  graph.matches.claimIntroduction(id, T1);
  assert.equal(graph.matches.get(id).state, MATCH_STATES.INTRODUCTION_SENDING);
  assert.equal(graph.matches.requeueStrandedIntroductions(T1), 1);
  assert.equal(graph.matches.get(id).state, MATCH_STATES.CONFIRMED);
});

test("cannot introduce a subject to itself, even by hand", () => {
  const { manager } = seeded();
  assert.throws(() => manager.createMatch({
    seeker: "person:a@b.c", offerer: "person:a@b.c",
  }), /itself/);
});

test("'same person' is an append at user authority, not a destructive merge", () => {
  const { graph, manager } = seeded();
  manager.samePerson({
    subjectA: "person:sarah@acme.com",
    subjectB: "person:s.chen@gmail.com",
    note: "same signature block",
  });
  const [same] = graph.observations
    .project("person:sarah@acme.com")
    .filter((row) => row.predicate === "same_as");

  assert.equal(same.object, "person:s.chen@gmail.com");
  assert.equal(same.authority, AUTHORITY.USER_CORRECTION);
  // Reversible by asserting the opposite — no deleted state to reconstruct.
  manager.differentPeople({
    subjectA: "person:sarah@acme.com", subjectB: "person:s.chen@gmail.com",
  });
  assert.ok(graph.observations.project("person:sarah@acme.com")
    .some((row) => row.predicate === "not_same_as"));
});

test("a wrong claim is superseded, not deleted, and drops out of the current view", () => {
  const { graph, manager } = seeded();
  const target = graph.observations.forSubject("person:sarah@acme.com")
    .find((row) => row.predicate === "intent:HIRING");
  const targetId = target.id ?? target._id;

  manager.wrongClaim({ observationId: targetId, note: "that was her colleague, not her" });

  const current = graph.observations.project("person:sarah@acme.com");
  const live = current.find((row) => row.predicate === "intent:HIRING");
  assert.equal(live.attributes.retracted, true, "the retraction is what the view now shows");
  assert.equal(live.authority, AUTHORITY.USER_CORRECTION);
  // The wrong reading stays queryable — that is how we learn which model and
  // schema version misread which kind of sentence.
  assert.ok(graph.observations.forSubject("person:sarah@acme.com")
    .some((row) => (row.id ?? row._id) === targetId));
});

test("excluding a subject is visible and reversible, not a hidden filter", () => {
  const { manager } = seeded();
  assert.equal(manager.isEligible("person:sarah@acme.com"), true);
  manager.excludeSubject({ subject: "person:sarah@acme.com", note: "personal friend" });
  assert.equal(manager.isEligible("person:sarah@acme.com"), false);
});

test("the manager summarises the whole loop, so a person can see it moving", () => {
  const { graph, manager } = seeded();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  const [proposal] = proposeIntroductions({ observations: graph.observations.all() });
  graph.matches.propose({ ...proposal, at: T0 });

  const summary = manager.summary();
  assert.equal(summary.subjects, 2);
  assert.ok(summary.observations >= 2);
  assert.equal(summary.jobs.READY, 1);
  assert.equal(summary.matches.proposed, 1);
});

test("subjects lists people and organisations with their claim counts", () => {
  const { graph, manager } = seeded();
  graph.observations.append({
    subject: "org:acme", predicate: "is_organization", object: "Acme Systems",
    evidenceId: "ev1", quote: "Acme Systems", observedAt: T0,
  });
  const rows = manager.subjects();
  const org = rows.find((r) => r.id === "org:acme");
  assert.equal(org.kind, "organization");
  assert.equal(org.name, "Acme Systems");
});

/* --- ingest: the order of operations is the design ----------------------- */

test("the cursor advances only AFTER evidence is durably recorded", async () => {
  // Advance first and a crash between the two permanently skips that mail —
  // never fetched again, and nothing anywhere says so.
  const { graph } = fresh();
  const order = [];

  const source = {
    async fetchNew() {
      return {
        messages: [normalizeMessage({
          uid: 7, raw: "raw", receivedAt: T0,
          parsed: { messageId: "<a@b>", text: "hello", from: "a@b.c" },
        })],
        uidValidity: 3, resynced: false,
      };
    },
    commit(args) { order.push(`commit:${args.lastUid}`); return args; },
  };

  const spy = graph.evidence.record.bind(graph.evidence);
  graph.evidence.record = (args) => { order.push("record"); return spy(args); };

  const { ingestMail } = await import("../src/graph/ingest.js");
  await ingestMail({ source, graph, now: () => T1 });

  assert.deepEqual(order, ["record", "commit:7"], "record, then commit — never the reverse");
});

test("a redelivered message records no new evidence and enqueues no second job", async () => {
  const { graph } = fresh();
  const message = normalizeMessage({
    uid: 7, raw: "raw bytes", receivedAt: T0,
    parsed: { messageId: "<a@b>", text: "hello", from: "a@b.c" },
  });
  const source = {
    async fetchNew() { return { messages: [message], uidValidity: 3, resynced: false }; },
    commit: () => {},
  };

  const { ingestMail } = await import("../src/graph/ingest.js");
  const first = await ingestMail({ source, graph, now: () => T1 });
  const again = await ingestMail({ source, graph, now: () => T1 });

  assert.equal(first.recorded, 1);
  assert.equal(first.enqueued, 1);
  assert.equal(again.recorded, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(again.enqueued, 0, "inference is the expensive part; never pay twice");
  assert.equal(graph.jobs.counts().READY, 1);
});

test("a new inbound message triggers seat accounting once, after durable evidence", async () => {
  const { graph } = fresh();
  const order = [];
  const message = normalizeMessage({
    uid: 9, raw: "resume mail", receivedAt: T0,
    parsed: {
      messageId: "<resume@b>", text: "attached", from: "founder@example.com",
      subject: "Founding seat — developer / founder",
    },
  });
  const source = {
    async fetchNew() { return { messages: [message], uidValidity: 3, resynced: false }; },
    commit: () => { order.push("commit"); },
  };
  const original = graph.evidence.record.bind(graph.evidence);
  graph.evidence.record = (args) => { order.push("evidence"); return original(args); };

  const { ingestMail } = await import("../src/graph/ingest.js");
  const onMessage = async () => { order.push("seat"); };
  await ingestMail({ source, graph, now: () => T1, onMessage });
  await ingestMail({ source, graph, now: () => T1, onMessage });

  assert.deepEqual(order, ["evidence", "seat", "commit", "evidence", "commit"],
    "seat is claimed after evidence and not again for duplicate mail");
});

test("the source text a quote is checked against includes the headers", async () => {
  // If the subject lived outside this string, an honest claim citing the subject
  // would fail grounding and be discarded as an invention.
  const { buildSourceText } = await import("../src/graph/ingest.js");
  const text = buildSourceText({
    from: "sarah@acme.com", to: ["mark@ccme.network"],
    subject: "Hiring a Rust engineer", sentAt: "2026-08-20T00:00:00.000Z",
    text: "We closed our seed round last month.",
  });
  assert.match(text, /Subject: Hiring a Rust engineer/);
  assert.match(text, /We closed our seed round last month\./);
  assert.match(text, /Date: 2026-08-20/);
});

/* --- attachments: untrusted files, isolated ------------------------------ */

test("the worker extracts text and refuses executables and macros by name", async () => {
  // Refused BY NAME rather than falling through to "unsupported", so the log
  // says something true about what arrived.
  const { extractDocument } = await import("../src/graph/documents.js");

  const ok = await extractDocument({
    filename: "notes.txt", mimeType: "text/plain",
    content: Buffer.from("Sarah Chen, Founder, Acme Systems."),
  });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /Sarah Chen/);

  for (const filename of ["invoice.exe", "payroll.xlsm", "archive.zip", "run.sh"]) {
    const refused = await extractDocument({
      filename, mimeType: "application/octet-stream", content: Buffer.from("MZ"),
    });
    assert.equal(refused.ok, false, `${filename} must be refused`);
    assert.match(refused.error, /executable, macro-enabled or archive/);
  }
});

test("a csv keeps its rows, and structure is reported", async () => {
  const { extractDocument } = await import("../src/graph/documents.js");
  const out = await extractDocument({
    filename: "leads.csv", mimeType: "text/csv",
    content: Buffer.from("name,role\nAlice,CTO\nBob,CEO"),
  });
  assert.equal(out.ok, true);
  assert.match(out.text, /Alice \| CTO/);
  assert.equal(out.structure.rows, 3);
});

test("a worker that cannot run reports it as data rather than throwing", async () => {
  // §22 again: the caller must have nothing to catch, or one poisoned file stops
  // ingestion.
  const { extractDocument } = await import("../src/graph/documents.js");
  const out = await extractDocument({
    filename: "x.txt", mimeType: "text/plain", content: Buffer.from("hi"),
    python: "/nonexistent/python",
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /cannot start worker|failed to run/);
});

test("an attachment becomes its own evidence, read by the LETTER's job", async () => {
  const { ingestAttachments } = await import("../src/graph/documents.js");
  const { graph } = fresh();

  const summary = await ingestAttachments({
    attachments: [{ filename: "deck.pdf", mimeType: "application/pdf", content: Buffer.from("x") }],
    graph,
    messageEvidenceId: "message:abc",
    subjectHint: "person:founder@example.com",
    receivedAt: T0,
    sentAt: "2026-08-20T00:00:00.000Z",
    now: () => T1,
    // Injected, so the test does not fork Python.
    extract: async () => ({
      ok: true, filename: "deck.pdf", contentHash: "doc-hash", mime_type: "application/pdf",
      text: "[[page 3]]\nWe are raising a seed round.", bytes: 1,
      structure: { pages: 4 }, truncated: false,
    }),
  });

  assert.equal(summary.extracted, 1);
  // NO separate inference job: the covering message's job carries this
  // attachment as an additional SOURCE block — the model reads the whole
  // letter, and a second job would pay for the same comprehension twice.
  // Claims quoting page 3 still cite THIS evidence id; only the prompt is
  // assembled whole.
  assert.equal(summary.enqueued, 0, "comprehension is per-letter; provenance stays per-document");
  const evidence = graph.evidence.get("attachment:doc-hash");
  assert.equal(evidence.kind, "attachment");
  assert.equal(evidence.meta.messageEvidenceId, "message:abc",
    "EMAIL -has_attachment-> DOCUMENT is recorded");
  assert.equal(evidence.meta.subjectHint, "person:founder@example.com");
  assert.equal(graph.jobs.ready().length, 0,
    "no attachment job exists to carry an owner — the letter's message job does");
  assert.match(evidence.text, /\[\[page 3\]\]/,
    "the page marker lives in the text a quote is checked against, so 'page 3' can ground");
});

test("a refused attachment is counted and named, never silently dropped", async () => {
  const { ingestAttachments } = await import("../src/graph/documents.js");
  const { graph } = fresh();
  const logs = [];

  const summary = await ingestAttachments({
    attachments: [{ filename: "virus.exe", mimeType: "application/octet-stream", content: Buffer.from("MZ") }],
    graph, messageEvidenceId: "message:abc", receivedAt: T0,
    log: (level, event, meta) => logs.push({ event, meta }),
    extract: async () => ({ ok: false, filename: "virus.exe", error: "refused by type (.exe)" }),
  });

  assert.equal(summary.refused, 1);
  assert.equal(summary.extracted, 0);
  assert.equal(logs[0].event, "attachment_refused");
  assert.equal(logs[0].meta.filename, "virus.exe");
  assert.equal(graph.jobs.counts().READY, 0, "nothing to interpret");
});

/* --- identity resolution: refusing to guess ------------------------------ */

test("gmail dots and plus tags are the same address; other providers are not", async () => {
  const { normalizeAddress } = await import("../src/graph/identity.js");
  assert.equal(normalizeAddress("Alice.Smith+yente@Gmail.com"), "alicesmith@gmail.com");
  // Documented provider behaviour, not a guess about humans — and it does NOT
  // generalise, because dots are significant almost everywhere else.
  assert.equal(normalizeAddress("alice.smith@acme.com"), "alice.smith@acme.com");
});

test("name similarity NEVER merges", async () => {
  // The single most tempting signal, and worth nothing: "Sarah Chen" is three
  // different people across three mailboxes and the graph cannot tell which.
  const { buildIdentityIndex } = await import("../src/graph/identity.js");
  const index = buildIdentityIndex([
    { subject: "person:sarah@acme.com", predicate: "is_person", object: "Sarah Chen" },
    { subject: "person:sarah@other.com", predicate: "is_person", object: "Sarah Chen" },
  ]);
  assert.notEqual(index.canonical("person:sarah@acme.com"),
    index.canonical("person:sarah@other.com"));
});

test("same_as merges, and the canonical root is stable across runs", async () => {
  const { buildIdentityIndex } = await import("../src/graph/identity.js");
  const rows = [
    { subject: "person:sarah@acme.com", predicate: "same_as", object: "person:s.chen@gmail.com" },
  ];
  const index = buildIdentityIndex(rows);
  assert.equal(index.canonical("person:s.chen@gmail.com"), index.canonical("person:sarah@acme.com"));

  // Stable, because the canonical id appears in URLs and in match records — a
  // root that moved between restarts would break both.
  const reversed = buildIdentityIndex([...rows].reverse());
  assert.equal(index.canonical("person:sarah@acme.com"), reversed.canonical("person:sarah@acme.com"));
});

test("not_same_as blocks a merge whichever order the claims arrived in", async () => {
  const { buildIdentityIndex } = await import("../src/graph/identity.js");
  for (const rows of [
    [
      { subject: "person:a@x.com", predicate: "same_as", object: "person:b@y.com" },
      { subject: "person:a@x.com", predicate: "not_same_as", object: "person:b@y.com" },
    ],
    [
      { subject: "person:a@x.com", predicate: "not_same_as", object: "person:b@y.com" },
      { subject: "person:a@x.com", predicate: "same_as", object: "person:b@y.com" },
    ],
  ]) {
    const index = buildIdentityIndex(rows);
    assert.notEqual(index.canonical("person:a@x.com"), index.canonical("person:b@y.com"),
      "a person saying 'different people' told us something we cannot infer");
  }
});

test("resolving rewrites the view, never the stored claim", async () => {
  const { resolveObservations } = await import("../src/graph/identity.js");
  const rows = [
    { subject: "person:sarah@acme.com", predicate: "same_as", object: "person:s@gmail.com" },
    { subject: "person:s@gmail.com", predicate: "intent:HIRING", object: "engineer" },
  ];
  const resolved = resolveObservations(rows);
  const intent = resolved.find((r) => r.predicate === "intent:HIRING");

  // The canonical id is the lexicographically smaller of the merged set —
  // "person:s@gmail.com" sorts before "person:sarah@acme.com" because '@' (0x40)
  // precedes 'a'. WHICH one wins does not matter; that it is STABLE does, since
  // the canonical id appears in URLs and in match records.
  assert.equal(intent.subject, "person:s@gmail.com");
  assert.equal(intent.originalSubject, undefined,
    "this row already carried the canonical id, so nothing was rewritten");

  const merged = resolved.find((r) => r.predicate === "same_as");
  assert.equal(merged.subject, "person:s@gmail.com");
  assert.equal(merged.originalSubject, "person:sarah@acme.com",
    "which alias it arrived under stays visible — a merge you cannot audit is one you must trust");
  assert.equal(rows[0].subject, "person:sarah@acme.com", "the stored row is untouched");
});

test("a signature block is proposed, never applied", async () => {
  const { proposeIdentityMerges } = await import("../src/graph/identity.js");
  const candidates = proposeIdentityMerges({
    observations: [],
    evidenceById: {
      "message:1": {
        meta: { from: "sarah@acme.com" },
        text: "Thanks!\n--\nSarah Chen\npersonal: s.chen@gmail.com",
      },
    },
    existingSubjects: ["person:sarah@acme.com", "person:s.chen@gmail.com"],
  });

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].quote && candidates[0].quote.includes("s.chen@gmail.com"),
    `expected the signature line, got ${JSON.stringify(candidates[0].quote)}`);
  // Named for what it is: this rule cannot tell a signature block from a
  // forwarded introduction, which is exactly why it proposes.
  assert.match(candidates[0].caution, /shared inbox|forwarded/);
});

test("a merge already ruled out is not proposed again", async () => {
  const { proposeIdentityMerges } = await import("../src/graph/identity.js");
  const candidates = proposeIdentityMerges({
    observations: [{
      subject: "person:sarah@acme.com", predicate: "not_same_as",
      object: "person:s.chen@gmail.com",
    }],
    evidenceById: {
      "message:1": {
        meta: { from: "sarah@acme.com" },
        text: "cc s.chen@gmail.com",
      },
    },
    existingSubjects: ["person:sarah@acme.com", "person:s.chen@gmail.com"],
  });
  assert.equal(candidates.length, 0, "asking twice is the treadmill again");
});

/* --- profiles ------------------------------------------------------------ */

test("a profile carries claims that arrived under an alias", () => {
  const { graph } = fresh();
  graph.evidence.record({ kind: "message", contentHash: "m1", text: "hi", receivedAt: T0 });
  graph.observations.append({
    subject: "person:sarah@acme.com", predicate: "is_person", object: "Sarah Chen",
    attributes: { title: "Founder" }, evidenceId: "message:m1", quote: "Sarah Chen, Founder",
    observedAt: T0,
  });
  graph.observations.append({
    subject: "person:sarah@acme.com", predicate: "same_as", object: "person:s@gmail.com",
    evidenceId: null, quote: "asserted", observedAt: T0, authority: AUTHORITY.USER_CORRECTION,
  });
  graph.observations.append({
    subject: "person:s@gmail.com", predicate: "intent:HIRING", object: "backend engineer",
    evidenceId: "message:m1", quote: "hiring a backend engineer", observedAt: T1,
  });

  const manager = createGraphManager({ graph, actor: "mark", now: () => T1 });
  const profile = manager.subject("person:s@gmail.com");

  // Canonical is the lexicographically smaller id, and both addresses resolve to
  // the same profile whichever one you ask for — that is the property that
  // matters, not which string wins.
  assert.equal(profile.id, "person:s@gmail.com", "one profile, one canonical id");
  assert.equal(manager.subject("person:sarah@acme.com").id, profile.id,
    "asking by either address reaches the same profile");
  assert.deepEqual(profile.aliases, ["person:sarah@acme.com"]);
  assert.equal(profile.name, "Sarah Chen");
  assert.equal(profile.title, "Founder");
  assert.equal(profile.intents.length, 1, "the aliased claim appears on the profile that owns it");
  assert.equal(profile.evidence.length, 1, "and the message it came from is listed");
});

test("the relationship signal is labelled as calculated, not asserted", () => {
  // §14: "Do not pretend this is psychological truth."
  const { graph } = fresh();
  const manager = createGraphManager({ graph, actor: "mark" });
  const signal = manager.relationshipSignal([
    { evidenceId: "e1", observedAt: T0 }, { evidenceId: "e2", observedAt: T1 },
  ]);
  assert.equal(signal.inputs.distinctEvidence, 2);
  assert.match(signal.label, /calculated signal, not a fact/);
});

test("a retracted claim disappears from the profile but not from history", () => {
  const { graph } = fresh();
  graph.observations.append({
    subject: "person:a@b.c", predicate: "intent:HIRING", object: "engineer",
    evidenceId: "e1", quote: "hiring an engineer", observedAt: T0,
  });
  const manager = createGraphManager({ graph, actor: "mark", now: () => T1 });
  const stored = graph.observations.forSubject("person:a@b.c")[0];

  manager.wrongClaim({ observationId: stored.id ?? stored._id, note: "that was a colleague" });

  const profile = manager.subject("person:a@b.c");
  assert.equal(profile.intents.length, 0, "gone from what Yente believes");
  assert.ok(profile.history.length >= 2, "and still in the record of what it thought");
});
