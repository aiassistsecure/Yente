/**
 * The graph — evidence, observations, and the cursor that got them here.
 *
 * THE ONE DESIGN DECISION, STATED ONCE
 *
 * Evidence is immutable. Claims are append-only and time-valid. Current state is
 * a PROJECTION — computed on read, never a row that gets updated.
 *
 * That is not architectural taste; it is the difference between a CRM and a
 * memory. The old `profile_views` collection collapsed facts into a mutable
 * current-value row with first-writer-wins on scalars, which means the second
 * thing you learn about somebody is discarded to protect the first. A person who
 * was raising in August, hiring in December, and investing in 2027 has three
 * true histories, and a mutable row can hold exactly one of them.
 *
 * So nothing here updates an observation. Superseding one is itself a write.
 *
 * WHY caused_by AND NOT _caused_by
 *
 * A document written with a `caused_by` array of hashes is traversable by
 * `TRACE caused_by`. A field named `_caused_by` is stored as ordinary data and
 * the trace stops dead. That was verified against the running engine, and it is
 * the whole reason "why do you think this?" is a query rather than a join we
 * maintain by hand.
 *
 * AUTHORITY IS WHAT MAKES CORRECTIONS WORK
 *
 * §19 asks that a user correction never be silently overridden by a later AI
 * guess. Rather than special-casing that at every write site — where it would
 * eventually be forgotten — every observation carries an `authority` tier, and
 * the projection sorts by it before recency. One rule, one place, and the
 * property holds for code nobody has written yet.
 */

import { COLLECTIONS, quote } from "./db.js";
import { digest } from "./keys.js";

/**
 * The graph's collections. Named additively rather than replacing §12's set,
 * because the funnel collections still hold real history and deleting them to
 * make room would destroy the only record of how the old desk behaved.
 */
export const GRAPH_COLLECTIONS = Object.freeze({
  /** Immutable: a message or an attachment, exactly as it arrived. */
  EVIDENCE: "evidence",
  /** Append-only: every claim, each pointing at the evidence that supports it. */
  OBSERVATIONS: "observations",
  /** One row per watched mailbox: where we got to, durably. */
  MAIL_CURSORS: "mail_cursors",
  /** The intelligence backlog. Ingestion writes here and returns. */
  INTELLIGENCE_JOBS: "intelligence_jobs",
  /**
   * Proposed introductions — from the scorer OR from a person. One collection
   * for both, deliberately: see the note in graph/manager.js. A human match
   * living in a parallel table would need a parallel renderer, a parallel
   * explainer, and a parallel export, and the three would drift.
   */
  MATCHES: "graph_matches",
  /** Human judgment: confirmations, rejections, corrections. Append-only. */
  DECISIONS: "graph_decisions",
});

/**
 * Who said it, in precedence order. The projection reads this before recency,
 * so a correction outranks a later model run no matter when each arrived.
 */
export const AUTHORITY = Object.freeze({
  /** A person told us directly. Outranks everything. */
  USER_CORRECTION: 400,
  /** A parser established it: MIME headers, an address, a date. Not a guess. */
  DETERMINISTIC: 300,
  /** A model proposed it AND its quote was found in the source. */
  MODEL_VERIFIED: 200,
  /** A model proposed it and the quote did not check out. Never stored. */
  MODEL_UNVERIFIED: 0,
});

export const JOB_STATES = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
});

/* --- keys -------------------------------------------------------------- */

/**
 * Evidence is content-addressed, so re-ingesting the same message writes the
 * same id and therefore no new row. Idempotency is a property of addressing
 * rather than something a guard has to catch afterwards.
 */
export function evidenceKey({ kind, contentHash }) {
  return `${kind}:${contentHash}`;
}

/**
 * An observation's identity is its full claim plus the evidence and the model
 * that produced it.
 *
 * Two consequences, both wanted. Re-running the SAME model over the SAME
 * evidence under the SAME schema rewrites one row instead of appending a
 * duplicate — so a replay after a crash costs nothing. And bumping the schema or
 * the model changes the id, so the new interpretation lands BESIDE the old one
 * and the two can be compared. That is what makes §"reprocess when Muse
 * improves" a query rather than a migration.
 */
export function observationKey(observation) {
  return digest([
    observation.subject ?? "",
    observation.predicate ?? "",
    observation.object ?? "",
    observation.evidenceId ?? "",
    observation.model ?? "",
    observation.schemaVersion ?? "",
    // AUTHORITY AND `supersedes` ARE PART OF IDENTITY.
    //
    // Without them a retraction collides with the claim it retracts — same
    // subject, predicate, object and evidence — so `append` saw a duplicate and
    // silently wrote NOTHING. The correction appeared to succeed while the wrong
    // claim stayed live: the worst available outcome for a feature whose entire
    // promise is that a person's judgment sticks.
    //
    // Including them keeps a human retraction a distinct row, while a replay of
    // the same model claim is still one row.
    String(observation.authority ?? ""),
    observation.supersedes ?? "",
  ].join(""));
}

export function cursorKey(mailbox) {
  return digest(String(mailbox));
}

/* --- evidence ---------------------------------------------------------- */

export class EvidenceRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * Record a message or attachment verbatim. Returns `{ evidence, duplicate }`
   * so a caller can tell "already knew this" from "just learned this" — the
   * distinction the whole ingestion loop is built on.
   */
  record({ kind, contentHash, text, meta = {}, receivedAt }) {
    const id = evidenceKey({ kind, contentHash });
    const existing = this.store.get(GRAPH_COLLECTIONS.EVIDENCE, id);
    if (existing) return { evidence: existing, duplicate: true };

    const evidence = this.store.put(GRAPH_COLLECTIONS.EVIDENCE, id, {
      kind,
      contentHash,
      // Verbatim. §3: "Never summarize away the source material." The span
      // verifier also needs the exact bytes to check a quote against, so a
      // trimmed copy here would quietly break grounding later.
      text: text ?? null,
      meta,
      receivedAt,
    });
    return { evidence: { ...evidence, id }, duplicate: false };
  }

  get(id) {
    return this.store.get(GRAPH_COLLECTIONS.EVIDENCE, id) ?? null;
  }

  all() {
    return this.store.query(`FROM ${GRAPH_COLLECTIONS.EVIDENCE}`);
  }
}

/* --- observations ------------------------------------------------------ */

export class ObservationRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * Append a claim. Never updates a previous one.
   *
   * `causedBy` carries the evidence hash so `TRACE caused_by` walks from the
   * claim back to the message it came from — which is exactly the "why do you
   * think this?" the product promises to answer.
   */
  append({
    subject, predicate, object,
    attributes = {},
    evidenceId, quote,
    authority = AUTHORITY.MODEL_VERIFIED,
    confidence = 0.5,
    observedAt, validFrom = null, validUntil = null,
    model = null, schemaVersion = null, contentHash = null,
    supersedes = null,
  }) {
    const claim = {
      subject, predicate, object,
      attributes,
      evidenceId,
      quote,
      authority,
      confidence,
      observedAt,
      // §8. `observedAt` is when we heard it; `validFrom` is when it became
      // true. A message on the 25th saying "we closed last month" has one of
      // each, and conflating them is how a graph comes to believe a year-old
      // raise happened yesterday.
      validFrom: validFrom ?? observedAt,
      validUntil,
      supersedes,
      model, schemaVersion, contentHash,
      caused_by: evidenceId ? [evidenceId] : [],
    };

    const id = observationKey({ ...claim, evidenceId, model, schemaVersion });
    const existing = this.store.get(GRAPH_COLLECTIONS.OBSERVATIONS, id);
    if (existing) return { observation: existing, duplicate: true };

    const observation = this.store.put(GRAPH_COLLECTIONS.OBSERVATIONS, id, claim);
    return { observation: { ...observation, id }, duplicate: false };
  }

  /** Every claim about one subject, newest first. */
  forSubject(subject) {
    return this.store.query(
      `FROM ${GRAPH_COLLECTIONS.OBSERVATIONS} WHERE subject = ${quote(subject)}`,
    );
  }

  all() {
    return this.store.query(`FROM ${GRAPH_COLLECTIONS.OBSERVATIONS}`);
  }

  /**
   * The projection: fold observations into a current view of one subject.
   *
   * Authority first, then recency. That ordering IS §19's guarantee — a user
   * correction cannot be displaced by a model run that happens to be newer,
   * because the sort never reaches the timestamp comparison. Superseded claims
   * are dropped but not deleted; they remain queryable as history.
   */
  project(subject) {
    const rows = this.forSubject(subject);
    const superseded = new Set(rows.map((row) => row.supersedes).filter(Boolean));

    const live = rows.filter((row) => !superseded.has(row.id ?? null));
    const byPredicate = new Map();

    for (const row of live) {
      const key = `${row.predicate}${row.object ?? ""}`;
      const held = byPredicate.get(key);
      if (!held) { byPredicate.set(key, row); continue; }
      const better =
        row.authority > held.authority ||
        (row.authority === held.authority
          && String(row.observedAt) > String(held.observedAt));
      if (better) byPredicate.set(key, row);
    }

    return [...byPredicate.values()];
  }
}

/* --- the mailbox cursor ------------------------------------------------ */

/**
 * Where we got to, durably.
 *
 * NOT the `\Seen` flag, which the old adapter used. Two reasons it had to go:
 * reading your own mail in Roundcube marks messages seen and Yente never sees
 * them, and a flag cannot express "what changed" for a thread that gained a
 * reply. A cursor is ours, invisible to the human using the mailbox, and it
 * survives a restart.
 *
 * UIDVALIDITY is stored ALONGSIDE the UID because a UID means nothing without
 * it — the server may invalidate the whole numbering, and a stored UID compared
 * across that boundary points at a different message. On a change we resync
 * from the beginning and say so loudly.
 */
export class MailCursorRepository {
  constructor(store) {
    this.store = store;
  }

  read(mailbox) {
    return this.store.get(GRAPH_COLLECTIONS.MAIL_CURSORS, cursorKey(mailbox)) ?? null;
  }

  /**
   * Advance only forward. A batch that arrives out of order, or a retry that
   * re-reads an older UID, must not rewind the cursor and cause the same mail to
   * be ingested forever.
   */
  advance({ mailbox, uidValidity, lastUid, at }) {
    const id = cursorKey(mailbox);
    const held = this.store.get(GRAPH_COLLECTIONS.MAIL_CURSORS, id);

    const sameEpoch = held && Number(held.uidValidity) === Number(uidValidity);
    const nextUid = sameEpoch ? Math.max(Number(held.lastUid), Number(lastUid)) : Number(lastUid);

    return this.store.put(GRAPH_COLLECTIONS.MAIL_CURSORS, id, {
      mailbox,
      uidValidity: Number(uidValidity),
      lastUid: nextUid,
      updatedAt: at,
      // Kept so an operator can see a resync happened rather than inferring it
      // from a suspiciously large batch.
      resyncedAt: sameEpoch ? (held.resyncedAt ?? null) : at,
    });
  }
}

/* --- the intelligence backlog ------------------------------------------ */

/**
 * Ingestion writes a job and returns. Nothing about mail durability waits on a
 * model.
 *
 * "If 500 messages arrive while Muse is busy, Yente should simply have 500
 * safely-ingested messages plus an intelligence backlog — not a broken mailbox
 * listener." That sentence is this collection.
 *
 * The job id IS the evidence id, so enqueueing the same evidence twice is one
 * job. A redelivered message cannot produce a second inference, which matters
 * when inference is the expensive part.
 */
export class IntelligenceJobRepository {
  constructor(store) {
    this.store = store;
  }

  enqueue({ evidenceId, subjectHint = null, at }) {
    const existing = this.store.get(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId);
    if (existing) return { job: existing, duplicate: true };

    const job = this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId, {
      evidenceId,
      subjectHint,
      state: JOB_STATES.READY,
      attempts: 0,
      lastError: null,
      lastErrorAt: null,
      enqueuedAt: at,
      // Eligibility, not order. A job with a future availableAt is READY but
      // not yet due — which is how backoff survives a reboot: it is a stored
      // timestamp, not a timer in a process that may not exist tomorrow.
      availableAt: at,
      startedAt: null,
      finishedAt: null,
    });
    return { job: { ...job, id: evidenceId }, duplicate: false };
  }

  /**
   * Jobs that are READY *and due*.
   *
   * The `availableAt` filter is what makes backoff real. Without it a failing
   * job is retried on every drain — every 15 seconds — which is not persistence,
   * it is a hot loop against something already known to be broken. That is how
   * the old poller earned a fail2ban ban.
   *
   * Oldest-due first, so a job that has been waiting longest is not starved by a
   * steady arrival of new mail.
   */
  ready(limit = 10, now = new Date().toISOString()) {
    return this.store
      .query(`FROM ${GRAPH_COLLECTIONS.INTELLIGENCE_JOBS} WHERE state = ${quote(JOB_STATES.READY)}`)
      .filter((job) => !job.availableAt || String(job.availableAt) <= String(now))
      .sort((a, b) => String(a.availableAt ?? a.enqueuedAt).localeCompare(
        String(b.availableAt ?? b.enqueuedAt)))
      .slice(0, limit);
  }

  /**
   * How long to wait before trying this job again.
   *
   * Exponential with a cap, and the cap matters more than the curve: an hour
   * between attempts on a persistently broken job is cheap, and it means a
   * gateway that comes back after a night of downtime is picked up within the
   * hour without anybody restarting anything.
   */
  static backoffMs(attempts, { baseMs = 30_000, capMs = 60 * 60_000 } = {}) {
    return Math.min(capMs, baseMs * 2 ** Math.max(0, Number(attempts) - 1));
  }

  /**
   * Claim a job for this worker. Synchronous read-modify-write in a
   * single-threaded runtime, so two concurrent drains cannot both claim one job
   * — the same reasoning that lets the outbox skip optimistic locking.
   */
  start(evidenceId, at) {
    const job = this.store.get(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId);
    if (!job || job.state !== JOB_STATES.READY) return null;
    return this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId, {
      ...job,
      state: JOB_STATES.RUNNING,
      attempts: Number(job.attempts ?? 0) + 1,
      startedAt: at,
    });
  }

  finish(evidenceId, { at, claims = 0, promptVersion = null }) {
    const job = this.store.get(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId);
    if (!job) return null;
    return this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId, {
      ...job, state: JOB_STATES.DONE, finishedAt: at, claims, promptVersion, lastError: null,
    });
  }

  /**
   * Reprocess evidence when the observation prompt changes materially.
   *
   * Old jobs did not record promptVersion, so they are intentionally included
   * once. After they finish under the current version they stay DONE, including
   * honest zero-claim messages — no infinite replay of genuinely empty mail.
   */
  requeueForPrompt(promptVersion, at) {
    let count = 0;
    for (const job of this.store.query(`FROM ${GRAPH_COLLECTIONS.INTELLIGENCE_JOBS}`)) {
      if (job.state !== JOB_STATES.DONE || job.promptVersion === promptVersion) continue;
      this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, job.evidenceId, {
        ...job,
        state: JOB_STATES.READY,
        availableAt: at,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        lastErrorAt: null,
        retryInMs: null,
      });
      count += 1;
    }
    return count;
  }

  /**
   * A failure returns the job to READY while it still has attempts left, so a
   * transient gateway outage does not permanently lose a message's meaning. The
   * reason is stored under `lastError` — the same field the inspector reads,
   * because a diagnostic that reads a different name than the store writes is
   * how an SMTP timeout stayed invisible for a day.
   */
  /**
   * A job failed. Decide whether it can ever succeed, and when to try again.
   *
   * TRANSIENT FAILURES NEVER GIVE UP. A gateway timeout, a truncated stream, an
   * unparseable reply — none of those are facts about the message, they are facts
   * about a moment. Marking them FAILED after five tries throws away a real
   * email's meaning because the network had a bad afternoon. So they go back to
   * READY with a growing delay, indefinitely, and the delay is a STORED
   * timestamp so it survives a restart.
   *
   * DETERMINISTIC failures stop immediately — evidence with no extractable text
   * will not acquire any by being asked again.
   *
   * Either way the reason is written to `lastError`: the field the inspector
   * reads, because a diagnostic that reads a different name than the store
   * writes is how an SMTP timeout stayed invisible for a day.
   */
  fail(evidenceId, { at, error, transient = true, maxAttempts = null, backoff = {} }) {
    const job = this.store.get(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId);
    if (!job) return null;

    const attempts = Number(job.attempts ?? 0);
    // maxAttempts is opt-in. Null means "keep trying" — the default for anything
    // that might work later.
    const giveUp = !transient
      || (maxAttempts !== null && attempts >= maxAttempts);

    const waitMs = IntelligenceJobRepository.backoffMs(attempts, backoff);
    return this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, evidenceId, {
      ...job,
      state: giveUp ? JOB_STATES.FAILED : JOB_STATES.READY,
      finishedAt: giveUp ? at : null,
      availableAt: giveUp ? null : new Date(Date.parse(at) + waitMs).toISOString(),
      lastError: String(error?.message ?? error),
      lastErrorAt: at,
      retryInMs: giveUp ? null : waitMs,
    });
  }

  counts() {
    const out = { READY: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
    for (const job of this.store.query(`FROM ${GRAPH_COLLECTIONS.INTELLIGENCE_JOBS}`)) {
      out[job.state] = (out[job.state] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Jobs left RUNNING by a process that died. Nothing else will ever move them,
   * so a restart has to, or a crash mid-inference silently drops a message's
   * meaning while the mail itself looks perfectly ingested.
   */
  requeueStranded(at) {
    const stranded = this.store.query(
      `FROM ${GRAPH_COLLECTIONS.INTELLIGENCE_JOBS} WHERE state = ${quote(JOB_STATES.RUNNING)}`,
    );
    for (const job of stranded) {
      this.store.put(GRAPH_COLLECTIONS.INTELLIGENCE_JOBS, job.evidenceId, {
        ...job, state: JOB_STATES.READY, startedAt: null,
        // Due immediately: a process that died mid-inference is not evidence
        // that the work is failing, so it should not inherit a backoff.
        availableAt: at,
        lastError: "requeued after restart",
      });
    }
    return stranded.length;
  }
}

/* --- matches and human judgment ---------------------------------------- */

export const MATCH_STATES = Object.freeze({
  PROPOSED: "PROPOSED",
  CONFIRMED: "CONFIRMED",
  INTRODUCTION_SENDING: "INTRODUCTION_SENDING",
  INTRODUCED: "INTRODUCED",
  REJECTED: "REJECTED",
});

export const MATCH_ORIGIN = Object.freeze({
  SCORER: "scorer",
  HUMAN: "human",
});

/**
 * A match's identity is the ORDERED pair plus its type.
 *
 * Ordered, because "Sarah needs what David has" is a different introduction from
 * the reverse — different sentence, different favour being asked. Including the
 * type means one pair can hold several distinct introductions (she is hiring him
 * AND he is raising from her) without one overwriting the other.
 */
export function matchPairKey({ seeker, offerer, matchType }) {
  return digest([seeker, offerer, matchType].join(""));
}

export class GraphMatchRepository {
  constructor(store) {
    this.store = store;
  }

  /**
   * Record a proposal. A re-run of the scorer over unchanged evidence produces
   * the same id, so it updates the score in place rather than accumulating
   * duplicates of the same suggestion.
   *
   * A CONFIRMED or REJECTED match is never re-opened by the scorer. That is the
   * whole HITL contract: once a person has ruled, the machine does not get
   * another vote by running again.
   */
  propose({ seeker, offerer, matchType, confidence, reasons, conflicts, evidence,
            origin = MATCH_ORIGIN.SCORER, at, note = null }) {
    const id = matchPairKey({ seeker, offerer, matchType });
    const held = this.store.get(GRAPH_COLLECTIONS.MATCHES, id);

    if (held && held.state !== MATCH_STATES.PROPOSED) {
      return { match: held, decided: true };
    }
    // A human proposal must not be downgraded to a machine one by a later
    // scorer pass over the same pair.
    const keepOrigin = held?.origin === MATCH_ORIGIN.HUMAN ? MATCH_ORIGIN.HUMAN : origin;

    const match = this.store.put(GRAPH_COLLECTIONS.MATCHES, id, {
      seeker, offerer, matchType,
      confidence, reasons, conflicts, evidence,
      origin: keepOrigin,
      note: note ?? held?.note ?? null,
      state: MATCH_STATES.PROPOSED,
      proposedAt: held?.proposedAt ?? at,
      updatedAt: at,
      decidedAt: null,
      decidedBy: null,
    });
    return { match: { ...match, id }, decided: false };
  }

  decide({ matchId, state, by, at, note = null }) {
    const held = this.store.get(GRAPH_COLLECTIONS.MATCHES, matchId);
    if (!held) return null;
    return this.store.put(GRAPH_COLLECTIONS.MATCHES, matchId, {
      ...held, state, decidedAt: at, decidedBy: by,
      note: note ?? held.note ?? null,
      updatedAt: at,
      ...(state === MATCH_STATES.CONFIRMED ? {
        introductionAvailableAt: at,
        introductionAttempts: Number(held.introductionAttempts ?? 0),
        introductionLastError: null,
      } : {}),
    });
  }

  confirmedReady(at) {
    return this.byState(MATCH_STATES.CONFIRMED)
      .filter((match) => !match.introductionAvailableAt
        || String(match.introductionAvailableAt) <= String(at));
  }

  claimIntroduction(matchId, at) {
    const held = this.get(matchId);
    if (!held || held.state !== MATCH_STATES.CONFIRMED) return null;
    if (held.introductionAvailableAt && String(held.introductionAvailableAt) > String(at)) return null;
    return this.store.put(GRAPH_COLLECTIONS.MATCHES, matchId, {
      ...held,
      state: MATCH_STATES.INTRODUCTION_SENDING,
      introductionAttempts: Number(held.introductionAttempts ?? 0) + 1,
      introductionStartedAt: at,
      updatedAt: at,
    });
  }

  markIntroduced(matchId, { at, messageId }) {
    const held = this.get(matchId);
    if (!held || held.state !== MATCH_STATES.INTRODUCTION_SENDING) return null;
    return this.store.put(GRAPH_COLLECTIONS.MATCHES, matchId, {
      ...held,
      state: MATCH_STATES.INTRODUCED,
      introductionMessageId: messageId,
      introducedAt: at,
      introductionLastError: null,
      updatedAt: at,
    });
  }

  failIntroduction(matchId, { at, error }) {
    const held = this.get(matchId);
    if (!held || held.state !== MATCH_STATES.INTRODUCTION_SENDING) return null;
    const attempts = Number(held.introductionAttempts ?? 1);
    const waitMs = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
    return this.store.put(GRAPH_COLLECTIONS.MATCHES, matchId, {
      ...held,
      state: MATCH_STATES.CONFIRMED,
      introductionAvailableAt: new Date(Date.parse(at) + waitMs).toISOString(),
      introductionLastError: String(error?.message ?? error),
      introductionLastErrorAt: at,
      updatedAt: at,
    });
  }

  requeueStrandedIntroductions(at) {
    const stranded = this.byState(MATCH_STATES.INTRODUCTION_SENDING);
    for (const match of stranded) {
      const id = match.id ?? match._id;
      this.store.put(GRAPH_COLLECTIONS.MATCHES, id, {
        ...match,
        state: MATCH_STATES.CONFIRMED,
        introductionAvailableAt: at,
        introductionLastError: "requeued after restart",
        updatedAt: at,
      });
    }
    return stranded.length;
  }

  get(matchId) {
    return this.store.get(GRAPH_COLLECTIONS.MATCHES, matchId) ?? null;
  }

  byState(state) {
    return this.store.query(
      `FROM ${GRAPH_COLLECTIONS.MATCHES} WHERE state = ${quote(state)}`,
    );
  }

  all() {
    return this.store.query(`FROM ${GRAPH_COLLECTIONS.MATCHES}`);
  }
}

/**
 * Every human ruling, kept forever.
 *
 * Append-only for the same reason observations are: "this isn't relevant" in
 * March and "actually introduce them" in June are both true statements about
 * different moments, and a mutable row can hold one. It is also the only record
 * of WHY the graph looks the way it does after a person has been through it.
 */
export class DecisionRepository {
  constructor(store) {
    this.store = store;
  }

  record({ kind, target, verdict, by, at, detail = {} }) {
    const id = digest([kind, target, verdict, by, at].join(""));
    const decision = this.store.put(GRAPH_COLLECTIONS.DECISIONS, id, {
      kind, target, verdict, by, at, detail,
      caused_by: detail.evidenceId ? [detail.evidenceId] : [],
    });
    return { ...decision, id };
  }

  forTarget(target) {
    return this.store.query(
      `FROM ${GRAPH_COLLECTIONS.DECISIONS} WHERE target = ${quote(target)}`,
    );
  }

  all() {
    return this.store.query(`FROM ${GRAPH_COLLECTIONS.DECISIONS}`);
  }
}

export function createGraphRepositories(store) {
  return Object.freeze({
    evidence: new EvidenceRepository(store),
    observations: new ObservationRepository(store),
    cursors: new MailCursorRepository(store),
    jobs: new IntelligenceJobRepository(store),
    matches: new GraphMatchRepository(store),
    decisions: new DecisionRepository(store),
  });
}
