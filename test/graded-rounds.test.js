/**
 * Graded rounds — Mark's protocol, 2026-08-31:
 *
 *   "could we make the model submit claims more frequently and show it the
 *    results of course? like 200 OK : 9 claims accepted, 2 rejected : xyz:
 *    error evidence <12 chars, etc etc"
 *
 * A PARTLY-verified answer is no longer the end of the conversation. The
 * accepted claims bank; the rejects come back graded with the parser's own
 * reasons; the model fixes what the source supports and drops what it does
 * not. Live motivation: the first GLM-4-32B run banked 46 claims and lost 1
 * to a drifted quote it could have fixed in ten seconds — had anyone told it.
 *
 * The discipline under the generosity:
 *   - a clean envelope never pays for an extra round
 *   - rounds extend the attempt budget; they are never paid for with retries
 *   - a claim rejected twice with the same grade stops being relitigated
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createIntelligenceProvider } from "../src/intelligence/provider.js";

const CV = "MARK EVANS JR. — Systems Architect. Built the storage layer in Rust. Skills: Rust, Docker.";
const SOURCES = [{ id: "attachment:cv1", text: CV }];

const line = (claim) => JSON.stringify(claim);
const ENTITY = line({
  claim: "entity", ref: "p1", kind: "PERSON", name: "Mark Evans Jr.",
  source_id: "attachment:cv1", evidence: "MARK EVANS JR. — Systems Architect.",
  explicit: true, confidence: 0.95,
});
const GOOD_DISCLOSURE = line({
  claim: "disclosure", subject_ref: "p1", field: "capability", value: "Rust",
  source_id: "attachment:cv1", evidence: "Rust", explicit: true, confidence: 0.9,
});
// An honest read with a drifted quote — the live SPAN_NOT_FOUND class.
const DRIFTED_DISCLOSURE = line({
  claim: "disclosure", subject_ref: "p1", field: "capability", value: "Docker",
  source_id: "attachment:cv1", evidence: "Built the storage layer in Rust and Docker.",
  explicit: true, confidence: 0.9,
});
const FIXED_DISCLOSURE = line({
  claim: "disclosure", subject_ref: "p1", field: "capability", value: "Docker",
  source_id: "attachment:cv1", evidence: "Docker", explicit: true, confidence: 0.9,
});

const envelope = (...lines) =>
  ["<<<OBSERVATIONS>>>", ...lines, "<<<END>>>"].join("\n");

function providerWith(replies, { onPrompt = null, rounds } = {}) {
  let call = 0;
  return createIntelligenceProvider({
    client: {
      async complete({ prompt }) {
        onPrompt?.(prompt, call);
        const text = replies[Math.min(call, replies.length - 1)];
        call += 1;
        return { text, finishReason: "stop", elapsedMs: 1 };
      },
    },
    provider: "pin", model: "GLM-4-32B",
    ...(rounds !== undefined ? { rounds } : {}),
    sleep: async () => {}, now: () => "2026-08-31T23:59:00.000Z",
  });
}

test("a clean envelope never pays for an extra round", async () => {
  const prompts = [];
  const provider = providerWith([envelope(ENTITY, GOOD_DISCLOSURE)], {
    onPrompt: (p) => prompts.push(p),
  });
  const result = await provider.observe({ sources: SOURCES });
  assert.equal(prompts.length, 1);
  assert.equal(result.rounds, 0);
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.disclosures.length, 1);
});

test("a reject earns a graded round, and the fix lands", async () => {
  const prompts = [];
  const provider = providerWith(
    [
      envelope(ENTITY, GOOD_DISCLOSURE, DRIFTED_DISCLOSURE),
      // Round 2: the model keeps the bank (no verdicts needed — silence
      // keeps) and resubmits the reject corrected.
      envelope(FIXED_DISCLOSURE),
    ],
    { onPrompt: (p) => prompts.push(p) },
  );
  const result = await provider.observe({ sources: SOURCES });

  assert.equal(prompts.length, 2, "one results turn, not a retry storm");
  const resultsTurn = prompts[1];
  assert.match(resultsTurn, /<<<RESULTS>>>/);
  assert.match(resultsTurn, /2 of your claims were ACCEPTED/);
  assert.match(resultsTurn, /1 were REJECTED/);
  assert.match(resultsTurn, /SPAN_NOT_FOUND/, "the parser's own code is the grade");
  assert.match(resultsTurn, /<<<EXTRACTED_CLAIMS>>>/);
  assert.match(resultsTurn, /1\. \{"claim"/, "the bank is numbered, never resent");

  assert.equal(result.rounds, 1);
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.disclosures.length, 2, "Rust banked + Docker fixed");
  assert.equal(result.attempts, 2);
});

test("a claim rejected twice with the same grade stops being relitigated", async () => {
  const prompts = [];
  // The model stubbornly resends the same drifted quote every round.
  const provider = providerWith(
    [
      envelope(ENTITY, DRIFTED_DISCLOSURE),
      envelope(DRIFTED_DISCLOSURE),
      envelope(DRIFTED_DISCLOSURE),
    ],
    { onPrompt: (p) => prompts.push(p) },
  );
  const result = await provider.observe({ sources: SOURCES });

  assert.equal(prompts.length, 2,
    "the second identical reject is dropped, not sent back a third time");
  assert.equal(result.verified.entities.length, 1, "the bank survives the standoff");
  assert.equal(result.verified.disclosures.length, 0);
  assert.ok(result.rejected.some((r) => r.code === "SPAN_NOT_FOUND"),
    "the loss is still reported honestly");
});

test("rounds: 0 disables the protocol entirely", async () => {
  const prompts = [];
  const provider = providerWith(
    [envelope(ENTITY, DRIFTED_DISCLOSURE)],
    { onPrompt: (p) => prompts.push(p), rounds: 0 },
  );
  const result = await provider.observe({ sources: SOURCES });
  assert.equal(prompts.length, 1);
  assert.equal(result.rounds, 0);
  assert.equal(result.verified.entities.length, 1);
});

test("the review verdict works on a graded round: reject-by-number drops a banked claim", async () => {
  const provider = providerWith([
    envelope(ENTITY, GOOD_DISCLOSURE, DRIFTED_DISCLOSURE),
    envelope(JSON.stringify({ claim: "reject", n: 2 })),
  ]);
  const result = await provider.observe({ sources: SOURCES });
  assert.equal(result.verified.entities.length, 1);
  assert.equal(result.verified.disclosures.length, 0,
    "the model withdrew banked claim 2 (Rust) and declined to fix Docker");
});

test("rounds are never paid for with retries: a transport failure after a round still retries", async () => {
  let call = 0;
  const replies = [
    envelope(ENTITY, DRIFTED_DISCLOSURE),   // round earned
    null,                                    // transport failure on results turn
    envelope(FIXED_DISCLOSURE),              // retry of the results turn
  ];
  const provider = createIntelligenceProvider({
    client: {
      async complete() {
        const reply = replies[call];
        call += 1;
        if (reply === null) {
          const error = new Error("socket hang up");
          error.code = "NETWORK_ERROR";
          throw error;
        }
        return { text: reply, finishReason: "stop", elapsedMs: 1 };
      },
    },
    provider: "pin", model: "GLM-4-32B",
    sleep: async () => {}, now: () => "2026-08-31T23:59:00.000Z",
  });
  const result = await provider.observe({ sources: SOURCES });
  assert.equal(result.verified.disclosures.length, 1, "the fix still landed");
  assert.equal(result.verified.entities.length, 1);
});
