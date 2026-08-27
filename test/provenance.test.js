/**
 * Which of this belongs where — and why matching had been ignoring most of it.
 *
 * `proposeIntroductions` filtered the graph to `intent:` rows and scored those
 * against each other. Every fact a résumé or a portfolio produced was invisible
 * to it, so the only thing that decided an introduction was a sentence somebody
 * typed in an email — the least considered thing they send.
 *
 * Two properties are tested here, and the second matters more than the first:
 *
 *   1. Documents substantiate a stated intent, raising its score and supplying
 *      the specifics the email lacked.
 *   2. Documents NEVER become an intent. A CV states capability, not desire;
 *      "knows Rust" is not "wants a Rust job". A scorer that read it as one
 *      would introduce a contented employee to a recruiter on the strength of a
 *      skills list, which is the résumé bug wearing a better disguise.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_KINDS, SOURCE_KINDS,
  documentFacts, documentVocabulary, groupBySource,
  indexDocumentVocabulary, isDocumentClaim, significantWords, sourceKindOf,
} from "../src/graph/provenance.js";
import { proposeIntroductions } from "../src/graph/matching.js";

const claim = (subject, predicate, object, evidenceId, extra = {}) => ({
  subject, predicate, object, evidenceId,
  quote: `…${object}…`,
  observedAt: "2026-08-27T12:00:00Z",
  ...extra,
});

/* --- provenance is read from the id ------------------------------------- */

test("the kind is read from the evidence id, not looked up", () => {
  // Evidence is content-addressed as `${kind}:${hash}`, so the id already
  // states its provenance. A lookup would be a second source of truth for a
  // fact the first one carries.
  assert.equal(sourceKindOf("message:0cce4e55"), SOURCE_KINDS.MESSAGE);
  assert.equal(sourceKindOf("attachment:eea45f00"), SOURCE_KINDS.ATTACHMENT);
  assert.equal(sourceKindOf("link:9f2b1c"), SOURCE_KINDS.LINK);
  assert.equal(sourceKindOf("vendor:abc123"), SOURCE_KINDS.VENDOR);
});

test("a claim with no evidence is the operator's, not provenance-less", () => {
  // Corrections are made by a person at a keyboard. There is no document to
  // point at and none is missing.
  assert.equal(sourceKindOf(null), SOURCE_KINDS.OPERATOR);
  assert.equal(sourceKindOf(undefined), SOURCE_KINDS.OPERATOR);
});

test("an unrecognised prefix is treated as a message, not dropped", () => {
  // Losing a claim because its evidence kind is new is worse than filing it
  // conservatively: a document cannot substantiate on the strength of a prefix
  // nobody has defined yet.
  assert.equal(sourceKindOf("something_new:abc"), SOURCE_KINDS.MESSAGE);
});

test("only authored sources count as documents", () => {
  assert.ok(DOCUMENT_KINDS.has(SOURCE_KINDS.ATTACHMENT));
  assert.ok(DOCUMENT_KINDS.has(SOURCE_KINDS.LINK));
  assert.ok(!DOCUMENT_KINDS.has(SOURCE_KINDS.MESSAGE),
    "a message cannot corroborate itself — that is one claim counted twice");
  assert.ok(!DOCUMENT_KINDS.has(SOURCE_KINDS.OPERATOR));
});

/* --- grouping: which of this belongs where ------------------------------ */

test("claims are grouped by what produced them", () => {
  const groups = groupBySource([
    claim("p:jim", "intent:SEEKING", "a react contractor", "message:aaa"),
    claim("p:jim", "skill", "React", "attachment:bbb"),
    claim("p:jim", "works_at", "Acme", "link:ccc"),
    claim("p:jim", "note", "spoke at a conference", null),
  ]);

  assert.equal(groups[SOURCE_KINDS.MESSAGE].length, 1);
  assert.equal(groups[SOURCE_KINDS.ATTACHMENT].length, 1);
  assert.equal(groups[SOURCE_KINDS.LINK].length, 1);
  assert.equal(groups[SOURCE_KINDS.OPERATOR].length, 1);
});

test("document facts exclude intents, even when a document produced one", () => {
  // Otherwise a single claim scores twice: once as the intent, once as its own
  // corroboration.
  const facts = documentFacts([
    claim("p:jim", "skill", "Rust", "attachment:bbb"),
    claim("p:jim", "intent:OFFERING", "rust consulting", "attachment:bbb"),
    claim("p:jim", "skill", "Go", "message:aaa"),
  ]);
  assert.deepEqual(facts.map((f) => f.object), ["Rust"]);
});

test("a retracted fact vouches for nothing", () => {
  const facts = documentFacts([
    claim("p:jim", "skill", "Rust", "attachment:bbb", { attributes: { retracted: true } }),
  ]);
  assert.deepEqual(facts, []);
});

/* --- vocabulary --------------------------------------------------------- */

test("the vocabulary carries the quote, because the quote is the deliverable", () => {
  // "David's CV lists React" is a sentence an introduction can contain. "the
  // vocabularies overlapped" is not, and an introduction that cannot say why it
  // happened is the one the recipient does not trust.
  const vocabulary = documentVocabulary([
    claim("p:d", "skill", "React", "attachment:cv1", { quote: "6 years of React" }),
  ]);
  assert.equal(vocabulary.get("react").quote, "6 years of React");
  assert.equal(vocabulary.get("react").evidenceId, "attachment:cv1");
});

test("attribute values are vouched for too, not just the object", () => {
  const vocabulary = documentVocabulary([
    claim("p:d", "role", "engineer", "attachment:cv1", {
      attributes: { sector: "fintech", stack: ["Kubernetes", "Postgres"] },
    }),
  ]);
  for (const word of ["engineer", "fintech", "kubernetes", "postgres"]) {
    assert.ok(vocabulary.has(word), `${word} must be vouched for`);
  }
});

test("noise words are not vocabulary", () => {
  // "experience", "years" and "team" appear in every CV ever written. Matching
  // on them would make every pair of résumés corroborate each other.
  const vocabulary = documentVocabulary([
    claim("p:d", "note", "years of experience working with the team", "attachment:cv1"),
  ]);
  assert.equal(vocabulary.size, 0);
});

test("the short, punctuated language names survive tokenising", () => {
  // The bug this replaced: trailing punctuation was stripped and then three
  // characters were required, so "C#" became "c" and was discarded — a C#
  // developer could never be corroborated on C#. Same for C++, F# and .NET.
  // "Go" and "R" failed on length alone, which on an engineering network is
  // the worst possible pair of words to be unable to match.
  assert.deepEqual(significantWords("C# and Node.js"), ["c#", "node.js"]);
  assert.deepEqual(significantWords("C++, Go, R"), ["c++", "go", "r"].filter((w) => w.length >= 2));
  assert.deepEqual(significantWords("Ships in Rust."), ["ships", "rust"],
    "a sentence period is not part of the word, but the dot in Node.js is");
});

/* --- the payoff: documents change a match ------------------------------- */

const intent = (subject, type, object, evidenceId = "message:m1") => ({
  subject,
  predicate: `intent:${type}`,
  object,
  quote: `${subject} said ${object}`,
  evidenceId,
});

test("a portfolio supplies the specifics the emails never shared", () => {
  // THE CASE THIS FEATURE IS FOR. Jim wants a Kubernetes contractor. Dana's
  // email says only "engineering help" — no overlap, no shared attribute, so
  // before this the pair scored on predicate shape alone and was flagged thin.
  // Her portfolio says Kubernetes.
  const observations = [
    intent("p:jim", "SEEKING", "a kubernetes contractor"),
    intent("p:dana", "OFFERING", "engineering help", "message:m2"),
    claim("p:dana", "skill", "Kubernetes", "link:portfolio1",
      { quote: "Kubernetes migrations for three fintechs" }),
  ];

  const [proposal] = proposeIntroductions({ observations, threshold: 0.4 });
  assert.ok(proposal, "the pair must now be proposed at all");
  assert.equal(proposal.seeker, "p:jim");
  assert.equal(proposal.offerer, "p:dana");

  const corroboration = proposal.reasons.find((r) => r.id === "document_corroboration");
  assert.ok(corroboration, "the document must be a named reason, not a silent bump");
  assert.match(corroboration.detail, /portfolio/, "a person reads 'portfolio', not 'link'");
  assert.deepEqual(corroboration.matched, ["kubernetes"]);
  assert.equal(corroboration.quotes[0].quote, "Kubernetes migrations for three fintechs",
    "the reason must carry a quote the recipient can check");

  assert.ok(!proposal.conflicts.some((c) => c.id === "no_shared_specifics"),
    "evidence only one side authored is a stronger specific than a shared word");
});

test("the direction is checked: the OFFERER's evidence answers the SEEKER's ask", () => {
  // What we want to know is whether the offerer can do the thing being asked
  // for. A seeker's own CV proving they know Kubernetes says nothing about
  // whether the other person can help.
  const observations = [
    intent("p:jim", "SEEKING", "a kubernetes contractor"),
    claim("p:jim", "skill", "Kubernetes", "attachment:jimcv"),
    intent("p:dana", "OFFERING", "engineering help", "message:m2"),
  ];

  const proposals = proposeIntroductions({ observations, threshold: 0.4 });
  const forward = proposals.find((p) => p.seeker === "p:jim" && p.offerer === "p:dana");
  assert.ok(!forward?.reasons.some((r) => r.id === "document_corroboration"),
    "the seeker's own résumé must not corroborate the offerer's ability");
});

test("a résumé NEVER creates an intent", () => {
  // The rule the résumé bug was paid for. A CV states capability, not desire —
  // a person whose CV lists Rust has not asked for anything, and nobody should
  // be introduced to them on the strength of a skills list.
  const observations = [
    intent("p:jim", "SEEKING", "a rust engineer"),
    claim("p:dana", "skill", "Rust", "attachment:cv1"),
    claim("p:dana", "works_at", "Acme", "attachment:cv1"),
  ];
  assert.deepEqual(proposeIntroductions({ observations, threshold: 0.01 }), [],
    "with no stated intent from Dana there is no match to make, at any threshold");
});

test("corroboration is weighted below a stated intent", () => {
  // A document proves capability; only a person can state desire. If evidence
  // outvoted the sentence, the loudest CV would win over the clearest ask.
  const stated = proposeIntroductions({
    observations: [
      intent("p:jim", "SEEKING", "a kubernetes contractor"),
      intent("p:dana", "OFFERING", "kubernetes contracting"),
    ],
    threshold: 0.01,
  })[0];

  const corroborated = proposeIntroductions({
    observations: [
      intent("p:jim", "SEEKING", "a kubernetes contractor"),
      intent("p:eve", "OFFERING", "engineering help", "message:m3"),
      claim("p:eve", "skill", "Kubernetes", "link:portfolio2"),
    ],
    threshold: 0.01,
  })[0];

  assert.ok(stated.confidence > corroborated.confidence,
    "two people who said the same thing outrank one whose document implies it");
});

test("the vocabulary index is built once per subject, not once per pair", () => {
  const index = indexDocumentVocabulary([
    claim("p:a", "skill", "React", "attachment:1"),
    claim("p:b", "skill", "Rust", "attachment:2"),
    claim("p:a", "skill", "Go", "attachment:1"),
  ]);
  assert.equal(index.size, 2);
  assert.ok(index.for("p:a").has("react"));
  assert.ok(index.for("p:a").has("go"));
  assert.equal(index.for("p:nobody").size, 0, "an unknown subject needs no guard at the call site");
});

test("isDocumentClaim is the single predicate the rest of this is built on", () => {
  assert.equal(isDocumentClaim({ evidenceId: "attachment:x" }), true);
  assert.equal(isDocumentClaim({ evidenceId: "message:x" }), false);
  assert.equal(isDocumentClaim({}), false);
});
