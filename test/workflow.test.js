import assert from "node:assert/strict";
import test from "node:test";

import {
  MATCH_STATES,
  PREVIEW_DECISIONS,
  advanceVetoDeadline,
  createMatchWorkflow,
  markIntroduced,
  markPreviewSent,
  queueIntroduction,
  recordPreviewDecision,
} from "../src/index.js";

const eligibleMatch = { eligible: true, idempotencyKey: "match-key" };

function previewsSent(vetoWindowMs = 1_000) {
  let workflow = createMatchWorkflow({
    matchId: "match_001",
    matchResult: eligibleMatch,
    memberIds: ["bob", "alice"],
    createdAt: "2026-08-12T12:00:00.000Z",
    vetoWindowMs,
  });
  workflow = markPreviewSent(workflow, "bob", {
    messageId: "<preview-bob@yente>",
    sentAt: "2026-08-12T12:00:01.000Z",
  });
  workflow = markPreviewSent(workflow, "alice", {
    messageId: "<preview-alice@yente>",
    sentAt: "2026-08-12T12:00:02.000Z",
  });
  return workflow;
}

test("the veto window opens only after both private previews are sent", () => {
  const workflow = previewsSent();
  assert.equal(workflow.state, MATCH_STATES.VETO_WINDOW);
  assert.equal(workflow.deadlineAt, "2026-08-12T12:00:03.000Z");
});

test("silence advances only after the recorded deadline", () => {
  const workflow = previewsSent();
  const early = advanceVetoDeadline(workflow, "2026-08-12T12:00:02.999Z");
  assert.equal(early.state, MATCH_STATES.VETO_WINDOW);

  const cleared = advanceVetoDeadline(workflow, "2026-08-12T12:00:03.000Z");
  assert.equal(cleared.state, MATCH_STATES.READY_TO_INTRODUCE);
});

test("either member can veto, correct, or globally stop", () => {
  assert.equal(
    recordPreviewDecision(
      previewsSent(),
      "bob",
      PREVIEW_DECISIONS.PASS,
      "2026-08-12T12:00:02.500Z",
    ).state,
    MATCH_STATES.VETOED,
  );
  assert.equal(
    recordPreviewDecision(
      previewsSent(),
      "alice",
      PREVIEW_DECISIONS.CORRECT,
      "2026-08-12T12:00:02.500Z",
    ).state,
    MATCH_STATES.INVALIDATED_BY_CORRECTION,
  );
  assert.equal(
    recordPreviewDecision(
      previewsSent(),
      "alice",
      PREVIEW_DECISIONS.STOP,
      "2026-08-12T12:00:02.500Z",
    ).state,
    MATCH_STATES.CANCELLED_BY_STOP,
  );
});

test("two approvals can introduce immediately and delivery is idempotent", () => {
  let workflow = previewsSent();
  workflow = recordPreviewDecision(
    workflow,
    "bob",
    PREVIEW_DECISIONS.APPROVE,
    "2026-08-12T12:00:02.500Z",
  );
  workflow = recordPreviewDecision(
    workflow,
    "alice",
    PREVIEW_DECISIONS.APPROVE,
    "2026-08-12T12:00:02.600Z",
  );
  assert.equal(workflow.state, MATCH_STATES.READY_TO_INTRODUCE);

  workflow = queueIntroduction(workflow, "2026-08-12T12:00:02.700Z");
  assert.equal(workflow.state, MATCH_STATES.INTRODUCTION_QUEUED);
  const sent = markIntroduced(workflow, {
    messageId: "<intro-001@yente>",
    sentAt: "2026-08-12T12:00:02.800Z",
  });
  assert.equal(sent.state, MATCH_STATES.INTRODUCED);
  assert.strictEqual(
    markIntroduced(sent, {
      messageId: "<intro-001@yente>",
      sentAt: "2026-08-12T12:00:02.900Z",
    }),
    sent,
  );
});
