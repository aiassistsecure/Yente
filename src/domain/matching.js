import { createHash } from "node:crypto";

import { readPath } from "./qualification.js";

const BLOCKING_PRIOR_STATES = new Set(["VETOED", "INTRODUCED"]);

function asValues(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function canonicalValues(value) {
  return [...new Set(asValues(value).map(String))].sort();
}

function evaluateRule(member, opportunity, rule) {
  const memberValues = canonicalValues(readPath(member, rule.memberPath));
  const opportunityValues = canonicalValues(readPath(opportunity, rule.opportunityPath));

  if (rule.operator === "overlap") {
    const matchedValues = memberValues.filter((value) => opportunityValues.includes(value));
    return { passed: matchedValues.length > 0, matchedValues };
  }

  if (rule.operator === "equals") {
    const passed =
      memberValues.length === 1 &&
      opportunityValues.length === 1 &&
      memberValues[0] === opportunityValues[0];
    return { passed, matchedValues: passed ? [memberValues[0]] : [] };
  }

  throw new TypeError(`Unsupported deterministic rule operator: ${rule.operator}`);
}

function scoreDirection(member, opportunity, rules, threshold) {
  const breakdown = rules.map((rule) => {
    const result = evaluateRule(member, opportunity, rule);
    return Object.freeze({
      id: rule.id,
      passed: result.passed,
      matchedValues: Object.freeze(result.matchedValues),
      contribution: result.passed ? rule.weight : 0,
    });
  });
  const score = breakdown.reduce((total, row) => total + row.contribution, 0);
  return Object.freeze({
    score,
    threshold,
    passed: score >= threshold,
    breakdown: Object.freeze(breakdown),
  });
}

function pairKey(memberId, opportunityId, policy, cycle) {
  const input = [policy.id, policy.version, memberId, opportunityId, cycle].join("\u001f");
  return createHash("sha256").update(input).digest("hex");
}

export function evaluateMatch({
  member,
  opportunity,
  memberQualification,
  opportunityQualification,
  policy,
  cycle = "default",
  priorMatches = [],
}) {
  const blockers = [];

  if (!memberQualification?.qualified) blockers.push("member_not_qualified");
  if (!opportunityQualification?.qualified) blockers.push("opportunity_not_qualified");
  if (!member?.inboundEstablishedAt) blockers.push("member_not_inbound");
  if (!opportunity?.inboundEstablishedAt) blockers.push("opportunity_not_inbound");

  const key = pairKey(member.id, opportunity.id, policy, cycle);
  if (
    priorMatches.some(
      (prior) => prior.idempotencyKey === key && BLOCKING_PRIOR_STATES.has(prior.state),
    )
  ) {
    blockers.push("pair_already_resolved_in_cycle");
  }

  const hardGates = policy.hardGates.map((rule) => {
    const result = evaluateRule(member, opportunity, rule);
    if (!result.passed) blockers.push(`hard_gate:${rule.id}`);
    return Object.freeze({
      id: rule.id,
      passed: result.passed,
      matchedValues: Object.freeze(result.matchedValues),
    });
  });

  const memberFit = scoreDirection(
    member,
    opportunity,
    policy.scores.member,
    policy.thresholds.member,
  );
  const opportunityFit = scoreDirection(
    member,
    opportunity,
    policy.scores.opportunity,
    policy.thresholds.opportunity,
  );

  if (!memberFit.passed) blockers.push("member_fit_below_threshold");
  if (!opportunityFit.passed) blockers.push("opportunity_fit_below_threshold");

  return Object.freeze({
    idempotencyKey: key,
    memberId: member.id,
    opportunityId: opportunity.id,
    cycle,
    policy: Object.freeze({ id: policy.id, version: policy.version }),
    eligible: blockers.length === 0,
    blockers: Object.freeze(blockers),
    hardGates: Object.freeze(hardGates),
    scores: Object.freeze({ member: memberFit, opportunity: opportunityFit }),
  });
}
