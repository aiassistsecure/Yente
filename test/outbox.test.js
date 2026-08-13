import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTBOUND_PURPOSES,
  OUTBOX_STATES,
  backoffMs,
  beginSend,
  enqueueEmail,
  isDue,
  isSendingHalted,
  markFailed,
  markSent,
  recoverStalledSend,
} from "../src/index.js";

const T0 = "2026-08-12T12:00:00.000Z";

function job(overrides = {}) {
  return enqueueEmail({
    jobId: "job_1",
    idempotencyKey: "match_7:private_match_preview:bob",
    purpose: OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW,
    recipients: ["bob@example.com"],
    enqueuedAt: T0,
    backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 3 },
    ...overrides,
  });
}

/** Deterministic jitter: full jitter with random() pinned to 1 gives the ceiling. */
const maxJitter = () => 1;

test("only the seven outbound purposes of §5.1 can be enqueued", () => {
  assert.deepEqual(Object.values(OUTBOUND_PURPOSES), [
    "profile_request",
    "interview_question",
    "clarification",
    "private_match_preview",
    "joint_introduction",
    "stop_confirmation",
    "deletion_confirmation",
  ]);
  assert.throws(() => job({ purpose: "newsletter" }), /Unsupported outbound purpose/);
  assert.throws(() => job({ purpose: "checking_in" }), /Unsupported outbound purpose/);
});

test("a job requires an idempotency key and at least one recipient", () => {
  assert.throws(() => job({ idempotencyKey: "" }), /idempotency key/);
  assert.throws(() => job({ recipients: [] }), /at least one recipient/);
});

test("the happy path is PENDING to SENDING to SENT", () => {
  let j = job();
  assert.equal(j.state, OUTBOX_STATES.PENDING);
  assert.equal(isDue(j, T0), true);

  j = beginSend(j, T0);
  assert.equal(j.state, OUTBOX_STATES.SENDING);
  assert.equal(j.attempts, 1);
  assert.equal(isDue(j, T0), false, "a claimed job is not claimable again");

  j = markSent(j, { messageId: "<a@yente>", sentAt: "2026-08-12T12:00:01.000Z" });
  assert.equal(j.state, OUTBOX_STATES.SENT);
  assert.equal(j.messageId, "<a@yente>");
  assert.equal(isDue(j, "2026-08-13T00:00:00.000Z"), false);
});

test("a delivered email can never be sent twice — INV-10, D7", () => {
  const sent = markSent(beginSend(job(), T0), { messageId: "<a@yente>", sentAt: T0 });
  assert.throws(() => beginSend(sent, T0), /already sent/);

  // Replaying the same success is fine; it is what a resumed worker does.
  assert.equal(markSent(sent, { messageId: "<a@yente>", sentAt: T0 }), sent);

  // Two distinct Message-IDs against one idempotency key means the same
  // intended email went out twice. Accepting it silently would erase the
  // evidence of exactly the bug this machine exists to prevent.
  assert.throws(
    () => markSent(sent, { messageId: "<b@yente>", sentAt: T0 }),
    /refusing to overwrite/,
  );
});

test("a transient failure schedules a jittered retry and the job is not due until then", () => {
  let j = beginSend(job(), T0);
  j = markFailed(j, { at: T0, error: "421 try again", random: maxJitter });

  assert.equal(j.state, OUTBOX_STATES.RETRY_WAIT);
  assert.equal(j.availableAt, "2026-08-12T12:00:01.000Z", "attempt 1 ceiling is baseMs");
  assert.equal(isDue(j, T0), false);
  assert.equal(isDue(j, "2026-08-12T12:00:01.000Z"), true);
  assert.throws(() => beginSend(j, T0), /not due until/);

  j = beginSend(j, "2026-08-12T12:00:01.000Z");
  assert.equal(j.attempts, 2, "attempts belong to the job, so a retry cannot reset the counter");
});

test("backoff is exponential, bounded, and jittered", () => {
  const opts = { baseMs: 1000, maxMs: 8000, random: maxJitter };
  assert.equal(backoffMs(1, opts), 1000);
  assert.equal(backoffMs(2, opts), 2000);
  assert.equal(backoffMs(3, opts), 4000);
  assert.equal(backoffMs(4, opts), 8000);
  assert.equal(backoffMs(9, opts), 8000, "bounded by maxMs");

  // Full jitter spreads a fan-out across the window instead of letting two
  // previews created atomically re-collide on every round.
  assert.equal(backoffMs(3, { ...opts, random: () => 0 }), 0);
  assert.equal(backoffMs(3, { ...opts, random: () => 0.5 }), 2000);
  assert.throws(() => backoffMs(0, opts), /positive integer/);
});

test("exhausting maxAttempts is DEAD", () => {
  let j = job();
  for (let i = 0; i < 3; i += 1) {
    j = beginSend(j, j.availableAt);
    j = markFailed(j, { at: j.availableAt, error: "421 try again", random: () => 0 });
  }
  assert.equal(j.attempts, 3);
  assert.equal(j.state, OUTBOX_STATES.DEAD);
  assert.equal(j.history.at(-1).reason, "attempts_exhausted");
  assert.throws(() => beginSend(j, "2026-08-13T00:00:00.000Z"), /dead/);
});

test("a permanent failure is DEAD immediately, without burning the remaining attempts", () => {
  // Retrying a rejected recipient is how a sending domain earns a reputation it
  // cannot spend. Deliverability is the trapdoor; this is the cheap guard.
  let j = beginSend(job(), T0);
  j = markFailed(j, { at: T0, error: "550 no such user", permanent: true });
  assert.equal(j.state, OUTBOX_STATES.DEAD);
  assert.equal(j.attempts, 1);
  assert.equal(j.history.at(-1).reason, "permanent_failure");
});

test("a job stranded in SENDING by a crash returns to RETRY_WAIT with the same key — D7", () => {
  const started = beginSend(job(), T0);

  // Inside the stall window it is simply still in flight.
  assert.equal(recoverStalledSend(started, "2026-08-12T12:05:00.000Z"), started);

  const recovered = recoverStalledSend(started, "2026-08-12T12:30:00.000Z", { random: maxJitter });
  assert.equal(recovered.state, OUTBOX_STATES.RETRY_WAIT);
  assert.equal(recovered.idempotencyKey, started.idempotencyKey,
    "the same intended email, so the delivery layer can dedupe it");
  assert.equal(recovered.attempts, 1, "recovery is not an attempt");
  assert.equal(recovered.history.at(-1).event, "RECOVERED_STALLED_SEND");
});

test("a stalled job with no attempts left is DEAD rather than retried forever", () => {
  let j = job({ backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 1 } });
  j = beginSend(j, T0);
  const recovered = recoverStalledSend(j, "2026-08-12T13:00:00.000Z");
  assert.equal(recovered.state, OUTBOX_STATES.DEAD);
  assert.equal(recovered.history.at(-1).reason, "stalled_attempts_exhausted");
});

test("failures and sends are refused from the wrong state", () => {
  const pending = job();
  assert.throws(() => markSent(pending, { messageId: "<a@yente>", sentAt: T0 }), /Cannot mark sent/);
  assert.throws(() => markFailed(pending, { at: T0 }), /Cannot record a failure/);
  assert.throws(() => beginSend(beginSend(pending, T0), T0), /already being sent/);
  assert.throws(() => markSent(beginSend(pending, T0), { sentAt: T0 }), /Message-ID/);
});

test("one flag halts all outbound — D7", () => {
  assert.equal(isSendingHalted({ haltOutbound: true }), true);
  assert.equal(isSendingHalted({ haltOutbound: false }), false);
  assert.equal(isSendingHalted({}), false);
  assert.equal(isSendingHalted(), false);
});

test("transitions are pure", () => {
  const pending = job();
  const started = beginSend(pending, T0);
  assert.equal(pending.state, OUTBOX_STATES.PENDING);
  assert.equal(pending.attempts, 0);
  assert.equal(started.attempts, 1);
});
