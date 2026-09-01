/**
 * Source ids a model can actually be trusted to copy.
 *
 * OBSERVED 2026-08-31, first GLM-4-32B run: the model reproduced a 64-char
 * source hash with ONE hex digit drifted (…0aa0e9a45cc… → …0aa0e9a42cc…) and
 * thirteen otherwise-grounded claims died UNKNOWN_SOURCE. The evidence quotes
 * were verbatim; only the robot-work failed. gpt-oss had merely been a luckier
 * scribe.
 *
 * Two fixes, both here:
 *   1. The model is shown SHORT ids (kind + 12 hex) and cites those — less to
 *      copy, less to get wrong, ~25 fewer output tokens per claim line.
 *   2. A cited id within hamming distance 2 of exactly one canonical id is a
 *      transcription slip and resolves to it; anything further stays
 *      UNKNOWN_SOURCE, because looser tolerance is guessing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntelligenceProvider, sourceAliases, canonicalizeSourceIds,
  shortSourceId, displaySourceIds,
} from "../src/intelligence/provider.js";

const HASH = "eea45b7e8c47a0f9ce5cf020aba3209b556b6b26e82f620aa0e9a45cc32920de";
const FULL = `attachment:${HASH}`;
const SHORT = "attachment:eea45b7e8c47";
// The live failure, verbatim: position 49's '5' became '2'.
const DRIFTED = `attachment:${HASH.slice(0, 49)}2${HASH.slice(50)}`;

const CV_TEXT = "MARK EVANS JR. — Systems Architect. Built the storage layer in Rust.";

/* --- the short form ------------------------------------------------------- */

test("a long hex hash shortens to 12 chars; human-readable ids do not", () => {
  assert.equal(shortSourceId(FULL), SHORT);
  assert.equal(shortSourceId("message:demo1"), "message:demo1");
  assert.equal(shortSourceId("attachment:cv1"), "attachment:cv1");
  assert.equal(shortSourceId("no-colon-at-all"), "no-colon-at-all");
});

test("display ids fall back to canonical when shortening would collide", () => {
  const twin = `attachment:${HASH.slice(0, 12)}${"0".repeat(52)}`;
  const display = displaySourceIds([
    { id: FULL, text: "a" },
    { id: twin, text: "b" },
  ]);
  assert.deepEqual(display.map((s) => s.id), [FULL, twin],
    "two sources sharing a 12-hex prefix keep their full ids");
});

test("the model is shown the short id, and its short citation verifies", async () => {
  let sawPrompt = null;
  const reply = [
    "<<<OBSERVATIONS>>>",
    JSON.stringify({
      claim: "entity", ref: "p1", kind: "PERSON", name: "Mark Evans Jr.",
      source_id: SHORT, evidence: "MARK EVANS JR. — Systems Architect.",
      explicit: true, confidence: 0.95,
    }),
    "<<<END>>>",
  ].join("\n");
  const provider = createIntelligenceProvider({
    client: {
      async complete({ prompt }) {
        sawPrompt = prompt;
        return { text: reply, finishReason: "stop", elapsedMs: 1 };
      },
    },
    provider: "pin", model: "GLM-4-32B",
    sleep: async () => {}, now: () => "2026-08-31T23:59:00.000Z",
  });

  const result = await provider.observe({ sources: [{ id: FULL, text: CV_TEXT }] });

  assert.ok(sawPrompt.includes(SHORT), "the prompt names the source by its short id");
  assert.ok(!sawPrompt.includes(HASH), "the 64-char hash never reaches the model");
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.entities[0].sourceId, FULL,
    "what lands in the graph is the CANONICAL id");
});

/* --- the drift tolerance --------------------------------------------------- */

test("a one-character drift in a full hash resolves to the canonical id", () => {
  const aliases = sourceAliases([{ id: FULL, text: CV_TEXT }]);
  const raw = canonicalizeSourceIds({
    disclosures: [{ subject_ref: "p1", field: "role", value: "Systems Architect",
      source_id: DRIFTED, evidence: "Systems Architect", explicit: true, confidence: 0.9 }],
  }, aliases);
  assert.equal(raw.disclosures[0].source_id, FULL,
    "the exact live failure — a42cc for a45cc — now lands");
});

test("three drifted characters is an invention, not a slip", () => {
  const aliases = sourceAliases([{ id: FULL, text: CV_TEXT }]);
  const mangled = `attachment:${"f".repeat(3)}${HASH.slice(3)}`;
  const raw = canonicalizeSourceIds({
    disclosures: [{ subject_ref: "p1", field: "role", value: "x",
      source_id: mangled, evidence: "y", explicit: true, confidence: 0.9 }],
  }, aliases);
  assert.equal(raw.disclosures[0].source_id, mangled, "left alone → UNKNOWN_SOURCE downstream");
});

test("a slip equidistant from two canonical ids resolves to neither", () => {
  const a = `message:${"a".repeat(20)}`;
  const b = `message:${"a".repeat(19)}b`;
  const aliases = sourceAliases([{ id: a, text: "1" }, { id: b, text: "2" }]);
  const raw = canonicalizeSourceIds({
    disclosures: [{ subject_ref: "p1", field: "role", value: "x",
      source_id: `message:${"a".repeat(19)}c`, evidence: "y",
      explicit: true, confidence: 0.9 }],
  }, aliases);
  assert.equal(raw.disclosures[0].source_id, `message:${"a".repeat(19)}c`,
    "ambiguity is not resolved by coin flip");
});

/* --- end to end: the exact run that died ----------------------------------- */

test("a full envelope citing drifted full ids verifies instead of dying", async () => {
  const reply = [
    "<<<OBSERVATIONS>>>",
    JSON.stringify({
      claim: "entity", ref: "p1", kind: "PERSON", name: "Mark Evans Jr.",
      source_id: DRIFTED, evidence: "MARK EVANS JR. — Systems Architect.",
      explicit: true, confidence: 0.95,
    }),
    JSON.stringify({
      claim: "proposal", subject_ref: "p1", kind: "hire_for",
      target: "systems architecture and Rust backend engineering roles",
      grade: "exceptional", source_id: DRIFTED,
      evidence: "Built the storage layer in Rust.", explicit: false, confidence: 0.9,
    }),
    "<<<END>>>",
  ].join("\n");
  const provider = createIntelligenceProvider({
    client: { async complete() { return { text: reply, finishReason: "stop", elapsedMs: 1 }; } },
    provider: "pin", model: "GLM-4-32B",
    sleep: async () => {}, now: () => "2026-08-31T23:59:00.000Z",
  });

  const result = await provider.observe({ sources: [{ id: FULL, text: CV_TEXT }] });
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.proposals.length, 1);
  assert.equal(result.verified.proposals[0].sourceId, FULL);
});
