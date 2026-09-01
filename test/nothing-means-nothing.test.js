/**
 * Nothing means nothing — live tape, 2026-09-01 18:39, Mark: "the model
 * submitted dozens of claims, why is 2 x {} erasing it"
 *
 * It wasn't — the dozens belonged to the OTHER job still streaming — but
 * the line that scared him held two real bugs:
 *
 *   1. The constitution teaches "the single line {} is the complete,
 *      correct answer" and the wire parser REJECTED {} as
 *      UNKNOWN_CLAIM_KIND — sole answer or padding alike. The prompt and
 *      the parser had contradicted each other since v2, and every {} paid
 *      a rejection that could burn a graded round.
 *   2. "understood NOTHING — the model returned no usable claims" also
 *      printed when the model returned perfectly VALID claims that all
 *      deduped against the graph ("I'm mark", already known). Nothing NEW
 *      is a quiet success, not a model failure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { envelopeFromLines } from "../src/intelligence/provider.js";

const CLAIM = JSON.stringify({
  claim: "disclosure", subject_ref: "sender", field: "capability",
  value: "Rust", source_id: "message:abc", evidence: "Rust",
  explicit: true, confidence: 0.95,
});

test("a sole {} is the contract's own valid empty answer, not a rejection", () => {
  const { raw, malformedLines } = envelopeFromLines("{}");
  assert.equal(malformedLines.length, 0, "the constitution's example cannot be a crime");
  assert.ok(raw, "an empty envelope is an ANSWER — parsedAny, not null");
  assert.equal((raw.disclosures ?? []).length, 0);
});

test("{} padding after real claims costs nothing — the claims stand untouched", () => {
  const { raw, malformedLines } = envelopeFromLines([CLAIM, "{}", "{}"].join("\n"));
  assert.equal(malformedLines.length, 0,
    "the live tape's rejected=2 UNKNOWN_CLAIM_KINDx2 is gone");
  assert.equal(raw.disclosures.length, 1, "the real claim is banked");
});

test("a claim with a WRONG kind is still rejected — the tolerance is for emptiness only", () => {
  const bogus = JSON.stringify({ claim: "vibe", value: "good" });
  const { raw, malformedLines } = envelopeFromLines([CLAIM, bogus].join("\n"));
  assert.equal(malformedLines.length, 1);
  assert.equal(malformedLines[0].code, "UNKNOWN_CLAIM_KIND");
  assert.equal(raw.disclosures.length, 1);
});
