import assert from "node:assert/strict";
import test from "node:test";

import {
  MATCH_STATES,
  createMatchWorkflow,
  markPreviewSent,
  proposeMatch,
  queuePreviews,
} from "../src/index.js";

const eligibleMatch = { eligible: true, idempotencyKey: "match-key" };

function proposal(overrides = {}) {
  return proposeMatch({
    matchId: "match_001",
    matchResult: eligibleMatch,
    memberIds: ["bob", "alice"],
    createdAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  });
}

test("a match opens at PROPOSED, before anything is queued for sending — §10.2", () => {
  // The distinction is not ceremony. A proposal is the engine's deterministic
  // conclusion; queueing previews is the decision to spend outbound on it. This
  // is the state a halted outbox or a member who stopped between scoring and
  // sending leaves the record in.
  const workflow = proposal();
  assert.equal(workflow.state, MATCH_STATES.PROPOSED);
  assert.equal(workflow.history.at(0).event, "MATCH_PROPOSED");
  assert.equal(workflow.deadlineAt, null);
  assert.equal(workflow.introduction.messageId, null);
});

test("nothing can be delivered while a match is only PROPOSED", () => {
  assert.throws(
    () => markPreviewSent(proposal(), "bob", { messageId: "<p@yente>", sentAt: "2026-08-12T12:00:01.000Z" }),
    /Cannot deliver a preview while match is PROPOSED/,
  );
});

test("queueing previews moves PROPOSED to PREVIEWS_QUEUED and is idempotent", () => {
  const queued = queuePreviews(proposal(), "2026-08-12T12:00:01.000Z");
  assert.equal(queued.state, MATCH_STATES.PREVIEWS_QUEUED);
  assert.equal(queued.history.at(-1).event, "PREVIEWS_QUEUED");
  assert.equal(queuePreviews(queued, "2026-08-12T12:00:02.000Z"), queued);
});

test("both previews are queued together, so one side is never told before the other — §8.1", () => {
  const queued = queuePreviews(proposal(), "2026-08-12T12:00:01.000Z");
  const rows = Object.values(queued.previews);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.delivery === "PENDING" && row.decision === "PENDING"));
});

test("createMatchWorkflow still composes both steps for the ordinary path", () => {
  const workflow = createMatchWorkflow({
    matchId: "match_002",
    matchResult: eligibleMatch,
    memberIds: ["bob", "alice"],
    createdAt: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(workflow.state, MATCH_STATES.PREVIEWS_QUEUED);
  assert.deepEqual(
    workflow.history.map((row) => row.event),
    ["MATCH_PROPOSED", "PREVIEWS_QUEUED"],
  );
});

test("an ineligible match cannot even be proposed — INV-4", () => {
  assert.throws(
    () => proposal({ matchResult: { eligible: false, idempotencyKey: "x" } }),
    /ineligible match/,
  );
});

test("a match requires exactly two distinct members", () => {
  assert.throws(() => proposal({ memberIds: ["bob"] }), /two distinct members/);
  assert.throws(() => proposal({ memberIds: ["bob", "bob"] }), /two distinct members/);
});
