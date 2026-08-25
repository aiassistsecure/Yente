/**
 * Bounding the prompt.
 *
 * THE BUG THESE TESTS EXIST FOR
 *
 * `queue.js` sent `text: evidence.text` — the whole evidence, however long —
 * while `prompt.js` carried a comment claiming the chunking policy "lives in one
 * place upstream". It didn't. A comment stood in for the design.
 *
 * The failure was not "the prompt is a bit big". During prefill a model emits
 * NOTHING: no tokens, no reasoning deltas. PIN kills a stream after 90 seconds
 * of silence. So a prompt whose prefill exceeds ninety seconds is killed before
 * it speaks, and killed identically on every retry because the input never
 * changed — permanent failure wearing the costume of a transient one. On the box
 * that burned 15 minutes per message while the dashboard said "busy".
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  boundSource,
  boundSources,
  estimateTokens,
  DEFAULT_MAX_SOURCE_CHARS,
} from "../src/intelligence/bound.js";

test("short evidence is passed through untouched", () => {
  // The common case must cost nothing. Most mail is short.
  const text = "Hi Yente, I am raising a seed round and looking for a CTO.";
  const result = boundSource(text);
  assert.equal(result.text, text);
  assert.equal(result.truncated, false);
  assert.equal(result.droppedChars, 0);
});

test("long evidence keeps the head AND the tail", () => {
  // Business correspondence puts the ask at the top and the identity at the
  // bottom — signature block, title, company. Keeping only the first N
  // characters reliably loses the person the whole graph is about.
  const head = "SUBJECT: Series A. We are raising.";
  const middle = "x".repeat(50_000);
  const tail = "Best regards,\nJane Okafor\nCTO, Northwind Robotics\n+1 555 0100";
  const result = boundSource(`${head}\n${middle}\n${tail}`, { maxChars: 4_000 });

  assert.equal(result.truncated, true);
  assert.ok(result.text.includes("SUBJECT: Series A"), "the ask must survive");
  assert.ok(result.text.includes("Northwind Robotics"), "the signature must survive");
  assert.ok(result.text.length <= 4_000 + 400, "within the bound plus its marker");
});

test("the gap is announced in the text, not left as a cliff", () => {
  // A letter that stops mid-sentence invites the model to bridge the gap. Saying
  // "characters omitted, do not quote across it" is cheaper than any amount of
  // downstream verification.
  const result = boundSource("a".repeat(20_000), { maxChars: 1_000 });
  assert.match(result.text, /omitted/);
  assert.match(result.text, /excerpt/);
  assert.match(result.text, /Do not quote across the gap/);
});

test("truncation can cost a claim but can never manufacture one", () => {
  // The property that matters. Everything the model sees is a verbatim substring
  // of the original except the marker, so a quote it makes either verifies
  // against the stored source or is rejected. Nothing new becomes quotable.
  const original = `${"A".repeat(5_000)}NEEDLE${"B".repeat(5_000)}`;
  const result = boundSource(original, { maxChars: 2_000 });

  const [head, tail] = result.text.split(/\[\.\.\..*?\.\.\.\]/s);
  assert.ok(original.includes(head.trim()), "the head must be verbatim");
  assert.ok(original.includes(tail.trim()), "the tail must be verbatim");
  assert.ok(!result.text.includes("NEEDLE"),
    "the dropped middle is genuinely gone — the model cannot quote it");
});

test("the report says what it cost, because the log has to be able to say it", () => {
  const { sources, report } = boundSources([
    { id: "message:short", text: "hello" },
    { id: "attachment:long", text: "z".repeat(40_000) },
  ], { maxChars: 8_000 });

  assert.equal(sources.length, 2);
  assert.equal(sources[0].truncated, false);
  assert.equal(sources[1].truncated, true);
  assert.equal(report.truncated, 1);
  assert.equal(report.originalChars, 5 + 40_000);
  assert.ok(report.keptChars < report.originalChars);
  assert.ok(report.estimatedTokens > 0);
});

test("the default bound leaves room inside a 90-second prefill", () => {
  // Not a magic number: the upstream kills a stream after 90s of silence, and
  // prefill IS silence. The bound has to be small enough that the model speaks
  // before then, with margin, on the slowest model we actually run.
  assert.ok(DEFAULT_MAX_SOURCE_CHARS <= 32_000,
    "a bound that cannot prefill in 90s is not a bound");
  assert.ok(estimateTokens(DEFAULT_MAX_SOURCE_CHARS) <= 8_000);
});

test("junk in is not a crash out", () => {
  for (const value of [null, undefined, 0, ""]) {
    const result = boundSource(value);
    assert.equal(result.text, "");
    assert.equal(result.truncated, false);
  }
  assert.deepEqual(boundSources(null).sources, []);
});
