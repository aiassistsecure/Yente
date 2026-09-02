/**
 * The frame forgives, and boot is optimistic — live, 2026-09-02 18:06:
 *
 *   confirmed introduction could not be sent  match=14a519234126
 *   why=the voice could not compose this introduction: MALFORMED_ARTIFACT,MALFORMED_ARTIFACT
 *   note=stored for automatic retry
 *
 * Both parties had said yes — the consent round WORKED — and the 8B then
 * failed the letter twice with "No canonical Sentinel Blocks found". Probed:
 * `...text<<<END>>>` with no newline before the closer, or a lowercase
 * `<<<end>>>`, produce exactly that code for a letter whose every block is
 * present. Frame whitespace and closer case are reflexes, not information.
 *
 * And "stored for automatic retry" must mean AT BOOT, not "in four minutes
 * if the process is still alive": the stored exponential backoff is for a
 * live loop, and a restart is a fresh chance (Mark: "lets ensure the model
 * retries optimistically on reboot right").
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractArtifact, parseEmailArtifact } from "../src/protocol/blocks.js";
import { generateEmail } from "../src/llm/generate.js";
import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES } from "../src/store/graph.js";

const META = '{"template":"joint_introduction","facts_used":[]}';

test("a closer glued to its content, or lowercase, is still a frame", () => {
  const glued = `<<<META>>>\n${META}<<<END>>>\n<<<SUBJECT>>>\nMeet Mark<<<END>>>\n<<<EMAIL_TEXT>>>\nHello both.<<<END>>>`;
  const lower = `<<<META>>>\n${META}\n<<<end>>>\n<<<SUBJECT>>>\nMeet Mark\n<<<end>>>\n<<<EMAIL_TEXT>>>\nHello both.\n<<<end>>>`;
  const oneLine = `<<<META>>> ${META} <<<END>>>\n<<<SUBJECT>>> Meet Mark <<<END>>>\n<<<EMAIL_TEXT>>>\nHello both.\n<<<END>>>`;
  for (const [name, raw] of [["glued", glued], ["lower", lower], ["oneLine", oneLine]]) {
    const email = parseEmailArtifact(extractArtifact(raw));
    assert.equal(email.subject, "Meet Mark", `${name}: the frame is read, the content is intact`);
    assert.equal(email.text, "Hello both.", `${name}: content untouched`);
  }
});

test("forgiveness never rewrites content — angle brackets inside a block survive", () => {
  const raw = `<<<META>>>\n${META}\n<<<END>>>\n<<<SUBJECT>>>\nA <> B\n<<<END>>>\n<<<EMAIL_TEXT>>>\nx > y and y < z\n<<<END>>>`;
  const email = parseEmailArtifact(extractArtifact(raw));
  assert.equal(email.subject, "A <> B");
  assert.equal(email.text, "x > y and y < z");
});

test("a failure carries what the model actually wrote, delimiters neutralized", async () => {
  const client = { async complete() { return { text: "Sure! <<<META>>> nope", finishReason: "stop", elapsedMs: 1 }; } };
  const result = await generateEmail({
    client, prompt: "p", expect: { template: "joint_introduction", allowedFactIds: [] },
  });
  assert.equal(result.email, null);
  assert.ok(result.failures.length >= 1);
  assert.match(result.failures[0].sample, /Sure!/, "the tape can show the body, not just the code");
  assert.doesNotMatch(result.failures[0].sample, /<<<|>>>/, "a sample can never be mistaken for a frame");
});

test("boot clears a stored backoff: a confirmed introduction is due immediately", () => {
  const graph = createGraphRepositories(openInMemory());
  const T0 = "2026-09-02T18:06:00.000Z";
  const { match } = graph.matches.propose({
    seeker: "person:a@x.test", offerer: "person:b@y.test", matchType: "hiring_x_hire_for",
    confidence: 0.8, reasons: [], conflicts: [], evidence: [], at: T0,
  });
  graph.matches.decide({ matchId: match.id, state: MATCH_STATES.CONFIRMED, by: "mark", at: T0 });
  // Two live failures stamp an exponential wait into the future.
  graph.matches.claimIntroduction(match.id, T0);
  graph.matches.failIntroduction(match.id, { at: T0, error: new Error("MALFORMED_ARTIFACT") });
  graph.matches.claimIntroduction(match.id, "2026-09-02T18:08:00.000Z");
  graph.matches.failIntroduction(match.id, { at: "2026-09-02T18:08:00.000Z", error: new Error("MALFORMED_ARTIFACT") });
  const before = graph.matches.get(match.id);
  assert.ok(String(before.introductionAvailableAt) > "2026-09-02T18:08:00.000Z", "a live wait is stamped");
  assert.equal(graph.matches.confirmedReady("2026-09-02T18:08:30.000Z").length, 0, "and it is honoured while alive");

  // The process restarts thirty seconds later: optimistic.
  const BOOT = "2026-09-02T18:08:30.000Z";
  const requeued = graph.matches.requeueStrandedIntroductions(BOOT);
  assert.equal(requeued, 1);
  assert.equal(graph.matches.confirmedReady(BOOT).length, 1, "due on the first pass after boot");
  assert.equal(graph.matches.get(match.id).introductionAttempts, 2, "history is kept; only the wait is cleared");
});
