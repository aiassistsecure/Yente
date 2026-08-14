/**
 * The outbox state machine — SPEC v2 §10.3.
 *
 *   PENDING -> SENDING -> SENT
 *                     \-> RETRY_WAIT -> SENDING
 *                     \-> DEAD
 *
 * The outbox is the only component that can cause an email to exist, which
 * makes it the place where two invariants are actually enforced rather than
 * merely stated: INV-1 (every recipient came inbound first) and INV-10 (one
 * pair, one introduction per match cycle).
 *
 * "An idempotency key is unique per intended email, not per send attempt."
 * That sentence is the whole design. Attempts are a property of a job; they
 * never mint a new job. A retry after a crash carries the same key as the
 * attempt that may already have reached the MTA, so the delivery layer can
 * recognise it as the same intended email instead of a second one.
 */

import { canReceiveOutbound, normalizeAddress } from "./member.js";

/**
 * The eight outbound purposes of SPEC v2 §5.1. The list is closed — a job with
 * any other purpose cannot be enqueued, which is how "there are no newsletters,
 * promotional sequences, cold introductions, or generic checking-in messages"
 * becomes a property of the code rather than a promise in a document.
 */
export const OUTBOUND_PURPOSES = Object.freeze({
  PROFILE_REQUEST: "profile_request",
  INTERVIEW_QUESTION: "interview_question",
  CLARIFICATION: "clarification",
  // What she understood, sent back for correction once a member qualifies.
  // Transactional, not promotional: it is a reply to a document they sent, it
  // states only span-verified facts, and it exists because the alternative was
  // silence — a member sent a résumé, she read it correctly, and said nothing.
  PROFILE_CONFIRMATION: "profile_confirmation",
  PRIVATE_MATCH_PREVIEW: "private_match_preview",
  JOINT_INTRODUCTION: "joint_introduction",
  STOP_CONFIRMATION: "stop_confirmation",
  DELETION_CONFIRMATION: "deletion_confirmation",
  ENROLLMENT_INVITATION: "enrollment_invitation",
});

const PURPOSE_VALUES = Object.freeze(new Set(Object.values(OUTBOUND_PURPOSES)));

export const OUTBOX_STATES = Object.freeze({
  PENDING: "PENDING",
  SENDING: "SENDING",
  SENT: "SENT",
  RETRY_WAIT: "RETRY_WAIT",
  DEAD: "DEAD",
});

export const TERMINAL_OUTBOX_STATES = Object.freeze(
  new Set([OUTBOX_STATES.SENT, OUTBOX_STATES.DEAD]),
);

/** Defaults for the bounded exponential backoff. Configuration, not architecture. */
export const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 60_000,
  maxMs: 6 * 60 * 60 * 1000,
  maxAttempts: 6,
});

function clone(value) {
  return structuredClone(value);
}

function timestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}

function appendHistory(job, event, at, details = {}) {
  job.history.push({ event, at, ...details });
}

/**
 * Full jitter over a capped exponential.
 *
 * `delay = random() * min(base * 2^(attempt-1), max)`
 *
 * Jitter is not decoration. Yente's two highest-volume moments both fan out
 * simultaneously — two previews created atomically for one match, and a
 * deadline worker sweeping many matches at once. Without jitter those retries
 * stay in lockstep and re-collide on every round, which reads to a receiving
 * MTA as a burst from one sender. Full jitter spreads them across the window.
 *
 * `random` is injectable so the machine stays deterministic under test.
 */
export function backoffMs(attempt, { baseMs, maxMs, random = Math.random } = DEFAULT_BACKOFF) {
  const base = baseMs ?? DEFAULT_BACKOFF.baseMs;
  const max = maxMs ?? DEFAULT_BACKOFF.maxMs;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("attempt must be a positive integer");
  }
  const ceiling = Math.min(base * 2 ** (attempt - 1), max);
  return Math.floor(random() * ceiling);
}

/**
 * Create a durable outbound job.
 *
 * @param {object} input
 * @param {string} input.jobId
 * @param {string} input.idempotencyKey unique per intended email
 * @param {string} input.purpose        one of OUTBOUND_PURPOSES
 * @param {string[]} input.recipients   every recipient must be a live member
 * @param {string} input.enqueuedAt
 * @param {object} [input.backoff]
 */
export function enqueueEmail({
  jobId,
  idempotencyKey,
  purpose,
  recipients,
  enqueuedAt,
  headers = {},
  backoff = {},
}) {
  if (!jobId) throw new TypeError("An outbox job requires an id");
  if (!idempotencyKey) throw new TypeError("An outbox job requires an idempotency key");
  if (!PURPOSE_VALUES.has(purpose)) {
    throw new TypeError(`Unsupported outbound purpose: ${purpose}`);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new TypeError("An outbox job requires at least one recipient");
  }

  // §5.4 makes List-Unsubscribe mandatory on the one class addressed to someone
  // who did not write in. Checked here rather than only in the builder, so a
  // direct enqueueEmail cannot route around it.
  if (purpose === OUTBOUND_PURPOSES.ENROLLMENT_INVITATION) {
    requireUnsubscribeHeaders(headers);
    if (recipients.length !== 1) {
      throw new TypeError("An enrollment invitation addresses exactly one person");
    }
  }

  const settings = { ...DEFAULT_BACKOFF, ...backoff };
  if (!Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer");
  }

  const at = timestamp(enqueuedAt);
  return {
    jobId,
    idempotencyKey,
    purpose,
    recipients: [...recipients],
    headers: { ...headers },
    state: OUTBOX_STATES.PENDING,
    attempts: 0,
    maxAttempts: settings.maxAttempts,
    backoff: { baseMs: settings.baseMs, maxMs: settings.maxMs },
    availableAt: at,
    messageId: null,
    sentAt: null,
    lastError: null,
    history: [{ event: "ENQUEUED", at, purpose, idempotencyKey }],
  };
}

/* -------------------------------------------------------------------------
 * The enrollment invitation — SPEC v2 §5.4
 * ---------------------------------------------------------------------- */

/**
 * The idempotency key is the normalized address and nothing else.
 *
 * Not the thread, not the inviting member, not the pair. §5.4: exactly once per
 * address for the lifetime of the system. Keying on anything narrower would let
 * a person surfaced on six threads by four members receive six invitations,
 * each individually defensible and collectively indistinguishable from a
 * campaign.
 */
export function enrollmentInvitationKey(address) {
  return `enrollment_invitation:${normalizeAddress(address)}`;
}

function requireUnsubscribeHeaders(headers) {
  const keys = Object.fromEntries(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (!keys["list-unsubscribe"]) {
    throw new TypeError("An enrollment invitation requires a List-Unsubscribe header (§5.4)");
  }
  if (!keys["list-unsubscribe-post"]) {
    throw new TypeError(
      "An enrollment invitation requires List-Unsubscribe-Post for one-click opt-out (RFC 8058, §5.4)",
    );
  }
}

/**
 * Build the one message a CC'd stranger may receive.
 *
 * Every gate of §5.4 is a parameter rather than a lookup, because this function
 * must stay pure and because the caller — which has the database — is the only
 * thing that can answer "has this address ever been invited". Passing the
 * answer in makes the check impossible to forget: there is no default.
 *
 * @param {object} input
 * @param {string}   input.jobId
 * @param {string}   input.invitedAddress
 * @param {object}   input.invitingMember     a live member who CC'd Yente
 * @param {string}   input.threadId
 * @param {string[]} input.threadParticipants addresses on the thread
 * @param {Set<string>|string[]} input.alreadyInvited normalized addresses ever invited
 * @param {Set<string>|string[]} input.suppressed     normalized addresses under STOP/DELETE
 * @param {object}   input.headers            must carry List-Unsubscribe(-Post)
 * @param {string}   input.enqueuedAt
 * @returns {object|null} the job, or null when §5.4 says do not send
 */
export function enqueueEnrollmentInvitation({
  jobId,
  invitedAddress,
  invitingMember,
  threadId,
  threadParticipants,
  alreadyInvited,
  suppressed,
  headers,
  enqueuedAt,
  backoff = {},
}) {
  const address = normalizeAddress(invitedAddress);
  const invited = toSet(alreadyInvited);
  const stopped = toSet(suppressed);

  if (!threadId) throw new TypeError("An enrollment invitation requires the thread that surfaced the address");
  if (!Array.isArray(threadParticipants)) {
    throw new TypeError("An enrollment invitation requires the thread participant list");
  }

  // INV-9 first, before anything else is evaluated or composed.
  if (stopped.has(address)) return null;

  // Exactly once, ever.
  if (invited.has(address)) return null;

  // INV-1's narrow exception is a *thread* relationship. An address that was not
  // on the thread has no relationship at all, and inviting it would be the cold
  // outbound §2.3 forbids.
  if (!threadParticipants.map(normalizeAddress).includes(address)) {
    throw new Error(`${address} is not a participant on thread ${threadId}`);
  }

  // A CC from a non-member triggers nothing.
  if (!invitingMember?.memberId) {
    throw new TypeError("An enrollment invitation requires the member who CC'd Yente");
  }
  if (!canReceiveOutbound(invitingMember)) {
    throw new Error(`Inviting member ${invitingMember.memberId} is ${invitingMember.state}`);
  }

  // The invitation cannot be addressed to the person who sent it.
  if (invitingMember.address && normalizeAddress(invitingMember.address) === address) {
    throw new Error("A member cannot invite themselves");
  }

  const job = enqueueEmail({
    jobId,
    idempotencyKey: enrollmentInvitationKey(address),
    purpose: OUTBOUND_PURPOSES.ENROLLMENT_INVITATION,
    recipients: [address],
    headers,
    enqueuedAt,
    backoff,
  });

  // Provenance, not disclosure: enough to explain why this address was reached,
  // and nothing about the thread's contents. §5.4 permits naming the member who
  // CC'd Yente; it permits nothing else.
  job.invitation = {
    threadId,
    invitedByMemberId: invitingMember.memberId,
  };
  job.history[0].threadId = threadId;
  return job;
}

/**
 * Silence is a no — §5.4.
 *
 * Present as a named function because its emptiness is the specification. There
 * is no follow-up, no reminder, and no deadline that converts non-response into
 * enrollment. An INV-8 veto window advances on silence because something was
 * disclosed to be vetoed; here nothing was, so nothing advances.
 */
export function invitationFollowUp() {
  return null;
}

function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(normalizeAddress));
  throw new TypeError("Expected a Set or Array of addresses");
}

/**
 * Claim a job for a send attempt.
 *
 * A job is claimable from PENDING or RETRY_WAIT, and only once its backoff has
 * elapsed. Claiming increments `attempts` — the counter belongs to the job, so
 * a crash loop cannot reset it by re-reading the row.
 */
export function beginSend(job, now) {
  if (job.state === OUTBOX_STATES.SENT) {
    throw new Error(`Job ${job.jobId} was already sent; refusing a second attempt`);
  }
  if (job.state === OUTBOX_STATES.DEAD) {
    throw new Error(`Job ${job.jobId} is dead`);
  }
  if (job.state === OUTBOX_STATES.SENDING) {
    throw new Error(`Job ${job.jobId} is already being sent`);
  }
  const at = timestamp(now);
  if (Date.parse(at) < Date.parse(job.availableAt)) {
    throw new Error(`Job ${job.jobId} is not due until ${job.availableAt}`);
  }

  const next = clone(job);
  next.state = OUTBOX_STATES.SENDING;
  next.attempts += 1;
  appendHistory(next, "SEND_STARTED", at, { attempt: next.attempts });
  return next;
}

/**
 * Record a successful SMTP handoff.
 *
 * Idempotent for the same Message-ID and loud for a different one: two distinct
 * Message-IDs against one idempotency key means the same intended email went
 * out twice, which is exactly the condition INV-10 exists to catch. Silently
 * accepting the second would erase the evidence.
 */
export function markSent(job, { messageId, sentAt }) {
  if (!messageId) throw new TypeError("A sent email requires an RFC Message-ID");
  if (job.state === OUTBOX_STATES.SENT) {
    if (job.messageId === messageId) return job;
    throw new Error(
      `Job ${job.jobId} was already sent as ${job.messageId}; refusing to overwrite with ${messageId}`,
    );
  }
  if (job.state !== OUTBOX_STATES.SENDING) {
    throw new Error(`Cannot mark sent while job is ${job.state}`);
  }

  const next = clone(job);
  const at = timestamp(sentAt);
  next.state = OUTBOX_STATES.SENT;
  next.messageId = messageId;
  next.sentAt = at;
  next.lastError = null;
  appendHistory(next, "SENT", at, { messageId, attempt: next.attempts });
  return next;
}

/**
 * Record a failed attempt.
 *
 * A permanent failure goes straight to DEAD without burning the remaining
 * attempts — retrying a rejected recipient is how a sending domain earns a
 * reputation it cannot spend. A transient failure schedules a jittered retry,
 * and exhausting `maxAttempts` is also DEAD.
 */
export function markFailed(job, { at, error, permanent = false, random = Math.random }) {
  if (job.state !== OUTBOX_STATES.SENDING) {
    throw new Error(`Cannot record a failure while job is ${job.state}`);
  }
  const when = timestamp(at);
  const next = clone(job);
  next.lastError = error ?? null;

  if (permanent) {
    next.state = OUTBOX_STATES.DEAD;
    appendHistory(next, "DEAD", when, { reason: "permanent_failure", error: error ?? null });
    return next;
  }
  if (next.attempts >= next.maxAttempts) {
    next.state = OUTBOX_STATES.DEAD;
    appendHistory(next, "DEAD", when, {
      reason: "attempts_exhausted",
      attempts: next.attempts,
      error: error ?? null,
    });
    return next;
  }

  const delay = backoffMs(next.attempts, { ...next.backoff, random });
  next.state = OUTBOX_STATES.RETRY_WAIT;
  next.availableAt = new Date(Date.parse(when) + delay).toISOString();
  appendHistory(next, "RETRY_SCHEDULED", when, {
    attempt: next.attempts,
    delayMs: delay,
    availableAt: next.availableAt,
    error: error ?? null,
  });
  return next;
}

/**
 * Recover a job stranded in SENDING by a crash — D7's "restarting during any
 * state transition is safe."
 *
 * SENDING after a restart is genuinely in doubt: the process may have died
 * before the handoff or after it. The job is returned to RETRY_WAIT carrying
 * the *same* idempotency key, which is the only reason this is safe. Marking it
 * SENT would invent a delivery; marking it DEAD would drop a real one.
 */
export function recoverStalledSend(job, now, { stalledAfterMs = 15 * 60 * 1000, random = Math.random } = {}) {
  if (job.state !== OUTBOX_STATES.SENDING) return job;
  const startedAt = [...job.history].reverse().find((row) => row.event === "SEND_STARTED")?.at;
  const at = timestamp(now);
  if (startedAt && Date.parse(at) - Date.parse(startedAt) < stalledAfterMs) return job;

  const next = clone(job);
  if (next.attempts >= next.maxAttempts) {
    next.state = OUTBOX_STATES.DEAD;
    appendHistory(next, "DEAD", at, { reason: "stalled_attempts_exhausted" });
    return next;
  }
  const delay = backoffMs(next.attempts, { ...next.backoff, random });
  next.state = OUTBOX_STATES.RETRY_WAIT;
  next.availableAt = new Date(Date.parse(at) + delay).toISOString();
  appendHistory(next, "RECOVERED_STALLED_SEND", at, {
    attempt: next.attempts,
    availableAt: next.availableAt,
  });
  return next;
}

/** True when a worker may claim this job right now. */
export function isDue(job, now) {
  if (TERMINAL_OUTBOX_STATES.has(job.state) || job.state === OUTBOX_STATES.SENDING) return false;
  return Date.parse(timestamp(now)) >= Date.parse(job.availableAt);
}

/**
 * The kill switch of D7: "One configuration flag halts all outbound sending."
 * Expressed as a predicate the worker consults rather than a branch buried in
 * the sender, so it is testable without an SMTP server.
 */
export function isSendingHalted({ haltOutbound = false } = {}) {
  return haltOutbound === true;
}
