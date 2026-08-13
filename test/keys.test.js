import assert from "node:assert/strict";
import test from "node:test";

import {
  digest,
  introductionKey,
  invitationKey,
  matchKey,
  memberKey,
  messageKey,
  outboxKey,
  outboxKeyFor,
  previewKey,
  sourceKey,
} from "../src/store/keys.js";

test("all eight uniqueness keys of §12.1 are derivable and deterministic", () => {
  const pair = { policyId: "employment", policyVersion: 3, memberIds: ["alice", "bob"], cycle: 1 };
  const keys = [
    messageKey("<abc@host>"),
    memberKey("Bob@Example.com"),
    sourceKey("bob", "resume bytes"),
    matchKey(pair),
    previewKey("match_1", "bob"),
    introductionKey("match_1"),
    invitationKey("stranger@example.com"),
    outboxKey("some:intended:email"),
  ];
  assert.equal(keys.length, 8);
  assert.equal(new Set(keys).size, 8, "no two keys collide");
  for (const key of keys) assert.ok(key.length > 0 && !/\s/.test(key));

  // Determinism is the whole point: the same tuple must address the same row on
  // a later process, a later day, and a different machine.
  assert.equal(messageKey("<abc@host>"), messageKey("<abc@host>"));
  assert.equal(matchKey(pair), matchKey({ ...pair, memberIds: ["alice", "bob"] }));
});

test("angle brackets are transport syntax, not identity", () => {
  assert.equal(messageKey("<abc@host>"), messageKey("abc@host"));
  assert.equal(messageKey("  <abc@host>  "), messageKey("abc@host"));
  assert.throws(() => messageKey(""), /requires an RFC Message-ID/);
  assert.throws(() => messageKey("<>"), /requires an RFC Message-ID/);
});

test("the member key folds case, so one human is one row", () => {
  assert.equal(memberKey("Bob@Example.COM"), memberKey("bob@example.com"));
  assert.notEqual(memberKey("bob@example.com"), memberKey("bob.smith@example.com"));
});

test("the match key sorts the pair, so one match cannot exist twice", () => {
  // §7.3 scores both directions inside a single match. An unordered pair would
  // let the same two people be proposed once from each side, with neither
  // instance able to see the other's veto.
  const forward = matchKey({ policyId: "employment", policyVersion: 3, memberIds: ["alice", "bob"], cycle: 1 });
  const reverse = matchKey({ policyId: "employment", policyVersion: 3, memberIds: ["bob", "alice"], cycle: 1 });
  assert.equal(forward, reverse);
});

test("the match key separates policy version and cycle", () => {
  const base = { policyId: "employment", policyVersion: 3, memberIds: ["alice", "bob"], cycle: 1 };
  assert.notEqual(matchKey(base), matchKey({ ...base, policyVersion: 4 }));
  assert.notEqual(matchKey(base), matchKey({ ...base, cycle: 2 }));
  assert.notEqual(matchKey(base), matchKey({ ...base, policyId: "founder_investor" }));
  assert.throws(() => matchKey({ ...base, memberIds: ["alice"] }), /exactly two member ids/);
  assert.throws(() => matchKey({ ...base, memberIds: ["a", "a"] }), /two distinct members/);
  assert.throws(() => matchKey({ ...base, policyVersion: undefined }), /policy version/);
  assert.throws(() => matchKey({ ...base, cycle: undefined }), /cycle/);
});

test("the source key is scoped to the member", () => {
  // Two people may legitimately send the same public deck. Deduping globally
  // would attribute one person's evidence to another.
  assert.equal(sourceKey("bob", "same bytes"), sourceKey("bob", "same bytes"));
  assert.notEqual(sourceKey("bob", "same bytes"), sourceKey("alice", "same bytes"));
  assert.equal(sourceKey("bob", Buffer.from("same bytes")), sourceKey("bob", "same bytes"));
});

test("the introduction key is the match alone — INV-10", () => {
  assert.equal(introductionKey("match_1"), introductionKey("match_1"));
  assert.notEqual(introductionKey("match_1"), introductionKey("match_2"));
});

test("values that are unsafe in an id are hashed rather than escaped", () => {
  // Inventing an escaping scheme means inventing its corner cases. Readable
  // when it can be, unambiguous always.
  const weird = messageKey('a"b\\c<>@ host\nnewline');
  assert.match(weird, /^[0-9a-f]{64}$/);
  assert.equal(weird, messageKey('a"b\\c<>@ host\nnewline'));
  assert.equal(messageKey("plain.id-123@host"), "plain.id-123@host");
});

test("digest is stable and 64 hex characters", () => {
  assert.match(digest("x"), /^[0-9a-f]{64}$/);
  assert.equal(digest("x"), digest("x"));
  assert.notEqual(digest("x"), digest("y"));
});

test("the canonical outbox keys compose from the §12.1 keys", () => {
  assert.equal(
    outboxKeyFor.privateMatchPreview("match_1", "bob"),
    outboxKey("private_match_preview:match_1:bob"),
  );
  assert.equal(outboxKeyFor.jointIntroduction("match_1"), outboxKey("joint_introduction:match_1"));
  assert.equal(outboxKeyFor.enrollmentInvitation("A@B.com"), outboxKey("enrollment_invitation:a@b.com"));

  // The two sides of one match are two intended emails, never one.
  assert.notEqual(
    outboxKeyFor.privateMatchPreview("match_1", "bob"),
    outboxKeyFor.privateMatchPreview("match_1", "alice"),
  );
  assert.throws(() => outboxKey(""), /requires an idempotency key/);
});
