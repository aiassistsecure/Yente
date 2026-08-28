/**
 * What a person came here for, declared rather than inferred.
 *
 * Every bad match Yente has produced came from mining intent out of email prose:
 * "both mention resume", `capability: "resume"`, `OFFERING: "professional
 * services and expertise"`. Meanwhile the résumé pass produced 63 correctly
 * typed claims. Documents carry signal; prose does not — and we were asking
 * prose to carry the single most important fact.
 *
 * So we ask a closed question instead. The tests that matter here are the ones
 * that prove the parser cannot be talked into the OPPOSITE of what somebody
 * said, because "funding" appears in both halves of that pair and a keyword
 * reading would introduce two founders who both need money.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLES, ROLE_LABELS, ROLE_PREDICATE,
  complementaryPair, declaredRoles, isSeekingRole, isUnambiguous,
  rolesComplement, rolesOf,
} from "../src/graph/roles.js";
import { proposeIntroductions } from "../src/graph/matching.js";

/* --- the four pair, and only the four ----------------------------------- */

test("the pairs close, and nothing else complements", () => {
  assert.ok(rolesComplement(ROLES.HIRING, ROLES.SEEKING_EMPLOYMENT));
  assert.ok(rolesComplement(ROLES.SEEKING_EMPLOYMENT, ROLES.HIRING));
  assert.ok(rolesComplement(ROLES.SEEKING_FUNDING, ROLES.FUNDING_STARTUPS));
  assert.ok(rolesComplement(ROLES.FUNDING_STARTUPS, ROLES.SEEKING_FUNDING));

  // Two people who both need money are not a match. Neither are two recruiters.
  assert.ok(!rolesComplement(ROLES.SEEKING_FUNDING, ROLES.SEEKING_FUNDING));
  assert.ok(!rolesComplement(ROLES.HIRING, ROLES.HIRING));
  assert.ok(!rolesComplement(ROLES.HIRING, ROLES.SEEKING_FUNDING));
  assert.ok(!rolesComplement(ROLES.SEEKING_EMPLOYMENT, ROLES.FUNDING_STARTUPS));
});

test("exactly one side of each pair is the asking side", () => {
  // Direction is not ambiguous for a declaration, so it must not be guessed
  // twice — otherwise one meeting lands in the review queue from both ends.
  assert.ok(isSeekingRole(ROLES.SEEKING_EMPLOYMENT));
  assert.ok(isSeekingRole(ROLES.SEEKING_FUNDING));
  assert.ok(!isSeekingRole(ROLES.HIRING));
  assert.ok(!isSeekingRole(ROLES.FUNDING_STARTUPS));
});

/* --- reading the declaration -------------------------------------------- */

test("each role is recognised from how a person actually writes it", () => {
  assert.deepEqual(declaredRoles("We are hiring two backend engineers"), [ROLES.HIRING]);
  assert.deepEqual(declaredRoles("Looking to hire a designer"), [ROLES.HIRING]);
  assert.deepEqual(declaredRoles("I am looking for a new role in fintech"),
    [ROLES.SEEKING_EMPLOYMENT]);
  assert.deepEqual(declaredRoles("We are raising a seed round"), [ROLES.SEEKING_FUNDING]);
  assert.deepEqual(declaredRoles("I need funding"), [ROLES.SEEKING_FUNDING]);
  assert.deepEqual(declaredRoles("I invest in early-stage startups"),
    [ROLES.FUNDING_STARTUPS]);
  assert.deepEqual(declaredRoles("I am an angel"), [ROLES.FUNDING_STARTUPS]);
});

test("the two halves of the funding pair are never confused", () => {
  // THE LOAD-BEARING TEST. Both roles contain the word "funding", and they are
  // opposites. A keyword reading would pair two founders who both need money —
  // the same error as matching on "resume", with worse consequences.
  const raising = declaredRoles("We are raising funding for our seed round");
  const deploying = declaredRoles("I fund startups at pre-seed");
  assert.deepEqual(raising, [ROLES.SEEKING_FUNDING]);
  assert.deepEqual(deploying, [ROLES.FUNDING_STARTUPS]);
  assert.ok(!rolesComplement(raising[0], raising[0]));
});

test("a negation never declares its own opposite", () => {
  for (const text of [
    "We are not hiring right now",
    "We aren't hiring this quarter",
    "I'm no longer looking for a role",
    "We are not raising at the moment",
  ]) {
    assert.deepEqual(declaredRoles(text), [], `"${text}" must declare nothing`);
  }
});

test("a negation in one sentence does not silence a declaration in the next", () => {
  // Rejecting the whole message would lose the real answer. The negation is
  // scoped to its sentence, which is the scope a person means it in.
  assert.deepEqual(
    declaredRoles("We're not hiring engineers. But we are raising a seed round."),
    [ROLES.SEEKING_FUNDING],
  );
});

test("a person can declare two roles, because a founder can do two things", () => {
  const roles = declaredRoles("We are hiring and we are raising a seed round");
  assert.equal(roles.length, 2);
  assert.ok(roles.includes(ROLES.HIRING));
  assert.ok(roles.includes(ROLES.SEEKING_FUNDING));
  assert.ok(isUnambiguous(roles), "two is a real answer, not a misread");
});

test("the messages that produced garbage before now declare nothing", () => {
  // These are the exact bodies from the live run. "Did you get my resume?" is
  // where the résumé match came from; a reply whose whole body is a signature
  // is five of six messages on a real mailbox.
  for (const text of [
    "Did you get my resume?",
    "Sent from my iPhone",
    "I'm Mark",
    "",
    "   ",
  ]) {
    assert.deepEqual(declaredRoles(text), [],
      `"${text}" must not be read as a business intent`);
  }
});

test("no answer is an empty answer, which means ask again", () => {
  assert.ok(!isUnambiguous([]), "silence is not a declaration");
});

/* --- projection --------------------------------------------------------- */

test("roles are read from observations, and a retraction removes one", () => {
  const rows = [
    { predicate: ROLE_PREDICATE, object: ROLES.HIRING },
    { predicate: ROLE_PREDICATE, object: ROLES.SEEKING_FUNDING, attributes: { retracted: true } },
    { predicate: "capability", object: "Kubernetes" },
  ];
  assert.deepEqual(rolesOf(rows), [ROLES.HIRING]);
});

test("complementaryPair names which of two role sets answer each other", () => {
  const pair = complementaryPair([ROLES.SEEKING_EMPLOYMENT], [ROLES.HIRING, ROLES.SEEKING_FUNDING]);
  assert.deepEqual(pair, { seeker: ROLES.SEEKING_EMPLOYMENT, offerer: ROLES.HIRING });
  assert.equal(complementaryPair([ROLES.HIRING], [ROLES.HIRING]), null);
});

/* --- matching on declarations ------------------------------------------- */

const claim = (subject, predicate, object, evidenceId = "message:m1", extra = {}) => ({
  subject, predicate, object, evidenceId,
  quote: `…${object}…`, observedAt: "2026-08-27T12:00:00Z", ...extra,
});

test("a declared pair is introduced once, in the direction that reads right", () => {
  const proposals = proposeIntroductions({
    observations: [
      claim("p:jim", ROLE_PREDICATE, ROLES.HIRING, "message:m1",
        { quote: "We are hiring two backend engineers" }),
      claim("p:dana", ROLE_PREDICATE, ROLES.SEEKING_EMPLOYMENT, "message:m2",
        { quote: "I am looking for a new role" }),
    ],
  });

  assert.equal(proposals.length, 1, "one meeting is one proposal");
  const [only] = proposals;
  assert.equal(only.seeker, "p:dana", "the person asking is the seeker");
  assert.equal(only.offerer, "p:jim");
  assert.ok(only.confidence >= 0.7, "a declaration outranks anything inferred");
  assert.match(only.reasons[0].detail, /looking for work.*answered by.*hiring/);
  assert.equal(only.evidence[0].quote, "I am looking for a new role",
    "each side carries the sentence they said it in");
});

test("documents rank a declared pair, they do not create it", () => {
  const base = [
    claim("p:jim", ROLE_PREDICATE, ROLES.HIRING),
    claim("p:dana", ROLE_PREDICATE, ROLES.SEEKING_EMPLOYMENT, "message:m2"),
  ];
  const bare = proposeIntroductions({ observations: base })[0];
  const backed = proposeIntroductions({
    observations: [
      ...base,
      claim("p:jim", "capability", "Kubernetes", "link:jimco"),
      claim("p:dana", "capability", "Kubernetes", "attachment:danacv"),
    ],
  })[0];

  assert.ok(backed.confidence > bare.confidence,
    "shared evidence is what separates a good match from a valid one");
  assert.ok(backed.reasons.some((r) => r.id === "document_corroboration"));
});

test("a document alone never produces an introduction", () => {
  // The rule the résumé bug was paid for, restated for the role path: only a
  // person can say what they want.
  assert.deepEqual(proposeIntroductions({
    observations: [
      claim("p:jim", "capability", "Kubernetes", "attachment:a"),
      claim("p:dana", "capability", "Kubernetes", "attachment:b"),
    ],
    threshold: 0.01,
  }), []);
});

test("two people on the same side of a pair are never introduced", () => {
  assert.deepEqual(proposeIntroductions({
    observations: [
      claim("p:a", ROLE_PREDICATE, ROLES.SEEKING_FUNDING),
      claim("p:b", ROLE_PREDICATE, ROLES.SEEKING_FUNDING, "message:m2"),
    ],
    threshold: 0.01,
  }), [], "two founders who both need money are not a match");
});

test("nobody is introduced to themselves, even declaring both sides", () => {
  // The résumé email introduced Mark to Mark. A person who is hiring AND
  // job-hunting must not become their own match.
  assert.deepEqual(proposeIntroductions({
    observations: [
      claim("p:solo", ROLE_PREDICATE, ROLES.HIRING),
      claim("p:solo", ROLE_PREDICATE, ROLES.SEEKING_EMPLOYMENT),
    ],
    threshold: 0.01,
  }), []);
});

test("every role has a label a person would recognise in an email", () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(typeof ROLE_LABELS[role], "string");
    assert.ok(ROLE_LABELS[role].length > 0, `${role} needs a human label`);
  }
});
