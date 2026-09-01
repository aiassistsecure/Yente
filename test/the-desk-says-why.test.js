/**
 * The desk says why — the two remaining silences, found live 2026-09-01:
 * "another bug, Yente is not emailing me back (a new email a new name a new
 * profile all ingested but no response...)"
 *
 *   1. A stored source whose extraction produced ZERO verified facts fell
 *      through to outcome "intake" — no clarification, no ask, nothing
 *      queued. The mirror of the dead end intake-continues.test.js pinned.
 *   2. drainOutbox recorded a failed send in the outbox row and NOWHERE
 *      else — a desk that queues a reply and fails to send it looked
 *      identical to a desk that decided silence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";

const WHO = "sam@newperson.test";

/** A model whose extraction verifies nothing — the live failure's shape. */
const emptyModel = {
  async complete() {
    return {
      text: ["<<<PROFILE_FACTS>>>", JSON.stringify({ facts: [] }), "<<<END>>>"].join("\n"),
      finishReason: "stop", elapsedMs: 1,
    };
  },
};

function harness({ extractionClient = emptyModel, transport = createMemoryTransport(), log } = {}) {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const evidenceById = new Map();
  const graphEvidence = {
    all: () => [...evidenceById.values()],
    get: (id) => evidenceById.get(id) ?? null,
  };
  const realDeliver = transport.deliver.bind(transport);
  transport.deliver = (message) => {
    const delivered = realDeliver(message);
    const id = `message:${delivered.rfcMessageId}`;
    evidenceById.set(id, {
      id, kind: "message", text: delivered.text ?? "",
      meta: {
        rfcMessageId: delivered.rfcMessageId, threadId: delivered.threadId ?? null,
        from: delivered.from, to: delivered.to, cc: [], subject: delivered.subject,
        sentAt: delivered.sentAt ?? null,
      },
      receivedAt: new Date().toISOString(),
    });
    return delivered;
  };
  const runtime = createRuntime({
    repositories, transport, extractionClient, graphEvidence, log,
    config: { extractionRetryDelayMs: 0 },
  });
  return { store, repositories, transport, runtime };
}

const NOW = new Date("2026-09-01T16:00:00.000Z");

test("a source that yields no facts earns a clarification, not silence", async () => {
  const { runtime, repositories, transport } = harness();
  transport.deliver({
    rfcMessageId: "<n1@newperson.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "hello",
    text: "Hi! I'm Sam, a new person writing you a message that is definitely over "
      + "eighty characters long so the body counts as a source with substance.",
  });

  const [result] = await runtime.ingest(NOW);
  assert.equal(result.outcome, "clarification_sent",
    "ingested-but-unusable must CONTINUE the conversation");

  const drained = await runtime.drainOutbox(NOW);
  assert.equal(drained.sent, 1, "the letter actually goes out");
  const letter = transport.sent[0];
  assert.deepEqual(letter.to, [WHO]);
  assert.match(letter.text, /could not pull verifiable facts/);
  assert.match(letter.text, /resume/i);

  // Idempotent: a second unusable message does not earn a second nag.
  transport.deliver({
    rfcMessageId: "<n2@newperson.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "hello again",
    text: "Another message from Sam with plenty of length but still nothing a "
      + "grounding gate could verify about my work or my intent, sadly.",
  });
  await runtime.ingest(NOW);
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.length, 1, "five unreadable notes earn ONE letter");
  assert.equal(repositories.members.findByAddress(WHO).state, "NEEDS_PROFILE",
    "and they are still in intake, awaiting something usable");
});

test("a failed send reaches the console, not just the outbox row", async () => {
  const lines = [];
  const transport = createMemoryTransport();
  const { runtime } = harness({
    transport, log: (level, event, fields) => lines.push({ level, event, fields }),
  });
  transport.deliver({
    rfcMessageId: "<n3@newperson.test>",
    from: WHO, to: ["yente@ccme.network"], subject: "hello",
    text: "A long enough first message from Sam so that the body is stored as a "
      + "source and the desk decides it owes a reply to this new person.",
  });
  await runtime.ingest(NOW);

  transport.send = async () => { throw new Error("SMTP 451: greylisted"); };
  const drained = await runtime.drainOutbox(NOW);
  assert.equal(drained.sent, 0);

  const failure = lines.find((l) => l.event === "send_failed");
  assert.ok(failure, "the console hears about every failed letter");
  assert.equal(failure.level, "error");
  assert.match(failure.fields.error, /greylisted/);
  assert.equal(failure.fields.to, WHO);
});
