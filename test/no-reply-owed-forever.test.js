/**
 * No reply owed forever — Mark, 2026-09-01: "are we keeping track of yente's
 * outbound so we can trigger replies on reboot idempotently … its ok if every
 * email ever received gets a reply from boardy once and then the system can
 * track from there on out."
 *
 * The outbox tracks LETTERS durably; it never tracked OWED replies. INV-2
 * dedupes an inbound message forever, so anyone processed under code that
 * decided silence stayed silent across every restart. sweepUnanswered settles
 * the debt at the member level: every live intake member Yente has NEVER
 * written to gets exactly one continuation — and the outbox tracks them from
 * then on, which is Mark's "reply once, then track" guarantee without
 * replaying a single raw email.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";
import { createMember, beginIntake, stopMember, MEMBER_STATES } from "../src/domain/member.js";

const T0 = "2026-09-01T10:00:00.000Z";
const NOW = new Date("2026-09-01T16:00:00.000Z");

const okModel = {
  async complete() {
    return {
      text: ["<<<PROFILE_FACTS>>>", JSON.stringify({ facts: [] }), "<<<END>>>"].join("\n"),
      finishReason: "stop", elapsedMs: 1,
    };
  },
};

function harness() {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  const runtime = createRuntime({
    repositories, transport, extractionClient: okModel,
    config: { extractionRetryDelayMs: 0 },
  });
  return { store, repositories, transport, runtime };
}

/** A member who exists because they wrote in — and was then forgotten. */
function stranded(repositories, address, { state = "intake" } = {}) {
  let member = createMember({
    memberId: address, address, inboundEstablishedAt: T0, createdAt: T0,
  });
  if (state === "intake") member = beginIntake(member, T0);
  if (state === "stopped") member = stopMember(member, T0, { reason: "STOP" });
  repositories.members.save(member);
  return member;
}

test("a member with a source but no letter gets the no-facts letter, once", async () => {
  const { repositories, transport, runtime } = harness();
  const WHO = "manfred@winnipeg.test";
  stranded(repositories, WHO);
  repositories.sources.save({
    memberId: WHO, content: "I am hiring a rust backend engineer.",
    filename: null, mimeType: "text/plain",
    extractedText: "I am hiring a rust backend engineer.", receivedAt: T0,
  });

  assert.equal(runtime.sweepUnanswered(NOW), 1, "one debt found, one debt settled");
  const drained = await runtime.drainOutbox(NOW);
  assert.equal(drained.sent, 1);
  assert.deepEqual(transport.sent[0].to, [WHO]);
  assert.match(transport.sent[0].text, /could not pull verifiable facts/);

  // Reboot, tick, reboot, tick: the debt stays settled.
  assert.equal(runtime.sweepUnanswered(NOW), 0, "a second sweep owes nothing");
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.length, 1, "one person, one letter, forever");
});

test("a member with nothing on file gets the profile request instead", async () => {
  const { repositories, transport, runtime } = harness();
  const WHO = "ghost@intake.test";
  stranded(repositories, WHO);

  assert.equal(runtime.sweepUnanswered(NOW), 1);
  await runtime.drainOutbox(NOW);
  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].subject, /What best explains your work/);
});

test("anyone Yente has already written to is not swept", async () => {
  const { repositories, transport, runtime } = harness();
  const WHO = "answered@already.test";
  stranded(repositories, WHO);
  repositories.sources.save({
    memberId: WHO, content: "hello", extractedText: "hello", receivedAt: T0,
  });

  // The first sweep writes the letter; every later sweep sees the outbox row
  // itself — QUEUED or SENT, written is written.
  assert.equal(runtime.sweepUnanswered(NOW), 1);
  assert.equal(runtime.sweepUnanswered(NOW), 0, "queued already counts as written");
  await runtime.drainOutbox(NOW);
  assert.equal(runtime.sweepUnanswered(NOW), 0, "sent counts as written");
  assert.equal(transport.sent.length, 1);
});

test("STOPPED means stopped — the sweep never writes past INV-9", () => {
  const { repositories, runtime } = harness();
  stranded(repositories, "quiet@please.test", { state: "stopped" });
  assert.equal(runtime.sweepUnanswered(NOW), 0);
});

test("members past intake are not owed intake letters", () => {
  const { repositories, runtime } = harness();
  const member = stranded(repositories, "active@member.test");
  repositories.members.save({ ...member, state: MEMBER_STATES.ACTIVE });
  assert.equal(runtime.sweepUnanswered(NOW), 0,
    "ACTIVE and QUALIFIED members converse through matching, not the sweep");
});
