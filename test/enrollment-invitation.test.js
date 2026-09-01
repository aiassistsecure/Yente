import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_PURPOSES,
  activate,
  beginInterview,
  beginIntake,
  createMember,
  deleteMember,
  enqueueEmail,
  enqueueEnrollmentInvitation,
  enrollmentInvitationKey,
  invitationFollowUp,
  markQualified,
  stopMember,
} from "../src/index.js";

const T0 = "2026-08-12T12:00:00.000Z";

const UNSUBSCRIBE = Object.freeze({
  "List-Unsubscribe": "<mailto:unsubscribe@ccme.network>, <https://ccme.network/u/abc>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

function member(overrides = {}) {
  let m = createMember({
    memberId: "member_alice",
    address: "alice@example.com",
    inboundEstablishedAt: T0,
    createdAt: T0,
    ...overrides,
  });
  m = beginIntake(m, T0);
  m = beginInterview(m, T0);
  m = markQualified(m, {
    qualification: { policyId: "employment_v1", policyVersion: 1, qualified: true },
    at: T0,
  });
  return activate(m, T0);
}

function invite(overrides = {}) {
  return enqueueEnrollmentInvitation({
    jobId: "job_invite_1",
    invitedAddress: "stranger@example.com",
    invitingMember: member(),
    threadId: "thread_9",
    threadParticipants: ["alice@example.com", "Stranger@Example.com", "yente@ccme.network"],
    alreadyInvited: [],
    suppressed: [],
    headers: UNSUBSCRIBE,
    enqueuedAt: T0,
    ...overrides,
  });
}

test("a CC'd stranger gets one invitation, addressed only to them", () => {
  const job = invite();
  assert.equal(job.purpose, OUTBOUND_PURPOSES.ENROLLMENT_INVITATION);
  assert.deepEqual(job.recipients, ["stranger@example.com"]);
  assert.equal(job.invitation.threadId, "thread_9");
  assert.equal(job.invitation.invitedByMemberId, "member_alice");
});

test("the idempotency key is the address alone — once per person, not once per thread", () => {
  // Keying on the thread or the pair would let someone surfaced on six threads
  // by four members receive six invitations: each individually defensible,
  // collectively indistinguishable from a campaign.
  assert.equal(enrollmentInvitationKey("Stranger@Example.COM"), "enrollment_invitation:stranger@example.com");
  assert.equal(
    invite().idempotencyKey,
    invite({ jobId: "job_invite_2", threadId: "thread_44" }).idempotencyKey,
  );
});

test("an address already invited is never invited again, by any member, ever", () => {
  assert.equal(invite({ alreadyInvited: ["stranger@example.com"] }), null);
  assert.equal(invite({ alreadyInvited: new Set(["stranger@example.com"]) }), null);
  // Case differences must not create a second invitation.
  assert.equal(invite({ alreadyInvited: ["STRANGER@example.com"] }), null);
});

test("suppression is checked before anything else — INV-9", () => {
  assert.equal(invite({ suppressed: ["stranger@example.com"] }), null);
});

test("an address that was not on the thread has no relationship and is refused", () => {
  // INV-1's exception is a thread relationship. Without it this would be the
  // cold outbound §2.3 forbids, so it throws rather than quietly returning null
  // — a caller asking for this has a bug, not a policy outcome.
  assert.throws(
    () => invite({ threadParticipants: ["alice@example.com", "yente@ccme.network"] }),
    /not a participant on thread/,
  );
});

test("a CC from a stopped or deleted member triggers nothing", () => {
  assert.throws(() => invite({ invitingMember: stopMember(member(), T0) }), /is STOPPED/);
  assert.throws(() => invite({ invitingMember: deleteMember(member(), T0) }), /is DELETED/);
  assert.throws(() => invite({ invitingMember: null }), /requires the member who CC'd/);
});

test("a member cannot invite themselves", () => {
  assert.throws(() => invite({ invitedAddress: "alice@example.com" }), /cannot invite themselves/);
});

test("List-Unsubscribe and one-click are mandatory on this class — §5.4", () => {
  // Every other class goes to someone who asked to be there. This one does not,
  // and a machine-readable opt-out is what separates an invitation from the
  // thing we said we would never build.
  assert.throws(() => invite({ headers: {} }), /List-Unsubscribe header/);
  assert.throws(
    () => invite({ headers: { "List-Unsubscribe": "<mailto:u@ccme.network>" } }),
    /List-Unsubscribe-Post/,
  );
  // Header names are case-insensitive on the wire, so the check must be too.
  assert.ok(invite({
    headers: { "list-unsubscribe": "<mailto:u@ccme.network>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" },
  }));
});

test("a direct enqueueEmail cannot route around the unsubscribe requirement", () => {
  assert.throws(
    () => enqueueEmail({
      jobId: "job_sneaky",
      idempotencyKey: "enrollment_invitation:stranger@example.com",
      purpose: OUTBOUND_PURPOSES.ENROLLMENT_INVITATION,
      recipients: ["stranger@example.com"],
      enqueuedAt: T0,
    }),
    /List-Unsubscribe header/,
  );
});

test("an invitation is never addressed to more than one person", () => {
  assert.throws(
    () => enqueueEmail({
      jobId: "job_bulk",
      idempotencyKey: "enrollment_invitation:bulk",
      purpose: OUTBOUND_PURPOSES.ENROLLMENT_INVITATION,
      recipients: ["a@example.com", "b@example.com"],
      headers: UNSUBSCRIBE,
      enqueuedAt: T0,
    }),
    /exactly one person/,
  );
});

test("the invitation job carries provenance but no thread content", () => {
  const job = invite();
  const serialized = JSON.stringify(job);
  assert.match(serialized, /thread_9/);
  assert.match(serialized, /member_alice/);
  // Nothing about what was said, and no other participant's address.
  assert.doesNotMatch(serialized, /yente@ccme\.network/);
  assert.equal(job.recipients.length, 1);
  assert.equal(Object.keys(job.invitation).length, 2);
});

test("silence is a no — there is no follow-up, by construction", () => {
  // The emptiness is the specification. An INV-8 veto window advances on
  // silence because something was disclosed to be vetoed; here nothing was.
  assert.equal(invitationFollowUp(), null);
});

test("the purpose list stays closed, and every member of it is deliberate", () => {
  // A closed list is the point: "she never sends promotional sequences" is a
  // property of this array, so adding to it is a decision that has to be made
  // here, in a test, rather than incidentally at a call site.
  //
  // profile_confirmation is the ninth. It exists because qualifying was silent:
  // qualify() queues a letter only when something is MISSING, so the better a
  // member's résumé, the less they heard back — and from the outside that is
  // indistinguishable from the extraction having failed.
  // linkedin_request is the tenth, added 2026-08-28 with the three-ask intake:
  // "send me a document" and "send me one URL" are different questions, asked
  // once each (idempotency key linkedin:<address>), and the "never ask for a
  // résumé twice" invariant is only checkable while they stay distinguishable.
  // conversation is the eleventh, added 2026-09-01 when the voice seat was
  // finally wired: a model-composed reply to a message no template answered,
  // one per inbound message (key reply:<rfcMessageId>) — still transactional,
  // still a reply to something THEY sent, never promotional.
  assert.deepEqual(Object.values(OUTBOUND_PURPOSES), [
    "profile_request",
    "linkedin_request",
    "interview_question",
    "clarification",
    "profile_confirmation",
    "conversation",
    "private_match_preview",
    "joint_introduction",
    "stop_confirmation",
    "deletion_confirmation",
    "enrollment_invitation",
  ]);
});
