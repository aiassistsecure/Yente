/**
 * The sensor, built from the environment.
 *
 * Extracted for the same reason as the loops: the merged process and the
 * graph-only entry point must not each carry their own copy of the IMAP wiring.
 * A mailbox configured slightly differently in two places is the kind of
 * difference you discover from a two-day silence rather than from an error.
 *
 * NOT CONFIGURED IS NOT AN ERROR. Returning `{ source: null }` is a supported
 * state: the intelligence and matching loops still have work to do over whatever
 * is already in the graph, so a box with no mail credentials can still drain a
 * backlog. Refusing to start would make a partial outage total.
 */

import { createImapClient } from "./imap-client.js";
import { createMailSource } from "./source.js";

/**
 * The transport config, in the shape `createMailTransport` actually takes.
 *
 * Lives here because I wrote it out by hand in a second entry point and got it
 * wrong — a flat `{host, port, user, pass}` where the transport wants
 * `{imap, smtp, from}`. One definition, one shape.
 *
 * `secure: false` on 587 means "upgrade via STARTTLS", not plaintext.
 */
export function mailConfigFromEnv(env = process.env) {
  const host = env.YENTE_MAIL_HOST;
  const user = env.YENTE_MAIL_USER;
  const pass = env.YENTE_MAIL_PASS;
  return {
    imap: { host, port: Number(env.YENTE_IMAP_PORT || 993), secure: true, auth: { user, pass } },
    smtp: {
      host, port: Number(env.YENTE_SMTP_PORT || 587),
      secure: false, requireTLS: true, auth: { user, pass },
    },
    from: env.YENTE_FROM || `Yente <${user}>`,
    mailbox: env.YENTE_MAILBOX || "INBOX",
  };
}

/**
 * @param {object}   deps
 * @param {object}   deps.graph  graph repositories (for the durable cursor)
 * @param {Function} [deps.log]
 * @param {object}   [deps.env]
 */
export function createMailFromEnv({ graph, log = () => {}, env = process.env }) {
  const mailbox = env.YENTE_MAILBOX || "INBOX";
  const configured = Boolean(env.YENTE_MAIL_HOST && env.YENTE_MAIL_USER);

  if (!configured) {
    log("warn", "mail_not_configured", {
      note: "YENTE_MAIL_HOST/USER unset — the intelligence and matching loops still "
        + "run over whatever is already in the graph, so a backlog can be worked "
        + "without a mailbox.",
    });
    return { source: null, imap: null, mailbox, configured: false };
  }

  const imap = createImapClient({
    imap: {
      host: env.YENTE_MAIL_HOST,
      port: Number(env.YENTE_IMAP_PORT || 993),
      secure: true,
      auth: { user: env.YENTE_MAIL_USER, pass: env.YENTE_MAIL_PASS },
    },
    mailbox,
    log,
  });

  const source = createMailSource({
    client: imap,
    cursors: graph.cursors,
    mailbox,
    // postal-mime: zero dependencies, actively maintained, and mailparser's own
    // README now points at it. Imported lazily so a box without it can still run
    // the other two loops.
    parse: async (raw) => {
      const { default: PostalMime } = await import("postal-mime");
      const parsed = await PostalMime.parse(raw);
      return {
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: Array.isArray(parsed.references) ? parsed.references : undefined,
        from: parsed.from?.address ?? null,
        to: (parsed.to ?? []).map((a) => a.address),
        cc: (parsed.cc ?? []).map((a) => a.address),
        subject: parsed.subject,
        text: parsed.text ?? parsed.html ?? "",
        date: parsed.date,
        attachments: parsed.attachments ?? [],
      };
    },
    log,
  });

  return { source, imap, mailbox, configured: true };
}
