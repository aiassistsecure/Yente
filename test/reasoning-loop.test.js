/**
 * A model that is alive and saying nothing new.
 *
 * THE TRACE THIS EXISTS FOR
 *
 *   21:55:05  text=- I will ensure the `confidence` field is between 0 and 1.
 *   21:55:06  text=- I will ensure the `source_id` includes the `message:` prefix.
 *   21:55:07  text=- I will ensure the `evidence` is a verbatim substring of the source.
 *   21:55:09  text=- I will ensure the `explicit` field is set correctly.
 *   ...for six and a half minutes, ~142 tokens, attempt 1
 *
 * Every guard was satisfied, and each was working exactly as designed:
 *
 *   firstTokenTimeoutMs   cleared — a token did arrive
 *   streamTimeoutMs       reset on EVERY reasoning delta, so it never fires
 *   maxCharacters         reasoning is not appended to `text`, so it never sees it
 *   maxTokens             the loop is slow; minutes from the ceiling
 *
 * Reasoning counts as liveness because discarding it caused FIRST_TOKEN_TIMEOUT
 * on a healthy model. That stays. The gap is narrower than it looks: arrival is
 * not progress, and a loop is the single best liveness signal there is.
 *
 * Note WHAT it was repeating: every line is from the RULES section of the output
 * contract. It was not thinking about the email, it was rehearsing the
 * constraints. That is why the answer is a wake-up that restates the TASK and
 * pointedly omits the rules — and why the second test below is the important
 * one, because a guard that fires on legitimate long reasoning would be worse
 * than the bug.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ModelErrorCode, createModelClient, isTransient } from "../src/llm/client.js";
import { createWakeUpPrompt } from "../src/intelligence/prompt.js";

/** An SSE stream of reasoning deltas, then optional content. */
function streamOf(reasoningLines, content = null) {
  const frames = reasoningLines.map((line) =>
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${line}\n` } }] })}\n\n`);
  if (content) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  }
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

const client = (fetchImpl, rest = {}) => createModelClient({
  baseUrl: "http://localhost:9999/v1", model: "test", fetchImpl, ...rest,
});

/* --- the loop is caught ------------------------------------------------- */

test("the exact observed loop is caught, and names the line", async () => {
  const looping = [];
  for (let i = 0; i < 12; i += 1) {
    looping.push(
      "- I will ensure the `confidence` field is between 0 and 1.",
      "- I will ensure the `source_id` includes the `message:` prefix.",
      "- I will ensure the `evidence` is a verbatim substring of the source.",
      "- I will ensure the `explicit` field is set correctly.",
    );
  }

  await assert.rejects(
    client(streamOf(looping)).complete({ prompt: "p", system: "s" }),
    (error) => {
      assert.equal(error.code, ModelErrorCode.REASONING_LOOP);
      assert.match(error.meta.repeatedLine, /confidence/,
        "the repeated line IS the diagnosis, and the wake-up quotes it back");
      assert.ok(error.meta.repeats >= 4);
      return true;
    },
  );
});

test("a loop is TRANSIENT, so the caller retries rather than failing the job", () => {
  // The job may be one nudge from succeeding. Treating a loop as permanent
  // would throw away work that a wake-up recovers.
  assert.equal(isTransient({ code: ModelErrorCode.REASONING_LOOP }), true);
});

test("a line split across deltas still counts as one line", async () => {
  // The observed trace split sentences mid-word across deltas ("...substring of
  // the" / "source."), and one line arrived without its leading dash because the
  // dash landed in the previous delta. Comparing raw deltas would have called
  // those different lines and never tripped.
  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    frames.push("- I will ensure the `evidence` is a verbatim ", "substring of the source.\n");
  }
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: {
      async *[Symbol.asyncIterator]() {
        for (const piece of frames) {
          yield new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning: piece } }] })}\n\n`);
        }
        yield new TextEncoder().encode("data: [DONE]\n\n");
      },
    },
  });

  await assert.rejects(
    client(fetchImpl).complete({ prompt: "p", system: "s" }),
    (error) => error.code === ModelErrorCode.REASONING_LOOP,
  );
});

/* --- THE IMPORTANT ONE: legitimate reasoning is never caught ------------- */

test("a long reasoning pass with novel lines is NOT a loop", async () => {
  // This is the real NuExtract3 trace from a healthy run: two minutes of
  // genuine step-by-step reasoning that reached a conclusion. A guard that
  // fired on this would be worse than the bug it replaced, because it would
  // break every message instead of one.
  const genuine = [
    "The user wants me to act as Yente, a matchmaker, and extract information from a single email message.",
    "**1. Analyze the Input:**",
    "- **Sender:** `founders@vibecode-101.com`. The `META` block provides a `sender_ref`.",
    "- **Recipient:** `yente@ccme.network`. This is the system I am acting for, not an entity.",
    "- **Subject:** \"This is a test\". This is generic and does not provide specific information.",
    "- **Body:** \"I'm mark Sent from my iPhone\". This is the core content to analyze.",
    "**2. Apply the Protocol and Rules:**",
    "- **Entity Extraction:** The sender identifies themselves as \"mark\". This is a `PERSON` entity.",
    "- **Disclosure Extraction:** The message discloses the name and the device. \"iPhone\" is not a field.",
    "- **Intent Extraction:** The message is a simple self-introduction with no request or offer.",
    "- **Relationship Extraction:** The message only mentions one person.",
    "**3. Conclusion:**",
    "The message identifies a person. I will report that entity.",
  ];

  const completion = await client(streamOf(genuine, "<<<OBSERVATIONS>>>{}\n<<<END>>>"))
    .complete({ prompt: "p", system: "s" });
  assert.match(completion.text, /OBSERVATIONS/, "healthy reasoning must reach its answer");
});

test("repeated structural fragments are not a loop", async () => {
  // "**2.**", "-", "```" and similar repeat constantly in real reasoning. They
  // are punctuation, not an argument going in circles, so short lines are
  // exempt — otherwise every numbered list would trip the guard.
  const withFragments = [];
  for (let i = 0; i < 20; i += 1) withFragments.push("-", "**", "  ", "###");
  withFragments.push("A genuinely novel concluding sentence about the message.");

  const completion = await client(streamOf(withFragments, "done"))
    .complete({ prompt: "p", system: "s" });
  assert.equal(completion.text, "done");
});

test("the threshold is configurable, because the right number depends on the model", async () => {
  const twice = ["This is a sufficiently long line to be counted at all.",
    "This is a sufficiently long line to be counted at all."];

  // Default tolerates two; a threshold of 2 does not.
  const ok = await client(streamOf(twice, "fine")).complete({ prompt: "p", system: "s" });
  assert.equal(ok.text, "fine");

  await assert.rejects(
    client(streamOf(twice), { maxReasoningRepeats: 2 }).complete({ prompt: "p", system: "s" }),
    (error) => error.code === ModelErrorCode.REASONING_LOOP,
  );
});

/* --- the wake-up ------------------------------------------------------- */

test("the wake-up names the loop and quotes the line back", async () => {
  const prompt = createWakeUpPrompt({
    sources: [{ id: "message:x", text: "hello" }],
    repeatedLine: "i will ensure the `confidence` field is between 0 and 1",
  });
  assert.match(prompt, /WAKE_UP/);
  assert.match(prompt, /repeatedly/i);
  assert.match(prompt, /confidence/, "a specific correction, not a scolding");
});

test("the wake-up restates TASK but NOT the rules it got stuck on", async () => {
  // The whole diagnosis. Every line the model looped on came from the RULES
  // section; re-supplying that list would hand back the exact material it was
  // captured by. The rules live in the system message, which is present anyway.
  const prompt = createWakeUpPrompt({ sources: [{ id: "message:x", text: "hello" }] });

  assert.match(prompt, /<<<TASK>>>/, "the task is what fell out of view");
  assert.match(prompt, /who it identifies/);

  for (const rehearsed of [
    /confidence.*between 0 and 1/i,
    /verbatim/i,
    /explicit.*is true when/i,
    /COMPLETE id/i,
  ]) {
    assert.doesNotMatch(prompt, rehearsed,
      "the wake-up must not re-supply the rule list the model was rehearsing");
  }
});

test("the wake-up still carries the sources and the vocabulary", async () => {
  // It is a real attempt, not a scolding — it needs everything required to
  // answer. The vocabulary is DATA the answer needs, not a rule to recite.
  const prompt = createWakeUpPrompt({
    sources: [{ id: "message:x", text: "the body of the email" }],
    context: { sender: "a@b.com" },
  });
  assert.match(prompt, /the body of the email/);
  assert.match(prompt, /disclosure_fields/);
  assert.match(prompt, /a@b\.com/);
  assert.match(prompt, /one OBSERVATIONS block/, "the shape is still required");
});

/* --- repetition is LOCAL: the pre-commit checklist false positive -------- */

// 2026-08-29, 20:40, message:600d48e26373. The model was not looping — it was
// walking a field checklist once per claim it was about to commit:
//
//   We need to check if we need to include "ref". Yes.
//   We need to check if we need to include "kind". Yes.
//   ... nine fields ...
//   We need to check if we need to include "ref". Yes.     <- NEXT claim
//
// The same sentence legitimately recurs every ~9 lines. The old detector
// counted phrases for the WHOLE stream, so a structural phrase hit four
// lifetime occurrences by the fourth claim and the attempt was evicted while
// the model was preparing its final commit. Mark's design: sha the phrase,
// compare against a ROLLING window of recent phrase hashes — repetition
// means "again, recently", never "again, ever".

const CHECKLIST_FIELDS = [
  "claim", "ref", "kind", "name", "email_address",
  "source_id", "evidence", "explicit", "confidence",
];

test("a per-claim commit checklist is method, not repetition", async () => {
  const lines = ["We are ready to write the block. Checking each claim now."];
  // Five claims, nine structurally identical check lines each: every phrase
  // occurs five times in the stream — but never twice within nine lines.
  for (let claim = 1; claim <= 5; claim += 1) {
    lines.push(`Now claim ${claim}: the ${claim} entity from the source.`);
    for (const field of CHECKLIST_FIELDS) {
      lines.push(`We need to check if we need to include "${field}". Yes.`);
    }
  }
  lines.push('{"claim":"entity","ref":"p1","kind":"PERSON","name":"Mark"}');

  const result = await client(streamOf(lines, "<<<OBSERVATIONS>>>\n{}\n<<<END>>>"))
    .complete({ prompt: "p", system: "s" });
  assert.equal(result.text.includes("OBSERVATIONS"), true,
    "the stream survives to the answer — the model was committing, not cycling");
});

test("the same checklist INSIDE the window is still a loop", async () => {
  // The counter-case that keeps the guard honest: the identical sentence
  // four times with nothing between is going in circles, whatever it says.
  const lines = ["Preparing the block now, checking the fields."];
  for (let i = 0; i < 6; i += 1) {
    lines.push('We need to check if we need to include "source_id". Yes.');
  }

  await assert.rejects(
    client(streamOf(lines)).complete({ prompt: "p", system: "s" }),
    (error) => {
      assert.equal(error.code, ModelErrorCode.REASONING_LOOP);
      assert.match(error.meta.repeatedLine, /source_id/);
      return true;
    },
  );
});

test("the window rolls — a tight loop cannot straddle a boundary and hide", async () => {
  // 18 distinct lines of real progress, THEN a tight loop. A batch-cleared
  // buffer could dump its state mid-loop and lose the count; a rolling
  // window cannot.
  const lines = [];
  for (let i = 0; i < 18; i += 1) lines.push(`step ${i} of the real analysis of the letter`);
  for (let i = 0; i < 6; i += 1) lines.push("And we must double check the whole plan again now.");

  await assert.rejects(
    client(streamOf(lines)).complete({ prompt: "p", system: "s" }),
    (error) => {
      assert.equal(error.code, ModelErrorCode.REASONING_LOOP);
      return true;
    },
  );
});

test("the sha is the WHOLE phrase — a differing tail is a different phrase", async () => {
  // Mark's exact worry: "then we know for sure — not the tail or something,
  // the phrase itself." Long lines sharing a 60-char prefix but differing at
  // the end must never be conflated into one repeated phrase.
  const prefix = "We need to verify the evidence span is a verbatim quote from the source for field";
  const lines = [];
  for (let i = 0; i < 8; i += 1) lines.push(`${prefix} number ${i} of the envelope.`);
  lines.push("Done with the distinct checks.");

  const result = await client(streamOf(lines, "<<<OBSERVATIONS>>>\n{}\n<<<END>>>"))
    .complete({ prompt: "p", system: "s" });
  assert.ok(result.text.includes("OBSERVATIONS"),
    "eight near-identical phrases with distinct tails are eight phrases");
});
