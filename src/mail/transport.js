/**
 * The transport seam — step 8 of SPEC v2 §15, and what makes step 9 possible.
 *
 * Two implementations sit behind one interface: a real IMAP/SMTP adapter, and
 * an in-memory transport used by the D8 acceptance test.
 *
 * That is not a testing convenience dressed up as architecture. D8 asks whether
 * the RUNTIME is correct — whether a stranger's first email becomes exactly one
 * introduction with both sides' consent. Whether `imapflow` can hold a socket
 * open is a different question with a different failure mode, and answering
 * both in one test means a flaky mailbox can fail an invariant check and a
 * broken invariant can hide behind a green mailbox.
 *
 * So the seam is the honest boundary: the runtime is proven against the
 * in-memory transport, the adapter is proven against a real server, and neither
 * proof borrows credibility from the other.
 *
 * INTERFACE
 *   fetchUnseen()            -> Promise<InboundMessage[]>
 *   markSeen(uid)            -> Promise<void>
 *   send(message)            -> Promise<{ messageId }>
 *
 *   InboundMessage: { uid, rfcMessageId, threadId, from, to, cc, subject,
 *                     text, attachments: [{filename, mimeType, content}] }
 *   OutboundMessage: { to, subject, text, headers, inReplyTo }
 */

import { randomUUID } from "node:crypto";

export class TransportError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.meta = meta;
  }
}

/**
 * An in-memory mailbox.
 *
 * Deliberately faithful about the two things that bite: every send is assigned
 * a real RFC-shaped Message-ID, and `deliver` can be called twice with the same
 * Message-ID so redelivery — the case D1 cares about — is reachable.
 */
export function createMemoryTransport({ domain = "ccme.network", failSend = null } = {}) {
  const inbox = [];
  const sent = [];
  let uid = 0;

  return {
    kind: "memory",
    sent,

    /** Simulate an inbound arrival. */
    deliver(message) {
      uid += 1;
      inbox.push({
        uid,
        seen: false,
        rfcMessageId: message.rfcMessageId ?? `<${randomUUID()}@sender.test>`,
        threadId: message.threadId ?? null,
        cc: [],
        attachments: [],
        ...message,
      });
      return inbox.at(-1);
    },

    async fetchUnseen() {
      return inbox.filter((message) => !message.seen).map((message) => ({ ...message }));
    },

    async markSeen(targetUid) {
      const message = inbox.find((row) => row.uid === targetUid);
      if (!message) throw new TransportError("UNKNOWN_UID", `No message with uid ${targetUid}`);
      message.seen = true;
    },

    async send(message) {
      if (failSend) {
        const failure = failSend(message, sent.length);
        if (failure) throw new TransportError(failure.code ?? "SEND_FAILED", failure.message ?? "send failed", failure);
      }
      if (!message.to || message.to.length === 0) {
        throw new TransportError("NO_RECIPIENT", "An outbound message requires at least one recipient");
      }
      const messageId = message.messageId ?? `<${randomUUID()}@${domain}>`;
      sent.push({ ...message, messageId, sentAt: new Date().toISOString() });
      return { messageId };
    },
  };
}

/**
 * The shape a real adapter must satisfy. Checked at wiring time rather than
 * discovered at 3am when a poller calls a method the adapter never had.
 */
export function assertTransport(transport) {
  for (const method of ["fetchUnseen", "markSeen", "send"]) {
    if (typeof transport?.[method] !== "function") {
      throw new TransportError("BAD_TRANSPORT", `A transport must implement ${method}()`);
    }
  }
  return transport;
}
