/**
 * The member state machine — SPEC v2 §10.1.
 *
 *   NEW -> NEEDS_PROFILE -> INTERVIEWING -> QUALIFIED -> ACTIVE
 *   any nonterminal -> STOPPED
 *   any state       -> DELETED
 *
 * Two properties of that diagram are easy to miss and both are load-bearing.
 *
 * First, NEEDS_PROFILE and INTERVIEWING alternate. A member who is ACTIVE for
 * one match type can be sent back for evidence when a second type asks for a
 * field nobody needed before. The machine is therefore not a ladder.
 *
 * Second, "qualification is scoped to a policy; it is not a permanent judgment
 * about the person." So QUALIFIED is not a badge — it is a per-policy record.
 * A member is qualified *for policy X at version N*, and a policy bump can
 * legitimately unqualify them without anything having gone wrong.
 *
 * Transitions are pure: every function returns a new member and never mutates
 * its argument, matching the match workflow in workflow.js.
 */

export const MEMBER_STATES = Object.freeze({
  NEW: "NEW",
  NEEDS_PROFILE: "NEEDS_PROFILE",
  INTERVIEWING: "INTERVIEWING",
  QUALIFIED: "QUALIFIED",
  ACTIVE: "ACTIVE",
  STOPPED: "STOPPED",
  DELETED: "DELETED",
});

/** STOPPED and DELETED are the only terminals. Nothing leaves them. */
export const TERMINAL_MEMBER_STATES = Object.freeze(
  new Set([MEMBER_STATES.STOPPED, MEMBER_STATES.DELETED]),
);

/**
 * Permitted transitions, excluding STOPPED and DELETED which are handled
 * separately because they are reachable from almost anywhere and must not be
 * expressible as an ordinary edge (INV-9 gives stop priority over every other
 * intent, so it cannot sit in the same table as a routine advance).
 */
const TRANSITIONS = Object.freeze({
  [MEMBER_STATES.NEW]: [MEMBER_STATES.NEEDS_PROFILE],
  [MEMBER_STATES.NEEDS_PROFILE]: [MEMBER_STATES.INTERVIEWING],
  [MEMBER_STATES.INTERVIEWING]: [MEMBER_STATES.NEEDS_PROFILE, MEMBER_STATES.QUALIFIED],
  [MEMBER_STATES.QUALIFIED]: [
    MEMBER_STATES.ACTIVE,
    MEMBER_STATES.NEEDS_PROFILE,
    MEMBER_STATES.INTERVIEWING,
  ],
  [MEMBER_STATES.ACTIVE]: [MEMBER_STATES.NEEDS_PROFILE, MEMBER_STATES.INTERVIEWING],
  [MEMBER_STATES.STOPPED]: [],
  [MEMBER_STATES.DELETED]: [],
});

function clone(value) {
  return structuredClone(value);
}

function timestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}

function appendHistory(member, event, at, details = {}) {
  member.history.push({ event, at, ...details });
}

function requireLive(member) {
  if (TERMINAL_MEMBER_STATES.has(member.state)) {
    throw new Error(`Member ${member.memberId} is terminal: ${member.state}`);
  }
}

function advance(member, to, at, event, details = {}) {
  requireLive(member);
  const allowed = TRANSITIONS[member.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Cannot move member ${member.memberId} from ${member.state} to ${to}`);
  }
  const next = clone(member);
  const when = timestamp(at);
  next.state = to;
  appendHistory(next, event, when, details);
  return next;
}

/**
 * A member exists because an address wrote in. INV-1 is enforced at
 * construction rather than at send time — an address with no inbound
 * relationship cannot become a member at all, so there is no later code path
 * that has to remember to check.
 */
export function createMember({ memberId, address, inboundEstablishedAt, createdAt }) {
  if (!memberId) throw new TypeError("A member requires an id");
  if (!address) throw new TypeError("A member requires an email address");
  if (!inboundEstablishedAt) {
    throw new TypeError("A member requires an inbound relationship (INV-1)");
  }

  const at = timestamp(createdAt);
  return {
    memberId,
    address: normalizeAddress(address),
    state: MEMBER_STATES.NEW,
    inboundEstablishedAt: timestamp(inboundEstablishedAt),
    qualifications: {},
    stoppedAt: null,
    deletedAt: null,
    history: [{ event: "MEMBER_CREATED", at }],
  };
}

/**
 * Addresses are compared normalized, because `Bob@Example.COM` and
 * `bob@example.com` are one person and one suppression record. §12.1 makes the
 * normalized address unique, so normalizing at the edge is what makes that
 * constraint mean what it says.
 *
 * Deliberately conservative: case-fold only. Stripping dots or +tags is
 * provider-specific folklore, and folding two real mailboxes into one member
 * would be worse than missing a duplicate.
 */
export function normalizeAddress(address) {
  const trimmed = String(address).trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new TypeError(`Not an email address: ${address}`);
  }
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

/** First inbound with no usable evidence yet: ask for professional material. */
export function beginIntake(member, at) {
  return advance(member, MEMBER_STATES.NEEDS_PROFILE, at, "INTAKE_BEGAN");
}

/** Evidence landed; targeted questions remain. */
export function beginInterview(member, at) {
  return advance(member, MEMBER_STATES.INTERVIEWING, at, "INTERVIEW_BEGAN");
}

/**
 * Send a member back for evidence. Legitimate from INTERVIEWING, QUALIFIED or
 * ACTIVE — a new match type may need a field the current profile never had, and
 * §6.4 would rather ask than infer (INV-3).
 */
export function requireMoreEvidence(member, at, { reason, policyId } = {}) {
  return advance(member, MEMBER_STATES.NEEDS_PROFILE, at, "EVIDENCE_REQUIRED", {
    ...(reason ? { reason } : {}),
    ...(policyId ? { policyId } : {}),
  });
}

/**
 * Record qualification against one policy version.
 *
 * The caller passes the result of `evaluateQualification`; this function
 * refuses to record a qualification that did not actually pass, so the state
 * cannot claim more than the deterministic check found (INV-4).
 */
export function markQualified(member, { qualification, at }) {
  if (!qualification?.qualified) {
    throw new Error("Cannot mark a member qualified from a failing qualification result");
  }
  const next = advance(member, MEMBER_STATES.QUALIFIED, at, "QUALIFIED", {
    policyId: qualification.policyId,
    policyVersion: qualification.policyVersion,
  });
  next.qualifications[qualification.policyId] = {
    policyVersion: qualification.policyVersion,
    qualifiedAt: timestamp(at),
  };
  return next;
}

/** Matchable. Only ACTIVE members reach the match engine (§7.2 gate 2). */
export function activate(member, at) {
  return advance(member, MEMBER_STATES.ACTIVE, at, "ACTIVATED");
}

/**
 * True when the member is qualified for `policyId` at exactly `policyVersion`.
 *
 * Version equality, not recency: a policy bump changes what qualification
 * meant, and honouring an old pass under a new policy is how a hard gate
 * quietly stops being hard.
 */
export function isQualifiedFor(member, policyId, policyVersion) {
  const record = member.qualifications?.[policyId];
  if (!record) return false;
  if (policyVersion === undefined) return true;
  return record.policyVersion === policyVersion;
}

/**
 * INV-9. Idempotent on purpose: a second unsubscribe from an already-stopped
 * member is a normal thing for a human to send and must never be an error path,
 * because an error path is a path that might not suppress.
 */
export function stopMember(member, at, { reason } = {}) {
  if (member.state === MEMBER_STATES.STOPPED) return member;
  if (member.state === MEMBER_STATES.DELETED) {
    throw new Error(`Member ${member.memberId} is deleted`);
  }
  const next = clone(member);
  const when = timestamp(at);
  next.state = MEMBER_STATES.STOPPED;
  next.stoppedAt = when;
  appendHistory(next, "STOPPED", when, reason ? { reason } : {});
  return next;
}

/**
 * DELETED is reachable from every state including STOPPED — a stopped member
 * can still ask to be erased, and refusing that would be the wrong answer to
 * the more serious request.
 */
export function deleteMember(member, at, { reason } = {}) {
  if (member.state === MEMBER_STATES.DELETED) return member;
  const next = clone(member);
  const when = timestamp(at);
  next.state = MEMBER_STATES.DELETED;
  next.deletedAt = when;
  appendHistory(next, "DELETED", when, reason ? { reason } : {});
  return next;
}

/** Outbound is permitted only to a live member (INV-1, INV-9). */
export function canReceiveOutbound(member) {
  return !TERMINAL_MEMBER_STATES.has(member.state);
}

/** Eligible to enter the match engine at all. */
export function isMatchable(member) {
  return member.state === MEMBER_STATES.ACTIVE;
}
