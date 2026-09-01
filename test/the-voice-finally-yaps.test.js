/**
 * The voice, finally yapping — Mark, 2026-09-01: "Yente is not replying to
 * emails sent to yente@ccme.network ... the model which is supposed to be
 * yapping is not yapping."
 *
 * generateEmail, guardEmailDisclosure, the email artifact protocol, the
 * voice seat and the voice lanes ALL existed — with zero callers. Every
 * letter was a template, and every template is idempotent by address or by
 * question, so a member who already had their letter and wrote AGAIN deduped
 * to nothing: repeat mail was answered exactly zero times, while the
 * identity file ordered "Reply to every email promptly."
 *
 * These tests pin the yap gate: when the pipeline queues nothing for a live
 * conversational message, the voice model composes the reply — guarded and
 * per-message idempotent. There is NO canned fallback ("thats not how we do
 * business with yente"): a wedged model records an owed reply and the desk
 * retries it every tick until the voice speaks for real.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";
import { createMember, beginIntake } from "../src/domain/member.js";
import { createEmailArtifact } from "../src/protocol/blocks.js";

const WHO = "president@worldvaporexpo.test";
const T0 = "2026-09-01T16:00:00.000Z";
const NOW = new Date("2026-09-01T16:53:03.000Z");

const emptyModel = {
  async complete() {
    return {
      text: ["<<<PROFILE_FACTS>>>", JSON.stringify({ facts: [] }), "<<<END>>>"].join("\n"),
      finishReason: "stop", elapsedMs: 1,
    };
  },
};

/** A well-behaved voice: speaks the artifact protocol on the first try. */
function politeVoice() {
  const calls = [];
  return {
    calls,
    async complete({ prompt, system }) {
      calls.push({ prompt, system });
      return {
        text: createEmailArtifact({
          meta: { template: "conversation", facts_used: [] },
          subject: "About your rust search",
          text: "I hear you — your ask is on file and I am on it.\n\n— Yente",
        }),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };
}

test("a repeat message every template ignores gets a model-composed reply", async () => {
  const voice = politeVoice();
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();

  // Two follow-ups on file as graph evidence; the member already has facts.
  const rows = [1, 2].map((n) => ({
    id: `message:f${n}`, kind: "message",
    text: n === 1 ? "Any candidates yet?" : "Hello? Anyone home?",
    meta: { rfcMessageId: `<f${n}@live.test>`, from: WHO, to: ["yente@ccme.network"], subject: "checking in" },
    receivedAt: T0,
  }));
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel, emailClient: voice,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });
  let member = beginIntake(createMember({
    memberId: WHO, address: WHO, inboundEstablishedAt: T0, createdAt: T0,
  }), T0);
  repositories.members.save(member);
  store.put(COLLECTIONS.PROFILE_FACTS, `${WHO}:role:0`, {
    memberId: WHO, field: "role", value: "Co-founder of World Vapor Expo",
    offset: 0, quote: "Co-founder of World Vapor Expo",
  });

  const results = await runtime.ingest(NOW);
  assert.equal(results.length, 2);

  // First follow-up: qualification asks its interview question (a fresh
  // template, so the voice stays quiet — no double-talk).
  // Second follow-up: the interview key is used up, the pipeline queues
  // NOTHING — and the voice answers.
  const replied = results.filter((r) => r.replied === true);
  assert.equal(replied.length, 1, "exactly one message was template-orphaned; it got the voice");

  await runtime.drainOutbox(NOW);
  const yaps = transport.sent.filter((m) => m.subject === "About your rust search");
  assert.equal(yaps.length, 1, "the model-composed reply actually went out");
  assert.deepEqual(yaps[0].to, [WHO]);
  assert.ok(voice.calls.length >= 1, "the voice model was actually asked to speak");
  assert.match(voice.calls[0].system ?? "", /You are Yente/,
    "the voice speaks under Yente's own identity");
  assert.match(voice.calls[0].prompt, /Co-founder of World Vapor Expo/,
    "the prompt reflects what she already knows about THEM");

  // Idempotent per message: re-running ingest re-reads the same evidence —
  // INV-2 makes them duplicates, and no second yap is queued.
  await runtime.ingest(NOW);
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.filter((m) => m.subject === "About your rust search").length, 1);
});

test("no dumb fallback: a wedged voice owes the reply and pays when it recovers", async () => {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  // A voice that babbles until it recovers — the live shape: the 8B flunks
  // the contract for a while, then produces a clean artifact.
  const moody = {
    recovered: false,
    async complete() {
      if (!this.recovered) return { text: "uhh no blocks here", finishReason: "stop", elapsedMs: 1 };
      return {
        text: createEmailArtifact({
          meta: { template: "conversation", facts_used: [] },
          subject: "About what I have for you",
          text: "Here is where things stand.\n\n\u2014 Yente",
        }),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };
  const rows = [{
    id: "message:f1", kind: "message", text: "Any candidates yet?",
    meta: { rfcMessageId: "<f1@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "checking in" },
    receivedAt: T0,
  }];
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel, emailClient: moody,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });
  let [result] = await runtime.ingest(NOW);
  assert.equal(result.outcome, "profile_requested");

  // Second note: pipeline silent, model babbles twice — NOTHING sends. The
  // debt is recorded instead of papered over with a form letter.
  rows.push({
    id: "message:f2", kind: "message", text: "hello?",
    meta: { rfcMessageId: "<f2@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "hello" },
    receivedAt: T0,
  });
  [result] = await runtime.ingest(NOW);
  assert.notEqual(result.replied, true, "no letter is faked");
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.length, 1, "only the profile request went out — no canned ack");
  assert.equal(store.query("FROM owed_replies").length, 1, "the reply is on the owed ledger");

  // Still wedged: the retry pays nothing and the debt stays.
  assert.equal(await runtime.retryOwedReplies(NOW), 0);
  assert.equal(store.query("FROM owed_replies").length, 1);

  // The model recovers: the next tick pays the debt with a REAL letter.
  moody.recovered = true;
  assert.equal(await runtime.retryOwedReplies(NOW), 1);
  await runtime.drainOutbox(NOW);
  const paid = transport.sent.find((m) => m.subject === "About what I have for you");
  assert.ok(paid, "the recovered voice paid the debt");
  assert.equal(store.query("FROM owed_replies").length, 0, "and the ledger is clear");

  // Settled means settled: another retry pays nothing twice.
  assert.equal(await runtime.retryOwedReplies(NOW), 0);
});

test("a voice that names a stranger is stopped by the disclosure guard", async () => {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  const leaky = {
    async complete() {
      return {
        text: createEmailArtifact({
          meta: { template: "conversation", facts_used: [] },
          subject: "Great news",
          text: "You should just email candidate.zero@secret.test directly!",
        }),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };
  const rows = [{
    id: "message:f1", kind: "message", text: "Any candidates yet?",
    meta: { rfcMessageId: "<f1@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "checking in" },
    receivedAt: T0,
  }];
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel, emailClient: leaky,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });
  let member = beginIntake(createMember({
    memberId: WHO, address: WHO, inboundEstablishedAt: T0, createdAt: T0,
  }), T0);
  repositories.members.save(member);
  store.put(COLLECTIONS.PROFILE_FACTS, `${WHO}:role:0`, {
    memberId: WHO, field: "role", value: "Organizer", offset: 0, quote: "Organizer",
  });
  // Use up the interview ask so the second message is template-orphaned.
  const first = await runtime.ingest(NOW);
  rows.push({
    id: "message:f2", kind: "message", text: "still there?",
    meta: { rfcMessageId: "<f2@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "ping" },
    receivedAt: T0,
  });
  await runtime.ingest(NOW);
  await runtime.drainOutbox(NOW);

  for (const sent of transport.sent) {
    assert.doesNotMatch(sent.text ?? "", /candidate\.zero@secret\.test/,
      "a stranger's address never leaves the desk");
  }
  // No form letter covers for the leak: the reply goes on the owed ledger
  // and waits for a letter the guard will pass.
  assert.equal(store.query("FROM owed_replies").length, 1,
    "the guard held the line and the debt is recorded, not papered over");
});

test("a chatty model that narrates around valid blocks still speaks", async () => {
  // The LIVE failure, 2026-09-01: the 8B wrapped a perfectly valid artifact
  // in preamble and fences, OUTSIDE_BLOCK_TEXT rejected it twice, and every
  // reply fell back. The reading edge now slices to the artifact first.
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  const chatty = {
    async complete() {
      const clean = createEmailArtifact({
        meta: { template: "conversation", facts_used: [] },
        subject: "Here is where we stand",
        text: "Working on it.\n\n\u2014 Yente",
      });
      return {
        text: "Sure! Here is the email you asked for:\n```\n" + clean + "\n```\nHope that helps!",
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };
  const rows = [
    {
      id: "message:f1", kind: "message", text: "Any candidates yet?",
      meta: { rfcMessageId: "<f1@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "checking in" },
      receivedAt: T0,
    },
    {
      id: "message:f2", kind: "message", text: "hello?",
      meta: { rfcMessageId: "<f2@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "hello" },
      receivedAt: T0,
    },
  ];
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel, emailClient: chatty,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });
  const results = await runtime.ingest(NOW);
  assert.ok(results.some((r) => r.replied === true),
    "narration around the blocks is transport noise, not a failure");
  await runtime.drainOutbox(NOW);
  const spoken = transport.sent.find((m) => m.subject === "Here is where we stand");
  assert.ok(spoken, "the model's own letter went out on the first pass");
  assert.doesNotMatch(spoken.text, /Hope that helps/,
    "the narration itself never reaches the recipient");
});

test("no voice model configured: exactly the old behavior, no crash", async () => {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  const rows = [
    {
      id: "message:f1", kind: "message", text: "Any candidates yet?",
      meta: { rfcMessageId: "<f1@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "checking in" },
      receivedAt: T0,
    },
    {
      id: "message:f2", kind: "message", text: "hello?",
      meta: { rfcMessageId: "<f2@live.test>", from: WHO, to: ["yente@ccme.network"], subject: "hello" },
      receivedAt: T0,
    },
  ];
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });
  const results = await runtime.ingest(NOW);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.replied === undefined), "nobody spoke — no voice seat");
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.length, 1, "one profile request; the second note stays unanswered as before");
});
