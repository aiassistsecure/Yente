/**
 * The real mailbox — step 8 of SPEC v2 §15.
 *
 * Implements the same three methods as the in-memory transport, so the runtime
 * cannot tell them apart. That separation is the point: D8 proves the runtime
 * against memory, and this file is proven against a real server, and neither
 * borrows credibility from the other.
 *
 * IMAP via `imapflow`, SMTP via `nodemailer` — both from the same author as the
 * protocol implementations they wrap, both pure JavaScript.
 *
 * FOUR THINGS THIS GETS RIGHT THAT A NAIVE POLLER DOES NOT:
 *
 * 1. `\Seen` is set only AFTER the runtime has durably recorded the message.
 *    Marking on read means a crash mid-ingest loses the email permanently, and
 *    INV-2's "every inbound message is deduplicated and recorded" then depends
 *    on a process not dying. The runtime calls markSeen; this does not do it
 *    for itself.
 *
 * 2. Dedupe is by RFC Message-ID, never by UID. A UID is per-mailbox and resets
 *    on UIDVALIDITY change; the Message-ID is the message. §12.1 already keys on
 *    it, so the two agree.
 *
 * 3. The connection lock is released in a `finally`. imapflow's mailbox lock is
 *    exclusive, and a lock leaked by an exception wedges every later poll —
 *    the process looks alive and silently stops reading mail.
 *
 * 4. A permanent SMTP failure is distinguished from a transient one by the
 *    5xx/4xx class, and handed to the outbox as `permanent` so it goes DEAD
 *    without burning retries. Retrying a hard bounce is how a sending domain
 *    earns a reputation it cannot spend.
 */

import { TransportError } from "./transport.js";

/**
 * @param {object} config
 * @param {object} config.imap  { host, port, secure, auth: { user, pass } }
 * @param {object} config.smtp  { host, port, secure, auth: { user, pass } }
 * @param {string} config.from  the envelope and header From
 * @param {string} [config.mailbox]
 * @param {object} [deps]       injectable for tests
 */
export function createMailTransport(config, deps = {}) {
  const { imap, smtp, from, mailbox = "INBOX" } = config;
  if (!from) throw new TransportError("BAD_CONFIG", "A mail transport requires a From address");

  const ImapFlowCtor = deps.ImapFlow;
  const createSmtp = deps.createTransport;

  async function withMailbox(run) {
    const { ImapFlow } = ImapFlowCtor ? { ImapFlow: ImapFlowCtor } : await import("imapflow");
    const client = new ImapFlow({ ...imap, logger: false });
    await client.connect();
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
      return await run(client);
    } finally {
      // Order matters. Release the lock before logout, and do both even when
      // the body threw — a leaked exclusive lock wedges every later poll while
      // the process still looks healthy.
      lock?.release();
      await client.logout().catch(() => {});
    }
  }

  let smtpTransport = null;
  async function mailer() {
    if (smtpTransport) return smtpTransport;
    const nodemailer = createSmtp ? { createTransport: createSmtp } : await import("nodemailer");
    smtpTransport = nodemailer.createTransport({ ...smtp, pool: true, maxConnections: 1 });
    return smtpTransport;
  }

  return {
    kind: "imap-smtp",

    /**
     * Unseen messages, fully parsed.
     *
     * Fetches the whole source and lets imapflow's parser produce the envelope
     * and attachments, rather than trusting BODYSTRUCTURE. Servers disagree
     * about structure often enough that parsing the source is the cheaper
     * correctness.
     */
    async fetchUnseen({ limit = 25 } = {}) {
      return withMailbox(async (client) => {
        const messages = [];
        for await (const row of client.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
          const parsed = await parseSource(row.source, deps);
          messages.push({
            uid: row.uid,
            rfcMessageId: parsed.messageId ?? row.envelope?.messageId ?? null,
            threadId: parsed.inReplyTo ?? parsed.references?.[0] ?? parsed.messageId ?? null,
            from: parsed.from ?? row.envelope?.from?.[0]?.address ?? null,
            to: parsed.to ?? [],
            cc: parsed.cc ?? [],
            subject: parsed.subject ?? row.envelope?.subject ?? null,
            text: parsed.text ?? "",
            attachments: parsed.attachments ?? [],
          });
          if (messages.length >= limit) break;
        }
        // A message with no Message-ID cannot be deduplicated (§12.1), and
        // ingesting it would mean an inbound that reprocesses on every poll.
        return messages.filter((message) => {
          if (message.rfcMessageId) return true;
          return false;
        });
      });
    },

    /** Called by the runtime AFTER the message is durably recorded. */
    async markSeen(uid) {
      return withMailbox(async (client) => {
        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
      });
    },

    async send({ to, subject, text, headers = {}, inReplyTo }) {
      if (!to || to.length === 0) {
        throw new TransportError("NO_RECIPIENT", "An outbound message requires at least one recipient");
      }
      const transport = await mailer();
      try {
        const info = await transport.sendMail({
          from,
          to: Array.isArray(to) ? to.join(", ") : to,
          subject,
          text,
          headers,
          ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
        });
        return { messageId: info.messageId };
      } catch (error) {
        throw new TransportError(
          smtpCode(error) ?? "SEND_FAILED",
          String(error?.message ?? error),
          { permanent: isPermanentSmtp(error) },
        );
      }
    },

    async close() {
      await smtpTransport?.close?.();
      smtpTransport = null;
    },
  };
}

/**
 * A 5xx is the recipient's final answer; a 4xx is "try later".
 *
 * Exported because the outbox needs the same judgement and two copies of this
 * rule would eventually disagree — at which point either a hard bounce gets
 * retried into a blocklist, or a transient failure is discarded as permanent.
 */
export function isPermanentSmtp(error) {
  const code = Number(error?.responseCode ?? error?.code);
  if (Number.isFinite(code)) return code >= 500 && code < 600;
  return /\b5\.\d\.\d\b|\b55\d\b/.test(String(error?.message ?? ""));
}

function smtpCode(error) {
  const code = error?.responseCode;
  return Number.isFinite(Number(code)) ? `SMTP_${code}` : null;
}

async function parseSource(source, deps) {
  if (deps.parseSource) return deps.parseSource(source);
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(source);
  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: [].concat(parsed.references ?? []),
    from: parsed.from?.value?.[0]?.address,
    to: (parsed.to?.value ?? []).map((entry) => entry.address),
    cc: (parsed.cc?.value ?? []).map((entry) => entry.address),
    subject: parsed.subject,
    text: parsed.text,
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.contentType,
      content: attachment.content,
    })),
  };
}
