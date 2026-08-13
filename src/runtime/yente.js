/**
 * The runtime — SPEC v2 §1.2's core loop, wired.
 *
 *   INBOUND -> PROFILE INTAKE -> INTERVIEW -> QUALIFIED -> DETERMINISTIC MATCH
 *   -> PRIVATE PREVIEWS -> VETO WINDOW -> CCME INTRODUCTION -> HANDOFF
 *
 * Everything here is orchestration. Every decision that matters was already
 * made by a pure function in src/domain, and this file's job is to call them in
 * the right order and persist the result. If a policy question appears to need
 * answering here, it belongs in the domain and has been mislaid.
 *
 * Two ordering rules are load-bearing rather than stylistic:
 *
 * 1. STOP is evaluated before anything else a message might mean (INV-9). Not
 *    "handled in the switch alongside the others" — first, before triage even
 *    asks what else the message is.
 *
 * 2. Nothing sends inline. Every outbound goes through the outbox and is
 *    delivered by `drainOutbox`, so a crash between deciding to send and
 *    sending leaves a durable job rather than a lost intention (D7).
 */

import { assertTransport } from "../mail/transport.js";
import { evaluateQualification, missingInterviewFields } from "../domain/qualification.js";
import { evaluateMatch } from "../domain/matching.js";
import {
  MEMBER_STATES,
  activate,
  beginIntake,
  beginInterview,
  canReceiveOutbound,
  createMember,
  deleteMember,
  markQualified,
  normalizeAddress,
  stopMember,
} from "../domain/member.js";
import {
  MATCH_STATES,
  PREVIEW_DECISIONS,
  advanceVetoDeadline,
  markIntroduced,
  markPreviewSent,
  proposeMatch,
  queueIntroduction,
  queuePreviews,
  recordPreviewDecision,
} from "../domain/workflow.js";
import {
  OUTBOUND_PURPOSES,
  OUTBOX_STATES,
  beginSend,
  enqueueEmail,
  isSendingHalted,
  markFailed,
  markSent,
} from "../domain/outbox.js";
import {
  createReferenceIntroduction,
  createReferencePrivatePreview,
} from "../domain/email-artifacts.js";
import { parseEmailArtifact } from "../protocol/blocks.js";
import { extractText } from "../extract/sources.js";
import { extractProfileFacts } from "../extract/profile.js";
import { outboxKeyFor } from "../store/keys.js";
import { COLLECTIONS } from "../store/db.js";
import { buildProfileView, saveProfileView } from "../store/profile-view.js";

/* --- triage ------------------------------------------------------------ */

/**
 * Control-word triage.
 *
 * Deliberately deterministic and deliberately narrow. §11 lets a model classify
 * intent, but STOP, PASS and DELETE are the three intents where being wrong is
 * unrecoverable — a missed STOP is an INV-9 violation and an invented PASS
 * silently kills a real introduction. Those three are matched by rule; anything
 * else the model may reason about later.
 *
 * `unknown` never acts. §11's own harness result said it plainly: a confidently
 * wrong reply from a matchmaking desk costs more than a slow one.
 */
export function triage(text) {
  const head = String(text ?? "").trim().slice(0, 200).toUpperCase();
  if (/\b(STOP|UNSUBSCRIBE|REMOVE ME)\b/.test(head)) return { intent: "stop" };
  if (/\b(DELETE ME|ERASE MY DATA|DELETE MY DATA)\b/.test(head)) return { intent: "delete" };
  if (/\bPASS\b/.test(head)) return { intent: "pass" };
  if (/\b(INTRODUCE|YES PLEASE INTRODUCE)\b/.test(head)) return { intent: "introduce" };
  if (/\bCORRECT\b/.test(head)) return { intent: "correct" };
  return { intent: "message" };
}

/* --- the runtime -------------------------------------------------------- */

export function createRuntime({
  repositories,
  transport,
  extractionClient = null,
  emailClient = null,
  policies,
  config = {},
}) {
  assertTransport(transport);
  const { store } = repositories;
  const {
    vetoWindowMs = 48 * 60 * 60 * 1000,
    haltOutbound = false,
    vocabulary = {},
    cycle = "c1",
  } = config;

  /* --- opportunities are stored, not modelled elsewhere yet ------------- */
  const opportunities = () => store.query(`FROM ${COLLECTIONS.OPPORTUNITIES}`);

  function saveOpportunity(opportunity, { causedBy = [] } = {}) {
    return store.put(COLLECTIONS.OPPORTUNITIES, opportunity.id, opportunity, { causedBy });
  }

  /* --- 1. ingest -------------------------------------------------------- */

  async function ingest(now) {
    const results = [];
    for (const inbound of await transport.fetchUnseen()) {
      results.push(await ingestOne(inbound, now));
      await transport.markSeen(inbound.uid);
    }
    return results;
  }

  async function ingestOne(inbound, now) {
    // INV-2: dedupe and record BEFORE anything can act on it.
    const { message, duplicate } = repositories.messages.recordInbound({
      rfcMessageId: inbound.rfcMessageId,
      threadId: inbound.threadId,
      from: inbound.from,
      to: inbound.to,
      subject: inbound.subject,
      receivedAt: now,
    });
    if (duplicate) return { outcome: "duplicate", rfcMessageId: inbound.rfcMessageId };

    const address = normalizeAddress(inbound.from);
    const intent = triage(inbound.text).intent;

    // INV-9, first and unconditionally.
    if (intent === "stop" || intent === "delete") {
      const existing = repositories.members.findByAddress(address);
      if (existing) {
        const updated =
          intent === "stop"
            ? stopMember(existing, now, { reason: "inbound request" })
            : deleteMember(existing, now, { reason: "inbound request" });
        repositories.members.save(updated, { causedBy: [message] });
        cancelPendingFor(address, intent, now);
      }
      return { outcome: intent, address };
    }

    let member = repositories.members.findByAddress(address);
    if (!member) {
      member = createMember({
        memberId: address,
        address,
        inboundEstablishedAt: now,
        createdAt: now,
      });
      member = beginIntake(member, now);
      repositories.members.save(member, { causedBy: [message] });
    }
    if (!canReceiveOutbound(member)) return { outcome: "suppressed", address };

    if (intent === "pass" || intent === "introduce" || intent === "correct") {
      return recordDecision(address, intent, now, message);
    }

    /* --- profile intake ------------------------------------------------- */
    const stored = [];
    for (const attachment of inbound.attachments ?? []) {
      try {
        const { text } = await extractText(attachment);
        const { source } = repositories.sources.save(
          {
            memberId: address,
            content: text,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            extractedText: text,
            receivedAt: now,
          },
          { causedBy: [message] },
        );
        stored.push({ source, text });
      } catch (error) {
        // §5.3: an unreadable attachment is answered with a plain request for
        // another format, not swallowed and not retried.
        queue(
          OUTBOUND_PURPOSES.CLARIFICATION,
          `clarify:${address}:${source_key(attachment)}`,
          [address],
          { subject: "I could not read that file", text: error.message },
          now,
          [message],
        );
      }
    }

    // The body itself is a source when it carries substance (§5.3).
    if (stored.length === 0 && String(inbound.text ?? "").trim().length >= 80) {
      const { source } = repositories.sources.save(
        { memberId: address, content: inbound.text, mimeType: "text/plain", extractedText: inbound.text, receivedAt: now },
        { causedBy: [message] },
      );
      stored.push({ source, text: inbound.text });
    }

    if (stored.length === 0) {
      queue(
        OUTBOUND_PURPOSES.PROFILE_REQUEST,
        `profile:${address}`,
        [address],
        {
          subject: "What best explains your work?",
          text:
            "Hi — I can help with introductions. Please send whatever best explains your " +
            "professional background: a resume, LinkedIn export, portfolio, or a short summary. " +
            "Also tell me what you are looking for.",
        },
        now,
        [message],
      );
      return { outcome: "profile_requested", address };
    }

    /* --- extraction ------------------------------------------------------ */
    const facts = [];
    if (extractionClient) {
      for (const { source, text } of stored) {
        // A prompt-safe alias, not the stored id. §12.1's source key is
        // `<memberId>:<hash>` and memberId is an email address, so the real id
        // contains an `@` — which blocks.js rightly refuses as a block
        // argument. Two modules had two definitions of "safe"; rather than
        // widen the protocol to fit an id, the prompt gets an alias. It also
        // keeps a member's address out of the model's context, which is the
        // right default even though nothing required it.
        const alias = `src_${source._hash.slice(0, 12)}`;
        const extraction = await extractProfileFacts({
          client: extractionClient,
          sourceId: alias,
          text,
          vocabulary,
        });
        for (const fact of extraction.verified) {
          facts.push(
            store.put(
              COLLECTIONS.PROFILE_FACTS,
              `${address}:${fact.field}:${fact.offset}`,
              { memberId: address, ...fact },
              { causedBy: [source] },
            ),
          );
        }
      }
    }

    member = repositories.members.findByAddress(address);
    if (member.state === MEMBER_STATES.NEEDS_PROFILE) {
      member = beginInterview(member, now);
      repositories.members.save(member, { causedBy: [message] });
    }

    return { outcome: "intake", address, sources: stored.length, facts: facts.length };
  }

  function source_key(attachment) {
    return String(attachment.filename ?? "attachment").replace(/[^A-Za-z0-9._-]/g, "_");
  }

  /* --- 2. qualification -------------------------------------------------- */

  /**
   * Qualification is a pure function of the profile and the policy (§6.4); this
   * only decides when to ask it and what to do with the answer. `profile` is
   * supplied by the caller for v0.1 — the profile_views materialisation of §12
   * is not built yet, and inventing one here would put a policy decision in the
   * orchestrator.
   */
  function qualify(address, profile = null, now = new Date().toISOString()) {
    const member = repositories.members.findByAddress(address);
    if (!member || !canReceiveOutbound(member)) return { qualified: false, reason: "suppressed" };

    // The profile is MATERIALISED from stored, span-verified facts unless a
    // caller supplies one. Taking it from the caller was a policy question
    // answered by a test fixture; §6.1 says the normalized profile is a view
    // over evidence, so it is built from evidence.
    if (!profile) {
      profile = buildProfileView(store, address);
      saveProfileView(store, address);
    }

    const qualification = evaluateQualification(
      { ...profile, id: address, state: member.state, inboundEstablishedAt: member.inboundEstablishedAt },
      policies.memberQualification,
    );

    if (!qualification.qualified) {
      const missing = missingInterviewFields(qualification);
      if (missing.length > 0) {
        queue(
          OUTBOUND_PURPOSES.INTERVIEW_QUESTION,
          `interview:${address}:${missing.join(",")}`,
          [address],
          {
            subject: "Two quick questions",
            text: `To match you well I still need: ${missing.join(" and ")}.`,
          },
          now,
        );
      }
      return { qualified: false, qualification };
    }

    let updated = member;
    if (updated.state !== MEMBER_STATES.QUALIFIED && updated.state !== MEMBER_STATES.ACTIVE) {
      if (updated.state === MEMBER_STATES.NEEDS_PROFILE) updated = beginInterview(updated, now);
      updated = markQualified(updated, { qualification, at: now });
    }
    if (updated.state === MEMBER_STATES.QUALIFIED) updated = activate(updated, now);
    repositories.members.save(updated);
    return { qualified: true, qualification, member: updated };
  }

  /* --- 3. matching and previews ------------------------------------------ */

  function proposeMatches({ profiles, now }) {
    const proposed = [];

    for (const opportunity of opportunities()) {
      const opportunityQualification = evaluateQualification(
        opportunity,
        policies.opportunityQualification,
      );

      for (const [address, profile] of Object.entries(profiles)) {
        const member = repositories.members.findByAddress(address);
        if (!member || member.state !== MEMBER_STATES.ACTIVE) continue;
        if (opportunity.memberId === address) continue;

        const candidate = { ...profile, id: address, state: member.state, inboundEstablishedAt: member.inboundEstablishedAt };
        const memberQualification = evaluateQualification(candidate, policies.memberQualification);

        const evaluation = evaluateMatch({
          member: candidate,
          opportunity,
          memberQualification,
          opportunityQualification,
          policy: policies.match,
          cycle,
          priorMatches: priorMatchesFor(address, opportunity.id),
        });

        if (!evaluation.eligible) continue;

        const memberIds = [address, opportunity.memberId];
        const stored = repositories.matches.find({
          policyId: policies.match.id,
          policyVersion: policies.match.version,
          memberIds,
          cycle,
        });
        if (stored) continue; // §7.2 gate 6, enforced by addressing

        let workflow = proposeMatch({
          matchId: `${policies.match.id}:${address}~${opportunity.memberId}`,
          matchResult: evaluation,
          memberIds,
          createdAt: now,
          vetoWindowMs,
        });
        workflow = queuePreviews(workflow, now);

        const saved = repositories.matches.save(workflow, {
          policyId: policies.match.id,
          policyVersion: policies.match.version,
          memberIds,
          cycle,
          causedBy: memberIds
            .map((id) => repositories.members.findByAddress(id))
            .filter(Boolean),
        });

        // §8.1: both previews are created atomically with the match. There is
        // no state in which one side has been told and the other has not.
        for (const recipient of memberIds) {
          const artifact = createReferencePrivatePreview({
            match: frozenMatchFor(saved, evaluation, memberIds, profiles, opportunity, now),
            recipientId: recipient,
          });
          const email = parseEmailArtifact(artifact);
          queue(
            OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW,
            outboxKeyFor.privateMatchPreview(saved._id, recipient),
            [recipient],
            email,
            now,
            [saved],
            { matchId: saved._id, recipient },
          );
        }

        proposed.push({ matchId: saved._id, evaluation });
      }
    }
    return proposed;
  }

  function frozenMatchFor(saved, evaluation, memberIds, profiles, opportunity, now) {
    const [memberId, employerId] = memberIds;
    const reason =
      `both directions cleared: member fit ${evaluation.scores.member.score}/${evaluation.scores.member.threshold}, ` +
      `opportunity fit ${evaluation.scores.opportunity.score}/${evaluation.scores.opportunity.threshold}`;
    return {
      id: saved._id,
      memberIds,
      reason,
      discussionTopic: opportunity.discussionTopic ?? "the role and the work behind it",
      factsUsed: evaluation.hardGates.map((gate) => `gate:${gate.id}`).concat(
        evaluation.scores.member.breakdown.filter((row) => row.passed).map((row) => `member:${row.id}`),
      ),
      vetoDeadlineAt: new Date(Date.parse(now) + vetoWindowMs).toISOString(),
      disclosures: {
        [memberId]: profiles[memberId]?.disclosure ?? { displayName: memberId, summary: "A qualified member." },
        [employerId]: opportunity.disclosure ?? { displayName: employerId, summary: "A qualified employer." },
      },
    };
  }

  function priorMatchesFor(address, opportunityId) {
    return store
      .query(`FROM ${COLLECTIONS.MATCHES}`)
      .filter((row) => Array.isArray(row.previews ? Object.keys(row.previews) : null))
      .filter((row) => Object.keys(row.previews ?? {}).includes(address))
      .map((row) => ({ idempotencyKey: row.matchIdempotencyKey, state: row.state, opportunityId }));
  }

  /* --- 4. decisions, deadline, introduction ------------------------------ */

  function recordDecision(address, intent, now, causedBy) {
    const decision =
      intent === "pass"
        ? PREVIEW_DECISIONS.PASS
        : intent === "introduce"
          ? PREVIEW_DECISIONS.APPROVE
          : PREVIEW_DECISIONS.CORRECT;

    const touched = [];
    for (const row of store.query(`FROM ${COLLECTIONS.MATCHES}`)) {
      if (!Object.keys(row.previews ?? {}).includes(address)) continue;
      if (row.state !== MATCH_STATES.VETO_WINDOW && row.state !== MATCH_STATES.READY_TO_INTRODUCE) continue;
      const next = recordPreviewDecision(row, address, decision, now);
      store.put(COLLECTIONS.MATCHES, row._id, next, { causedBy: causedBy ? [causedBy] : [] });
      touched.push(row._id);
    }
    return { outcome: intent, address, matches: touched };
  }

  function cancelPendingFor(address, intent, now) {
    const decision = intent === "stop" ? PREVIEW_DECISIONS.STOP : PREVIEW_DECISIONS.DELETE;
    for (const row of store.query(`FROM ${COLLECTIONS.MATCHES}`)) {
      if (!Object.keys(row.previews ?? {}).includes(address)) continue;
      if (row.state !== MATCH_STATES.VETO_WINDOW && row.state !== MATCH_STATES.READY_TO_INTRODUCE) continue;
      store.put(COLLECTIONS.MATCHES, row._id, recordPreviewDecision(row, address, decision, now));
    }
  }

  /**
   * The deadline sweep. Idempotent by construction: the introduction's outbox
   * key is the match, so a second pass enqueues nothing (INV-10).
   */
  function advanceDeadlines(now, profilesByAddress = {}) {
    const introduced = [];
    for (const row of store.query(`FROM ${COLLECTIONS.MATCHES}`)) {
      let workflow = row;
      if (workflow.state === MATCH_STATES.VETO_WINDOW) {
        workflow = advanceVetoDeadline(workflow, now);
      }
      if (workflow.state !== MATCH_STATES.READY_TO_INTRODUCE) {
        if (workflow !== row) store.put(COLLECTIONS.MATCHES, row._id, workflow);
        continue;
      }

      const memberIds = Object.keys(workflow.previews);
      if (memberIds.some((id) => !canReceiveOutbound(repositories.members.findByAddress(id) ?? {}))) {
        continue;
      }

      workflow = queueIntroduction(workflow, now);
      store.put(COLLECTIONS.MATCHES, row._id, workflow);

      const artifact = createReferenceIntroduction({
        match: {
          id: row._id,
          memberIds,
          reason: row.reason ?? "both sides cleared the same policy in both directions",
          discussionTopic: row.discussionTopic ?? "the role and the work behind it",
          factsUsed: row.factsUsed ?? ["gate:counterpart_type"],
          disclosures: Object.fromEntries(
            memberIds.map((id) => [
              id,
              profilesByAddress[id]?.disclosure ?? { displayName: id, summary: "A qualified member." },
            ]),
          ),
        },
      });

      queue(
        OUTBOUND_PURPOSES.JOINT_INTRODUCTION,
        outboxKeyFor.jointIntroduction(row._id),
        memberIds,
        parseEmailArtifact(artifact),
        now,
        [row],
        { matchId: row._id },
      );
      introduced.push(row._id);
    }
    return introduced;
  }

  /* --- 5. the outbox ------------------------------------------------------ */

  function queue(purpose, key, recipients, email, now, causedBy = [], context = null) {
    const live = recipients.filter((address) =>
      canReceiveOutbound(repositories.members.findByAddress(address) ?? { state: MEMBER_STATES.NEW }),
    );
    if (live.length !== recipients.length) return null; // INV-9 before anything else
    const job = enqueueEmail({
      jobId: key,
      idempotencyKey: key,
      purpose,
      recipients: live,
      enqueuedAt: now,
      headers: email.headers ?? {},
    });
    const { job: stored, duplicate } = repositories.outbox.enqueue({ ...job, email, context }, { causedBy });
    return duplicate ? null : stored;
  }

  async function drainOutbox(now) {
    if (isSendingHalted({ haltOutbound })) return { halted: true, sent: 0 };

    let sent = 0;
    for (const stored of repositories.outbox.claimable(now)) {
      const claimed = beginSend(stored, now);
      repositories.outbox.save(claimed);
      try {
        const { messageId } = await transport.send({
          to: claimed.recipients,
          subject: claimed.email?.subject ?? "",
          text: claimed.email?.text ?? "",
          headers: claimed.headers ?? {},
        });
        const delivered = markSent(claimed, { messageId, sentAt: now });
        repositories.outbox.save(delivered);
        recordDelivery(delivered, now);
        sent += 1;
      } catch (error) {
        repositories.outbox.save(
          markFailed(claimed, { at: now, error: error.message, permanent: isPermanent(error) }),
        );
      }
    }
    return { halted: false, sent };
  }

  function recordDelivery(job, now) {
    repositories.messages.recordOutbound({ rfcMessageId: job.messageId, job, sentAt: now });

    // The link travels WITH the job. An earlier version recovered the match by
    // pattern-matching the outbox key, which cannot work: §12.1 keys are
    // hashed when they contain characters that are unsafe in an id, and a
    // member address always does. The bug was invisible in unit tests because
    // nothing there round-tripped a key through the outbox — D8 found it.
    const context = job.context ?? null;
    if (!context?.matchId) return;

    const row = store.get(COLLECTIONS.MATCHES, context.matchId);
    if (!row) return;

    if (job.purpose === OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW) {
      store.put(
        COLLECTIONS.MATCHES,
        row._id,
        markPreviewSent(row, context.recipient, { messageId: job.messageId, sentAt: now }),
      );
      return;
    }

    if (job.purpose === OUTBOUND_PURPOSES.JOINT_INTRODUCTION) {
      if (row.state !== MATCH_STATES.INTRODUCTION_QUEUED) return;
      store.put(COLLECTIONS.MATCHES, row._id, markIntroduced(row, { messageId: job.messageId, sentAt: now }));
      repositories.introductions.save(
        { matchId: row._id, messageId: job.messageId, sentAt: now },
        { causedBy: [row] },
      );
    }
  }

  function isPermanent(error) {
    return /^5\d\d|5\.\d\.\d/.test(String(error.message ?? ""));
  }

  return {
    triage,
    ingest,
    qualify,
    saveOpportunity,
    proposeMatches,
    advanceDeadlines,
    drainOutbox,
    outboxStates: () =>
      Object.fromEntries(
        Object.values(OUTBOX_STATES).map((state) => [
          state,
          store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = "${state}"`).length,
        ]),
      ),
  };
}
