/**
 * LISTEN — the first stage, and the one that must never be slow.
 *
 * The order of operations here is the whole design, and it is not negotiable:
 *
 *   1. fetch from the cursor
 *   2. record each message as EVIDENCE (immutable, content-addressed)
 *   3. write an intelligence JOB
 *   4. THEN advance the cursor
 *   5. return
 *
 * Step 4 last is what makes a crash survivable. Advance the cursor first and a
 * process that dies at step 2 has permanently skipped that mail — it will never
 * be fetched again, and nothing anywhere will say so. Advance it last and the
 * worst case is re-reading messages we already have, which is free because
 * evidence is content-addressed and jobs are keyed by evidence id.
 *
 * Step 5 without waiting for a model is what keeps the mailbox healthy.
 * Observation takes 40-75 seconds through PIN on this hardware and the variance
 * is not ours to control. Fifty messages arriving at once would hold an IMAP
 * connection for the better part of an hour — and we have already been banned
 * once by a mail server for behaving oddly.
 *
 * WHAT THIS STAGE IS ALLOWED TO DECIDE: nothing. It does deterministic work
 * only — MIME, addresses, dates, hashes — because those have exact answers and
 * §16 is right that a parser beats a model at all of them.
 */

import { normalizeMessage } from "../mail/source.js";
import { ingestAttachments } from "./documents.js";

/**
 * One pass of the listener.
 *
 * @param {object} input
 * @param {object} input.source  createMailSource(...)
 * @param {object} input.graph   createGraphRepositories(store)
 */
export async function ingestMail({
  source,
  graph,
  now = () => new Date().toISOString(),
  log = () => {},
  // Injected so the ordering test does not fork Python, and so a box without
  // the worker's dependencies still ingests mail bodies.
  attachments: extractAttachments = ingestAttachments,
}) {
  const { messages, uidValidity, resynced } = await source.fetchNew();

  const summary = {
    fetched: messages.length,
    recorded: 0,
    duplicates: 0,
    enqueued: 0,
    documents: 0,
    documentsRefused: 0,
    resynced,
    highestUid: null,
  };

  if (messages.length === 0) return summary;

  for (const message of messages) {
    // Evidence first, and verbatim. §3: the original stays canonical, and the
    // span verifier needs the exact text to check a quote against later.
    const { evidence, duplicate } = graph.evidence.record({
      kind: "message",
      contentHash: message.contentHash,
      text: buildSourceText(message),
      meta: {
        uid: message.uid,
        identity: message.identity,
        identityKind: message.identityKind,
        rfcMessageId: message.rfcMessageId,
        threadId: message.threadId,
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        // Carried because "we closed last month" is only resolvable against
        // when it was said, and the model never sees a Date header.
        sentAt: message.sentAt,
        attachmentCount: message.attachments.length,
      },
      receivedAt: message.receivedAt,
    });

    if (duplicate) {
      summary.duplicates += 1;
    } else {
      summary.recorded += 1;
      // Enqueue only for new evidence. A redelivered message must not pay for
      // inference twice — that is the expensive part of the whole system.
      const { duplicate: jobExisted } = graph.jobs.enqueue({
        evidenceId: evidence.id ?? `message:${message.contentHash}`,
        subjectHint: message.from ?? null,
        at: now(),
      });
      if (!jobExisted) summary.enqueued += 1;

      // §4: an attachment is its own graph object, with its own evidence and its
      // own job — so a deck sent to two people is extracted once, and a claim
      // quoting page 3 traces to the document rather than to the covering email.
      //
      // Only for NEW messages: re-extracting an attachment we already have would
      // fork a parser for nothing.
      if (message.attachments.length > 0) {
        const docs = await extractAttachments({
          attachments: message.attachments,
          graph,
          messageEvidenceId: evidence.id ?? `message:${message.contentHash}`,
          receivedAt: message.receivedAt,
          sentAt: message.sentAt,
          now, log,
        });
        summary.documents += docs.extracted;
        summary.documentsRefused += docs.refused;
        summary.enqueued += docs.enqueued;
      }
    }

    summary.highestUid = Math.max(summary.highestUid ?? 0, message.uid);
  }

  // ONLY NOW. See the note at the top of this file.
  if (summary.highestUid !== null) {
    source.commit({ uidValidity, lastUid: summary.highestUid });
  }

  log("info", "ingested", {
    fetched: summary.fetched,
    new: summary.recorded,
    duplicates: summary.duplicates,
    enqueued: summary.enqueued,
    uid: summary.highestUid,
    ...(summary.documents ? { documents: summary.documents } : {}),
    // Counted, because an attachment we could not read is a real gap in the
    // graph and a silent one is indistinguishable from a message with none.
    ...(summary.documentsRefused ? { documents_refused: summary.documentsRefused } : {}),
    ...(resynced ? { resynced: true } : {}),
  });

  return summary;
}

/**
 * The text the observer will read, and the text quotes are checked against.
 *
 * Headers are included as plain lines rather than as separate structured input
 * for one specific reason: a quote must be findable in ONE source string. If the
 * subject line lived outside this text, a perfectly honest claim citing the
 * subject would fail grounding and be discarded as an invention.
 *
 * Attachment text is NOT here yet. The isolated Python document worker is the
 * next slice; until it exists an attachment is recorded in the metadata (so we
 * know it existed) and not fabricated into the source.
 */
function buildSourceText(message) {
  const lines = [];
  if (message.from) lines.push(`From: ${message.from}`);
  if (message.to?.length) lines.push(`To: ${message.to.join(", ")}`);
  if (message.subject) lines.push(`Subject: ${message.subject}`);
  if (message.sentAt) lines.push(`Date: ${message.sentAt}`);
  if (lines.length > 0) lines.push("");
  lines.push(message.text ?? "");
  return lines.join("\n").trim();
}

export { buildSourceText };
