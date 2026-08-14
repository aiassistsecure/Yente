/**
 * Intake must not be the end of the conversation.
 *
 * THE BUG
 *
 * `ingestOne` extracted facts, moved the member to INTERVIEWING, and returned.
 * `qualify()` — the only function in the runtime that queues the next letter —
 * was exported at yente.js:615 and called by NOTHING in src/ or bin/. Grep it.
 *
 * In production: a DOCX résumé arrived, sixteen facts came out of it, all
 * span-verified, and she never replied. Not a crash, not a failed send. The
 * per-tick log read `ingested=1 sent=0` and there was no error anywhere,
 * because nothing had gone wrong — the pipeline just stopped one step early.
 *
 * Two silences, and both are tested here:
 *   1. facts extracted, nothing queued            -> the dead end
 *   2. member fully qualifies, still nothing queued -> qualify() only ever
 *      wrote a letter when something was MISSING, so the better the résumé, the
 *      less they heard back.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";

const T = (m) => new Date(Date.parse("2026-08-13T12:00:00.000Z") + m * 60_000).toISOString();
const WHO = "dev@interchained.org";

const RESUME = [
  "MARK ALLEN EVANS JR.",
  "Founder & Systems Architect  |  Interchained LLC   ·   Winter Park, FL",
  "Languages: Rust, Python, TypeScript",
  "10+ years across Linux infrastructure, databases, blockchain protocols.",
].join("\n");

/**
 * A model that answers with the field names a real model chose — aliases, not
 * canonical paths — because the point is that a correct extraction using
 * reasonable names must still reach the view.
 */
function scriptedModel(facts) {
  return {
    async complete(request) {
      const sourceId = request.prompt.match(/<<<SOURCE ([^>]+)>>>/)?.[1];
      return {
        text: [
          "<<<PROFILE_FACTS>>>",
          JSON.stringify({
            facts: facts.map((f) => ({ ...f, source_id: sourceId, explicit: true, confidence: "certain" })),
          }),
          "<<<END>>>",
        ].join("\n"),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };
}

function harness(facts) {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  // NO policies argument — production passes none either, and that used to make
  // qualify() throw on `policies.memberQualification`. Defaults now live in the
  // runtime, so this is the shape the daemon actually runs in.
  const runtime = createRuntime({
    repositories, transport, extractionClient: scriptedModel(facts),
    // No real backoff in the suite. Production waits 5s then 10s between
    // transient retries; a test asserting the failure path must not.
    config: { extractionRetryDelayMs: 0 },
  });
  return { store, repositories, transport, runtime };
}

function sendResume(transport, id = "<r1@sender.test>") {
  transport.deliver({
    rfcMessageId: id,
    from: WHO,
    to: ["yente@ccme.network"],
    subject: "Resume",
    text: "Here is my resume.",
    attachments: [{
      filename: "Mark_Evans_Resume 2026 latest.docx",
      mimeType: "text/plain",   // parsed content is what matters here
      content: RESUME,
    }],
  });
}

const jobs = (store) => store.query(`FROM ${COLLECTIONS.OUTBOX}`);
const purposes = (store) => jobs(store).map((j) => j.purpose).sort();

/* ----------------------------------------------------------------------- */

test("a résumé produces a letter, not silence", async () => {
  const { store, transport, runtime } = harness([
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
    { field: "professional.location", value: "Winter Park, FL", evidence: "Interchained LLC   ·   Winter Park, FL" },
    { field: "professional.skills.languages", value: "Rust", evidence: "Languages: Rust, Python, TypeScript" },
  ]);
  sendResume(transport);

  const [result] = await runtime.ingest(T(1));

  assert.equal(result.facts, 3, "the facts were stored");
  assert.notEqual(jobs(store).length, 0,
    "THE BUG: three verified facts and not one queued letter");
  assert.deepEqual(purposes(store), ["interview_question"]);
  assert.equal(result.outcome, "interviewing");
});

test("the letter reflects the document back and asks in plain words", async () => {
  const { store, transport, runtime } = harness([
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
    { field: "professional.location", value: "Winter Park, FL", evidence: "Interchained LLC   ·   Winter Park, FL" },
    { field: "professional.skills.languages", value: "Rust", evidence: "Languages: Rust, Python, TypeScript" },
  ]);
  sendResume(transport);
  await runtime.ingest(T(1));

  const letter = jobs(store)[0].email;

  // Proof of reading. Without it a member assumes they were ignored and re-sends.
  assert.match(letter.text, /Role: Founder & Systems Architect/);
  assert.match(letter.text, /Based: Winter Park, FL/);

  // The schema must never reach a human.
  assert.doesNotMatch(letter.text, /intent\.seeks|introductionTypes|professional\./);
  assert.match(letter.text, /what you are looking for/);
});

test("a member who qualifies is told what she has — the second silence", async () => {
  // A résumé that also states intent clears the whole policy. Before, that
  // queued nothing at all: qualify() writes a letter only for MISSING fields.
  const { store, transport, runtime } = harness([
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
    { field: "professional.location", value: "Winter Park, FL", evidence: "Interchained LLC   ·   Winter Park, FL" },
    { field: "professional.skills.languages", value: "Rust", evidence: "Languages: Rust, Python, TypeScript" },
    { field: "intent.seeks", value: "technical co-founder", evidence: "10+ years across Linux infrastructure" },
    { field: "intent.introductionTypes", value: "investment", evidence: "blockchain protocols." },
  ]);
  sendResume(transport);

  const [result] = await runtime.ingest(T(1));

  assert.equal(result.outcome, "qualified");
  assert.deepEqual(purposes(store), ["profile_confirmation"],
    "a qualified member hears back, and is not sent an interview question");

  const letter = jobs(store).find((j) => j.purpose === "profile_confirmation").email;
  assert.match(letter.text, /Role: Founder & Systems Architect/);
  assert.match(letter.text, /reply CORRECT/, "corrigible by the one person who can spot an error");
  assert.match(letter.text, /without showing you first/);
});

test("re-sending the same résumé does not send a second letter — INV-10", async () => {
  const facts = [
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
    { field: "professional.location", value: "Winter Park, FL", evidence: "Interchained LLC   ·   Winter Park, FL" },
    { field: "professional.skills.languages", value: "Rust", evidence: "Languages: Rust, Python, TypeScript" },
  ];
  const { store, transport, runtime } = harness(facts);

  sendResume(transport, "<r1@sender.test>");
  await runtime.ingest(T(1));
  // A different Message-ID, so dedupe does not catch it: the same person sending
  // the same document again because they heard nothing. Which is exactly what
  // happened in production.
  sendResume(transport, "<r2@sender.test>");
  await runtime.ingest(T(2));

  assert.equal(jobs(store).length, 1, "the outbox key is per-member and per-question");
});

test("an extraction that fails is reported, not swallowed", async () => {
  // The runtime used to discard extractProfileFacts' `failures` array entirely,
  // which is why a broken extraction and an honestly empty one produced the
  // identical log line. Recovering the reason took a second tool.
  const { store, transport, runtime } = harness([]);
  const broken = {
    async complete() { return { text: "I could not read that.", finishReason: "stop", elapsedMs: 1 }; },
  };
  const r2 = createRuntime({
    repositories: createRepositories(store), transport, extractionClient: broken,
    config: { extractionRetryDelayMs: 0 },
  });
  sendResume(transport);

  const [result] = await r2.ingest(T(1));

  assert.equal(result.facts, 0);
  assert.ok(result.failures.length > 0, "the reason must reach the caller");
  assert.equal(result.failures[0].code, "MALFORMED_ARTIFACT");
});

test("a member who sends nothing readable is still asked for a profile", async () => {
  // The pre-existing path, unbroken by the new hand-off: no source means no
  // extraction, so qualification must not run and PROFILE_REQUEST still goes.
  const { store, transport, runtime } = harness([]);
  transport.deliver({
    rfcMessageId: "<hi@sender.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "hello", text: "hi",
  });

  const [result] = await runtime.ingest(T(1));

  assert.equal(result.outcome, "profile_requested");
  assert.deepEqual(purposes(store), ["profile_request"]);
});

test("STOP still wins over everything, résumé attached or not", async () => {
  // INV-9 is evaluated before intake, and the new hand-off must not have moved
  // anything in front of it.
  const { store, transport, runtime } = harness([
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
  ]);
  transport.deliver({
    rfcMessageId: "<stop@sender.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "STOP",
    text: "STOP please remove me",
    attachments: [{ filename: "r.txt", mimeType: "text/plain", content: RESUME }],
  });

  const [result] = await runtime.ingest(T(1));

  assert.equal(result.outcome, "stop");
  assert.equal(store.query(`FROM ${COLLECTIONS.PROFILE_FACTS}`).length, 0,
    "a STOP message is never mined for facts");
  assert.deepEqual(purposes(store), []);
});

test("a follow-up with no attachment is not asked for a résumé again", async () => {
  // Mark's exact case. Sixteen verified facts on file, he emails to ask why he
  // has not heard back, the message carries no attachment and under 80
  // characters of substance — and the old code replied "please send a resume",
  // which is the most insulting possible answer from a desk that had already
  // read it.
  const { store, transport, runtime } = harness([
    { field: "professional.role", value: "Founder & Systems Architect", evidence: "Founder & Systems Architect  |  Interchained LLC" },
    { field: "professional.location", value: "Winter Park, FL", evidence: "Interchained LLC   ·   Winter Park, FL" },
    { field: "professional.skills.languages", value: "Rust", evidence: "Languages: Rust, Python, TypeScript" },
  ]);

  sendResume(transport, "<r1@sender.test>");
  await runtime.ingest(T(1));

  transport.deliver({
    rfcMessageId: "<followup@sender.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "any news?", text: "any news?",
  });
  const [result] = await runtime.ingest(T(2));

  assert.notEqual(result.outcome, "profile_requested",
    "she already has his résumé — asking again is the bug");
  assert.equal(result.facts, 3, "answered from what is already on file");
  assert.ok(!purposes(store).includes("profile_request"));
});
