/**
 * Silence keeps the bank — Mark, live tape 19:33, watching thirty
 * {"claim":"approve","n":K} lines crawl past at 3-5s each: "she shouldnt
 * have to approve her own claims just give her the knob to reject the ones
 * she doesnt want" — and then "just watched 27 claims get thrown in the
 * trash."
 *
 * Two findings:
 *   1. applyReviews was ALWAYS keep-unless-rejected — but all four prompt
 *      sites solicited approve-by-number ("stand behind them or reject
 *      them"), so the model dutifully paid ~30 lines approving its own
 *      work every round. The prompts now say what the parser always meant:
 *      EXTRACTED_CLAIMS is already kept; silence keeps; only a
 *      reject-by-number withdraws. (Approve lines remain legal wire — an
 *      old-style answer still parses — they are simply never asked for.)
 *   2. The 27 were never trashed — they were on the graph from the earlier
 *      partial write, and "understood 5" refused to say so because the
 *      duplicates count only rendered when written was ZERO. It renders
 *      whenever nonzero now: "understood 5 claims (+27 already on the
 *      graph)".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyReviews, createIntelligenceProvider } from "../src/intelligence/provider.js";
import { createWakeUpPrompt, createResultsPrompt } from "../src/intelligence/prompt.js";
import { createLogger } from "../src/log.js";

const SOURCES = [{ id: "message:abc123def456", text: "I am Mark. Rust is my language.", kind: "message" }];

function capture(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return written.join("");
}

test("the parser's law, pinned: unreviewed claims are KEPT", () => {
  const banked = [
    { group: "disclosures", claim: { field: "capability", value: "Rust" } },
    { group: "disclosures", claim: { field: "capability", value: "SQL" } },
    { group: "disclosures", claim: { field: "capability", value: "Bash" } },
  ];
  // No verdicts at all: everything stays.
  assert.equal(applyReviews(banked, []).length, 3);
  // One reject: exactly that one goes; no approval needed for the others.
  const afterReject = applyReviews(banked, [{ verdict: "reject", n: 2 }]);
  assert.deepEqual(afterReject.map((e) => e.claim.value), ["Rust", "Bash"]);
});

test("no prompt solicits approvals anymore — the knob is reject, only", () => {
  const claims = ['{"claim":"disclosure","field":"capability","value":"Rust"}'];
  const wakeUp = createWakeUpPrompt({
    sources: SOURCES, repeatedLine: "(loop)", extracted: claims,
  });
  const results = createResultsPrompt({
    sources: SOURCES, accepted: claims, rejected: [],
  });
  for (const [name, prompt] of [["wake-up", wakeUp], ["results", results]]) {
    assert.doesNotMatch(prompt, /"approve"/,
      `${name}: approve-by-number is never asked for`);
    assert.match(prompt, /already/i, `${name}: the bank is stated as already kept`);
    assert.match(prompt, /reject/, `${name}: the reject knob is offered`);
  }
});

test("old-style approve lines remain legal wire — never a rejection", () => {
  const banked = [{ group: "disclosures", claim: { field: "capability", value: "Rust" } }];
  const kept = applyReviews(banked, [{ verdict: "approve", n: 1 }]);
  assert.equal(kept.length, 1, "an unsolicited approval is harmless");
});

test("the understood line confesses its duplicates instead of looking like trash", () => {
  const logger = createLogger();
  const out = capture(() => logger.log("info", "observed", {
    evidence: "message:b4dc7b8b5227d9a4", claims: 5, duplicates: 27,
    rejected: 0, elapsed_ms: 20_900,
  }));
  assert.match(out, /understood/);
  assert.match(out, /\+27 already on the graph/,
    "twenty-seven safe claims must never read as twenty-seven trashed ones");
});
