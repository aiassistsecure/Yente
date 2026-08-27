/**
 * A résumé is how a profile gets built, not something one person seeks from
 * another.
 *
 * THE EMAIL THAT PROMPTED THIS
 *
 *   Interchained Core is looking for or offering: resume.
 *   founders@vibecode-101.com is looking for or offering: resume receipt confirmation.
 *   Why this matched: OFFERING is answered by SEEKING; both mention resume.
 *
 * Yente sent that. The scorer was not broken — it was handed the INTAKE
 * CONVERSATION dressed as business intent (a person sending a résumé, Yente
 * confirming receipt) and did its job on it faithfully.
 *
 * Two rules, tested here. The second is the one that matters, because it would
 * have stopped that email even if the scorer had loved the word "resume":
 *
 *   1. Artefacts of intake are never business intent.
 *   2. Only a person who has APPROVED THEIR OWN PROFILE can be matched.
 *
 * Rule 2 also fixes the thing nobody had to tell the scorer about: that email
 * introduced Mark to Mark. Neither identity was qualified.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_STATES,
  isIntakeArtifact,
  isLegalTransition,
  isQualified,
  profileState,
} from "../src/graph/qualification.js";
import { proposeIntroductions } from "../src/graph/matching.js";

const intent = (subject, type, object, extra = {}) => ({
  subject,
  predicate: `intent:${type}`,
  object,
  quote: `${subject} said ${object}`,
  evidenceId: `message:${subject}`,
  ...extra,
});

/* --- rule 1: intake is not intent --------------------------------------- */

test("the exact objects from the bad email are recognised as intake", () => {
  assert.equal(isIntakeArtifact("resume"), true);
  assert.equal(isIntakeArtifact("resume receipt confirmation"), true);
  assert.equal(isIntakeArtifact("my résumé"), true);
  assert.equal(isIntakeArtifact("LinkedIn export"), true);
  assert.equal(isIntakeArtifact("profile approval"), true);
});

test("a real business intent that MENTIONS a résumé is not refused", () => {
  // The over-correction to avoid. A CV-writing service seeking clients is a
  // genuine intent whose object contains "resume", and a stop-list would have
  // silently stopped matching it.
  assert.equal(isIntakeArtifact("resume review for senior engineers"), false);
  assert.equal(isIntakeArtifact("technical cofounder"), false);
  assert.equal(isIntakeArtifact("seed funding"), false);
  assert.equal(isIntakeArtifact("LinkedIn ads for B2B SaaS"), false);
});

test("empty or wordless objects are not treated as intake", () => {
  for (const value of ["", "   ", null, undefined, "!!!"]) {
    assert.equal(isIntakeArtifact(value), false);
  }
});

test("the résumé pair scores zero and says why", () => {
  // End to end through the real scorer, with the real objects from the email.
  const proposals = proposeIntroductions({
    observations: [
      intent("person:dev@interchained.org", "OFFERING", "resume"),
      intent("person:founders@vibecode-101.com", "SEEKING", "resume receipt confirmation"),
    ],
    threshold: 0.01,   // deliberately floor-level: even then, nothing may pass
  });
  assert.deepEqual(proposals, [],
    "the introduction Yente actually sent must now be impossible");
});

/* --- rule 2: only an approved profile is matchable ----------------------- */

test("a new person is not qualified", () => {
  assert.equal(profileState([]), PROFILE_STATES.NEW);
  assert.equal(isQualified([]), false);
});

test("state is the LAST claim, so the lifecycle can move", () => {
  const rows = [
    { predicate: "profile_state", object: PROFILE_STATES.ASKED, observedAt: "2026-08-27T10:00:00Z" },
    { predicate: "profile_state", object: PROFILE_STATES.RECEIVED, observedAt: "2026-08-27T11:00:00Z" },
    { predicate: "profile_state", object: PROFILE_STATES.QUALIFIED, observedAt: "2026-08-27T12:00:00Z" },
  ];
  assert.equal(profileState(rows), PROFILE_STATES.QUALIFIED);
  assert.equal(isQualified(rows), true);
});

test("out-of-order arrival still yields the latest state", () => {
  // Observations are append-only and nothing guarantees insertion order matches
  // wall-clock order — a retried job can land after a later claim.
  const rows = [
    { predicate: "profile_state", object: PROFILE_STATES.QUALIFIED, observedAt: "2026-08-27T12:00:00Z" },
    { predicate: "profile_state", object: PROFILE_STATES.ASKED, observedAt: "2026-08-27T10:00:00Z" },
  ];
  assert.equal(profileState(rows), PROFILE_STATES.QUALIFIED);
});

test("other observations do not disturb the state", () => {
  const rows = [
    { predicate: "intent:SEEKING", object: "a CTO", observedAt: "2026-08-27T13:00:00Z" },
    { predicate: "profile_state", object: PROFILE_STATES.QUALIFIED, observedAt: "2026-08-27T12:00:00Z" },
  ];
  assert.equal(profileState(rows), PROFILE_STATES.QUALIFIED);
});

/* --- the lifecycle is enforced, not decorative --------------------------- */

test("a profile cannot skip approval", () => {
  // The whole point: nothing may reach QUALIFIED without the person having been
  // shown their bio and having answered.
  assert.equal(isLegalTransition(PROFILE_STATES.NEW, PROFILE_STATES.QUALIFIED), false);
  assert.equal(isLegalTransition(PROFILE_STATES.RECEIVED, PROFILE_STATES.QUALIFIED), false);
  assert.equal(isLegalTransition(PROFILE_STATES.DRAFTED, PROFILE_STATES.QUALIFIED), false);
  assert.equal(
    isLegalTransition(PROFILE_STATES.AWAITING_APPROVAL, PROFILE_STATES.QUALIFIED), true,
    "approval is the ONLY door into QUALIFIED");
});

test("a qualified person can send a new résumé and go round again", () => {
  // A profile is a living thing, not a one-time form — and the new bio needs
  // approving too, so it re-enters the lifecycle rather than staying qualified.
  assert.equal(isLegalTransition(PROFILE_STATES.QUALIFIED, PROFILE_STATES.RECEIVED), true);
  assert.equal(isLegalTransition(PROFILE_STATES.RECEIVED, PROFILE_STATES.DRAFTED), true);
});

test("declining is reversible, because no today is not no forever", () => {
  assert.equal(isLegalTransition(PROFILE_STATES.DECLINED, PROFILE_STATES.ASKED), true);
  assert.equal(isLegalTransition(PROFILE_STATES.DECLINED, PROFILE_STATES.QUALIFIED), false);
});

test("re-asserting the same state is allowed, and a first state is always legal", () => {
  // Idempotence matters: a retried job must not throw for doing its work twice.
  assert.equal(isLegalTransition(PROFILE_STATES.ASKED, PROFILE_STATES.ASKED), true);
  assert.equal(isLegalTransition(null, PROFILE_STATES.NEW), true);
  assert.equal(isLegalTransition(undefined, PROFILE_STATES.RECEIVED), true);
});

test("anyone can be declined from anywhere", () => {
  // Consent has to be honoured from whatever state the person is in.
  for (const from of Object.values(PROFILE_STATES)) {
    if (from === PROFILE_STATES.DECLINED) continue;
    assert.equal(isLegalTransition(from, PROFILE_STATES.DECLINED), true,
      `${from} must be able to decline`);
  }
});
