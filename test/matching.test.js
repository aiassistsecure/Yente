import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMatch,
  evaluateQualification,
  missingInterviewFields,
} from "../src/index.js";
import {
  matchPolicy,
  member,
  memberQualificationPolicy,
  opportunity,
  opportunityQualificationPolicy,
} from "../test-support/fixtures.js";

test("qualification requires inbound, required values, and evidence", () => {
  const qualified = evaluateQualification(member, memberQualificationPolicy);
  assert.equal(qualified.qualified, true);

  const incomplete = structuredClone(member);
  delete incomplete.evidenceByField["intent.seeks"];
  incomplete.professional.geographies = [];
  const result = evaluateQualification(incomplete, memberQualificationPolicy);

  assert.equal(result.qualified, false);
  assert.deepEqual(result.missingFields, ["professional.geographies"]);
  assert.deepEqual(result.unevidencedFields, ["intent.seeks"]);
  assert.deepEqual(missingInterviewFields(result), [
    "professional.geographies",
    "intent.seeks",
  ]);
});

test("qualification rejects a complete profile in a non-matchable state", () => {
  // NEW rather than INTERVIEWING. The property under test is unchanged —
  // allowedStates must refuse a state outside its list — but INTERVIEWING is no
  // longer an example of one: qualification cannot require the state that
  // qualification produces (§10.1 QUALIFIED -> ACTIVE), so the member policy now
  // admits the states a member passes THROUGH on the way to ACTIVE. D8 found
  // that circularity the first time the whole loop ran.
  const untriaged = { ...member, state: "NEW" };
  const result = evaluateQualification(untriaged, memberQualificationPolicy);

  assert.equal(result.qualified, false);
  assert.deepEqual(result.blockers, ["member_state_not_allowed"]);
});

test("qualification still refuses a stopped member whatever the policy allows", () => {
  // The unconditional half: STOPPED and DELETED are refused by
  // evaluateQualification itself, not by allowedStates, so widening the policy
  // cannot accidentally let a suppressed member qualify. INV-9.
  for (const state of ["STOPPED", "DELETED"]) {
    const suppressed = { ...member, state };
    const result = evaluateQualification(suppressed, memberQualificationPolicy);
    assert.equal(result.qualified, false);
    assert.ok(result.blockers.includes(`member_${state.toLowerCase()}`));
  }
});

test("deterministic matching requires both directions and returns stable output", () => {
  const memberQualification = evaluateQualification(member, memberQualificationPolicy);
  const opportunityQualification = evaluateQualification(
    opportunity,
    opportunityQualificationPolicy,
  );
  const input = {
    member,
    opportunity,
    memberQualification,
    opportunityQualification,
    policy: matchPolicy,
    cycle: "2026-08",
  };

  const first = evaluateMatch(input);
  const second = evaluateMatch(input);

  assert.deepEqual(first, second);
  assert.equal(first.eligible, true);
  assert.equal(first.scores.member.score, 100);
  assert.equal(first.scores.opportunity.score, 100);
  assert.match(first.idempotencyKey, /^[a-f0-9]{64}$/);
});

test("a hard gate cannot be outweighed by otherwise strong scores", () => {
  const wrongGeography = structuredClone(opportunity);
  wrongGeography.needs.geographies = ["eu_on_site"];

  const result = evaluateMatch({
    member,
    opportunity: wrongGeography,
    memberQualification: evaluateQualification(member, memberQualificationPolicy),
    opportunityQualification: evaluateQualification(
      wrongGeography,
      opportunityQualificationPolicy,
    ),
    policy: matchPolicy,
  });

  assert.equal(result.scores.member.score, 100);
  assert.equal(result.scores.opportunity.score, 100);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("hard_gate:geography"));
});

test("a vetoed pair cannot be recreated in the same policy cycle", () => {
  const memberQualification = evaluateQualification(member, memberQualificationPolicy);
  const opportunityQualification = evaluateQualification(
    opportunity,
    opportunityQualificationPolicy,
  );
  const first = evaluateMatch({
    member,
    opportunity,
    memberQualification,
    opportunityQualification,
    policy: matchPolicy,
    cycle: "cycle-1",
  });
  const repeated = evaluateMatch({
    member,
    opportunity,
    memberQualification,
    opportunityQualification,
    policy: matchPolicy,
    cycle: "cycle-1",
    priorMatches: [{ idempotencyKey: first.idempotencyKey, state: "VETOED" }],
  });

  assert.equal(repeated.eligible, false);
  assert.ok(repeated.blockers.includes("pair_already_resolved_in_cycle"));
});
