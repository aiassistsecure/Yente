/**
 * Two holes from one live reasoning trace, 2026-08-28.
 *
 * The model thought, verbatim:
 *
 *   "The sender mentions a resume, which discloses their `capability`.
 *    I will add a `disclosure` for `capability: \"resume\"` for the sender."
 *
 *   "The sender is communicating with Yente. This is a `communicated_with`
 *    relationship."
 *
 * The first is the résumé bug walking back in through a door built after the
 * guard: isIntakeArtifact protects INTENTS, and disclosures did not exist when
 * it was written. `capability: "resume"` would land as a typed fact, join the
 * document vocabulary, and become something two people can match on.
 *
 * The second violates the absolute invariant — yente@ccme.network IS Yente,
 * never a member, candidate, or graph entity — and was blocked only by
 * COINCIDENCE: the model kept emitting `object_ref: null` for her, which
 * happened to fail requireString. The day it declares a real ref for her, she
 * enters the graph and the desk starts introducing people to itself.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { observationsFrom } from "../src/intelligence/queue.js";

const base = {
  evidenceId: "message:abc123",
  provenance: { model: "test", schemaVersion: "obs_v2", contentHash: "h" },
  observedAt: "2026-08-28T22:00:00Z",
  sentAt: "2026-08-28T21:00:00Z",
  senderSubject: "person:dev@interchained.org",
};

const entity = (ref, name, email = null) => ({
  ref, kind: "PERSON", name,
  emailAddress: email,
  evidence: name, explicit: true, confidence: 0.9,
});

/* --- Yente is never a graph entity --------------------------------------- */

test("an entity carrying Yente's address never becomes a subject", () => {
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [
        entity("sender", "Mark", "dev@interchained.org"),
        entity("y1", "Yente", "yente@ccme.network"),
      ],
      intents: [], relationships: [], disclosures: [],
    },
  });

  const subjects = out.map((row) => row.subject);
  assert.ok(!subjects.some((s) => String(s).includes("yente@ccme.network")),
    "the desk must not appear in its own graph");
  assert.ok(subjects.some((s) => s === "person:dev@interchained.org"),
    "the real person still lands");
});

test("a name-only Yente entity is skipped, but a member named Yente is not", () => {
  // The address is the identity. A real member who happens to be named Yente
  // has a different address, and erasing her would be wrong in the other
  // direction.
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [
        entity("y1", "Yente"),                              // no address: the desk
        entity("p2", "Yente Goldberg", "yg@example.com"),   // a person
      ],
      intents: [], relationships: [], disclosures: [],
    },
  });
  const subjects = out.map((row) => row.subject);
  assert.ok(!subjects.includes("person:name:yente"));
  assert.ok(subjects.includes("person:yg@example.com"));
});

test("the exact observed relationship — communicated_with Yente — produces no edge", () => {
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [
        entity("sender", "Mark", "dev@interchained.org"),
        entity("y1", "Yente", "yente@ccme.network"),
      ],
      intents: [], disclosures: [],
      relationships: [{
        subjectRef: "sender", predicate: "communicated_with", objectRef: "y1",
        evidence: "yente@ccme.network", explicit: true, confidence: 0.9,
      }],
    },
  });
  assert.ok(!out.some((row) => row.predicate === "communicated_with"),
    "an edge into the desk is not protection-by-null anymore; it is refused by rule");
});

test("a one-ended relationship is dropped, not stored with object null", () => {
  // The old accident, now the rule: an edge needs both ends whatever the reason
  // the far end is missing.
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [entity("sender", "Mark", "dev@interchained.org")],
      intents: [], disclosures: [],
      relationships: [{
        subjectRef: "sender", predicate: "works_at", objectRef: "ghost",
        evidence: "Mark", explicit: true, confidence: 0.9,
      }],
    },
  });
  assert.ok(!out.some((row) => row.predicate === "works_at"));
});

test("a real relationship between two real people still lands", () => {
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [
        entity("sender", "Mark", "dev@interchained.org"),
        { ref: "o1", kind: "ORGANIZATION", name: "Acme", emailAddress: null,
          evidence: "Acme", explicit: true, confidence: 0.9 },
      ],
      intents: [], disclosures: [],
      relationships: [{
        subjectRef: "sender", predicate: "works_at", objectRef: "o1",
        evidence: "Mark", explicit: true, confidence: 0.9,
      }],
    },
  });
  const edge = out.find((row) => row.predicate === "works_at");
  assert.ok(edge, "the guard must not eat legitimate edges");
  assert.equal(edge.object, "org:name:acme");
});

/* --- intake artefacts are not disclosures -------------------------------- */

test("the exact observed disclosure — capability: resume — is refused", () => {
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [entity("sender", "Mark", "dev@interchained.org")],
      intents: [], relationships: [],
      disclosures: [
        { subjectRef: "sender", field: "capability", value: "resume",
          evidence: "my resume", explicit: true, confidence: 0.9 },
        { subjectRef: "sender", field: "capability", value: "Kubernetes",
          evidence: "Kubernetes", explicit: true, confidence: 0.9 },
      ],
    },
  });

  const capabilities = out.filter((row) => row.predicate === "capability");
  assert.deepEqual(capabilities.map((c) => c.object), ["Kubernetes"],
    "a résumé is how a profile gets built, never what a person IS — "
    + "and the real skill beside it must survive");
});

test("the guard covers the intake vocabulary, not just the one word", () => {
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [entity("sender", "Mark", "dev@interchained.org")],
      intents: [], relationships: [],
      disclosures: ["LinkedIn export", "portfolio", "my résumé", "attachment"]
        .map((value) => ({
          subjectRef: "sender", field: "capability", value,
          evidence: value, explicit: true, confidence: 0.9,
        })),
    },
  });
  assert.equal(out.filter((row) => row.predicate === "capability").length, 0);
});

test("a genuine capability that merely mentions a document survives", () => {
  // The over-correction to avoid, same as the intent guard: a CV-writing
  // service is a real business, and "resume writing for executives" carries
  // content words beyond the artefact list.
  const out = observationsFrom({
    ...base,
    verified: {
      entities: [entity("sender", "Mark", "dev@interchained.org")],
      intents: [], relationships: [],
      disclosures: [{
        subjectRef: "sender", field: "capability", value: "resume writing for executives",
        evidence: "resume writing", explicit: true, confidence: 0.9,
      }],
    },
  });
  assert.equal(out.filter((row) => row.predicate === "capability").length, 1);
});
