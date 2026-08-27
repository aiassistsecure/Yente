/**
 * The graph starts at one email and ends at what that email taught us.
 *
 * WHAT WAS WRONG WITH THE SHAPE
 *
 * The observer asked for five arrays per inference and the graph was the union
 * of those inventories. Three of the five actively encouraged the model to
 * manufacture:
 *
 *   opportunities   "a concrete business possibility the sources support" —
 *                   an invitation to speculate.
 *   observations    "anything else worth remembering that the shapes above do
 *                   not fit" — an instruction to keep producing until it runs
 *                   out of text, which is exactly what it did.
 *   relationships   open vocabulary with a fallback: an unrecognised predicate
 *                   was rewritten to `associated_with` and STORED. A tie the
 *                   model invented could not fail validation; it just arrived
 *                   wearing a vaguer name.
 *
 * And the task line said "report what they show about people, organisations,
 * their relationships" — an inventory instruction with no notion of THIS
 * message.
 *
 * The shape now: a message identifies people, discloses facts about them, and
 * carries what they are asking for. Three things, all rooted at one email.
 * Disclosures are typed against a closed field list, so there is a shape to
 * fill and a point at which the source has nothing left to say — replacing the
 * two free-text arrays that had no such point.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIM_GROUPS, DISCLOSURE_FIELDS, OBSERVATION_SCHEMA_VERSION,
  RELATIONSHIP_PREDICATES, validateEnvelope,
} from "../src/intelligence/schema.js";

const evidence = (text) => ({
  source_id: "message:abc123", evidence: text, explicit: true, confidence: 0.9,
});

const PERSON = { ref: "p1", kind: "PERSON", name: "Dana Reed", ...evidence("Dana Reed") };

/* --- the catch-alls are gone -------------------------------------------- */

test("the speculative and catch-all arrays no longer exist", () => {
  assert.deepEqual([...CLAIM_GROUPS], ["entities", "intents", "relationships", "disclosures"]);
  assert.ok(!CLAIM_GROUPS.includes("opportunities"), "the model is not asked to speculate");
  assert.ok(!CLAIM_GROUPS.includes("observations"), "the model is not asked to keep going");
});

test("an envelope carrying the old arrays simply ignores them", () => {
  // Forward compatibility in the direction that matters: a model still answering
  // in the old shape loses the two arrays we no longer want, and keeps the rest,
  // rather than failing the whole inference.
  const result = validateEnvelope({
    entities: [PERSON],
    opportunities: [{ subject_ref: "p1", summary: "could use a CRM", ...evidence("CRM") }],
    observations: [{ subject_ref: "p1", text: "seems friendly", ...evidence("friendly") }],
  });
  assert.equal(result.envelope.entities.length, 1);
  assert.equal(result.envelope.opportunities, undefined);
  assert.equal(result.envelope.observations, undefined);
});

/* --- an invented relationship can no longer pass ------------------------ */

test("an unrecognised predicate is REJECTED, not renamed", () => {
  // The bug: `predicate: known ? predicate : "associated_with"`. Anything the
  // model made up was downgraded and stored as a real edge, so the graph filled
  // with ties nobody could trace to a claim anyone made.
  const result = validateEnvelope({
    entities: [PERSON, { ref: "p2", kind: "PERSON", name: "Jim Ko", ...evidence("Jim Ko") }],
    relationships: [
      { subject_ref: "p1", predicate: "probably_collaborates_with", object_ref: "p2",
        ...evidence("Dana Reed") },
    ],
  });

  assert.equal(result.envelope.relationships.length, 0, "the invented tie must not survive");
  const rejection = result.rejected.find((r) => r.code === "UNKNOWN_PREDICATE");
  assert.ok(rejection, "and it must be COUNTED — silent discarding is the worse failure");
  assert.match(rejection.message, /probably_collaborates_with/,
    "the offending predicate is named, so a too-narrow vocabulary shows as a pattern");
});

test("the two predicates that were facts about text, not people, are gone", () => {
  // `mentions` and `associated_with` are always true and never meaningful, and
  // they were where the fallback funnelled everything.
  assert.ok(!RELATIONSHIP_PREDICATES.includes("mentions"));
  assert.ok(!RELATIONSHIP_PREDICATES.includes("associated_with"));
});

test("a real relationship still passes", () => {
  const result = validateEnvelope({
    entities: [PERSON, { ref: "o1", kind: "ORGANIZATION", name: "Acme", ...evidence("Acme") }],
    relationships: [
      { subject_ref: "p1", predicate: "works_at", object_ref: "o1", ...evidence("Dana Reed") },
    ],
  });
  assert.equal(result.envelope.relationships.length, 1);
  assert.equal(result.envelope.relationships[0].predicate, "works_at");
});

/* --- disclosures: what the message taught us ---------------------------- */

test("a disclosure is a typed field and a short value", () => {
  const result = validateEnvelope({
    entities: [PERSON],
    disclosures: [
      { subject_ref: "p1", field: "capability", value: "Kubernetes", ...evidence("Dana Reed") },
      { subject_ref: "p1", field: "employer", value: "Acme", ...evidence("Dana Reed") },
    ],
  });
  assert.equal(result.envelope.disclosures.length, 2);
  assert.deepEqual(result.envelope.disclosures.map((d) => d.field), ["capability", "employer"]);
});

test("a field outside the closed list is rejected and named", () => {
  // The closed list is what stops `disclosures` from becoming the new catch-all.
  const result = validateEnvelope({
    entities: [PERSON],
    disclosures: [
      { subject_ref: "p1", field: "vibe", value: "enthusiastic", ...evidence("Dana Reed") },
    ],
  });
  assert.equal(result.envelope.disclosures.length, 0);
  assert.ok(result.rejected.some((r) => r.code === "UNKNOWN_DISCLOSURE_FIELD"));
});

test("a disclosure about nobody is dangling and dropped", () => {
  // Every claim hangs off an entity THIS message declared. That is what makes
  // the graph rooted rather than a pile.
  const result = validateEnvelope({
    entities: [PERSON],
    disclosures: [
      { subject_ref: "ghost", field: "role", value: "CTO", ...evidence("Dana Reed") },
    ],
  });
  assert.equal(result.envelope.disclosures.length, 0);
  assert.ok(result.rejected.some((r) => r.code === "DANGLING_REF"));
});

test("the disclosure vocabulary covers what a résumé actually states", () => {
  for (const field of ["role", "capability", "employer", "industry", "geography", "seniority"]) {
    assert.ok(DISCLOSURE_FIELDS.includes(field), `${field} must have somewhere to land`);
  }
});

/* --- the version says the shape changed --------------------------------- */

test("the schema version bumped, which invalidates cached inferences", () => {
  // The version is part of the inference cache key, so a bump invalidates old
  // cached answers by construction rather than by somebody remembering to clear
  // something — and old observations stay queryable under their own version,
  // which is what makes reprocessing a query instead of a migration.
  assert.equal(OBSERVATION_SCHEMA_VERSION, "obs_v2");
});
