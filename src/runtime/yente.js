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
import { DEFAULT_POLICIES } from "../domain/policies.js";
import { extractionVocabulary, questionsFor, resolveField } from "../domain/profile-schema.js";
import { outboxKeyFor } from "../store/keys.js";
import { COLLECTIONS, quote } from "../store/db.js";
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

/** The three asks — ONE wording, used by intake and the reply-debt sweep. */
const PROFILE_REQUEST_LETTER = Object.freeze({
  subject: "What best explains your work?",
  text:
    "Hi — I make introductions between people who can help each other.\n\n" +
    "Three things get you matched, in any order:\n\n" +
    "1. Send your resume (attach it, any common format).\n" +
    "2. Send your LinkedIn profile URL.\n" +
    "3. Tell me which of these you are — one or more:\n" +
    "   hiring · seeking employment · seeking funding · funding startups\n\n" +
    "Reply STOP at any time and I will not write again.",
});

const NO_FACTS_LETTER = Object.freeze({
  subject: "I read it, but I could not use it yet",
  text:
    "Thanks — I received what you sent, but I could not pull verifiable " +
    "facts from it.\n\nAny of these will get you matched:\n\n" +
    "1. A resume, attached in any common format.\n" +
    "2. Your LinkedIn profile URL.\n" +
    "3. Which of these you are — one or more:\n" +
    "   hiring · seeking employment · seeking funding · funding startups\n\n" +
    "Reply STOP at any time and I will not write again.",
});

export function createRuntime({
  repositories,
  transport,
  extractionClient = null,
  emailClient = null,
  // The graph's evidence collection — the single source of mail truth.
  // The desk consumes from this instead of opening its own IMAP connection,
  // so the graph's LISTEN loop and the desk's tick never race for the same
  // inbox.
  graphEvidence = null,
  // A desk with no policies could not qualify anybody: `policies` had no
  // default and the only qualification policy in the tree lived in
  // test-support/fixtures.js, so `policies.memberQualification` was undefined in
  // production and qualify() would have thrown. Defaults are merged per-key, so
  // overriding one policy does not silently drop the others.
  policies: policyOverrides = {},
  config = {},
  // Observability. The runtime made decisions silently — most expensively in
  // drainOutbox, where a failed SMTP send was recorded in the outbox row and
  // NOWHERE else. "Yente is not emailing me back" was undiagnosable from the
  // console because the console was never told.
  log = () => {},
}) {
  assertTransport(transport);
  const { store } = repositories;
  // Evidence the graph has durably recorded. The desk processes each
  // message evidence exactly once through the profile pipeline.
  const evidenceSource = graphEvidence ?? { all: () => [] };
  const processedEvidence = new Set();
  const policies = { ...DEFAULT_POLICIES, ...policyOverrides };
  const {
    vetoWindowMs = 48 * 60 * 60 * 1000,
    haltOutbound = false,
    // The model was previously handed `{}` — an EMPTY controlled vocabulary —
    // so it invented its own field names and every fact it produced was later
    // dropped by the profile view for not matching a schema nobody had told it
    // about. See domain/profile-schema.js.
    vocabulary = extractionVocabulary(),
    cycle = "c1",
    // Backoff between extraction attempts. Real seconds in production, because a
    // busy peer operator needs time rather than an immediate identical retry;
    // 0 in tests, which must not sit through it.
    extractionRetryDelayMs = 5_000,
    extractionAttempts = 3,
  } = config;

  /* --- opportunities are stored, not modelled elsewhere yet ------------- */
  const opportunities = () => store.query(`FROM ${COLLECTIONS.OPPORTUNITIES}`);

  function saveOpportunity(opportunity, { causedBy = [] } = {}) {
    return store.put(COLLECTIONS.OPPORTUNITIES, opportunity.id, opportunity, { causedBy });
  }

  /* --- 1. ingest -------------------------------------------------------- */

  async function ingest(now) {
    // The desk must NOT race the graph's LISTEN loop for the same INBOX.
    // The graph's MailSource owns the single IMAP read path with its durable
    // cursor; the desk consumes evidence the graph has already durably
    // recorded. Two separate IMAP connections to the same mailbox was the
    // resume-attachment bug: whichever loop fired first won the message and
    // the other never saw it.
    //
    // When no graphEvidence is provided (legacy tests, standalone daemon),
    // fall back to the transport's fetchUnseen so the desk still works
    // without the graph — backward compatible, not the production path.
    if (!evidenceSource || evidenceSource.all().length === 0) {
      const results = [];
      for (const inbound of await transport.fetchUnseen()) {
        results.push(await ingestOne(inbound, now));
        await transport.markSeen(inbound.uid);
      }
      return results;
    }

    // One inbound per covering message. Attachments are folded onto the
    // parent so ingestOne stays the single pipeline: STOP is evaluated
    // before any résumé is mined, and qualify() runs once after every
    // source on that mail has been stored.
    const attachmentsByMessage = new Map();
    for (const evidence of evidenceSource.all()) {
      if (evidence.kind !== "attachment") continue;
      if (processedEvidence.has(evidence.id)) continue;
      const parentId = evidence.meta?.messageEvidenceId ?? null;
      if (!parentId) continue;
      const list = attachmentsByMessage.get(parentId) ?? [];
      list.push(evidence);
      attachmentsByMessage.set(parentId, list);
    }

    const results = [];
    for (const evidence of evidenceSource.all()) {
      if (evidence.kind !== "message") continue;
      if (processedEvidence.has(evidence.id)) continue;
      processedEvidence.add(evidence.id);
      const attachments = attachmentsByMessage.get(evidence.id) ?? [];
      for (const attachment of attachments) processedEvidence.add(attachment.id);
      results.push(await ingestFromEvidence(evidence, attachments, now));
    }
    return results;
  }

  // Map graph evidence into the shape ingestOne expects, then run the same
  // profile pipeline. The graph already parsed MIME, extracted attachment
  // text, and content-hashed the raw source. The desk does not re-read IMAP.
  async function ingestFromEvidence(evidence, attachments, now) {
    const meta = evidence.meta ?? {};
    const inbound = {
      uid: 0,
      rfcMessageId: meta.rfcMessageId ?? evidence.id,
      threadId: meta.threadId ?? null,
      from: meta.from ?? null,
      to: meta.to ?? [],
      cc: meta.cc ?? [],
      subject: meta.subject ?? null,
      text: evidence.text ?? "",
      sentAt: meta.sentAt ?? null,
      attachments: attachments.map((attachment) => ({
        filename: attachment.meta?.filename ?? "attachment",
        mimeType: attachment.meta?.mimeType ?? "text/plain",
        content: attachment.text ?? "",
      })),
    };
    return ingestOne(inbound, now);
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
      // A member who has already sent a résumé must never be asked for one
      // again. Their facts are on file; a short follow-up ("any news?", or an
      // answer to an interview question) carries no attachment and no 80
      // characters of substance, and this branch used to reply with the same
      // "please send a resume" letter — while she was holding sixteen verified
      // facts about them. Continue the conversation from what she already knows.
      const known = store.query(
        `FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(address)}`,
      );
      if (known.length > 0) {
        let outcome = "interviewing";
        const failures = [];
        try {
          const result = qualify(address, null, now);
          outcome = result.qualified ? "qualified" : "interviewing";
          if (result.qualified) acknowledge(address, now, [message]);
        } catch (error) {
          failures.push({ code: "QUALIFY_FAILED", message: String(error?.message ?? error) });
          outcome = "intake";
        }
        return { outcome, address, sources: 0, facts: known.length, rejected: 0, failures };
      }

      queue(
        OUTBOUND_PURPOSES.PROFILE_REQUEST,
        `profile:${address}`,
        [address],
        PROFILE_REQUEST_LETTER,
        now,
        [message],
      );
      return { outcome: "profile_requested", address };
    }

    /* --- extraction ------------------------------------------------------ */
    const facts = [];
    // Counted and RETURNED, not discarded. extractProfileFacts already reports
    // why an extraction produced nothing — MALFORMED_ARTIFACT, a model error,
    // or excerpts that failed grounding — and this function used to throw all of
    // it away. That made a failed extraction indistinguishable from an honestly
    // empty one, and cost a whole debugging session: the tick logged
    // `ingested=1 sent=0` either way, and the only way to recover the reason was
    // a second tool re-running extraction by hand.
    let rejected = 0;
    const failures = [];
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
          attempts: extractionAttempts,
          retryDelayMs: extractionRetryDelayMs,
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
        rejected += (extraction.rejected ?? []).length;
        for (const failure of extraction.failures ?? []) {
          failures.push({ code: failure.code, message: failure.message });
        }
      }
    }

    // THE OTHER DEAD END. The block below documents the first one — facts
    // extracted, qualify() never called. This is its mirror, found live
    // 2026-09-01: a NEW person's message stored a source, extraction produced
    // ZERO verified facts (model error, failed grounding, or a document that
    // simply carries none), and the function fell through to outcome "intake"
    // — no clarification, no ask, nothing queued. "A new email, a new name, a
    // new profile, all ingested... and no response." A stored source with no
    // facts must CONTINUE the conversation, not end it.
    if (stored.length > 0 && facts.length === 0) {
      const known = store.query(
        `FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(address)}`,
      );
      if (known.length > 0) {
        // They already have a profile on file; treat this like any thin
        // follow-up and let qualification continue the conversation.
        let outcome = "interviewing";
        try {
          const result = qualify(address, null, now);
          outcome = result.qualified ? "qualified" : "interviewing";
          if (result.qualified) acknowledge(address, now, [message]);
        } catch (error) {
          failures.push({ code: "QUALIFY_FAILED", message: String(error?.message ?? error) });
          outcome = "intake";
        }
        return { outcome, address, sources: stored.length, facts: 0, rejected, failures };
      }
      // Per-address idempotent: five unreadable documents earn ONE letter.
      queue(
        OUTBOUND_PURPOSES.CLARIFICATION,
        `clarify:nofacts:${address}`,
        [address],
        NO_FACTS_LETTER,
        now,
        [message],
      );
      return {
        outcome: "clarification_sent", address,
        sources: stored.length, facts: 0, rejected, failures,
      };
    }

    member = repositories.members.findByAddress(address);
    if (member.state === MEMBER_STATES.NEEDS_PROFILE) {
      member = beginInterview(member, now);
      repositories.members.save(member, { causedBy: [message] });
    }

    // THE DEAD END. Extraction used to be the last thing that happened: facts
    // were stored, the member was moved to INTERVIEWING, and this returned —
    // while `qualify()`, the ONLY function that queues the next letter, was
    // exported and called by nothing in the entire tree. A résumé arrived,
    // sixteen facts came out of it, and she said nothing, forever. Not a crash,
    // not a failed send; a pipeline that stopped one step early.
    //
    // Qualification is where the conversation continues: it either asks for what
    // is still missing, or promotes the member and lets acknowledge() confirm.
    // Its failure must not lose the ingest — the message is already durably
    // recorded, and throwing here would leave it recorded and unanswered with
    // no record of why.
    let outcome = "intake";
    if (facts.length > 0) {
      try {
        const result = qualify(address, null, now);
        outcome = result.qualified ? "qualified" : "interviewing";
        if (result.qualified) acknowledge(address, now, [message]);
      } catch (error) {
        failures.push({ code: "QUALIFY_FAILED", message: String(error?.message ?? error) });
        outcome = "intake";
      }

      // THE SECOND ASK, SENT ONLY WHEN IT IS STILL OPEN. A member whose résumé
      // just landed has completed ask 1; if none of their mail has ever carried
      // a LinkedIn URL, ask 2 is outstanding and this is the natural moment —
      // the reply they are already expecting, not a fresh nag.
      //
      // Idempotent by construction: the outbox key is per-address, so a member
      // who sends five documents is asked ONCE. And it rides the same INV-9
      // gate as every letter — a suppressed member is never asked anything.
      requestLinkedInIfMissing(address, now, [message]);
    }

    return {
      outcome, address,
      sources: stored.length,
      facts: facts.length,
      rejected,
      failures,
    };
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
  /**
   * Ask for the LinkedIn URL — once, and only while nobody has sent one.
   *
   * "Has one" is judged from the member's stored inbound text, not from a flag
   * somebody has to remember to set: if any message from this address ever
   * contained a linkedin.com/in URL, the ask is settled, whether or not the
   * enrichment that consumes it has run yet.
   */
  function requestLinkedInIfMissing(address, now, causedBy = []) {
    const inbound = store.query(
      `FROM ${COLLECTIONS.MESSAGES} WHERE direction = ${quote("inbound")} AND from = ${quote(address)}`,
    );
    const hasLinkedIn = inbound.some((row) =>
      /linkedin\.com\/in\//i.test(`${row.text ?? ""} ${row.raw ?? ""}`));
    if (hasLinkedIn) return null;

    return queue(
      OUTBOUND_PURPOSES.LINKEDIN_REQUEST,
      `linkedin:${address}`,
      [address],
      {
        subject: "One link would help",
        text:
          "Thanks — your document is on file and read.\n\n" +
          "If you have a LinkedIn profile, reply with the URL " +
          "(linkedin.com/in/...). It fills in what documents usually leave " +
          "out, and it is the fastest way to complete your profile.\n\n" +
          "No LinkedIn? No problem — just say so and we will work from what " +
          "you have sent.",
      },
      now,
      causedBy,
    );
  }

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
        // Asked in words, not in field paths. This used to interpolate the raw
        // schema — a member would have been sent "I still need: intent.seeks and
        // intent.introductionTypes", which nobody can answer.
        const asks = questionsFor(missing);
        const known = describeKnown(profile);
        queue(
          OUTBOUND_PURPOSES.INTERVIEW_QUESTION,
          `interview:${address}:${missing.join(",")}`,
          [address],
          {
            subject: asks.length > 1 ? "Two quick questions" : "One quick question",
            // Reflecting back what she already read matters more than brevity:
            // it proves the document was actually understood, and it stops the
            // member re-sending it because they assumed it was ignored.
            text: [
              "Thanks — I read that and it is on file.",
              known ? `\nWhat I have so far:\n${known}` : null,
              `\nTo find you the right introduction I still need to know ${
                asks.length > 1
                  ? `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}`
                  : asks[0]
              }.`,
              "\nJust reply in your own words — no forms.",
            ].filter(Boolean).join("\n"),
          },
          now,
        );
      } else if (qualification.blockers.length > 0) {
        // Not qualified, nothing to ask for: a state or relationship blocker.
        // Nothing to send — a member cannot fix `no_inbound_relationship` by
        // answering an email — but it must not look like a successful pass, so
        // the reason is returned rather than swallowed into a bare `false`.
        return { qualified: false, qualification, blocked: qualification.blockers };
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
    return { qualified: true, qualification, member: updated, profile };
  }

  /**
   * What she understood, in plain lines, for a member to correct.
   *
   * Only fields the view actually holds, which means only span-verified explicit
   * facts — so this cannot describe her as believing something she inferred.
   * Values are printed verbatim from the evidence, because a member reading
   * their own words back is how a wrong extraction gets caught by the one person
   * who can definitely spot it.
   */
  function describeKnown(profile) {
    const LINES = [
      ["professional.roles", "Role"],
      ["professional.employers", "Where"],
      ["professional.capabilities", "Works with"],
      ["professional.geographies", "Based"],
      ["professional.industries", "Industries"],
      ["professional.years_experience", "Experience"],
      ["professional.education", "Education"],
      ["intent.seeks", "Looking for"],
      ["intent.introductionTypes", "Useful introductions"],
      ["intent.constraints", "Constraints"],
    ];
    const out = [];
    for (const [path, label] of LINES) {
      const { spec } = resolveField(path);
      const value = spec ? profile?.[spec.group]?.[spec.key] : null;
      const text = Array.isArray(value) ? value.join(", ") : value;
      if (text) out.push(`  ${label}: ${text}`);
    }
    return out.join("\n");
  }

  /**
   * Tell a newly qualified member what she has, and how to change it.
   *
   * Without this, qualifying was ALSO silent: `qualify()` queues a letter only
   * when something is missing, so the better a member's résumé was, the less
   * they heard back. Nothing was queued, nothing was sent, and from the outside
   * that is identical to the extraction having failed.
   *
   * Idempotent by construction — the outbox key is per-address and per-fact-count,
   * so re-qualifying with the same evidence enqueues nothing (INV-10), while a
   * genuinely updated profile does produce a fresh confirmation.
   */
  function acknowledge(address, now, causedBy = []) {
    const profile = buildProfileView(store, address);
    const known = describeKnown(profile);
    if (!known) return null;

    const factCount = store
      .query(`FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(address)}`)
      .length;

    return queue(
      OUTBOUND_PURPOSES.PROFILE_CONFIRMATION,
      `confirm:${address}:${factCount}`,
      [address],
      {
        subject: "Here is what I have for you",
        text: [
          "Thanks — I have read what you sent and you are on the list.",
          "\nThis is what I took from it:",
          known,
          "\nEverything above came straight out of your own words; I do not record",
          "anything I cannot quote back to you.",
          "\nIf a line is wrong, reply CORRECT and tell me what it should say.",
          "I will not introduce you to anyone without showing you first.",
        ].join("\n"),
      },
      now,
      causedBy,
    );
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
    // REPLY IN THREAD. The inbound message that caused this letter is
    // the thread anchor: set its Message-ID as In-Reply-To so the
    // recipient's mail client threads this reply under the original
    // conversation. A letter without threading headers is a fresh
    // email from a stranger, and deliverability for a matchmaker who
    // shows up in a separate folder is zero.
    const inReplyTo = causedBy
      .map((c) => c?.rfcMessageId ?? null)
      .find((id) => id) ?? null;
    const job = enqueueEmail({
      jobId: key,
      idempotencyKey: key,
      purpose,
      recipients: live,
      enqueuedAt: now,
      headers: email.headers ?? {},
    });
    const { job: stored, duplicate } = repositories.outbox.enqueue({
      ...job,
      email: { ...email, ...(inReplyTo ? { inReplyTo } : {}) },
      context,
    }, { causedBy });
    return duplicate ? null : stored;
  }

  /**
   * THE REPLY-DEBT SWEEP — Mark, 2026-09-01: "are we keeping track of yente's
   * outbound so we can trigger replies on reboot idempotently."
   *
   * The outbox tracks LETTERS durably — queued survives reboot, sent is sent
   * forever. What it never tracked was OWED replies: a message processed
   * under code that decided nothing is deduped by INV-2 and never revisited,
   * so the person who triggered a dead end stayed unanswered across every
   * restart. This sweep closes that: any live member still in intake who has
   * NEVER been written to gets the continuation their last message deserved —
   * qualify() when facts are on file, the no-facts letter when a source is,
   * the three asks when nothing is. Idempotent three ways: the outbox keys
   * dedupe, a member with ANY letter on record is skipped, and INV-9 still
   * gates every recipient.
   */
  function sweepUnanswered(now) {
    const owedStates = new Set([
      MEMBER_STATES.NEW, MEMBER_STATES.NEEDS_PROFILE, MEMBER_STATES.INTERVIEWING,
    ]);
    const written = new Set();
    for (const job of store.query(`FROM ${COLLECTIONS.OUTBOX}`)) {
      for (const recipient of job.recipients ?? []) written.add(normalizeAddress(recipient));
    }

    let answered = 0;
    for (const member of store.query(`FROM ${COLLECTIONS.MEMBERS}`)) {
      if (!owedStates.has(member.state)) continue;
      const address = member.address ?? member._id;
      if (written.has(normalizeAddress(address))) continue;
      if (!canReceiveOutbound(member)) continue;

      const facts = store.query(
        `FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(address)}`,
      );
      if (facts.length > 0) {
        try {
          const result = qualify(address, null, now);
          if (result.qualified) acknowledge(address, now, []);
          answered += 1;
          continue;
        } catch { /* fall through to the letters */ }
      }
      const sources = store.query(
        `FROM ${COLLECTIONS.SOURCES} WHERE memberId = ${quote(address)}`,
      );
      if (sources.length > 0) {
        queue(OUTBOUND_PURPOSES.CLARIFICATION, `clarify:nofacts:${address}`,
          [address], NO_FACTS_LETTER, now, []);
      } else {
        queue(OUTBOUND_PURPOSES.PROFILE_REQUEST, `profile:${address}`,
          [address], PROFILE_REQUEST_LETTER, now, []);
      }
      answered += 1;
    }
    return answered;
  }

  async function drainOutbox(now) {
    if (isSendingHalted({ haltOutbound })) {
      const pending = repositories.outbox.claimable(now).length;
      // Silence here cost a debugging session: halted outbound with letters
      // waiting looked identical to a desk with nothing to say.
      if (pending > 0) log("warn", "outbound_halted", { pending });
      return { halted: true, sent: 0 };
    }

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
          // REPLY IN THREAD. Every outbound letter must be a reply to the
          // inbound message that caused it, so the recipient's mail client
          // threads it under the original conversation. A fresh email with
          // no threading headers looks like a cold message from a stranger,
          // and a matchmaker whose replies land in a separate folder is a
          // matchmaker nobody reads.
          ...(claimed.email?.inReplyTo ? { inReplyTo: claimed.email.inReplyTo } : {}),
        });
        const delivered = markSent(claimed, { messageId, sentAt: now });
        repositories.outbox.save(delivered);
        recordDelivery(delivered, now);
        sent += 1;
      } catch (error) {
        repositories.outbox.save(
          markFailed(claimed, { at: now, error: error.message, permanent: isPermanent(error) }),
        );
        // THE CONSOLE HEARS ABOUT EVERY FAILED LETTER. This was recorded in
        // the outbox row and nowhere else — a desk that queues a reply, fails
        // to send it, and says nothing is indistinguishable from a desk that
        // decided silence, and only one of those is a bug.
        log("error", "send_failed", {
          purpose: claimed.purpose ?? null,
          to: (claimed.recipients ?? []).join(", "),
          permanent: isPermanent(error),
          error: String(error?.message ?? error).slice(0, 300),
        });
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
    acknowledge,
    saveOpportunity,
    proposeMatches,
    advanceDeadlines,
    drainOutbox,
    sweepUnanswered,
    outboxStates: () =>
      Object.fromEntries(
        Object.values(OUTBOX_STATES).map((state) => [
          state,
          store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = "${state}"`).length,
        ]),
      ),
  };
}
