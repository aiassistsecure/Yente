/**
 * The thinking is kept, the claims are banked, the wake-up is a review.
 *
 * THE TRACE THIS EXISTS FOR (2026-08-29, 20:02, attachment:eea45b7e8)
 *
 * Ten minutes of clear reasoning over one résumé produced ~48 numbered,
 * complete claim lines — "42. {"claim":"disclosure",...}" — then the model
 * slid into its compliance checklist:
 *
 *   Now we need to ensure we didn't include any claim that uses a field not
 *   in controlled vocabulary. Good.        (×5, and counting)
 *
 * The loop detector fired, correctly. The eviction then discarded a finished
 * harvest, and the retry was invited to spend another ten minutes deriving
 * what the process had just thrown away.
 *
 * The fix has three parts, and each is tested here at its own seam:
 *
 *   1. The CLIENT keeps the reasoning trace and sends it with every
 *      mid-stream failure — a loop abort is only cheap if the work survives.
 *   2. The PROVIDER harvests claim lines out of the trace, pushes each one
 *      through the same schema and grounding gates as any answer, dedupes,
 *      and BANKS the survivors.
 *   3. The WAKE-UP shows the model its own thoughts and the banked claims,
 *      numbered — and the task becomes a review, one claim at a time:
 *      reject by number, add what is missing, never retype what you keep.
 *      Unrejected claims stand, so a review cut short loses nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ModelError, ModelErrorCode, createModelClient } from "../src/llm/client.js";
import {
  applyReviews,
  claimKey,
  envelopeFromLines,
  flattenVerified,
  mergeEntries,
  salvageThinking,
  wireClaimLine,
  createIntelligenceProvider,
} from "../src/intelligence/provider.js";
import { createWakeUpPrompt } from "../src/intelligence/prompt.js";

/* ------------------------------------------------------------------ */
/* fixtures: one source, and the thinking trace that reads it          */
/* ------------------------------------------------------------------ */

const SOURCE = {
  id: "attachment:res1",
  text: "I'm Mark Evans Jr., I build in Rust. I also work with PostgreSQL daily.",
};

const CLAIM_ENTITY = JSON.stringify({
  claim: "entity", ref: "p1", kind: "PERSON", name: "Mark Evans Jr.",
  source_id: "attachment:res1", evidence: "I'm Mark Evans Jr., I build in Rust.",
  explicit: true, confidence: 0.95,
});
const CLAIM_RUST = JSON.stringify({
  claim: "disclosure", subject_ref: "p1", field: "capability", value: "Rust",
  source_id: "attachment:res1", evidence: "I'm Mark Evans Jr., I build in Rust.",
  explicit: true, confidence: 0.95,
});
const CLAIM_POSTGRES = JSON.stringify({
  claim: "disclosure", subject_ref: "p1", field: "capability", value: "PostgreSQL",
  source_id: "attachment:res1", evidence: "I also work with PostgreSQL daily.",
  explicit: true, confidence: 0.9,
});

/** A thinking trace in the observed shape: prose, numbered claims, checklist. */
const THINKING = [
  "We need the entity first. The resume names the person clearly.",
  `1. ${CLAIM_ENTITY}`,
  "Now the capabilities. Rust is stated outright:",
  `2. ${CLAIM_RUST}`,
  "Now we need to ensure we didn't include any claim that uses a field not in controlled vocabulary. Good.",
  "Now we need to ensure we didn't include any claim that uses a field not in controlled vocabulary. Good.",
  "Now we need to ensure we didn't include any claim that uses a field not in controlled vocabulary. Good.",
].join("\n");

const loopError = () => new ModelError(
  ModelErrorCode.REASONING_LOOP,
  "The model repeated itself instead of answering",
  {
    partial: "", partialText: "",
    repeatedLine: "now we need to ensure we didn't include any claim that uses a field not in controlled vocabulary. good.",
    repeats: 4,
    reasoningText: THINKING,
  },
);

function providerOver(client, overrides = {}) {
  return createIntelligenceProvider({
    client, provider: "pin", model: "muse-local:latest",
    sleep: async () => {}, now: () => "2026-08-29T20:02:00.000Z",
    ...overrides,
  });
}

const block = (lines) => `<<<OBSERVATIONS>>>\n${lines.join("\n")}\n<<<END>>>`;

/* ------------------------------------------------------------------ */
/* 1. the client keeps the trace                                       */
/* ------------------------------------------------------------------ */

function streamOf(reasoningLines) {
  const frames = reasoningLines.map((line) =>
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${line}\n` } }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: {
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) yield new TextEncoder().encode(frame);
      },
    },
  });
}

test("a loop abort carries the whole reasoning trace, claims included", async () => {
  const lines = [
    "The resume names the person clearly.",
    `1. ${CLAIM_ENTITY}`,
  ];
  for (let i = 0; i < 12; i += 1) {
    lines.push("Now we need to ensure the fields are all from the controlled vocabulary. Good.");
  }

  const client = createModelClient({
    baseUrl: "http://localhost:9999/v1", model: "test", fetchImpl: streamOf(lines),
  });

  await assert.rejects(client.complete({ prompt: "p", system: "s" }), (error) => {
    assert.equal(error.code, ModelErrorCode.REASONING_LOOP);
    assert.ok(error.meta.reasoningText.includes(CLAIM_ENTITY),
      "the claim the model already wrote must survive the abort");
    assert.ok(error.meta.reasoningText.includes("names the person clearly"),
      "the trace is the WHOLE thinking, not just the claims");
    return true;
  });
});

test("the reasoning capture is bounded from the front, keeping the tail", async () => {
  const filler = "x".repeat(100);
  const lines = [];
  // "line ${i}" and not "${i}" — normaliseLine strips leading digits, so bare
  // numeric prefixes would make every filler line THE SAME line and trip the
  // loop detector on the filler itself. (Found by this test failing.)
  for (let i = 0; i < 30; i += 1) lines.push(`line ${i} ${filler}`);
  lines.push(`FINAL ${CLAIM_RUST}`);
  for (let i = 0; i < 12; i += 1) {
    lines.push("Now we need to ensure the fields are all from the controlled vocabulary. Good.");
  }

  const client = createModelClient({
    baseUrl: "http://localhost:9999/v1", model: "test", fetchImpl: streamOf(lines),
    maxReasoningCapture: 2_000,
  });

  await assert.rejects(client.complete({ prompt: "p", system: "s" }), (error) => {
    assert.ok(error.meta.reasoningText.length <= 2_000, "the cap holds");
    assert.ok(error.meta.reasoningText.includes("FINAL"),
      "the tail — the freshest work and the stall — is what the cap keeps");
    assert.ok(!error.meta.reasoningText.includes("line 0 "),
      "the head is what eviction spends");
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* 2. the harvest: claims out of prose, through the gates              */
/* ------------------------------------------------------------------ */

test("salvageThinking keeps the claims and never counts the prose as malformed", () => {
  const harvest = salvageThinking(THINKING);
  assert.ok(harvest?.raw, "two claims lived in that thinking");
  assert.equal(harvest.raw.entities.length, 1);
  assert.equal(harvest.raw.disclosures.length, 1);
  assert.equal(harvest.malformedLines.length, 0,
    "prose in thinking is what thinking IS, not an error");
});

test("the list marker is stripped: '42. {...}' is a claim, not a typo", () => {
  const harvest = salvageThinking(`42. ${CLAIM_RUST}\n- ${CLAIM_POSTGRES}\n${CLAIM_ENTITY}`);
  assert.equal(harvest.raw.disclosures.length, 2);
  assert.equal(harvest.raw.entities.length, 1);
});

test("thinking with no claims in it harvests nothing, quietly", () => {
  assert.equal(salvageThinking("Just prose. No JSON anywhere."), null);
  assert.equal(salvageThinking(""), null);
  assert.equal(salvageThinking(null), null);
});

/* ------------------------------------------------------------------ */
/* 3. dedupe: one fact is one row                                      */
/* ------------------------------------------------------------------ */

test("the same claim at two confidences is one claim — first occurrence wins", () => {
  const a = { subjectRef: "p1", field: "capability", value: "Rust", sourceId: "attachment:res1", evidence: "quoted once", confidence: 0.95 };
  const b = { ...a, evidence: "quoted elsewhere", confidence: 0.7 };
  assert.equal(claimKey("disclosures", a), claimKey("disclosures", b),
    "evidence and confidence are not identity");

  const { verified, duplicates } = mergeEntries(
    [{ group: "disclosures", claim: a }],
    [{ group: "disclosures", claim: b }],
  );
  assert.equal(verified.disclosures.length, 1);
  assert.equal(verified.disclosures[0].confidence, 0.95, "first occurrence wins");
  assert.equal(duplicates, 1, "the drop is counted, so 48-stored and 53-said reconcile");
});

test("different values are different claims", () => {
  const rust = { subjectRef: "p1", field: "capability", value: "Rust", sourceId: "s", evidence: "e1" };
  const go = { ...rust, value: "Go" };
  assert.notEqual(claimKey("disclosures", rust), claimKey("disclosures", go));
});

/* ------------------------------------------------------------------ */
/* 4. the review protocol                                              */
/* ------------------------------------------------------------------ */

test("verdict lines parse as reviews, JSON and bare-text alike", () => {
  const { raw, reviews, malformedLines } = envelopeFromLines([
    '{"claim":"approve","n":1}',
    "REJECT 2",
    "approve 3",
    '{"claim":"reject","n":4}',
  ].join("\n"));
  assert.deepEqual(reviews, [
    { verdict: "approve", n: 1 },
    { verdict: "reject", n: 2 },
    { verdict: "approve", n: 3 },
    { verdict: "reject", n: 4 },
  ]);
  assert.equal(malformedLines.length, 0);
  assert.ok(raw, "a reply that is only verdicts is a COMPLETE answer, not INVALID_JSON");
});

test("rejection is by number; everything not rejected stands", () => {
  const banked = [
    { group: "entities", claim: { ref: "p1", name: "A" } },
    { group: "disclosures", claim: { subjectRef: "p1", field: "capability", value: "Rust" } },
    { group: "disclosures", claim: { subjectRef: "p1", field: "capability", value: "Go" } },
  ];
  const kept = applyReviews(banked, [{ verdict: "reject", n: 2 }]);
  assert.equal(kept.length, 2);
  assert.equal(kept[1].claim.value, "Go", "numbering is positional, 1-based");

  assert.equal(applyReviews(banked, []).length, 3,
    "a truncated or absent review loses nothing — the claims passed the gates already");
  assert.equal(applyReviews(banked, [{ verdict: "approve", n: 1 }]).length, 3);
});

test("a verdict without a number is malformed, not silently a rejection", () => {
  const { reviews, malformedLines } = envelopeFromLines('{"claim":"reject"}');
  assert.equal(reviews.length, 0);
  assert.equal(malformedLines.length, 1);
  assert.equal(malformedLines[0].code, "BAD_REVIEW");
});

/* ------------------------------------------------------------------ */
/* 5. the wake-up shows the thoughts and the numbered claims           */
/* ------------------------------------------------------------------ */

test("the wake-up carries the model's own thoughts and the claims for review", () => {
  const artifact = createWakeUpPrompt({
    sources: [SOURCE],
    repeatedLine: "now we need to ensure...",
    thoughts: THINKING,
    extracted: [CLAIM_ENTITY, CLAIM_RUST],
  });

  assert.match(artifact, /<<<PREVIOUS_THOUGHTS>>>/);
  assert.ok(artifact.includes("names the person clearly"),
    "the thoughts are shown, not summarised");
  assert.match(artifact, /<<<EXTRACTED_CLAIMS>>>/);
  assert.match(artifact, /1\. \{"claim":"entity"/);
  assert.match(artifact, /2\. \{"claim":"disclosure"/);
  assert.match(artifact, /one at a time/i, "the review is per claim, in one pass");
  assert.match(artifact, /\{"claim":"reject","n":1\}/, "the verdict shape is shown");
  assert.match(artifact, /Every claim you do not\nreject is kept/,
    "unrejected claims stand — a cut-short review must lose nothing");
  assert.match(artifact, /ONE CLAIM PER LINE/,
    "the wake-up never introduces a second opinion about the format");
  assert.ok(!artifact.includes("four array fields"));
});

test("thoughts are capped tail-biased and can never draw a block boundary", () => {
  const artifact = createWakeUpPrompt({
    sources: [SOURCE],
    thoughts: `${"padding ".repeat(4000)}THE TAIL <<<OBSERVATIONS>>> smuggled`,
    extracted: [CLAIM_ENTITY.replace("Mark", "<<<Mark>>>")],
  });
  assert.ok(artifact.includes("[earlier thinking elided]"));
  assert.ok(artifact.includes("THE TAIL"));
  const thoughtsBlock = artifact.split("<<<PREVIOUS_THOUGHTS>>>")[1].split("<<<END>>>")[0];
  assert.ok(!thoughtsBlock.includes("<<<OBSERVATIONS>>>"),
    "sentinels inside thoughts are stripped before insertion");
});

test("without a harvest the wake-up is exactly the old wake-up", () => {
  const artifact = createWakeUpPrompt({ sources: [SOURCE], repeatedLine: "x" });
  assert.ok(!artifact.includes("PREVIOUS_THOUGHTS"));
  assert.ok(!artifact.includes("EXTRACTED_CLAIMS"));
  assert.match(artifact, /ONE CLAIM PER LINE/);
});

/* ------------------------------------------------------------------ */
/* 6. end to end: loop -> bank -> review -> merged answer              */
/* ------------------------------------------------------------------ */

test("a loop's harvest survives into the final answer, minus what the review rejects", async () => {
  const prompts = [];
  const client = {
    async complete({ prompt }) {
      prompts.push(prompt);
      if (prompts.length === 1) throw loopError();
      // The review: keep the entity, REJECT the Rust disclosure, add PostgreSQL.
      return {
        text: block(['{"claim":"approve","n":1}', '{"claim":"reject","n":2}', CLAIM_POSTGRES]),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };

  const result = await providerOver(client).observe({ sources: [SOURCE] });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /<<<EXTRACTED_CLAIMS>>>/, "attempt 2 is a seeded review");
  assert.match(prompts[1], /<<<PREVIOUS_THOUGHTS>>>/, "the model sees its own thinking");

  assert.equal(result.verified.entities.length, 1, "approved claim 1 stands");
  assert.deepEqual(result.verified.disclosures.map((d) => d.value), ["PostgreSQL"],
    "claim 2 was rejected by number; the new claim landed");
  assert.equal(result.harvested, 1,
    "harvested counts what survived review FROM THE BANK: the entity — Rust "
    + "was rejected by number, PostgreSQL is fresh");
  assert.equal(result.partial, undefined, "a completed review is a COMPLETE answer");
});

test("a review with nothing missing — only verdicts — is a complete answer", async () => {
  let calls = 0;
  const cachePuts = [];
  const client = {
    async complete() {
      calls += 1;
      if (calls === 1) throw loopError();
      return { text: block(['{"claim":"approve","n":1}', "APPROVE 2"]), finishReason: "stop", elapsedMs: 1 };
    },
  };
  const cache = {
    async get() { return null; },
    async put(key, value) { cachePuts.push(value); },
  };

  const result = await providerOver(client, { cache }).observe({ sources: [SOURCE] });

  assert.equal(result.verified.entities.length, 1);
  assert.deepEqual(result.verified.disclosures.map((d) => d.value), ["Rust"]);
  assert.equal(cachePuts.length, 1, "a completed review with claims is cacheable");
});

test("a banked claim the model retypes anyway is stored once and counted", async () => {
  let calls = 0;
  const client = {
    async complete() {
      calls += 1;
      if (calls === 1) throw loopError();
      return { text: block([CLAIM_RUST]), finishReason: "stop", elapsedMs: 1 };
    },
  };

  const result = await providerOver(client).observe({ sources: [SOURCE] });
  assert.deepEqual(result.verified.disclosures.map((d) => d.value), ["Rust"]);
  assert.equal(result.duplicates, 1, "the retype is deduped, and the drop is visible");
});

test("a new claim on a review turn may use a ref the bank declares", async () => {
  let calls = 0;
  const client = {
    async complete() {
      calls += 1;
      if (calls === 1) throw loopError();
      // p1 is declared only in EXTRACTED_CLAIMS — the model was told not to
      // retype the entity, so rejecting this as DANGLING_REF would make the
      // review contract unsatisfiable.
      return { text: block([CLAIM_POSTGRES]), finishReason: "stop", elapsedMs: 1 };
    },
  };

  const result = await providerOver(client).observe({ sources: [SOURCE] });
  assert.ok(result.verified.disclosures.some((d) => d.value === "PostgreSQL"),
    "the banked entity's ref counts as declared");
});

/* ------------------------------------------------------------------ */
/* 7. exhaustion: the bank is the floor, never lost                    */
/* ------------------------------------------------------------------ */

test("when every attempt loops, the thinking harvest IS the salvage", async () => {
  const client = { async complete() { throw loopError(); } };
  const cachePuts = [];
  const cache = { async get() { return null; }, async put(k, v) { cachePuts.push(v); } };

  const result = await providerOver(client, { cache, maxAttempts: 2 })
    .observe({ sources: [SOURCE] });

  assert.equal(result.partial, true, "the job stays open — salvage never claims completion");
  assert.equal(result.recovered, "salvaged_thinking");
  assert.equal(result.verified.entities.length, 1);
  assert.deepEqual(result.verified.disclosures.map((d) => d.value), ["Rust"]);
  assert.equal(cachePuts.length, 0, "a partial answer must never satisfy a replay");
});

test("ungrounded claims in the thinking are refused at the bank's door", async () => {
  const invented = JSON.stringify({
    claim: "disclosure", subject_ref: "p1", field: "capability", value: "Kubernetes",
    source_id: "attachment:res1", evidence: "certified Kubernetes administrator",
    explicit: true, confidence: 0.95,
  });
  const error = new ModelError(ModelErrorCode.REASONING_LOOP, "looped", {
    partialText: "", repeatedLine: "x", repeats: 4,
    reasoningText: `1. ${CLAIM_ENTITY}\n2. ${invented}`,
  });
  const client = { async complete() { throw error; } };

  const result = await providerOver(client, { maxAttempts: 1 }).observe({ sources: [SOURCE] });
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.disclosures.length, 0,
    "an evidence quote that appears nowhere in the source does not enter the "
    + "graph on the strength of having been thought");
});

/* ------------------------------------------------------------------ */
/* 8. wire serialization round-trips what the model needs to see       */
/* ------------------------------------------------------------------ */

test("a validated claim serializes back to the wire shape, sentinels stripped", () => {
  const line = wireClaimLine("disclosures", {
    subjectRef: "p1", field: "capability", value: "Rust <<<END>>>",
    sourceId: "attachment:res1", evidence: "I build in Rust.", explicit: true, confidence: 0.95,
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.claim, "disclosure");
  assert.equal(parsed.subject_ref, "p1");
  assert.equal(parsed.source_id, "attachment:res1");
  assert.equal(parsed.value, "Rust END",
    "the delimiters are gone; the leftover word cannot draw a boundary");
});

test("flattenVerified walks every group in claim-group order", () => {
  const entries = flattenVerified({
    entities: [{ ref: "p1" }], intents: [], relationships: [],
    disclosures: [{ subjectRef: "p1", value: "Rust" }],
  });
  assert.deepEqual(entries.map((e) => e.group), ["entities", "disclosures"]);
});

/* ------------------------------------------------------------------ */
/* 9. prose thinking: the thoughts travel even when the bank is empty  */
/* ------------------------------------------------------------------ */

// Mark's question, 2026-08-29: "is the wake up from the loop contract
// updated with the content that was in the thoughts too?" — asked over a
// live trace where the model thought about the resume IN PROSE ("We need to
// produce entity claim for that person...") and wrote no JSON claim lines,
// so the harvest banked nothing. The answer must be YES either way: an
// empty bank must not mean an empty-handed wake-up. The thoughts block is
// the model's continuity; the claims block is a bonus when the thinking
// happened to be written as claims.

test("a prose-thinking loop still hands the wake-up the model's own thoughts", async () => {
  const proseThinking = [
    "We need to produce observations from the message and attachment.",
    "The attachment is a resume. We can identify Mark Evans Jr. as a PERSON.",
    "We also see Rust in the skills line, that is a capability disclosure.",
    "Now produce the block.",
    "Now produce the block.",
    "Now produce the block.",
  ].join("\n");

  const prompts = [];
  const client = {
    async complete({ prompt }) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        throw new ModelError(ModelErrorCode.REASONING_LOOP, "looped", {
          partialText: "", repeatedLine: "now produce the block.", repeats: 10,
          reasoningText: proseThinking,
        });
      }
      return { text: block([CLAIM_ENTITY]), finishReason: "stop", elapsedMs: 1 };
    },
  };

  const result = await providerOver(client).observe({ sources: [SOURCE] });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /<<<PREVIOUS_THOUGHTS>>>/,
    "the thoughts travel even though no claim lines existed to bank");
  assert.ok(prompts[1].includes("identify Mark Evans Jr. as a PERSON"),
    "the CONTENT of the thinking is in the block, verbatim");
  assert.ok(!prompts[1].includes("<<<EXTRACTED_CLAIMS>>>"),
    "no bank, no numbered review — the model resumes from prose, not from a list");
  assert.match(prompts[1], /Resume\s*\nfrom where the real work stopped; do not start over/,
    "the wake-up says what the thoughts are FOR");
  assert.equal(result.verified.entities.length, 1,
    "and the resumed attempt lands its answer");
});
