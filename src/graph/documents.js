/**
 * The bridge to the document worker — and the boundary it enforces.
 *
 * WHAT THIS FILE IS ACTUALLY FOR
 *
 * Not "calling Python". It is the place where an untrusted file from a stranger
 * is turned into text WITHOUT the thing that reads it having any capability
 * worth attacking. The worker gets bytes on stdin and answers on stdout; it has
 * no store handle, no network client, no credentials, and no way to reach the
 * graph. §5's list of things an attachment worker must not execute is satisfied
 * by there being nothing in that process to execute them with.
 *
 * WHY A SUBPROCESS PER ATTACHMENT
 *
 * Because the failure mode we are guarding against is a segfault, not an
 * exception. PDF and Office parsers have long CVE histories and the interesting
 * ones are memory-safety bugs. A long-lived worker pool would let one malicious
 * PDF take out the process handling everyone else's mail; one process per file
 * costs a few hundred milliseconds and bounds the damage to that file.
 *
 * A timeout and a kill, because a parser can also simply hang — and an
 * attachment that hangs the listener is a denial of service that any stranger
 * can trigger by emailing us.
 *
 * EVERY OUTCOME IS DATA
 *
 * Refused, unreadable, empty, timed out: all of them return a shape, none of
 * them throw. §22 — one poisoned PDF must never stop mailbox ingestion — and the
 * only way to honour that is for the caller to have nothing to catch.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..", "workers", "document_worker.py");

/** Same hash family as everything else, so provenance reads as one vocabulary. */
export function attachmentHash(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  return createHash("blake2b512").update(buffer).digest("hex").slice(0, 64);
}

/**
 * Extract one attachment.
 *
 * Never throws. Returns `{ ok, text, structure, error, ... }`.
 */
export function extractDocument({
  filename,
  mimeType,
  content,
  python = process.env.YENTE_PYTHON || "python3",
  timeoutMs = Number(process.env.YENTE_DOC_TIMEOUT_MS || 60_000),
  workerPath = WORKER,
} = {}) {
  return new Promise((resolve) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? "");
    const done = (value) => resolve({ filename, contentHash: attachmentHash(bytes), ...value });

    let child;
    try {
      child = spawn(python, [workerPath], {
        stdio: ["pipe", "pipe", "pipe"],
        // No inherited environment beyond what the worker needs. It has no use
        // for our credentials, and a parser that can read process.env is a
        // parser that can exfiltrate through a crafted document.
        // Only what is actually set. Passing `VAR: ""` is not "unset" — it is
        // the empty string, and `int(os.environ.get(VAR, default))` then raises
        // on it rather than taking the default. That cost a debugging round and
        // was invisible until the empty-stdout handling above was fixed.
        env: {
          PATH: process.env.PATH,
          PYTHONIOENCODING: "utf-8",
          ...(process.env.YENTE_DOC_MAX_BYTES
            ? { YENTE_DOC_MAX_BYTES: process.env.YENTE_DOC_MAX_BYTES } : {}),
          ...(process.env.YENTE_DOC_MAX_CHARS
            ? { YENTE_DOC_MAX_CHARS: process.env.YENTE_DOC_MAX_CHARS } : {}),
        },
      });
    } catch (error) {
      return done({ ok: false, error: `cannot start worker: ${error.message}` });
    }

    let out = "";
    let err = "";
    let settled = false;

    // A parser can hang as easily as it can crash, and an attachment that hangs
    // the listener is a denial of service any stranger can trigger by email.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      done({ ok: false, error: `worker timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok: false, error: `worker failed to run: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // An EMPTY stdout is not an empty verdict. Parsing `""||"{}"` into `{}`
        // and returning it made a worker that died before writing anything look
        // like a successful extraction of nothing — and it swallowed the stderr
        // that said why. That is the same mistake as EMPTY_COMPLETION hiding the
        // gateway's own explanation, committed twice in one codebase.
        const raw = out.trim();
        if (!raw) throw new Error("no output");
        return done(JSON.parse(raw));
      } catch {
        // A worker that died before writing JSON — the segfault case this whole
        // design exists for. Report it as data; stderr is the only clue and it
        // is worth keeping.
        return done({
          ok: false,
          error: `worker produced no verdict (code=${code} signal=${signal ?? "none"})`,
          stderr: err.slice(0, 500),
        });
      }
    });

    child.stdin.on("error", () => { /* the close handler already reports it */ });
    child.stdin.end(JSON.stringify({
      filename,
      mime_type: mimeType,
      b64: bytes.toString("base64"),
    }));
  });
}

/**
 * Extract every attachment on a message and record each as its own evidence row.
 *
 * §4: "An attachment is its own graph object." So a document gets its own
 * content-addressed evidence and its own intelligence job — which means a deck
 * sent to two people is extracted once, and a claim quoting page 3 traces to the
 * document rather than to the covering email.
 *
 * Sequential rather than parallel. Six vCPUs on this box, one subprocess per
 * file, and a message with twenty attachments should not fork twenty parsers.
 */
export async function ingestAttachments({
  attachments = [],
  graph,
  messageEvidenceId,
  subjectHint = null,
  receivedAt,
  sentAt = null,
  now = () => new Date().toISOString(),
  log = () => {},
  extract = extractDocument,
}) {
  const summary = { seen: attachments.length, extracted: 0, refused: 0, empty: 0, enqueued: 0 };

  for (const attachment of attachments) {
    const content = attachment.content ?? attachment.buffer ?? attachment.data;
    if (!content) { summary.refused += 1; continue; }

    const result = await extract({
      filename: attachment.filename ?? attachment.name ?? "attachment",
      mimeType: attachment.mimeType ?? attachment.contentType ?? "",
      content,
    });

    if (!result.ok) {
      summary.refused += 1;
      // Named and counted. An attachment we could not read is a real gap in the
      // graph, and §5.3's plain refusal is only possible if we know it happened.
      log("warn", "attachment_refused", {
        filename: result.filename,
        error: String(result.error ?? "unknown").slice(0, 200),
        ...(result.timedOut ? { timed_out: true } : {}),
      });
      continue;
    }

    if (!result.text) {
      summary.empty += 1;
      log("info", "attachment_empty", {
        filename: result.filename,
        reason: result.empty_reason ?? "no text",
      });
      continue;
    }

    const { evidence, duplicate } = graph.evidence.record({
      kind: "attachment",
      contentHash: result.contentHash,
      // Verbatim, including the [[page N]] markers. They live in the same string
      // the span verifier checks against, so a quote naming a page can ground.
      text: result.text,
      meta: {
        filename: result.filename,
        mimeType: result.mime_type ?? attachment.mimeType ?? null,
        bytes: result.bytes ?? null,
        structure: result.structure ?? {},
        truncated: Boolean(result.truncated),
        // The covering message. §4's `EMAIL --has_attachment--> DOCUMENT`, and
        // what lets a profile show which mail a document arrived on.
        messageEvidenceId,
        // Deterministic owner from the covering message's From header. This is
        // what makes résumé facts and the full document appear on the sender's
        // manager profile instead of an orphan name-derived subject.
        subjectHint,
        sentAt,
      },
      receivedAt,
    });

    summary.extracted += 1;
    const evidenceId = evidence.id ?? `attachment:${result.contentHash}`;
    if (!duplicate) {
      // NO SEPARATE INFERENCE JOB. The covering message's job now carries this
      // attachment as an additional SOURCE block — the model reads the whole
      // letter — so a second job here would pay for the same comprehension
      // twice. The evidence row stays: dedupe, TRACE and the span verifier all
      // key on it, and claims quoting this document cite ITS id.
      summary.enqueued += 0;
    } else {
      // THE SAME DOCUMENT, A LATER COVERING MESSAGE. Evidence meta kept only
      // the FIRST messageEvidenceId, so every later email carrying this file
      // showed NO attachment in the manager's thread view — 'manager is not
      // showing attachments' was this line missing. Linkage is appended, never
      // replaced: the original covering message stays first, and the thread
      // view can now find the document from ANY email that carried it.
      const held = graph.evidence.get(evidenceId);
      if (held && messageEvidenceId) {
        const covering = new Set([
          held.meta?.messageEvidenceId,
          ...(held.meta?.coveringMessages ?? []),
          messageEvidenceId,
        ].filter(Boolean));
        graph.evidence.updateMeta(evidenceId, {
          coveringMessages: [...covering],
        });
      }
      if (!subjectHint) continue;
      // And a NEW sender's copy must teach the graph about THEM — see
      // reassignOwner for the bug and why the re-run costs no new inference.
      const reopened = graph.jobs.reassignOwner(evidenceId, subjectHint, now());
      if (reopened) {
        summary.enqueued += 1;
        log("info", "document_reowned", {
          evidence: evidenceId.slice(0, 24), owner: subjectHint,
        });
      }
    }
  }

  return summary;
}
