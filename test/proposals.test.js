/**
 * Proposals: Yente's graded, positive-only read of a résumé.
 *
 * Mark's directive, 2026-08-29: "build 'proposals' for people who send
 * resumes (every participant)... best candidate for job xyz, good candidate
 * for investment in xyz... only have the model grade resumes for GOOD
 * reasons, not anything negative — determining negatives about a resume
 * could be time consuming and expensive, therefore only judge the book by
 * its cover... make sure we have the model building those proposals
 * alongside matches... determine hire-ability and make proposals for well
 * fitting jobs."
 *
 * The positivity is STRUCTURAL, in this schema's house style: the grade
 * scale has no bottom below "good", the normalizer copies no field a
 * weakness could ride in on, and the matching arm can only add weight or
 * stay silent. A person a résumé does not support proposing is simply not
 * proposed — absence is the only "no", and absence is free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_GROUPS, PROPOSAL_GRADES, PROPOSAL_KINDS, validateEnvelope,
} from "../src/intelligence/schema.js";
import { readEnvelope, createIntelligenceProvider } from "../src/intelligence/provider.js";
import { createObservationPrompt, OBSERVER_SYSTEM } from "../src/intelligence/prompt.js";
import { observationsFrom } from "../src/intelligence/queue.js";
import { proposeIntroductions } from "../src/graph/matching.js";
import { ROLES, ROLE_PREDICATE } from "../src/graph/roles.js";

const evidence = (quote, sourceId = "attachment:cv1") => ({
  source_id: sourceId, evidence: quote, explicit: false, confidence: 0.8,
});

const PERSON = {
  ref: "p1", kind: "PERSON", name: "Dana Ito",
  source_id: "attachment:cv1", evidence: "Dana Ito — Platform Engineer",
  explicit: true, confidence: 0.95,
};

/* --- the schema: closed kinds, a scale with no bottom -------------------- */

test("proposals joined the claim groups with a closed kind and grade", () => {
  assert.ok(CLAIM_GROUPS.includes("proposals"));
  assert.deepEqual([...PROPOSAL_KINDS], ["hire_for", "invest_in"]);
  assert.deepEqual([...PROPOSAL_GRADES], ["good", "strong", "exceptional"],
    "the scale starts at good — there is nothing below it to say");
});

test("a well-formed proposal survives validation", () => {
  const { envelope, rejected } = validateEnvelope({
    entities: [PERSON],
    proposals: [{
      subject_ref: "p1", kind: "hire_for",
      target: "Kubernetes platform engineering roles", grade: "strong",
      ...evidence("Ran the Kubernetes platform at Acme."),
    }],
  });
  assert.equal(rejected.length, 0);
  assert.equal(envelope.proposals.length, 1);
  assert.equal(envelope.proposals[0].kind, "hire_for");
  assert.equal(envelope.proposals[0].grade, "strong");
});

test("an unknown kind and a negative grade are rejected AND counted", () => {
  const { envelope, rejected } = validateEnvelope({
    entities: [PERSON],
    proposals: [
      { subject_ref: "p1", kind: "date_with", target: "someone nice", grade: "good",
        ...evidence("q") },
      { subject_ref: "p1", kind: "hire_for", target: "backend roles", grade: "weak",
        ...evidence("q") },
      { subject_ref: "p1", kind: "hire_for", target: "backend roles", grade: "poor",
        ...evidence("q") },
    ],
  });
  assert.equal(envelope.proposals.length, 0);
  assert.deepEqual(rejected.map((r) => r.code),
    ["UNKNOWN_PROPOSAL_KIND", "UNKNOWN_PROPOSAL_GRADE", "UNKNOWN_PROPOSAL_GRADE"],
    "a grade below good is UNREPRESENTABLE, not merely discouraged");
});

test("volunteered negativity has no field to land in", () => {
  // A model that ships weaknesses anyway finds them dropped by construction:
  // the normalizer builds the claim from named fields, never a spread.
  const { envelope } = validateEnvelope({
    entities: [PERSON],
    proposals: [{
      subject_ref: "p1", kind: "hire_for", target: "backend roles", grade: "good",
      weaknesses: ["no leadership experience"], concerns: "gap in 2024", score: 2,
      ...evidence("Built the storage layer."),
    }],
  });
  const [proposal] = envelope.proposals;
  assert.equal(proposal.weaknesses, undefined);
  assert.equal(proposal.concerns, undefined);
  assert.equal(proposal.score, undefined);
  assert.deepEqual(Object.keys(proposal).sort(),
    ["confidence", "evidence", "explicit", "grade", "kind", "sourceId", "subjectRef", "target"]);
});

test("a proposal about an undeclared person dangles and is dropped", () => {
  const { envelope, rejected } = validateEnvelope({
    proposals: [{
      subject_ref: "ghost", kind: "hire_for", target: "backend roles", grade: "good",
      ...evidence("q"),
    }],
  });
  assert.equal(envelope.proposals.length, 0);
  assert.equal(rejected[0].code, "DANGLING_REF");
});

/* --- the wire: one claim line like any other ----------------------------- */

test("the line reader routes a proposal claim into its group", () => {
  const { raw } = readEnvelope([
    "<<<OBSERVATIONS>>>",
    JSON.stringify({
      claim: "proposal", subject_ref: "p1", kind: "hire_for",
      target: "Rust backend roles", grade: "exceptional",
      source_id: "attachment:cv1", evidence: "Built the storage layer in Rust.",
      explicit: false, confidence: 0.8,
    }),
    "<<<END>>>",
  ].join("\n"));
  assert.equal(raw.proposals.length, 1);
  assert.equal(raw.proposals[0].grade, "exceptional");
});

test("a proposal's target is grounded like any claim's substance", async () => {
  // The TARGET is what verification traces: the grade is judgment, but the
  // quote behind it must exist verbatim or the proposal dies at the gate.
  const sources = [{ id: "attachment:cv1", text: "Dana Ito — Platform Engineer. Ran the Kubernetes platform at Acme." }];
  const line = (targetEvidence) => [
    "<<<OBSERVATIONS>>>",
    JSON.stringify({ claim: "entity", ref: "p1", kind: "PERSON", name: "Dana Ito",
      source_id: "attachment:cv1", evidence: "Dana Ito — Platform Engineer.",
      explicit: true, confidence: 0.95 }),
    JSON.stringify({ claim: "proposal", subject_ref: "p1", kind: "hire_for",
      target: "Kubernetes platform roles", grade: "strong",
      source_id: "attachment:cv1", evidence: targetEvidence,
      explicit: false, confidence: 0.8 }),
    "<<<END>>>",
  ].join("\n");

  const observe = (text) => createIntelligenceProvider({
    client: { async complete() { return { text, finishReason: "stop", elapsedMs: 1 }; } },
    provider: "pin", model: "muse-local:latest",
    sleep: async () => {}, now: () => "2026-08-29T20:30:00.000Z",
  }).observe({ sources });

  const grounded = await observe(line("Ran the Kubernetes platform at Acme."));
  assert.equal(grounded.verified.proposals.length, 1);

  const invented = await observe(line("Certified Kubernetes administrator since 2019."));
  assert.equal(invented.verified.proposals.length, 0,
    "a quote that appears nowhere in the source does not carry a grade into the graph");
});

/* --- the graph: namespaced rows, grade as attribute ----------------------- */

const baseObservation = {
  evidenceId: "attachment:cv1",
  provenance: { model: "test", schemaVersion: "obs_v2", contentHash: "h" },
  observedAt: "2026-08-29T20:00:00Z",
  sentAt: "2026-08-29T19:00:00Z",
  senderSubject: "person:dana@example.com",
};

test("a proposal lands as a proposal:-namespaced row with its grade riding along", () => {
  const out = observationsFrom({
    ...baseObservation,
    verified: {
      entities: [{ ref: "p1", kind: "PERSON", name: "Dana Ito", emailAddress: "dana@example.com",
        evidence: "Dana Ito", explicit: true, confidence: 0.95 }],
      intents: [], relationships: [], disclosures: [],
      proposals: [{
        subjectRef: "p1", kind: "hire_for", target: "Kubernetes platform roles",
        grade: "strong", sourceId: "attachment:cv1",
        evidence: "Ran the Kubernetes platform.", explicit: false, confidence: 0.8,
      }],
    },
  });
  const row = out.find((r) => r.predicate === "proposal:hire_for");
  assert.ok(row, "the kind namespaces the predicate, like intent: does");
  assert.equal(row.object, "Kubernetes platform roles");
  assert.equal(row.attributes.grade, "strong",
    "the grade is judgment ABOUT the fit, not part of the fit's identity");
  assert.equal(row.subject, "person:dana@example.com");
});

test("the intake guard covers proposal targets too", () => {
  const out = observationsFrom({
    ...baseObservation,
    verified: {
      entities: [{ ref: "p1", kind: "PERSON", name: "Dana Ito", emailAddress: "dana@example.com",
        evidence: "Dana Ito", explicit: true, confidence: 0.95 }],
      intents: [], relationships: [], disclosures: [],
      proposals: [{
        // Pure intake vocabulary. ("sending a resume" would survive — the
        // guard is every-word, so real activity words keep a claim alive.)
        subjectRef: "p1", kind: "hire_for", target: "my resume",
        grade: "good", sourceId: "attachment:cv1",
        evidence: "my resume", explicit: false, confidence: 0.8,
      }],
    },
  });
  assert.ok(!out.some((r) => String(r.predicate).startsWith("proposal:")),
    "'strong candidate for sending a resume' is the onboarding conversation "
    + "dressed as an endorsement");
});

/* --- the prompt: judge the cover, positives only -------------------------- */

test("the doctrine rides the contract; the worked example rides the system", () => {
  // The glossary (kind-by-kind guidance) lives in the per-prompt OUTPUT
  // contract; the worked examples live in the system message. Assert each
  // where it actually is.
  const prompt = createObservationPrompt({
    sources: [{ id: "message:m1", text: "hello" }],
  });
  assert.match(prompt, /JUDGE THE COVER/, "the doctrine is named, in Mark's words");
  assert.match(prompt, /scale has no bottom, ON PURPOSE/i);
  assert.match(prompt, /handled by\s+SILENCE, and silence is free/i,
    "absence is the only no");
  assert.match(OBSERVER_SYSTEM, /"claim": "proposal".*"kind": "hire_for"/,
    "example 2 shows a proposal coming off the résumé");
});

test("the vocabulary block hands the model the closed kinds and grades", () => {
  const prompt = createObservationPrompt({
    sources: [{ id: "message:m1", text: "hello" }],
  });
  assert.match(prompt, /"proposal_kinds"/);
  assert.match(prompt, /"hire_for"/);
  assert.match(prompt, /"proposal_grades"/);
  assert.match(prompt, /"exceptional"/);
});

/* --- matching: proposals rank alongside matches --------------------------- */

const claim = (subject, predicate, object, evidenceId = "message:m1", extra = {}) => ({
  subject, predicate, object, evidenceId,
  quote: `…${object}…`, observedAt: "2026-08-29T12:00:00Z", ...extra,
});

test("a graded proposal ranks a declared pair and travels as a named reason", () => {
  const base = [
    claim("p:jim", ROLE_PREDICATE, ROLES.HIRING),
    claim("p:dana", ROLE_PREDICATE, ROLES.SEEKING_EMPLOYMENT, "message:m2"),
    // The offerer's ask, evidenced in a document, is what the target must touch.
    claim("p:jim", "capability", "Kubernetes", "link:jimco"),
  ];
  const bare = proposeIntroductions({ observations: base })[0];
  const endorsed = proposeIntroductions({
    observations: [
      ...base,
      claim("p:dana", "proposal:hire_for", "Kubernetes platform engineering roles",
        "attachment:danacv", { attributes: { grade: "exceptional" },
          quote: "Ran the Kubernetes platform at Acme." }),
    ],
  })[0];

  assert.ok(endorsed.confidence > bare.confidence,
    "Yente's read warms the introduction");
  const reason = endorsed.reasons.find((r) => r.id === "graded_proposal");
  assert.ok(reason, "the grade is a named, quotable reason, never a silent number");
  assert.match(reason.detail, /exceptional candidate for Kubernetes platform engineering roles/);
  assert.equal(reason.quotes[0].quote, "Ran the Kubernetes platform at Acme.",
    "the endorsement carries the line it stands on");
});

test("the family gate: an investment endorsement says nothing about a hiring pair", () => {
  const base = [
    claim("p:jim", ROLE_PREDICATE, ROLES.HIRING),
    claim("p:dana", ROLE_PREDICATE, ROLES.SEEKING_EMPLOYMENT, "message:m2"),
    claim("p:jim", "capability", "Kubernetes", "link:jimco"),
  ];
  const [proposal] = proposeIntroductions({
    observations: [
      ...base,
      claim("p:dana", "proposal:invest_in", "Kubernetes tooling venture",
        "attachment:danacv", { attributes: { grade: "exceptional" } }),
    ],
  });
  assert.ok(!proposal.reasons.some((r) => r.id === "graded_proposal"),
    "an exceptional investment candidate is not thereby a hire");
});

test("a proposal ranks a match; it never establishes one", () => {
  // Two intents that complement in shape but share NO specifics stay refused,
  // however glowing the endorsement — the positive-only arm can warm a real
  // match, never conjure one.
  const [refused] = proposeIntroductions({
    observations: [
      claim("p:dana", "intent:SEEKING", "a new engineering role", "message:m2"),
      claim("p:jim", "intent:HIRING", "someone for the design team", "message:m1"),
      claim("p:dana", "proposal:hire_for", "engineering role work",
        "attachment:danacv", { attributes: { grade: "exceptional" } }),
    ],
    threshold: 0.39,
  }).filter((p) => p.seeker === "p:dana");
  if (refused) {
    assert.ok(!refused.reasons.some((r) => r.id === "graded_proposal")
      || refused.reasons.some((r) => r.id === "subject_overlap")
      || refused.reasons.some((r) => r.id === "attribute_match"),
      "no proposal weight without a shared specific underneath it");
  }
});

/* --- a fenced envelope reads end to end ----------------------------------- */

test("readEnvelope unwraps a markdown-fenced envelope and reads it strictly", () => {
  // The 2026-08-31 live failure: a perfect answer wearing ```json. The
  // reading edge unwraps the chat reflex; every other rule stays strict.
  const { raw } = readEnvelope([
    "```json",
    "<<<OBSERVATIONS>>>",
    JSON.stringify({
      claim: "proposal", subject_ref: "p1", kind: "invest_in",
      target: "Interchained LLC", grade: "strong",
      source_id: "attachment:cv1", evidence: "Founder & Systems Architect | Interchained LLC",
      explicit: false, confidence: 0.8,
    }),
    "<<<END>>>",
    "```",
  ].join("\n"));
  assert.equal(raw.proposals.length, 1);
  assert.equal(raw.proposals[0].target, "Interchained LLC");
});
