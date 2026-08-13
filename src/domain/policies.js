/**
 * The policies the desk actually runs on.
 *
 * WHY THIS FILE DID NOT EXIST, AND WHAT THAT COST
 *
 * `createRuntime` destructures `policies` with no default, and until now the
 * only qualification policy anywhere in the tree lived in
 * `test-support/fixtures.js`. `bin/daemon.mjs` passes no policies at all.
 *
 * So `qualify()` could not have run in production even if something had called
 * it: `policies.memberQualification` would have thrown on undefined and taken
 * the tick with it. A policy that exists only in a test fixture is not a
 * default, it is an assumption the tests were quietly satisfying — the same
 * shape of bug as the parser registry that only the test suite ever called.
 *
 * Defaults live here and are applied INSIDE createRuntime, so an entry point
 * cannot forget them. A caller may still override any of them; what it cannot
 * do is start a desk with none.
 */

/**
 * Who is ready to be matched.
 *
 * REQUIRED FIELDS ARE A PRODUCT DECISION, NOT A SCHEMA DUMP
 *
 * Every required field is a question somebody has to answer before she will do
 * anything for them, so the list is the shortest one that still makes a match
 * defensible:
 *
 *  - roles, capabilities, geographies — what they do and where. A résumé
 *    supplies all three, so a member who sends one has already cleared them.
 *  - intent.seeks and intent.introductionTypes — what they WANT. A résumé
 *    almost never says. This is the honest reason a perfect résumé still leaves
 *    somebody unqualified, and it is exactly the right thing to ask first.
 *
 * `professional.industries` is deliberately NOT required, though the test
 * fixture requires it. Industry is rarely stated outright — it is inferred from
 * employer names, and an inferred fact cannot satisfy the evidence check by
 * design (INV-3). Requiring it would mean asking every member which industry
 * they work in, as one of only two questions she gets to ask, to fill a field
 * that matters less than what they are looking for.
 *
 * `allowedStates` excludes NEW on purpose: a member who has not been through
 * intake has no evidence yet, and INTERVIEWING is the state intake produces.
 * It cannot require ACTIVE, because ACTIVE is what qualifying PRODUCES —
 * a policy demanding its own output is unreachable, which is a mistake this
 * codebase has already made once and left a comment about.
 */
export const memberQualificationPolicy = Object.freeze({
  id: "ccme-member-qualification",
  version: "1",
  allowedStates: Object.freeze(["INTERVIEWING", "QUALIFIED", "ACTIVE"]),
  requiredFields: Object.freeze([
    "professional.roles",
    "professional.capabilities",
    "professional.geographies",
    "intent.seeks",
    "intent.introductionTypes",
  ]),
});

/**
 * Opportunities — the employer/investor side of the desk.
 *
 * Kept looser than the member policy on purpose: an opportunity is described by
 * whoever is offering it, in one message, and demanding six evidenced fields
 * from a first email is how a desk gets no supply at all.
 */
export const opportunityQualificationPolicy = Object.freeze({
  id: "ccme-opportunity-qualification",
  version: "1",
  allowedStates: Object.freeze(["INTERVIEWING", "QUALIFIED", "ACTIVE"]),
  requiredFields: Object.freeze([
    "needs.roles",
    "needs.geographies",
  ]),
});

/**
 * Matching. Thresholds are conservative because the cost of the two errors is
 * not symmetric: a missed match is invisible, a bad introduction burns the trust
 * of two people at once and is the one thing this desk cannot buy back.
 */
export const matchPolicy = Object.freeze({
  id: "ccme-match",
  version: "1",
  minimumScore: 0.6,
  requireMutualIntent: true,
});

/** The full set, for a caller that wants to override one and keep the rest. */
export const DEFAULT_POLICIES = Object.freeze({
  memberQualification: memberQualificationPolicy,
  opportunityQualification: opportunityQualificationPolicy,
  match: matchPolicy,
});
