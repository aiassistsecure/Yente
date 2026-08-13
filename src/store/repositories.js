/**
 * Repositories — the durable half of SPEC v2 §12.
 *
 * Each repository owns one collection, derives its ids from §12.1, and supplies
 * the causal links that make §12's closing requirement true: "A completed
 * introduction must trace to the match policy, both profiles, their evidence,
 * and the inbound relationships that permitted outbound."
 *
 * Every write here is synchronous and never awaits mid-sequence. That is not an
 * incidental style choice — it is what makes read-modify-write atomic in a
 * single-threaded runtime holding an embedded engine, and therefore what lets
 * `enqueue` and `save` guarantee INV-10 without optimistic locking.
 *
 * Repositories persist and enforce identity. They do not decide policy: a state
 * transition is computed by the domain functions in src/domain and handed here
 * already valid.
 */

import { COLLECTIONS, quote } from "./db.js";
import {
  introductionKey,
  matchKey,
  memberKey,
  messageKey,
  outboxKey,
  previewKey,
  sourceKey,
} from "./keys.js";
import { OUTBOX_STATES } from "../domain/outbox.js";

/* --- messages --------------------------------------------------------- */

export class MessageRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * INV-2 and D1: "A duplicate RFC `Message-ID` changes state exactly once."
   *
   * Returns the existing row untouched on a duplicate rather than writing a
   * second version. Re-putting identical content would be harmless to the data
   * and corrosive to the audit trail — a redelivered message would appear in
   * history as a new event that never happened.
   */
  recordInbound({ rfcMessageId, threadId, from, to, receivedAt, subject, raw }) {
    const id = messageKey(rfcMessageId);
    const existing = this.store.get(COLLECTIONS.MESSAGES, id);
    if (existing) return { message: existing, duplicate: true };

    const message = this.store.put(COLLECTIONS.MESSAGES, id, {
      direction: "inbound",
      rfcMessageId: String(rfcMessageId),
      threadId: threadId ?? null,
      from,
      to: to ?? [],
      subject: subject ?? null,
      receivedAt,
      raw: raw ?? null,
    });
    return { message, duplicate: false };
  }

  /** The delivery record for an outbound job, linked to what caused it. */
  recordOutbound({ rfcMessageId, job, sentAt, causedBy = [] }) {
    const id = messageKey(rfcMessageId);
    return this.store.put(
      COLLECTIONS.MESSAGES,
      id,
      {
        direction: "outbound",
        rfcMessageId: String(rfcMessageId),
        purpose: job.purpose,
        recipients: job.recipients,
        idempotencyKey: job.idempotencyKey,
        sentAt,
      },
      { causedBy },
    );
  }

  findByRfcId(rfcMessageId) {
    return this.store.get(COLLECTIONS.MESSAGES, messageKey(rfcMessageId));
  }
}

/* --- members ---------------------------------------------------------- */

export class MemberRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * The id is the normalized address (§12.1), so a member cannot be created
   * twice under two spellings of the same mailbox. `causedBy` carries the
   * inbound message that established the relationship — this is where INV-1
   * becomes auditable rather than merely enforced: every member traces to the
   * message that let them exist.
   */
  save(member, { causedBy = [] } = {}) {
    return this.store.put(COLLECTIONS.MEMBERS, memberKey(member.address), member, { causedBy });
  }

  findByAddress(address) {
    return this.store.get(COLLECTIONS.MEMBERS, memberKey(address));
  }

  /** Ancestry back through the inbound message that created the member. */
  provenance(address) {
    return this.store.trace(COLLECTIONS.MEMBERS, memberKey(address));
  }

  /** Addresses under global suppression — INV-9's read side. */
  suppressedAddresses() {
    return this.store
      .query(`FROM ${COLLECTIONS.MEMBERS} WHERE state = "STOPPED"`)
      .concat(this.store.query(`FROM ${COLLECTIONS.MEMBERS} WHERE state = "DELETED"`))
      .map((row) => row.address);
  }
}

/* --- sources ---------------------------------------------------------- */

export class SourceRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * Keyed by content hash *within a member* (§12.1). Re-sending the same resume
   * is idempotent and does not create a second source or a second extraction
   * run, while the same public deck sent by two people stays two sources with
   * two provenance chains.
   */
  save({ memberId, content, filename, mimeType, extractedText, receivedAt }, { causedBy = [] } = {}) {
    const id = sourceKey(memberId, content);
    const existing = this.store.get(COLLECTIONS.SOURCES, id);
    if (existing) return { source: existing, duplicate: true };

    const source = this.store.put(
      COLLECTIONS.SOURCES,
      id,
      {
        memberId,
        filename: filename ?? null,
        mimeType: mimeType ?? null,
        extractedText: extractedText ?? null,
        receivedAt,
      },
      { causedBy },
    );
    return { source, duplicate: false };
  }

  findFor(memberId, content) {
    return this.store.get(COLLECTIONS.SOURCES, sourceKey(memberId, content));
  }
}

/* --- matches, previews, introductions --------------------------------- */

export class MatchRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * The id is policy version + ordered pair + cycle, so the same two people
   * cannot be proposed twice in one cycle — §7.2 gate 6 enforced by addressing
   * rather than by a lookup that a second worker could race.
   */
  save(workflow, { policyId, policyVersion, memberIds, cycle, causedBy = [] }) {
    const id = matchKey({ policyId, policyVersion, memberIds, cycle });
    return this.store.put(COLLECTIONS.MATCHES, id, { ...workflow, policyId, policyVersion, cycle }, { causedBy });
  }

  find({ policyId, policyVersion, memberIds, cycle }) {
    return this.store.get(COLLECTIONS.MATCHES, matchKey({ policyId, policyVersion, memberIds, cycle }));
  }
}

export class PreviewRepository {
  constructor(store) {
    this.store = store;
  }

  save({ matchId, recipientMemberId, decision, decidedAt, messageId }, { causedBy = [] } = {}) {
    const id = previewKey(matchId, recipientMemberId);
    return this.store.put(
      COLLECTIONS.PREVIEW_DECISIONS,
      id,
      { matchId, recipientMemberId, decision, decidedAt: decidedAt ?? null, messageId: messageId ?? null },
      { causedBy },
    );
  }

  find(matchId, recipientMemberId) {
    return this.store.get(COLLECTIONS.PREVIEW_DECISIONS, previewKey(matchId, recipientMemberId));
  }
}

export class IntroductionRepository {
  constructor(store) {
    this.store = store;
  }

  /** One per match. INV-10, expressed as the id itself. */
  save({ matchId, messageId, sentAt }, { causedBy = [] } = {}) {
    return this.store.put(
      COLLECTIONS.INTRODUCTIONS,
      introductionKey(matchId),
      { matchId, messageId: messageId ?? null, sentAt: sentAt ?? null },
      { causedBy },
    );
  }

  find(matchId) {
    return this.store.get(COLLECTIONS.INTRODUCTIONS, introductionKey(matchId));
  }

  /**
   * The receipt. Walks the causal chain from a delivered introduction back
   * through everything that authorised it.
   */
  receipt(matchId) {
    return this.store.trace(COLLECTIONS.INTRODUCTIONS, introductionKey(matchId));
  }
}

/* --- outbox ----------------------------------------------------------- */

export class OutboxRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * Durable enqueue.
   *
   * If a job already exists under this idempotency key, the existing row is
   * returned and nothing is written. This is the persistent half of INV-10: the
   * in-memory machine refuses a second send of one job, and this refuses a
   * second job for one intended email. Without both, two workers each holding
   * their own copy would each send once and the invariant would hold locally
   * while failing globally.
   */
  enqueue(job, { causedBy = [] } = {}) {
    const id = outboxKey(job.idempotencyKey);
    const existing = this.store.get(COLLECTIONS.OUTBOX, id);
    if (existing) return { job: existing, duplicate: true };
    return { job: this.store.put(COLLECTIONS.OUTBOX, id, job, { causedBy }), duplicate: false };
  }

  /**
   * Persist a transition.
   *
   * Refuses to move a job out of SENT, and refuses to overwrite a recorded
   * Message-ID with a different one. The domain machine already guards this for
   * a job held in memory; the repository has to guard it again because a stale
   * in-memory copy — a worker that read the row before another path advanced it
   * — would otherwise write the old state back over the new one. Same invariant,
   * different failure mode.
   */
  save(job) {
    const id = outboxKey(job.idempotencyKey);
    const stored = this.store.get(COLLECTIONS.OUTBOX, id);
    if (stored?.state === OUTBOX_STATES.SENT) {
      if (job.state !== OUTBOX_STATES.SENT) {
        throw new Error(
          `Refusing to move job ${id} out of SENT into ${job.state}; the email has already been delivered`,
        );
      }
      if (stored.messageId !== job.messageId) {
        throw new Error(
          `Job ${id} was delivered as ${stored.messageId}; refusing to record ${job.messageId}`,
        );
      }
      return stored;
    }
    return this.store.put(COLLECTIONS.OUTBOX, id, job);
  }

  find(idempotencyKey) {
    return this.store.get(COLLECTIONS.OUTBOX, outboxKey(idempotencyKey));
  }

  /**
   * Jobs a worker may claim now.
   *
   * Two queries and a filter in JavaScript rather than one clever predicate.
   * `availableAt` is an ISO-8601 UTC string, so lexicographic order happens to
   * match chronological order — but relying on that inside the query language
   * would be a correctness argument resting on a coincidence of formatting, and
   * the honest version costs nothing at v0.1 volumes.
   */
  claimable(now, { limit = 50 } = {}) {
    const due = Date.parse(now);
    if (Number.isNaN(due)) throw new TypeError(`Invalid timestamp: ${now}`);
    return [
      ...this.store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = ${quote(OUTBOX_STATES.PENDING)}`),
      ...this.store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = ${quote(OUTBOX_STATES.RETRY_WAIT)}`),
    ]
      .filter((job) => Date.parse(job.availableAt) <= due)
      .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))
      .slice(0, limit);
  }

  /** Jobs stranded in SENDING by a crash — the input to recoverStalledSend. */
  stalled() {
    return this.store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = ${quote(OUTBOX_STATES.SENDING)}`);
  }

  /** Every address ever sent an enrollment invitation — §5.4's lifetime check. */
  invitedAddresses() {
    return new Set(
      this.store
        .query(`FROM ${COLLECTIONS.OUTBOX} WHERE purpose = "enrollment_invitation"`)
        .flatMap((job) => job.recipients),
    );
  }
}

/* --- composition ------------------------------------------------------ */

/** Every repository over one store. */
export function createRepositories(store) {
  return Object.freeze({
    store,
    messages: new MessageRepository(store),
    members: new MemberRepository(store),
    sources: new SourceRepository(store),
    matches: new MatchRepository(store),
    previews: new PreviewRepository(store),
    introductions: new IntroductionRepository(store),
    outbox: new OutboxRepository(store),
  });
}
