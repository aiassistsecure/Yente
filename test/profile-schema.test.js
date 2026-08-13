/**
 * The field vocabulary — the drift that cost sixteen facts.
 *
 * THE INCIDENT THESE PIN
 *
 * A real résumé (DOCX, 6728 characters) was parsed, extracted, and produced 16
 * facts. Every one was span-verified: the evidence was literally in the
 * document. All sixteen were then dropped by the profile view, because three
 * modules disagreed about what a field is called and nothing tied them
 * together:
 *
 *   - the extraction prompt was handed `vocabulary: {}` — EMPTY — so the model
 *     chose its own field names;
 *   - `buildProfileView` hardcoded a different set;
 *   - the qualification policy named a third set, and existed only in
 *     test-support/fixtures.js.
 *
 * Nothing threw. The member was asked to supply what he had already supplied.
 *
 * The field names in FIELD_PATHS_FROM_A_REAL_RESUME are not invented for this
 * test — they are exactly what the model emitted, read back out of the ledger.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIELDS,
  ALIASES,
  IGNORED_FIELDS,
  resolveField,
  extractionVocabulary,
  questionsFor,
  canonicalFields,
} from "../src/domain/profile-schema.js";
import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { buildProfileView, unmappedFields } from "../src/store/profile-view.js";
import { evaluateQualification } from "../src/domain/qualification.js";
import { memberQualificationPolicy } from "../src/domain/policies.js";

/** Verbatim from `bin/inspect.mjs` against the live ledger. */
const FIELD_PATHS_FROM_A_REAL_RESUME = [
  "education.degree",
  "education.institution",
  "professional.email",
  "professional.employer.current",
  "professional.employer.past",
  "professional.experience_years",
  "professional.location",
  "professional.name",
  "professional.role",
  "professional.skills.languages",
  "professional.title",
];

test("every field name a real model produced now resolves or is deliberately ignored", () => {
  const lost = FIELD_PATHS_FROM_A_REAL_RESUME
    .map((path) => ({ path, ...resolveField(path) }))
    .filter((r) => r.via === "unknown");

  assert.deepEqual(lost, [],
    "each of these was silently discarded in production; none may be unknown");
});

test("the three-segment paths resolve — pathTarget could never accept them", () => {
  // The old view split on "." and required EXACTLY two parts, so these were
  // rejected for their shape rather than their meaning. The model was not wrong.
  assert.equal(resolveField("professional.employer.current").field, "professional.employers");
  assert.equal(resolveField("professional.skills.languages").field, "professional.capabilities");
  assert.equal(resolveField("professional.employer.past").field, "professional.employers");
});

test("singular/plural and synonym drift resolves to one canonical field", () => {
  assert.equal(resolveField("professional.role").field, "professional.roles");
  assert.equal(resolveField("professional.title").field, "professional.roles");
  assert.equal(resolveField("professional.location").field, "professional.geographies");
  assert.equal(resolveField("professional.experience_years").field, "professional.years_experience");
  assert.equal(resolveField("professional.name").field, "professional.display_name");
});

test("contact details are dropped deliberately, and say so", () => {
  // Distinct from "unknown" on purpose. We already have the member's address —
  // it is how they reached us — and a second one lifted from a résumé is a
  // channel they never established (§5.1).
  const email = resolveField("professional.email");
  assert.equal(email.via, "ignored");
  assert.equal(email.field, null);
  assert.notEqual(resolveField("professional.email").via, "unknown");
});

test("a genuinely unknown field is reported as unknown, not quietly aliased", () => {
  // The aliases must not become a catch-all. Something nobody anticipated has
  // to be visible, or this whole class of bug returns.
  assert.equal(resolveField("astrology.sign").via, "unknown");
  assert.equal(resolveField("").via, "unknown");
});

test("every alias points at a field that exists", () => {
  for (const [from, to] of Object.entries(ALIASES)) {
    assert.ok(FIELDS[to], `alias ${from} -> ${to}, which is not a canonical field`);
  }
});

test("an alias never collides with a canonical name", () => {
  for (const from of Object.keys(ALIASES)) {
    assert.equal(FIELDS[from], undefined,
      `${from} is both canonical and an alias — resolution would be ambiguous`);
  }
  for (const ignored of IGNORED_FIELDS) {
    assert.equal(FIELDS[ignored], undefined, `${ignored} is both ignored and canonical`);
  }
});

test("the controlled vocabulary is not empty — the original defect", () => {
  const vocabulary = extractionVocabulary();
  assert.ok(Object.keys(vocabulary.fields).length >= 10,
    "the model was previously handed {} and invented its own field names");
  assert.deepEqual(Object.keys(vocabulary.fields).sort(), [...canonicalFields()].sort(),
    "the vocabulary IS the schema, so the two cannot drift");
  assert.ok(vocabulary.rules.some((r) => /ONLY these field names/.test(r)));
});

test("every required field of the production policy is a real field", () => {
  // A policy naming a field the schema does not have is unsatisfiable: the view
  // can never populate it, so the member can never qualify, and she would ask
  // for it forever.
  for (const path of memberQualificationPolicy.requiredFields) {
    assert.ok(FIELDS[path], `policy requires ${path}, which is not a canonical field`);
  }
});

test("missing fields become questions a person can answer", () => {
  const asks = questionsFor(["intent.seeks", "intent.introductionTypes"]);
  assert.equal(asks.length, 2);
  for (const ask of asks) {
    assert.doesNotMatch(ask, /intent\.|professional\./,
      "a field path in an email is unanswerable — nobody knows what an introductionType is");
  }
  assert.match(asks[0], /looking for/);
});

test("every field can be asked for in words", () => {
  for (const [path, spec] of Object.entries(FIELDS)) {
    assert.ok(spec.asks && spec.asks.length > 3, `${path} has no human question`);
    assert.doesNotMatch(spec.asks, /^[a-z]+\.[a-z_]+$/, `${path}'s question is a field path`);
  }
});

/* --- the end-to-end consequence ---------------------------------------- */

test("the real résumé's facts now populate a view — they all vanished before", () => {
  const MEMBER = "dev@interchained.org";
  const store = openInMemory();

  // The values are also verbatim from the ledger.
  const facts = [
    ["professional.name", "Mark Allen Evans Jr."],
    ["professional.role", "Founder & Systems Architect"],
    ["professional.role", "DevOps Engineer"],
    ["professional.employer.current", "Interchained LLC"],
    ["professional.employer.past", "Blockchained Solutions LLC"],
    ["professional.location", "Winter Park, FL"],
    ["professional.skills.languages", "Rust"],
    ["professional.experience_years", "10+"],
    ["education.degree", "A.S., Computer Programming & Analysis"],
    ["professional.email", "founders@vibecode-101.com"],
  ];
  for (const [field, value] of facts) {
    store.put(COLLECTIONS.PROFILE_FACTS, `${MEMBER}:${field}:${value}`, {
      memberId: MEMBER, field, value, explicit: true, sourceId: "src_1", evidence: value,
    });
  }

  const view = buildProfileView(store, MEMBER);

  assert.deepEqual(view.professional.roles, ["DevOps Engineer", "Founder & Systems Architect"]);
  assert.deepEqual(view.professional.employers,
    ["Blockchained Solutions LLC", "Interchained LLC"]);
  assert.deepEqual(view.professional.geographies, ["Winter Park, FL"]);
  assert.deepEqual(view.professional.capabilities, ["Rust"]);
  assert.equal(view.professional.years_experience, "10+");
  assert.equal(view.professional.display_name, "Mark Allen Evans Jr.");

  // Evidence is recorded under the CANONICAL name, because that is what the
  // qualification policy looks for. Recording it under the alias would satisfy
  // presence and fail the evidence check — qualification theatre.
  assert.ok(view.evidenceByField["professional.roles"]?.length >= 2);
  assert.equal(view.evidenceByField["professional.role"], undefined);

  // And the email did NOT come along.
  assert.ok(!JSON.stringify(view).includes("vibecode-101"));
});

test("a résumé alone still does not qualify anybody, and that is correct", () => {
  // The point of the fix is not "qualify everyone". A résumé says what somebody
  // has DONE; matching needs what they WANT. So she should still have exactly
  // one thing to ask about, rather than either silence or a false positive.
  const MEMBER = "dev@interchained.org";
  const store = openInMemory();
  for (const [field, value] of [
    ["professional.role", "Founder & Systems Architect"],
    ["professional.skills.languages", "Rust"],
    ["professional.location", "Winter Park, FL"],
  ]) {
    store.put(COLLECTIONS.PROFILE_FACTS, `${MEMBER}:${field}:${value}`, {
      memberId: MEMBER, field, value, explicit: true, sourceId: "src_1", evidence: value,
    });
  }

  const view = buildProfileView(store, MEMBER);
  const result = evaluateQualification(
    { ...view, id: MEMBER, state: "INTERVIEWING", inboundEstablishedAt: "2026-08-13T00:00:00Z" },
    memberQualificationPolicy,
  );

  assert.equal(result.qualified, false);
  assert.deepEqual([...result.missingFields], ["intent.seeks", "intent.introductionTypes"],
    "the professional side is satisfied by the résumé; only intent is outstanding");
  assert.deepEqual([...result.blockers], [], "INTERVIEWING is an allowed state");
});

test("unmapped fields are reportable, so this drift cannot hide again", () => {
  const MEMBER = "x@example.com";
  const store = openInMemory();
  for (const field of ["professional.role", "astrology.sign", "astrology.sign"]) {
    store.put(COLLECTIONS.PROFILE_FACTS, `${MEMBER}:${field}:v`, {
      memberId: MEMBER, field, value: "v", explicit: true, sourceId: "s", evidence: "v",
    });
  }
  assert.deepEqual(unmappedFields(store, MEMBER), [{ field: "astrology.sign", count: 1 }]);
});
