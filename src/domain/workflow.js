export const MATCH_STATES = Object.freeze({
  PREVIEWS_QUEUED: "PREVIEWS_QUEUED",
  VETO_WINDOW: "VETO_WINDOW",
  READY_TO_INTRODUCE: "READY_TO_INTRODUCE",
  INTRODUCTION_QUEUED: "INTRODUCTION_QUEUED",
  INTRODUCED: "INTRODUCED",
  VETOED: "VETOED",
  INVALIDATED_BY_CORRECTION: "INVALIDATED_BY_CORRECTION",
  CANCELLED_BY_STOP: "CANCELLED_BY_STOP",
  CANCELLED_BY_DELETION: "CANCELLED_BY_DELETION",
  DELIVERY_FAILED: "DELIVERY_FAILED",
});

export const PREVIEW_DECISIONS = Object.freeze({
  PENDING: "PENDING",
  APPROVE: "APPROVE",
  PASS: "PASS",
  CORRECT: "CORRECT",
  STOP: "STOP",
  DELETE: "DELETE",
});

const TERMINAL_STATES = new Set([
  MATCH_STATES.INTRODUCED,
  MATCH_STATES.VETOED,
  MATCH_STATES.INVALIDATED_BY_CORRECTION,
  MATCH_STATES.CANCELLED_BY_STOP,
  MATCH_STATES.CANCELLED_BY_DELETION,
  MATCH_STATES.DELIVERY_FAILED,
]);

function clone(value) {
  return structuredClone(value);
}

function timestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}

function requireMember(workflow, memberId) {
  if (!workflow.previews[memberId]) {
    throw new TypeError(`Member ${memberId} is not part of match ${workflow.matchId}`);
  }
}

function requireMutable(workflow) {
  if (TERMINAL_STATES.has(workflow.state)) {
    throw new Error(`Match ${workflow.matchId} is terminal: ${workflow.state}`);
  }
}

function appendHistory(workflow, event, at, details = {}) {
  workflow.history.push({ event, at, ...details });
}

export function createMatchWorkflow({
  matchId,
  matchResult,
  memberIds,
  createdAt,
  vetoWindowMs = 48 * 60 * 60 * 1000,
}) {
  if (!matchResult?.eligible) throw new Error("Cannot create previews for an ineligible match");
  if (!Array.isArray(memberIds) || memberIds.length !== 2 || memberIds[0] === memberIds[1]) {
    throw new TypeError("A match workflow requires exactly two distinct members");
  }
  if (!Number.isInteger(vetoWindowMs) || vetoWindowMs <= 0) {
    throw new TypeError("vetoWindowMs must be a positive integer");
  }

  const at = timestamp(createdAt);
  return {
    matchId,
    matchIdempotencyKey: matchResult.idempotencyKey,
    state: MATCH_STATES.PREVIEWS_QUEUED,
    vetoWindowMs,
    deadlineAt: null,
    previews: Object.fromEntries(
      memberIds.map((memberId) => [
        memberId,
        {
          delivery: "PENDING",
          messageId: null,
          deliveredAt: null,
          decision: PREVIEW_DECISIONS.PENDING,
          decidedAt: null,
        },
      ]),
    ),
    introduction: {
      idempotencyKey: `${matchId}:joint-introduction`,
      messageId: null,
      sentAt: null,
    },
    history: [{ event: "MATCH_CREATED", at }],
  };
}

export function markPreviewSent(workflow, memberId, { messageId, sentAt }) {
  requireMutable(workflow);
  requireMember(workflow, memberId);
  if (![MATCH_STATES.PREVIEWS_QUEUED, MATCH_STATES.VETO_WINDOW].includes(workflow.state)) {
    throw new Error(`Cannot deliver a preview while match is ${workflow.state}`);
  }
  if (!messageId) throw new TypeError("A delivered preview requires an RFC Message-ID");

  const existing = workflow.previews[memberId];
  if (existing.delivery === "SENT") {
    if (existing.messageId === messageId) return workflow;
    throw new Error(`Preview for ${memberId} was already sent with another Message-ID`);
  }

  const next = clone(workflow);
  const at = timestamp(sentAt);
  next.previews[memberId].delivery = "SENT";
  next.previews[memberId].messageId = messageId;
  next.previews[memberId].deliveredAt = at;
  appendHistory(next, "PREVIEW_SENT", at, { memberId, messageId });

  const delivered = Object.values(next.previews).filter((row) => row.delivery === "SENT");
  if (delivered.length === 2) {
    const latestDelivery = Math.max(...delivered.map((row) => Date.parse(row.deliveredAt)));
    next.deadlineAt = new Date(latestDelivery + next.vetoWindowMs).toISOString();
    next.state = MATCH_STATES.VETO_WINDOW;
    appendHistory(next, "VETO_WINDOW_OPENED", at, { deadlineAt: next.deadlineAt });
  }
  return next;
}

export function recordPreviewDecision(workflow, memberId, decision, decidedAt) {
  requireMutable(workflow);
  requireMember(workflow, memberId);
  if (![MATCH_STATES.VETO_WINDOW, MATCH_STATES.READY_TO_INTRODUCE].includes(workflow.state)) {
    throw new Error(`Cannot record a preview decision while match is ${workflow.state}`);
  }
  if (!Object.values(PREVIEW_DECISIONS).includes(decision) || decision === "PENDING") {
    throw new TypeError(`Unsupported preview decision: ${decision}`);
  }
  if (workflow.previews[memberId].delivery !== "SENT") {
    throw new Error(`Cannot decide before ${memberId}'s private preview is sent`);
  }

  const current = workflow.previews[memberId].decision;
  if (current === decision) return workflow;
  if (current !== PREVIEW_DECISIONS.PENDING && current !== PREVIEW_DECISIONS.APPROVE) {
    throw new Error(`${memberId} already made a blocking decision: ${current}`);
  }

  const next = clone(workflow);
  const at = timestamp(decidedAt);
  next.previews[memberId].decision = decision;
  next.previews[memberId].decidedAt = at;
  appendHistory(next, "PREVIEW_DECISION", at, { memberId, decision });

  if (decision === PREVIEW_DECISIONS.PASS) next.state = MATCH_STATES.VETOED;
  if (decision === PREVIEW_DECISIONS.CORRECT) {
    next.state = MATCH_STATES.INVALIDATED_BY_CORRECTION;
  }
  if (decision === PREVIEW_DECISIONS.STOP) next.state = MATCH_STATES.CANCELLED_BY_STOP;
  if (decision === PREVIEW_DECISIONS.DELETE) {
    next.state = MATCH_STATES.CANCELLED_BY_DELETION;
  }

  if (
    Object.values(next.previews).every(
      (row) => row.decision === PREVIEW_DECISIONS.APPROVE,
    )
  ) {
    next.state = MATCH_STATES.READY_TO_INTRODUCE;
    appendHistory(next, "BOTH_SIDES_APPROVED", at);
  }
  return next;
}

export function advanceVetoDeadline(workflow, now) {
  requireMutable(workflow);
  if (workflow.state !== MATCH_STATES.VETO_WINDOW) return workflow;
  const at = timestamp(now);
  if (Date.parse(at) < Date.parse(workflow.deadlineAt)) return workflow;

  const next = clone(workflow);
  next.state = MATCH_STATES.READY_TO_INTRODUCE;
  appendHistory(next, "VETO_WINDOW_CLEARED", at);
  return next;
}

export function queueIntroduction(workflow, queuedAt) {
  requireMutable(workflow);
  if (workflow.state === MATCH_STATES.INTRODUCTION_QUEUED) return workflow;
  if (workflow.state !== MATCH_STATES.READY_TO_INTRODUCE) {
    throw new Error(`Cannot queue introduction while match is ${workflow.state}`);
  }

  const next = clone(workflow);
  const at = timestamp(queuedAt);
  next.state = MATCH_STATES.INTRODUCTION_QUEUED;
  appendHistory(next, "INTRODUCTION_QUEUED", at, {
    idempotencyKey: next.introduction.idempotencyKey,
  });
  return next;
}

export function markIntroduced(workflow, { messageId, sentAt }) {
  if (workflow.state === MATCH_STATES.INTRODUCED) {
    if (workflow.introduction.messageId === messageId) return workflow;
    throw new Error("Introduction was already sent with another Message-ID");
  }
  requireMutable(workflow);
  if (workflow.state !== MATCH_STATES.INTRODUCTION_QUEUED) {
    throw new Error(`Cannot mark introduced while match is ${workflow.state}`);
  }
  if (!messageId) throw new TypeError("Introduction requires an RFC Message-ID");

  const next = clone(workflow);
  const at = timestamp(sentAt);
  next.state = MATCH_STATES.INTRODUCED;
  next.introduction.messageId = messageId;
  next.introduction.sentAt = at;
  appendHistory(next, "INTRODUCED", at, { messageId });
  return next;
}
