/**
 * A way to reach you — live tape, 2026-09-01 17:36:
 *
 *   rejected=2 why=UNKNOWN_DISCLOSURE_FIELDx2
 *   first=disclosures[0].field must be one of role, capability, industry,
 *   employer, geography, seniority, credential, availability
 *
 * The writer offered "+1-844-VAPE-B2B" and "+1-786-759-5499" — twice, across
 * two graded rounds — and the schema had nowhere to put a way to reach
 * someone. `contact` is now the eleventh disclosure field, and it renders
 * everywhere including the PUBLIC directory: this is B2B, and a business
 * line the writer volunteered is part of their card (Mark, 2026-09-01).
 * Email addresses stay unrendered — they are member identifiers, not
 * disclosures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateEnvelope, DISCLOSURE_FIELDS } from "../src/intelligence/schema.js";
import { OBSERVER_SYSTEM } from "../src/intelligence/prompt.js";
import { PROMPT_VERSION } from "../src/intelligence/provider.js";
import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { buildDirectory } from "../src/graph/directory.js";

const T0 = "2026-09-01T17:36:00.000Z";

test("contact is a disclosure field — a phone number has somewhere to land", () => {
  assert.ok(DISCLOSURE_FIELDS.includes("contact"));

  const { envelope, rejected } = validateEnvelope({
    disclosures: [{
      subject_ref: "sender", field: "contact", value: "+1-844-VAPE-B2B",
      source_id: "message:f223661bc826", evidence: "+1-844-VAPE-B2B",
      explicit: true, confidence: 0.95,
    }],
  }, { providedRefs: ["sender"] });

  assert.equal(rejected.length, 0,
    `the live rejection is gone: ${JSON.stringify(rejected)}`);
  assert.equal(envelope.disclosures.length, 1);
  assert.equal(envelope.disclosures[0].field, "contact");
});

test("the constitution teaches contact instead of forbidding phone numbers", () => {
  const system = Array.isArray(OBSERVER_SYSTEM) ? OBSERVER_SYSTEM.join("\n") : OBSERVER_SYSTEM;
  assert.match(system, /contact holds a way to reach the writer/);
  assert.doesNotMatch(system, /A phone number is not a disclosure field/,
    "the old refusal is gone — it was the missing capability");
});

test("the prompt version moved, so v17-read evidence gets its second chance", () => {
  assert.equal(PROMPT_VERSION, "obs_prompt_v18");
});

test("the public directory renders the contact route — B2B, by directive", () => {
  const graph = createGraphRepositories(openInMemory());
  // A directory card requires a resume on the desk: attachment evidence.
  graph.evidence.record({
    kind: "attachment", contentHash: "cv1", text: "resume text", receivedAt: T0,
    meta: { filename: "mark.pdf" },
  });
  const claim = (predicate, object) => graph.observations.append({
    subject: "person:mark@vapor.test", predicate, object,
    evidenceId: "attachment:cv1", quote: object, authority: AUTHORITY.MODEL_VERIFIED,
    confidence: 0.95, observedAt: T0,
  });
  claim("is_person", "Mark Allen Evans");
  claim("role", "Co-founder of World Vapor Expo");
  claim("contact", "+1-844-VAPE-B2B");

  const rendered = JSON.stringify(buildDirectory({ graph }));
  assert.match(rendered, /Co-founder of World Vapor Expo/);
  assert.match(rendered, /VAPE-B2B/, "the volunteered business line is on the card");
  assert.doesNotMatch(rendered, /mark@vapor\.test/,
    "email addresses remain the one thing never rendered");
});
