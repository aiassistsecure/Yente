import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMBER_STATES,
  activate,
  beginIntake,
  beginInterview,
  canReceiveOutbound,
  createMember,
  deleteMember,
  isMatchable,
  isQualifiedFor,
  markQualified,
  normalizeAddress,
  requireMoreEvidence,
  stopMember,
} from "../src/index.js";

const INBOUND = "2026-08-12T12:00:00.000Z";

function newMember(overrides = {}) {
  return createMember({
    memberId: "member_bob",
    address: "bob@example.com",
    inboundEstablishedAt: INBOUND,
    createdAt: INBOUND,
    ...overrides,
  });
}

const passingQualification = Object.freeze({
  policyId: "employment_v1",
  policyVersion: 3,
  qualified: true,
  blockers: [],
  missingFields: [],
  unevidencedFields: [],
});

function activeMember() {
  let member = newMember();
  member = beginIntake(member, "2026-08-12T12:00:01.000Z");
  member = beginInterview(member, "2026-08-12T12:00:02.000Z");
  member = markQualified(member, { qualification: passingQualification, at: "2026-08-12T12:00:03.000Z" });
  return activate(member, "2026-08-12T12:00:04.000Z");
}

test("a member cannot exist without an inbound relationship — INV-1", () => {
  assert.throws(
    () => createMember({ memberId: "m", address: "x@example.com", createdAt: INBOUND }),
    /inbound relationship/,
  );
});

test("the happy path walks NEW to ACTIVE", () => {
  let member = newMember();
  assert.equal(member.state, MEMBER_STATES.NEW);
  member = beginIntake(member, "2026-08-12T12:00:01.000Z");
  assert.equal(member.state, MEMBER_STATES.NEEDS_PROFILE);
  member = beginInterview(member, "2026-08-12T12:00:02.000Z");
  assert.equal(member.state, MEMBER_STATES.INTERVIEWING);
  member = markQualified(member, { qualification: passingQualification, at: "2026-08-12T12:00:03.000Z" });
  assert.equal(member.state, MEMBER_STATES.QUALIFIED);
  member = activate(member, "2026-08-12T12:00:04.000Z");
  assert.equal(member.state, MEMBER_STATES.ACTIVE);
  assert.deepEqual(
    member.history.map((row) => row.event),
    ["MEMBER_CREATED", "INTAKE_BEGAN", "INTERVIEW_BEGAN", "QUALIFIED", "ACTIVATED"],
  );
});

test("transitions are pure — the input member is never mutated", () => {
  const member = newMember();
  const moved = beginIntake(member, "2026-08-12T12:00:01.000Z");
  assert.equal(member.state, MEMBER_STATES.NEW);
  assert.equal(moved.state, MEMBER_STATES.NEEDS_PROFILE);
  assert.equal(member.history.length, 1);
});

test("an out-of-order transition is refused", () => {
  const member = newMember();
  assert.throws(() => activate(member, INBOUND), /Cannot move member/);
  assert.throws(() => beginInterview(member, INBOUND), /Cannot move member/);
});

test("NEEDS_PROFILE and INTERVIEWING alternate, because a new match type can ask for a new field", () => {
  // SPEC v2 §10.1. The machine is not a ladder: an ACTIVE member sent back for
  // evidence is a normal event, not a regression.
  let member = activeMember();
  member = requireMoreEvidence(member, "2026-08-12T13:00:00.000Z", {
    reason: "geography missing for policy",
    policyId: "employment_v2",
  });
  assert.equal(member.state, MEMBER_STATES.NEEDS_PROFILE);
  member = beginInterview(member, "2026-08-12T13:00:01.000Z");
  assert.equal(member.state, MEMBER_STATES.INTERVIEWING);
  assert.equal(member.history.at(-2).reason, "geography missing for policy");
});

test("qualification is recorded per policy version, not as a permanent badge", () => {
  const member = activeMember();
  assert.equal(isQualifiedFor(member, "employment_v1", 3), true);
  // A policy bump changes what qualification meant. Honouring the old pass
  // under the new version is how a hard gate quietly stops being hard.
  assert.equal(isQualifiedFor(member, "employment_v1", 4), false);
  assert.equal(isQualifiedFor(member, "founder_investor_v1", 1), false);
  assert.equal(member.qualifications.employment_v1.policyVersion, 3);
});

test("a failing qualification cannot be recorded as a pass — INV-4", () => {
  let member = newMember();
  member = beginIntake(member, "2026-08-12T12:00:01.000Z");
  member = beginInterview(member, "2026-08-12T12:00:02.000Z");
  assert.throws(
    () => markQualified(member, {
      qualification: { ...passingQualification, qualified: false, missingFields: ["intent.seeks"] },
      at: "2026-08-12T12:00:03.000Z",
    }),
    /failing qualification/,
  );
});

test("STOP is terminal, idempotent, and blocks outbound — INV-9", () => {
  const member = activeMember();
  const stopped = stopMember(member, "2026-08-12T14:00:00.000Z", { reason: "unsubscribe" });
  assert.equal(stopped.state, MEMBER_STATES.STOPPED);
  assert.equal(canReceiveOutbound(stopped), false);
  assert.equal(isMatchable(stopped), false);

  // A second unsubscribe from an already-stopped member is a normal thing for a
  // human to send. An error path here is a path that might not suppress.
  const again = stopMember(stopped, "2026-08-12T15:00:00.000Z");
  assert.equal(again, stopped);

  assert.throws(() => activate(stopped, "2026-08-12T15:00:00.000Z"), /terminal/);
  assert.throws(() => beginInterview(stopped, "2026-08-12T15:00:00.000Z"), /terminal/);
});

test("DELETE is reachable from every state, including STOPPED", () => {
  const stopped = stopMember(activeMember(), "2026-08-12T14:00:00.000Z");
  const deleted = deleteMember(stopped, "2026-08-12T16:00:00.000Z", { reason: "erasure request" });
  assert.equal(deleted.state, MEMBER_STATES.DELETED);
  assert.equal(deleted.deletedAt, "2026-08-12T16:00:00.000Z");

  // And directly from NEW, without passing through anything else.
  assert.equal(deleteMember(newMember(), INBOUND).state, MEMBER_STATES.DELETED);
  assert.equal(deleteMember(deleted, "2026-08-12T17:00:00.000Z"), deleted);
});

test("a deleted member cannot be stopped, because there is nothing left to suppress", () => {
  const deleted = deleteMember(newMember(), INBOUND);
  assert.throws(() => stopMember(deleted, INBOUND), /deleted/);
});

test("only an ACTIVE member is matchable — §7.2 gate 2", () => {
  assert.equal(isMatchable(activeMember()), true);
  assert.equal(isMatchable(newMember()), false);
  let qualified = beginIntake(newMember(), "2026-08-12T12:00:01.000Z");
  qualified = beginInterview(qualified, "2026-08-12T12:00:02.000Z");
  qualified = markQualified(qualified, { qualification: passingQualification, at: "2026-08-12T12:00:03.000Z" });
  assert.equal(isMatchable(qualified), false);
});

test("the whole address is lowercased, so one human is one member and one suppression record", () => {
  // RFC 5321 leaves the local part case-sensitive. Honouring that here would
  // make Stranger@Example.com and stranger@example.com two members with two
  // suppression records — a stopped person could be mailed again by typing
  // their own address differently, and §5.4's "once per address, ever" would
  // become once per capitalisation. INV-9 wins over the paper reading.
  assert.equal(normalizeAddress("Bob@Example.COM"), "bob@example.com");
  assert.equal(normalizeAddress("STRANGER@example.com"), normalizeAddress("stranger@Example.com"));
  assert.equal(newMember({ address: "  Bob@EXAMPLE.com " }).address, "bob@example.com");

  // Dots and +tags are preserved. Unlike case, stripping those merges mailboxes
  // that genuinely different people read.
  assert.equal(normalizeAddress("bob.smith+jobs@example.com"), "bob.smith+jobs@example.com");
  assert.notEqual(normalizeAddress("bobsmith@example.com"), normalizeAddress("bob.smith@example.com"));

  assert.throws(() => normalizeAddress("not-an-address"), /Not an email address/);
  assert.throws(() => normalizeAddress("@example.com"), /Not an email address/);
});

test("an invalid timestamp is rejected rather than stored as Invalid Date", () => {
  assert.throws(() => beginIntake(newMember(), "yesterday"), /Invalid timestamp/);
});
