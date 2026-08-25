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

test("a failure returns the job to READY until attempts are exhausted", () => {
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  const retried = graph.jobs.fail("e1", { at: T0, error: new Error("gateway 503"), maxAttempts: 3 });
  assert.equal(retried.state, JOB_STATES.READY);
  assert.match(retried.lastError, /gateway 503/,
    "under lastError — the field the inspector reads, because a mismatch there hid an SMTP timeout for a day");

  graph.jobs.start("e1", T1); graph.jobs.fail("e1", { at: T1, error: "x", maxAttempts: 1 });
  assert.equal(graph.jobs.read?.("e1")?.state ?? graph.jobs.counts().FAILED, 1);
});

test("jobs stranded RUNNING by a crash are requeued on restart", () => {
  // Mail ingested, meaning lost, and nothing else would ever move them.
  const { graph } = fresh();
  graph.jobs.enqueue({ evidenceId: "e1", at: T0 });
  graph.jobs.start("e1", T0);
  assert.equal(graph.jobs.requeueStranded(T1), 1);
  assert.equal(graph.jobs.counts().READY, 1);
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
