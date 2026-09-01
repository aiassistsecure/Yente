/**
 * No claim left behind — Mark, 2026-09-01, watching a résumé stream forty
 * proposal lines and then die with "OpenAI stream error: error decoding
 * response body": "I just dont want wasted claims going in the trash."
 *
 * Salvage used to fire only at EXHAUSTION, and only on the LAST attempt's
 * partial text. Attempt 1's forty delivered lines were re-paid in full by
 * attempt 2 — and lost outright if attempt 2 died EARLIER than attempt 1.
 * Now every failed attempt's delivered lines go through the same gates
 * immediately and join the bank: the retry sees them in EXTRACTED_CLAIMS,
 * never re-pays them, and exhaustion keeps them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createIntelligenceProvider } from "../src/intelligence/provider.js";

const SOURCE_TEXT = "MARK EVANS. Rust. Built storage layers. WordPress plugin work. HMAC tunnel.";
const SOURCES = [{ id: "attachment:eea45b7e8c47aaaa", text: SOURCE_TEXT, kind: "attachment" }];

const line = (field, value, evidence) => JSON.stringify({
  claim: "disclosure", subject_ref: "sender", field, value,
  source_id: "attachment:eea45b7e8c47", evidence, explicit: true, confidence: 0.9,
});

/** A transport that streams claims whole, then dies — differently per attempt. */
function dyingClient(attempts) {
  let call = 0;
  return {
    calls: () => call,
    async complete() {
      const script = attempts[Math.min(call, attempts.length - 1)];
      call += 1;
      if (script.ok) {
        return { text: script.text, finishReason: "stop", elapsedMs: 1 };
      }
      const error = Object.assign(new Error("Upstream: OpenAI stream error: error decoding response body"), {
        code: "UPSTREAM_ERROR",
        meta: { transient: true, partialText: script.partialText },
      });
      throw error;
    },
  };
}

test("lines delivered before the stream died are banked, kept, and never lost", async () => {
  // Attempt 1 delivers TWO whole claims then dies. Attempt 2 dies EARLIER —
  // one different claim. Attempt 3 dies with nothing. Under the old
  // exhaustion-only salvage, attempts 1's two claims were gone (only the
  // LAST partial was salvaged); now all three survive.
  const client = dyingClient([
    { partialText: "<<<OBSERVATIONS>>>\n" + line("capability", "Rust", "Rust") + "\n" + line("capability", "Built storage layers", "Built storage layers") + "\n" },
    { partialText: "<<<OBSERVATIONS>>>\n" + line("capability", "WordPress plugin", "WordPress plugin") + "\n" },
    { partialText: "" },
  ]);
  const provider = createIntelligenceProvider({
    client, provider: "test", model: "test-model", retryDelayMs: 0,
  });

  const result = await provider.observe({ sources: SOURCES, attempts: 3, providedRefs: ["sender"] });
  assert.equal(result.partial, true, "no END ever arrived — the job stays open");
  const values = (result.verified?.disclosures ?? []).map((d) => d.value).sort();
  assert.deepEqual(values, ["Built storage layers", "Rust", "WordPress plugin"],
    "every line ANY dying stream delivered whole is kept — none re-paid, none trashed");
});

test("the retry sees the banked lines and does not re-pay them", async () => {
  // Attempt 1 delivers a claim and dies; attempt 2 completes with a
  // DIFFERENT claim. The final result carries both — the first claim rode
  // the bank across the retry.
  const client = dyingClient([
    { partialText: "<<<OBSERVATIONS>>>\n" + line("capability", "Rust", "Rust") + "\n" },
    { ok: true, text: "<<<OBSERVATIONS>>>\n" + line("capability", "HMAC tunnel", "HMAC tunnel") + "\n<<<END>>>" },
  ]);
  const provider = createIntelligenceProvider({
    client, provider: "test", model: "test-model", retryDelayMs: 0,
  });

  const result = await provider.observe({ sources: SOURCES, attempts: 3, providedRefs: ["sender"] });
  assert.notEqual(result.partial, true, "the second attempt finished the answer");
  const values = (result.verified?.disclosures ?? []).map((d) => d.value).sort();
  assert.deepEqual(values, ["HMAC tunnel", "Rust"],
    "attempt 1's paid-for claim joined attempt 2's completion");
});
