/**
 * These run against a real embedded NEDB engine — the in-memory constructor,
 * which is the same v2 DAG code as the durable path with the disk turned off.
 * Not a fake, not a mock. A repository test against a stub proves the stub.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_PURPOSES,
  activate,
  beginIntake,
  beginInterview,
  beginSend,
  createMember,
  enqueueEmail,
  markFailed,
  markQualified,
  markSent,
  stopMember,
} from "../src/index.js";
import { COLLECTIONS, openInMemory, quote } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { outboxKeyFor } from "../src/store/keys.js";

const T0 = "2026-08-12T12:00:00.000Z";

function repos() {
  return createRepositories(openInMemory());
}

function member(address = "alice@example.com") {
  let m = createMember({
    memberId: `member_${address}`,
    address,
    inboundEstablishedAt: T0,
    createdAt: T0,
  });
  m = beginIntake(m, T0);
  m = beginInterview(m, T0);
  m = markQualified(m, {
    qualification: { policyId: "employment", policyVersion: 3, qualified: true },
    at: T0,
  });
  return activate(m, T0);
}

function job(overrides = {}) {
  return enqueueEmail({
    jobId: "job_1",
    idempotencyKey: outboxKeyFor.privateMatchPreview("match_1", "bob"),
    purpose: OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW,
    recipients: ["bob@example.com"],
    enqueuedAt: T0,
    backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 3 },
    ...overrides,
  });
}

test("a duplicate RFC Message-ID changes state exactly once — D1", () => {
  const { messages, store } = repos();
  const first = messages.recordInbound({ rfcMessageId: "<abc@host>", from: "bob@example.com", receivedAt: T0 });
  const seqAfterFirst = store.seq();

  const second = messages.recordInbound({ rfcMessageId: "abc@host", from: "bob@example.com", receivedAt: T0 });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.message._hash, first.message._hash);
  assert.equal(store.seq(), seqAfterFirst, "a redelivery must not append a new version");
});

test("one human is one member row, whatever they typed", () => {
  const { members } = repos();
  members.save(member("Alice@Example.COM"));
  const found = members.findByAddress("alice@example.com");
  assert.ok(found);
  assert.equal(found.address, "alice@example.com");
  assert.equal(members.findByAddress("ALICE@example.com")._id, found._id);
});

test("a resent resume is the same source; the same deck from two people is two", () => {
  const { sources } = repos();
  const bytes = "Led infrastructure operations for a fleet of 400 machines.";
  const a = sources.save({ memberId: "bob", content: bytes, receivedAt: T0 });
  const b = sources.save({ memberId: "bob", content: bytes, receivedAt: "2026-08-13T12:00:00.000Z" });
  const c = sources.save({ memberId: "alice", content: bytes, receivedAt: T0 });

  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.source._hash, a.source._hash);
  assert.equal(c.duplicate, false);
  assert.notEqual(c.source._id, a.source._id);
});

test("enqueueing one intended email twice yields one job — INV-10, durably", () => {
  const { outbox } = repos();
  const first = outbox.enqueue(job());
  const second = outbox.enqueue(job({ jobId: "job_2" }));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.job.jobId, "job_1", "the second enqueue did not overwrite the first");
});

test("a stale in-memory copy cannot overwrite a delivered job", () => {
  // The domain machine guards a job held in memory. The repository has to guard
  // it again: a worker that read the row before another path advanced it would
  // otherwise write the old state back over the new one. Same invariant,
  // different failure mode.
  const { outbox } = repos();
  const pending = outbox.enqueue(job()).job;
  const sent = markSent(beginSend(job(), T0), { messageId: "<sent@yente>", sentAt: T0 });
  outbox.save(sent);

  assert.throws(() => outbox.save(pending), /Refusing to move job .* out of SENT/);

  const impostor = { ...sent, messageId: "<other@yente>" };
  assert.throws(() => outbox.save(impostor), /refusing to record/);

  // Replaying the identical success is fine — that is what a resumed worker does.
  assert.equal(outbox.save(sent).messageId, "<sent@yente>");
});

test("claimable respects both state and the backoff deadline", () => {
  const { outbox } = repos();
  outbox.enqueue(job());
  const retrying = markFailed(beginSend(job({ idempotencyKey: "k_retry" }), T0), {
    at: T0,
    error: "421 try again",
    random: () => 1,
  });
  outbox.enqueue(retrying);
  outbox.save(retrying);
  outbox.enqueue(job({ idempotencyKey: "k_sent" }));
  outbox.save(markSent(beginSend(job({ idempotencyKey: "k_sent" }), T0), { messageId: "<s@y>", sentAt: T0 }));

  const early = outbox.claimable(T0).map((j) => j.idempotencyKey);
  assert.ok(early.includes(outboxKeyFor.privateMatchPreview("match_1", "bob")));
  assert.ok(!early.includes("k_retry"), "not due until its backoff elapses");
  assert.ok(!early.includes("k_sent"), "a delivered job is never claimable");

  const later = outbox.claimable("2026-08-12T12:00:01.000Z").map((j) => j.idempotencyKey);
  assert.ok(later.includes("k_retry"));
});

test("stalled jobs are findable after a crash — D7", () => {
  const { outbox } = repos();
  outbox.enqueue(job());
  outbox.save(beginSend(job(), T0));
  const stalled = outbox.stalled();
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].state, "SENDING");
});

test("every address ever invited is recoverable — §5.4's lifetime check", () => {
  const { outbox } = repos();
  outbox.enqueue(
    enqueueEmail({
      jobId: "job_inv",
      idempotencyKey: outboxKeyFor.enrollmentInvitation("stranger@example.com"),
      purpose: OUTBOUND_PURPOSES.ENROLLMENT_INVITATION,
      recipients: ["stranger@example.com"],
      headers: {
        "List-Unsubscribe": "<mailto:u@ccme.network>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      enqueuedAt: T0,
    }),
  );
  const invited = outbox.invitedAddresses();
  assert.equal(invited.has("stranger@example.com"), true);
  assert.equal(invited.has("someone.else@example.com"), false);
});

test("suppressed addresses are readable from the store — INV-9", () => {
  const { members } = repos();
  members.save(member("alice@example.com"));
  members.save(stopMember(member("bob@example.com"), T0));
  assert.deepEqual(members.suppressedAddresses(), ["bob@example.com"]);
});

test("an introduction traces back to the members and the messages that permitted it", () => {
  // §12: "A completed introduction must trace to the match policy, both
  // profiles, their evidence, and the inbound relationships that permitted
  // outbound." This is that chain, end to end, on a real engine.
  const { messages, members, matches, introductions, store } = repos();

  const inboundAlice = messages.recordInbound({ rfcMessageId: "<a1@host>", from: "alice@example.com", receivedAt: T0 }).message;
  const inboundBob = messages.recordInbound({ rfcMessageId: "<b1@host>", from: "bob@example.com", receivedAt: T0 }).message;

  const alice = members.save(member("alice@example.com"), { causedBy: [inboundAlice] });
  const bob = members.save(member("bob@example.com"), { causedBy: [inboundBob] });

  const match = matches.save(
    { matchId: "match_1", state: "READY_TO_INTRODUCE" },
    { policyId: "employment", policyVersion: 3, memberIds: ["alice", "bob"], cycle: 1, causedBy: [alice, bob] },
  );

  introductions.save(
    { matchId: match._id, messageId: "<intro@yente>", sentAt: T0 },
    { causedBy: [match] },
  );

  const chain = introductions.receipt(match._id);
  const hashes = new Set(chain.map((row) => row._hash));

  assert.ok(hashes.has(match._hash), "the match that authorised it");
  assert.ok(hashes.has(alice._hash), "both members");
  assert.ok(hashes.has(bob._hash));
  assert.ok(hashes.has(inboundAlice._hash), "and the inbound messages that permitted outbound");
  assert.ok(hashes.has(inboundBob._hash));
  assert.equal(store.verify(), true);
});

test("history survives a state transition — the record is versioned, not overwritten", () => {
  const { outbox, store } = repos();
  const pending = outbox.enqueue(job()).job;
  outbox.save(markSent(beginSend(job(), T0), { messageId: "<sent@yente>", sentAt: T0 }));

  const now = store.get(COLLECTIONS.OUTBOX, pending._id);
  assert.equal(now.state, "SENT");
  assert.equal(store.getAsOf(COLLECTIONS.OUTBOX, pending._id, pending._seq).state, "PENDING");
});

test("query values are escaped, and control characters are refused", () => {
  assert.equal(quote('a"b'), '"a\\"b"');
  assert.equal(quote("a\\b"), '"a\\\\b"');
  assert.throws(() => quote("a b"), /Control characters/);
  assert.throws(() => quote("a\nb"), /Control characters/);
});

test("caused_by takes documents or hashes, and rejects anything else", () => {
  const { store } = repos();
  const parent = store.put(COLLECTIONS.MESSAGES, "p", { x: 1 });
  const viaDoc = store.put(COLLECTIONS.MESSAGES, "c1", { x: 2 }, { causedBy: [parent] });
  const viaHash = store.put(COLLECTIONS.MESSAGES, "c2", { x: 3 }, { causedBy: [parent._hash] });
  assert.deepEqual(viaDoc.caused_by, [parent._hash]);
  assert.deepEqual(viaHash.caused_by, [parent._hash]);
  assert.throws(() => store.put(COLLECTIONS.MESSAGES, "c3", { x: 4 }, { causedBy: [{ nope: true }] }), /document hashes/);
});

test("the store uses caused_by, not _caused_by — the field TRACE actually reads", () => {
  // Verified against the engine: a `_caused_by` field is stored as ordinary
  // data and the trace stops at the node itself. This is the reverse of the
  // HTTP daemon's shape, and getting it wrong yields a chain that looks present
  // in the row and is absent from every TRACE.
  const { store } = repos();
  const parent = store.put(COLLECTIONS.MESSAGES, "p", { x: 1 });
  store.put(COLLECTIONS.MESSAGES, "child", { x: 2 }, { causedBy: [parent] });
  assert.deepEqual(store.trace(COLLECTIONS.MESSAGES, "child").map((r) => r._id), ["child", "p"]);

  store.core.put(COLLECTIONS.MESSAGES, "wrong", JSON.stringify({ _caused_by: [parent._hash] }));
  assert.deepEqual(store.trace(COLLECTIONS.MESSAGES, "wrong").map((r) => r._id), ["wrong"]);
});
