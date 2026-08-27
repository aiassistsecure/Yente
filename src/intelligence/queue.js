/**
 * The intelligence channel — separate from the mailbox, on purpose.
 *
 * "Email ingestion MUST NOT wait synchronously for Muse." That is the entire
 * reason this file exists as its own loop rather than a function call inside
 * ingestion.
 *
 * The numbers make it concrete. Measured through PIN on this hardware, one
 * observation takes 40–75 seconds, and the variance is not ours to control: the
 * model spends 70–80% of its tokens on reasoning that is stripped before we see
 * it, and how long it deliberates changes run to run. If ingestion awaited that,
 * a burst of fifty messages would hold an IMAP connection open for the better
 * part of an hour — and the fail2ban ban we already earned by polling every 30
 * seconds says exactly how servers respond to a client behaving oddly.
 *
 * So: mail arrives, is recorded durably, a job is written, and the connection is
 * free. If five hundred messages land while Muse is busy, we have five hundred
 * safely-ingested messages and a backlog — not a broken listener.
 *
 * WHY CONCURRENCY IS THE LEVER, NOT LATENCY
 *
 * Nobody waits on any single message. Four in flight at 60s each is a message
 * every fifteen seconds; the per-message number stops mattering. We verified
 * earlier that two concurrent PIN calls to one operator both succeed, so the
 * capacity is real — but it is finite and shared, which is why the limit is
 * bounded and configurable rather than "spawn one per job".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not parse mail, resolve identities, or decide anything. It moves work
 * between a store and a provider and records what came back. Every claim it
 * writes has already survived span verification inside the provider, and every
 * claim it writes carries the evidence hash that produced it.
 */

import { AUTHORITY, JOB_STATES } from "../store/graph.js";
import { boundSources } from "./bound.js";
import { CLAIM_GROUPS } from "./schema.js";
// ONE function turns an address into a subject id. This file used to build
// `person:${emailAddress}` inline while identity.js normalised gmail dots and
// plus-tags — so the graph stored `person:s.chen@gmail.com` and identity
// resolution looked for `person:schen@gmail.com` and found nothing. Silent, and
// exactly the drift that once dropped sixteen verified facts.
import { addressesIn, subjectForAddress } from "../graph/identity.js";
import { currentReplyOnly } from "../mail/quoted.js";

/**
 * Turn one verified envelope into graph observations.
 *
 * The mapping is deliberately dull. Interesting logic here would be logic
 * operating on model output, and the whole architecture is built so that the
 * model's output has already been gated by the time it arrives.
 *
 * `entities` become their own subjects; everything else attaches to the entity
 * its ref names. A claim whose ref was never declared has already been dropped
 * by validateEnvelope, so there is no dangling case to handle.
 */
export function observationsFrom({
  verified, evidenceId, provenance, observedAt, sentAt,
  subjectHint = null, evidenceKind = null,
}) {
  const out = [];
  const subjectOf = new Map();
  const entities = verified.entities ?? [];
  // A covering message's From header is deterministic ownership for its résumé.
  // Anchor only the unambiguous case: one person entity in attachment evidence.
  // Multi-person decks and arbitrary documents keep their own identities.
  const anchoredRef = evidenceKind === "attachment" && subjectHint
    && entities.filter((entity) => entity.kind === "PERSON").length === 1
    ? entities.find((entity) => entity.kind === "PERSON")?.ref
    : null;

  for (const entity of entities) {
    // Identity: prefer the address, because an address is an identifier and a
    // name is not. §7 — "Sarah Chen" is three different people in three
    // different mailboxes; sarah@acme.com is one.
    const naturalSubject = entity.emailAddress
      ? subjectForAddress(entity.emailAddress)
      : `${entity.kind === "ORGANIZATION" ? "org" : "person"}:name:${entity.name.toLowerCase()}`;
    const subject = entity.ref === anchoredRef ? subjectHint : naturalSubject;
    subjectOf.set(entity.ref, subject);

    out.push({
      subject,
      predicate: entity.kind === "ORGANIZATION" ? "is_organization" : "is_person",
      object: entity.name,
      attributes: entity.title ? { title: entity.title } : {},
      evidenceId, quote: entity.evidence,
      authority: AUTHORITY.MODEL_VERIFIED,
      confidence: entity.confidence,
      observedAt,
      // §8: when we HEARD it vs when it was TRUE. The message's own Date is the
      // only honest anchor for the second, and the model never saw it.
      validFrom: sentAt ?? observedAt,
      ...provenance,
    });

    if (entity.ref === anchoredRef && naturalSubject !== subject) {
      out.push({
        subject: naturalSubject,
        predicate: "same_as",
        object: subject,
        attributes: { reason: "covering_message_sender" },
        evidenceId,
        quote: entity.evidence,
        authority: AUTHORITY.DETERMINISTIC,
        confidence: 1,
        observedAt,
        validFrom: sentAt ?? observedAt,
        ...provenance,
      });
    }
  }

  const attach = (group, toClaim) => {
    for (const claim of verified[group] ?? []) {
      const mapped = toClaim(claim);
      if (!mapped?.subject) continue;   // ref we never declared; already dropped
      out.push({
        ...mapped,
        evidenceId, quote: claim.evidence,
        authority: AUTHORITY.MODEL_VERIFIED,
        confidence: claim.confidence,
        observedAt,
        validFrom: sentAt ?? observedAt,
        ...provenance,
      });
    }
  };

  attach("intents", (claim) => ({
    subject: subjectOf.get(claim.actorRef),
    // The intent TYPE is the predicate, so complementarity is a predicate
    // comparison rather than a string search through free text. That is what
    // makes SEEKING x OFFERING a deterministic query later.
    predicate: `intent:${claim.type}`,
    object: claim.object,
    attributes: { ...claim.attributes, ...(claim.rawType ? { rawType: claim.rawType } : {}) },
  }));

  attach("relationships", (claim) => ({
    subject: subjectOf.get(claim.subjectRef),
    predicate: claim.predicate,
    object: subjectOf.get(claim.objectRef) ?? null,
  }));

  // What the message revealed about somebody. The FIELD is the predicate, so a
  // disclosure is queryable the same way an intent is — `capability` claims are
  // findable as a set rather than buried in free text under `note`.
  //
  // This is what documents were always producing and the graph had nowhere to
  // put: a résumé's facts used to arrive as `opportunity` summaries and `note`
  // blobs, which is why matching could see almost nothing in them.
  attach("disclosures", (claim) => ({
    subject: subjectOf.get(claim.subjectRef),
    predicate: claim.field,
    object: claim.value,
  }));

  return out;
}

/** Resolve the deterministic member who owns this evidence, including old rows. */
function subjectHintFor({ graph, job, evidence }) {
  if (job.subjectHint) {
    return String(job.subjectHint).startsWith("person:")
      ? job.subjectHint
      : subjectForAddress(addressesIn(job.subjectHint)[0]?.normalized ?? job.subjectHint);
  }
  if (evidence.meta?.subjectHint) return evidence.meta.subjectHint;
  if (evidence.kind !== "attachment" || !evidence.meta?.messageEvidenceId) return null;

  // Attachments ingested before subjectHint existed still cite their covering
  // message. Recover the sender from that immutable parent instead of asking the
  // model to infer ownership from a résumé filename.
  const parent = graph.evidence.get(evidence.meta.messageEvidenceId);
  const address = addressesIn(parent?.meta?.from ?? "")[0]?.normalized;
  return address ? subjectForAddress(address) : null;
}

/**
 * Drain the backlog with bounded concurrency.
 *
 * Returns a summary rather than throwing: one poisoned message must not stop the
 * drain, and the caller (a tick loop) needs to know what happened without
 * catching per-job errors itself.
 *
 * @param {object} input
 * @param {object} input.graph        createGraphRepositories(store)
 * @param {object} input.observer     IntelligenceProvider
 * @param {number} [input.concurrency]
 * @param {number} [input.limit]      max jobs per drain
 */
export async function drainIntelligence({
  graph,
  observer,
  // The env fallback stays for the one-shot tools, but a caller that owns the
  // number should pass it. `= default` covers an explicit `undefined`, which is
  // what a caller that hasn't decided actually sends.
  concurrency = Number(process.env.YENTE_INTELLIGENCE_CONCURRENCY || 3),
  limit = 24,
  now = () => new Date().toISOString(),
  log = () => {},
  signal,
}) {
  const jobs = graph.jobs.ready(limit, now());
  if (jobs.length === 0) {
    return { claimed: 0, observed: 0, claims: 0, failed: 0, skipped: 0 };
  }

  const summary = { claimed: 0, observed: 0, claims: 0, failed: 0, skipped: 0 };
  const queue = [...jobs];

  async function worker() {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const job = queue.shift();

      // Claim it. A synchronous read-modify-write in a single-threaded runtime,
      // so two workers cannot both take one job — the same property the outbox
      // relies on instead of optimistic locking.
      const claimed = graph.jobs.start(job.evidenceId, now());
      if (!claimed) { summary.skipped += 1; continue; }
      summary.claimed += 1;

      const evidence = graph.evidence.get(job.evidenceId);
      const subjectHint = evidence ? subjectHintFor({ graph, job, evidence }) : null;
      if (!evidence?.text) {
        // DETERMINISTIC. Evidence with no extractable text will not acquire any
        // by being asked again, so this is the one case that stops immediately.
        graph.jobs.fail(job.evidenceId, {
          at: now(), error: "evidence has no extractable text", transient: false,
        });
        summary.failed += 1;
        log("error", "job_failed_permanently", {
          evidence: job.evidenceId,
          reason: "no extractable text",
          note: "will never be retried — the evidence itself is unusable",
        });
        continue;
      }

      // BOUND THE PROMPT. An unbounded one does not fail gently: during prefill
      // a model emits nothing, PIN's limit is "nothing for 90s", and a prompt
      // whose prefill exceeds that is killed before it speaks — identically on
      // every retry, because the input never changes. Permanent, disguised as
      // transient. See bound.js.
      const analysisText = evidence.kind === "message"
        ? currentReplyOnly(evidence.text)
        : evidence.text;
      const { sources, report } = boundSources([
        { id: job.evidenceId, text: analysisText },
      ]);

      // Announced BEFORE the await, because the whole point is the 40-75s in
      // between. A job reported only on completion is invisible for exactly as
      // long as it is interesting. The SIZE goes here too: "why is this slow"
      // was unanswerable from outside the process.
      log("info", "observe_started", {
        evidence: job.evidenceId,
        attempt: Number(job.attempts ?? 0) + 1,
        chars: report.keptChars,
        est_tokens: report.estimatedTokens,
        truncated: report.truncated > 0 ? report.originalChars : 0,
      });

      try {
        const result = await observer.observe({
          sources,
          // Deterministic orientation, marked as such. The parser already knows
          // who sent this and when; making the model re-derive it from a
          // signature block would be slower and less reliable. Anything it
          // reports still needs its own quote.
          context: {
            sender: evidence.meta?.from
              ?? (subjectHint?.startsWith("person:") ? subjectHint.slice("person:".length) : null),
            subject: evidence.meta?.subject ?? evidence.meta?.filename ?? null,
            sent_at: evidence.meta?.sentAt ?? null,
          },
          signal,
        });

        const claims = observationsFrom({
          verified: result.verified,
          evidenceId: job.evidenceId,
          provenance: {
            model: result.provenance.model,
            schemaVersion: result.provenance.schemaVersion,
            contentHash: result.provenance.contentHash,
          },
          observedAt: now(),
          sentAt: evidence.meta?.sentAt ?? null,
          subjectHint,
          evidenceKind: evidence.kind,
        });

        let written = 0;
        for (const claim of claims) {
          const { duplicate } = graph.observations.append(claim);
          if (!duplicate) written += 1;
        }

        graph.jobs.finish(job.evidenceId, {
          at: now(), claims: written,
          promptVersion: result.provenance.promptVersion ?? null,
        });
        summary.observed += 1;
        summary.claims += written;

        log("info", "observed", {
          evidence: job.evidenceId,
          claims: written,
          rejected: result.rejected.length,
          cached: result.cached,
          // Drift worth watching: the model stopped using the block frame.
          ...(result.recovered ? { recovered: result.recovered } : {}),
          elapsed_ms: result.provenance.elapsedMs,
        });
      } catch (error) {
        // EVERYTHING ELSE IS TRANSIENT UNTIL PROVEN OTHERWISE.
        //
        // A gateway timeout, a truncated stream, an unparseable reply — none of
        // those are facts about this email. They are facts about a moment, and
        // giving up on them discards a real message's meaning because the
        // network had a bad afternoon. So the job goes back to READY with a
        // growing, STORED delay and is retried indefinitely.
        //
        // The one exception is a request that is itself wrong (an HTTP 400, an
        // oversized prompt): repeating it unchanged is a slower way to fail.
        const permanent = error?.code === "HTTP_ERROR"
          && Number(error?.meta?.status ?? error?.meta?.failures?.[0]?.status ?? 0) === 400;

        const updated = graph.jobs.fail(job.evidenceId, {
          at: now(), error, transient: !permanent,
        });
        summary.failed += 1;

        // LOUD, AND IT SAYS WHERE. An attempt count and a next-retry time turn
        // "it isn't working" into "this evidence, this error, trying again in
        // four minutes" — which is the difference between a mystery and a
        // maintenance task.
        log(permanent ? "error" : "warn",
          permanent ? "job_failed_permanently" : "observe_failed", {
          evidence: job.evidenceId,
          code: error?.code ?? "OBSERVE_FAILED",
          error: String(error?.message ?? error),
          attempt: updated?.attempts ?? null,
          ...(updated?.retryInMs
            ? { retry_in_s: Math.round(updated.retryInMs / 1000) } : {}),
          // What the model actually sent, when it sent something unusable.
          // Reporting "malformed" while discarding the malformed thing is how a
          // gateway's own explanation went unread for a whole session.
          ...(error?.meta?.failures?.[0]?.sample
            ? { sample: error.meta.failures[0].sample.slice(0, 300) } : {}),
        });

        // Escalate on a job that has been failing for a long time. Not a
        // different behaviour — the same retry, said louder, because a backlog
        // stuck for an hour is an operator problem and silence is how the last
        // two-day outage happened.
        if ((updated?.attempts ?? 0) === 5 || (updated?.attempts ?? 0) === 20) {
          log("error", "job_stuck", {
            evidence: job.evidenceId,
            attempts: updated.attempts,
            since: updated.enqueuedAt,
            last_error: updated.lastError,
            note: "still retrying with backoff; nothing is lost, but something "
              + "upstream needs attention",
          });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  );

  return summary;
}

export { JOB_STATES, CLAIM_GROUPS };
