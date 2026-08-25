/**
 * EmailSource — the sensor.
 *
 * WHAT CHANGED FROM THE OLD ADAPTER, AND WHY
 *
 * `imap-smtp.js` fetched `{ seen: false }` and set `\Seen` once the runtime had
 * recorded the message. That was careful about the right thing — it marked AFTER
 * the durable write, so a crash mid-ingest could not lose mail — and wrong about
 * the cursor itself, for two reasons that only show up in production:
 *
 *   1. The flag is the HUMAN's. Read your own mail in Roundcube and those
 *      messages are `\Seen`; Yente never sees them again. A listener whose
 *      progress marker is a UI affordance loses a race with its own operator.
 *   2. A flag cannot express "what changed". `message.updated` and
 *      `thread.updated` are events the graph wants, and `\Seen` has no room for
 *      them.
 *
 * So the cursor is ours: `(mailbox, UIDVALIDITY, lastUid)`, stored in our own
 * database, invisible to anyone using the mailbox normally.
 *
 * UIDVALIDITY IS NOT OPTIONAL
 *
 * A UID is meaningless without the UIDVALIDITY it was issued under. If the
 * server changes it, every stored UID now points at a different message — or
 * nothing. Comparing across that boundary is the single most dangerous mistake
 * available here, because it fails silently and looks like an empty mailbox. So
 * we store both, and a mismatch triggers a full resync that says so out loud.
 *
 * AND WE STOPPED POLLING EVERY 30 SECONDS
 *
 * The old daemon opened a connection every 30s. Over eight days that is ~23,000
 * connections, and Mail-in-a-Box's fail2ban eventually did what any reasonable
 * server would: it started rejecting us with ECONNREFUSED. IDLE is one long-held
 * connection the server notifies — lower latency AND it stops us looking like a
 * brute-forcer. `waitForMail` exposes it; the fetch path stays correct on its
 * own so a server without IDLE just polls slowly instead of breaking.
 *
 * A MESSAGE WITHOUT A Message-ID IS STILL EVIDENCE
 *
 * The old adapter dropped those entirely to protect its dedupe key. Discarding
 * mail to protect a hash is the wrong trade — the content hash is a perfectly
 * good identity, and §3 says the original is canonical evidence. So we fall back
 * to hashing the raw source and keep the message.
 */

import { createHash } from "node:crypto";

export class MailSourceError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "MailSourceError";
    this.code = code;
    this.meta = meta;
  }
}

/** Content identity for a message that gave us no usable Message-ID. */
export function contentHashOf(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
  return createHash("blake2b512").update(bytes).digest("hex").slice(0, 64);
}

/**
 * Normalize one fetched message into the shape the graph ingests.
 *
 * Deterministic work only: MIME parsing, addresses, dates, hashes. §16 draws
 * this line and it is worth honouring literally — a parser answers these
 * exactly, and asking a model to do it would be slower, costlier and wrong more
 * often.
 */
export function normalizeMessage({ uid, raw, parsed, receivedAt }) {
  const contentHash = contentHashOf(raw);
  const rfcMessageId = (parsed?.messageId ?? "").trim().replace(/^<|>$/g, "") || null;

  return {
    uid: Number(uid),
    // Identity, in preference order. The Message-ID is the message when it
    // exists; the content hash is a correct fallback rather than a reason to
    // throw the message away.
    identity: rfcMessageId ?? contentHash,
    identityKind: rfcMessageId ? "message_id" : "content_hash",
    rfcMessageId,
    contentHash,
    // Threading from the headers, not from subject-line guessing. The graph
    // needs conversations reconstructed, and References is the only reliable
    // account of what replied to what.
    threadId: parsed?.inReplyTo ?? parsed?.references?.[0] ?? rfcMessageId ?? contentHash,
    from: parsed?.from ?? null,
    to: parsed?.to ?? [],
    cc: parsed?.cc ?? [],
    subject: parsed?.subject ?? null,
    text: parsed?.text ?? "",
    attachments: parsed?.attachments ?? [],
    // THE MESSAGE'S OWN DATE, falling back to arrival. §8 needs this: "we closed
    // last month" is only resolvable against when it was said, and a model never
    // sees a Date header.
    sentAt: parsed?.date ? new Date(parsed.date).toISOString() : null,
    receivedAt,
  };
}

/**
 * Build a source over an injected IMAP client.
 *
 * The client is injected rather than constructed so the cursor logic — which is
 * where the real subtlety lives — can be tested against a fake without a server.
 * The seam is the same one that let the runtime be proven against an in-memory
 * transport while the adapter was proven against a real mailbox, and neither
 * borrowed credibility from the other.
 *
 * @param {object} input
 * @param {object} input.client    connect/status/fetchSince/idle/close
 * @param {object} input.cursors   MailCursorRepository
 * @param {string} input.mailbox
 * @param {Function} [input.parse] raw -> parsed MIME
 * @param {Function} [input.log]
 */
export function createMailSource({
  client,
  cursors,
  mailbox = "INBOX",
  parse,
  now = () => new Date().toISOString(),
  log = () => {},
  batchSize = 50,
}) {
  if (!client) throw new TypeError("createMailSource requires an IMAP client");
  if (!cursors) throw new TypeError("createMailSource requires a cursor repository");

  /**
   * Fetch everything newer than the cursor.
   *
   * Returns `{ messages, uidValidity, resynced }`. It does NOT advance the
   * cursor — the caller does that AFTER the messages are durably recorded. That
   * ordering is the only thing standing between a crash and permanently skipped
   * mail, and it is why this function refuses to be convenient about it.
   */
  async function fetchNew() {
    const status = await client.status(mailbox);
    const uidValidity = Number(status.uidValidity);
    if (!Number.isFinite(uidValidity)) {
      throw new MailSourceError("NO_UIDVALIDITY",
        `Mailbox ${mailbox} reported no UIDVALIDITY; a UID cursor would be meaningless`);
    }

    const held = cursors.read(mailbox);
    const sameEpoch = held && Number(held.uidValidity) === uidValidity;
    const resynced = Boolean(held) && !sameEpoch;

    if (resynced) {
      // Loud, because the alternative is a silent full re-read that looks like a
      // mail flood, or worse, a silent SKIP that looks like an empty mailbox.
      log("warn", "mail_uidvalidity_changed", {
        mailbox,
        was: held.uidValidity,
        now: uidValidity,
        note: "every stored UID is void; resyncing from the start of the mailbox. "
          + "Ingestion is idempotent by content hash, so this re-reads without duplicating.",
      });
    }

    const sinceUid = sameEpoch ? Number(held.lastUid) : 0;
    const rows = await client.fetchSince({ mailbox, sinceUid, limit: batchSize });

    const messages = [];
    for (const row of rows) {
      // A single unparseable message must not stop the batch. One malformed
      // MIME body is not a reason to stop hearing the mailbox (§22).
      try {
        const parsed = parse ? await parse(row.raw) : row.parsed;
        messages.push(normalizeMessage({
          uid: row.uid, raw: row.raw, parsed, receivedAt: now(),
        }));
      } catch (error) {
        log("warn", "mail_parse_failed", {
          uid: row.uid, error: String(error?.message ?? error),
        });
      }
    }

    return { messages, uidValidity, resynced, sinceUid };
  }

  /**
   * Commit progress. Separate from `fetchNew` on purpose — see above.
   */
  function commit({ uidValidity, lastUid }) {
    if (!Number.isFinite(Number(lastUid))) return null;
    return cursors.advance({ mailbox, uidValidity, lastUid, at: now() });
  }

  /**
   * Wait for the server to say something arrived.
   *
   * Re-issued well inside 29 minutes because RFC 2177 advises exactly that, and
   * because a NAT or firewall between us and the server will drop a 30-minute
   * idle connection without telling either end. A client that trusts IDLE
   * forever goes deaf silently, which is the worst way for a listener to fail.
   *
   * Returns true if mail arrived, false on timeout — either way the caller
   * fetches, so a server that does not support IDLE degrades to a slow poll
   * rather than to nothing.
   */
  async function waitForMail({ timeoutMs = 20 * 60_000, signal } = {}) {
    if (typeof client.idle !== "function") return false;
    try {
      return await client.idle({ mailbox, timeoutMs, signal });
    } catch (error) {
      log("warn", "mail_idle_failed", {
        error: String(error?.message ?? error),
        note: "falling back to interval polling for this cycle",
      });
      return false;
    }
  }

  return Object.freeze({ fetchNew, commit, waitForMail, mailbox });
}
