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
import { CLAIM_GROUPS } from "./schema.js";
// ONE function turns an address into a subject id. This file used to build
// `person:${emailAddress}` inline while identity.js normalised gmail dots and
// plus-tags — so the graph stored `person:s.chen@gmail.com` and identity
// resolution looked for `person:schen@gmail.com` and found nothing. Silent, and
// exactly the drift that once dropped sixteen verified facts.
import { subjectForAddress } from "../graph/identity.js";

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
export function observationsFrom({ verified, evidenceId, provenance, observedAt, sentAt }) {
  const out = [];
  const subjectOf = new Map();

  for (const entity of verified.entities ?? []) {
    // Identity: prefer the address, because an address is an identifier and a
    // name is not. §7 — "Sarah Chen" is three different people in three
    // different mailboxes; sarah@acme.com is one.
    const subject = entity.emailAddress
      ? subjectForAddress(entity.emailAddress)
      : `${entity.kind === "ORGANIZATION" ? "org" : "person"}:name:${entity.name.toLowerCase()}`;
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
    attributes: claim.rawPredicate ? { rawPredicate: claim.rawPredicate } : {},
  }));

  attach("opportunities", (claim) => ({
    subject: subjectOf.get(claim.subjectRef),
    predicate: "opportunity",
    object: claim.summary,
  }));

  attach("observations", (claim) => ({
    subject: claim.subjectRef ? subjectOf.get(claim.subjectRef) : null,
    predicate: "note",
    object: claim.text,
  }));

  return out;
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
  concurrency = Number(process.env.YENTE_INTELLIGENCE_CONCURRENCY || 3),
  limit = 24,
  now = () => new Date().toISOString(),
  log = () => {},
  signal,
}) {
  const jobs = graph.jobs.ready(limit);
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
      if (!evidence?.text) {
        // Enqueued but the text is gone or was never extractable. Fail it
        // permanently rather than retrying forever against nothing.
        graph.jobs.fail(job.evidenceId, {
          at: now(), error: "evidence has no extractable text", maxAttempts: 0,
        });
        summary.failed += 1;
        continue;
      }

      try {
        const result = await observer.observe({
          sources: [{ id: job.evidenceId, text: evidence.text }],
          // Deterministic orientation, marked as such. The parser already knows
          // who sent this and when; making the model re-derive it from a
          // signature block would be slower and less reliable. Anything it
          // reports still needs its own quote.
          context: {
            sender: evidence.meta?.from ?? null,
            subject: evidence.meta?.subject ?? null,
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
        });

        let written = 0;
        for (const claim of claims) {
          const { duplicate } = graph.observations.append(claim);
          if (!duplicate) written += 1;
        }

        graph.jobs.finish(job.evidenceId, { at: now(), claims: written });
        summary.observed += 1;
        summary.claims += written;

        log("info", "observed", {
          evidence: job.evidenceId.slice(0, 16),
          claims: written,
          rejected: result.rejected.length,
          cached: result.cached,
          // Drift worth watching: the model stopped using the block frame.
          ...(result.recovered ? { recovered: result.recovered } : {}),
          elapsed_ms: result.provenance.elapsedMs,
        });
      } catch (error) {
        graph.jobs.fail(job.evidenceId, { at: now(), error });
        summary.failed += 1;
        log("warn", "observe_failed", {
          evidence: job.evidenceId.slice(0, 16),
          code: error?.code ?? "OBSERVE_FAILED",
          error: String(error?.message ?? error),
          // What the model actually sent, when it sent something unusable.
          // Reporting "malformed" while discarding the malformed thing is how a
          // gateway's own explanation went unread for a whole session.
          ...(error?.meta?.failures?.[0]?.sample
            ? { sample: error.meta.failures[0].sample.slice(0, 300) } : {}),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  );

  return summary;
}

export { JOB_STATES, CLAIM_GROUPS };
