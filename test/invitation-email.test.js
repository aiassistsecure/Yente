import assert from "node:assert/strict";
import test from "node:test";

import {
  createEnrollmentInvitationPrompt,
  createReferenceEnrollmentInvitation,
  enrollmentInvitationExpectation,
} from "../src/domain/email-artifacts.js";
import { guardEmailDisclosure } from "../src/llm/generate.js";
import { parseEmailArtifact } from "../src/protocol/blocks.js";

const SLOTS = Object.freeze({
  invitedName: "Dana",
  invitingName: "Alice Chen",
  replyAddress: "yente@ccme.network",
  unsubscribeUrl: "https://ccme.network/u/7f3a91",
  threadId: "thread_9",
  invitedByMemberId: "member_alice",
});

const EXPECT = enrollmentInvitationExpectation({
  replyAddress: "yente@ccme.network",
  unsubscribeAddress: "unsubscribe@ccme.network",
});

const reference = (overrides = {}) => createReferenceEnrollmentInvitation({ ...SLOTS, ...overrides });

test("the reference invitation satisfies its own disclosure guard", () => {
  const email = guardEmailDisclosure(reference(), EXPECT);
  assert.equal(email.meta.template, "enrollment_invitation");
  assert.deepEqual(email.meta.facts_used, [], "an invitation cites no facts because it discloses none");
});

test("the subject answers the only question a stranger has", () => {
  // "Why is this in my inbox." Nothing available here beats the plain fact, and
  // the inviting member's name is the one piece of context §5.4 permits.
  const { subject } = parseEmailArtifact(reference());
  assert.equal(subject, "Alice Chen copied me on a thread with you");
  assert.ok(subject.length <= 200);
  assert.doesNotMatch(subject, /\n/);
});

test("the email makes three promises, and each is enforced by code elsewhere", () => {
  const { text } = parseEmailArtifact(reference());

  // "the only time you will" — invitationKey is the bare address, so §5.4's
  // once-per-lifetime is enforced by addressing in keys.js.
  assert.match(text, /only time you will/);

  // "I have not read the thread" — there is no slot on this template capable of
  // carrying thread content. See the structural test below.
  assert.match(text, /have not read the thread/);

  // "no follow-up" — invitationFollowUp() returns null and exists to be empty.
  assert.match(text, /no follow-up and no second message/);
});

test("the template is structurally incapable of leaking the thread", () => {
  // The strongest version of "I have not read the thread" is not a promise in
  // the copy, it is the absence of a parameter. Passing thread content in is
  // impossible because there is nowhere to put it: threadId reaches META only.
  const artifact = reference({ threadId: "thread_SECRETSUBJECT" });
  const { text, meta } = parseEmailArtifact(artifact);
  assert.doesNotMatch(text, /SECRETSUBJECT/);
  assert.equal(meta.thread_id, "thread_SECRETSUBJECT", "provenance, not disclosure");
});

test("it offers exactly one yes and one no, and never a deadline", () => {
  const { text } = parseEmailArtifact(reference());
  assert.match(text, /reply to this email with whatever best explains what you do/);
  assert.match(text, /ignore this/);
  assert.match(text, /unsubscribe/);
  // Silence is a no. Any deadline language would make it a veto window, which
  // §5.4 explicitly says this is not.
  assert.doesNotMatch(text, /by \w+day|within \d+|deadline|unless you reply by/i);
});

test("an unknown recipient name degrades to a plain greeting rather than a placeholder", () => {
  const { text } = parseEmailArtifact(reference({ invitedName: null }));
  assert.match(text, /^Hi,\n/);
  assert.doesNotMatch(text, /Hi (undefined|null|there|\{)/);
  guardEmailDisclosure(reference({ invitedName: null }), EXPECT);
});

test("the only address in the body is Yente's own", () => {
  const { text } = parseEmailArtifact(reference());
  const found = [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])];
  assert.deepEqual(found, ["yente@ccme.network"]);
});

test("required slots are required", () => {
  assert.throws(() => reference({ invitingName: "" }), /requires invitingName/);
  assert.throws(() => reference({ replyAddress: " " }), /requires replyAddress/);
  assert.throws(() => reference({ unsubscribeUrl: undefined }), /requires unsubscribeUrl/);
  assert.throws(() => reference({ invitedName: 42 }), /invitedName must be text/);
});

test("the prompt carries the approved slots and a longer list of what is forbidden", () => {
  const prompt = createEnrollmentInvitationPrompt(SLOTS);
  assert.match(prompt, /<<<TASK>>>/);
  assert.match(prompt, /<<<POLICY>>>/);
  assert.match(prompt, /<<<OUTPUT_CONTRACT>>>/);

  const policy = JSON.parse(prompt.match(/<<<POLICY>>>\n([\s\S]*?)\n<<<END>>>/)[1]);
  assert.deepEqual(Object.keys(policy.approvedSlots).sort(), [
    "invitedName",
    "invitingName",
    "replyAddress",
    "unsubscribeUrl",
  ]);
  assert.ok(
    policy.forbidden.length > Object.keys(policy.approvedSlots).length,
    "for the only class addressed to a stranger, the forbidden list should be the longer one",
  );
  assert.ok(policy.forbidden.some((rule) => /thread/.test(rule)));
});

test("the prompt has no slot for thread content, counterpart, or match", () => {
  const prompt = createEnrollmentInvitationPrompt(SLOTS);
  // A PROFILE or MATCH block would mean there was something to disclose.
  assert.doesNotMatch(prompt, /<<<PROFILE>>>/);
  assert.doesNotMatch(prompt, /<<<MATCH>>>/);
  assert.doesNotMatch(prompt, /<<<SOURCE/);
});
