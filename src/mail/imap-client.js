/**
 * The IMAP client the listener drives — cursor-based, long-lived, quiet.
 *
 * WHY A SECOND IMAP FILE RATHER THAN EDITING THE FIRST
 *
 * `imap-smtp.js` implements the OLD transport contract — `fetchUnseen` /
 * `markSeen` / `send` — and the funnel still uses it. Retrofitting a different
 * cursor model into it would change behaviour under code that is working, for a
 * product slice that no longer exists. This file implements the three methods
 * `createMailSource` wants (`status`, `fetchSince`, `idle`) and nothing else.
 *
 * ONE CONNECTION, HELD OPEN
 *
 * The old poller connected, fetched, and logged out every 30 seconds. Over eight
 * days that is roughly 23,000 connections from one IP, and Mail-in-a-Box's
 * fail2ban eventually rejected us with ECONNREFUSED — which then looked like an
 * outage for two days. A held connection with IDLE is fewer moving parts, lower
 * latency, and does not resemble an attack.
 *
 * The connection is lazy and self-healing: if it drops, the next call rebuilds
 * it. A listener that needs a supervisor to survive a network blip is not a
 * listener.
 */

import { MailSourceError } from "./source.js";

export function createImapClient({ imap, mailbox = "INBOX", deps = {}, log = () => {} }) {
  if (!imap?.host) throw new MailSourceError("BAD_CONFIG", "IMAP needs a host");

  let client = null;
  let connecting = null;

  async function connect() {
    if (client?.usable) return client;
    // Collapse concurrent callers onto one connect. Two drains racing on a
    // fresh process would otherwise open two connections and double our
    // footprint on a server that already banned us once for looking busy.
    if (connecting) return connecting;

    connecting = (async () => {
      const { ImapFlow } = deps.ImapFlow ? { ImapFlow: deps.ImapFlow } : await import("imapflow");
      const next = new ImapFlow({
        ...imap,
        logger: false,
        // Long-lived by intent. imapflow's own keepalive handles the NOOP
        // cadence; we only re-issue IDLE.
        emitLogs: false,
      });
      next.on("error", (error) => {
        // Never throw from the event handler — an unhandled 'error' on a socket
        // takes the whole daemon down, and mail is only one of its jobs.
        log("warn", "imap_error", { error: String(error?.message ?? error) });
      });
      await next.connect();
      client = next;
      connecting = null;
      log("info", "imap_connected", { host: imap.host, mailbox });
      return client;
    })().catch((error) => {
      connecting = null;
      throw new MailSourceError("IMAP_CONNECT_FAILED",
        `Cannot reach IMAP at ${imap.host}:${imap.port ?? 993}: ${error.message}`,
        { cause: String(error?.message ?? error) });
    });

    return connecting;
  }

  async function withLock(run) {
    const c = await connect();
    let lock;
    try {
      lock = await c.getMailboxLock(mailbox);
      return await run(c);
    } finally {
      // Release before anything else, and on the throwing path too. A leaked
      // exclusive lock wedges every later fetch while the process still looks
      // perfectly healthy — the worst kind of failure to diagnose.
      lock?.release();
    }
  }

  return {
    /**
     * UIDVALIDITY and the highest UID present.
     *
     * UIDVALIDITY is the reason this method exists separately from the fetch: a
     * UID compared across a change of it points at a different message, and that
     * failure presents as an empty mailbox rather than an error.
     */
    async status() {
      return withLock(async (c) => {
        const box = c.mailbox;
        return {
          uidValidity: Number(box?.uidValidity),
          uidNext: Number(box?.uidNext),
          exists: Number(box?.exists ?? 0),
        };
      });
    },

    /**
     * Everything with a UID above the cursor.
     *
     * Fetches the raw source and lets the caller parse it. Servers disagree
     * about BODYSTRUCTURE often enough that parsing the source is the cheaper
     * correctness — and the graph wants the exact bytes anyway, because the span
     * verifier checks quotes against them.
     */
    async fetchSince({ sinceUid = 0, limit = 50 } = {}) {
      return withLock(async (c) => {
        const rows = [];
        // `${uid+1}:*` is the UID range every server understands. A search would
        // work too and costs a round trip we do not need.
        const range = `${Number(sinceUid) + 1}:*`;
        for await (const row of c.fetch({ uid: range }, { uid: true, source: true }, { uid: true })) {
          // The range's open end returns the last message even when nothing is
          // newer, so filter rather than trust it.
          if (Number(row.uid) <= Number(sinceUid)) continue;
          rows.push({ uid: Number(row.uid), raw: row.source });
          if (rows.length >= limit) break;
        }
        return rows.sort((a, b) => a.uid - b.uid);
      });
    },

    /**
     * Wait for the server to announce new mail.
     *
     * Resolves true on arrival, false on timeout. Both are normal, and the
     * caller fetches either way — so a server without IDLE degrades to a slow
     * poll instead of to silence.
     *
     * The default window is well under RFC 2177's 29-minute advice, because a
     * NAT or firewall between us and the server will drop a longer idle
     * connection without telling either end, and a listener that has gone deaf
     * looks exactly like a quiet mailbox.
     */
    async idle({ timeoutMs = 20 * 60_000, signal } = {}) {
      const c = await connect();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          c.off("exists", onExists);
          resolve(value);
        };
        const onExists = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);

        c.on("exists", onExists);
        signal?.addEventListener("abort", () => finish(false), { once: true });

        // imapflow enters IDLE by itself when nothing else is in flight; this
        // just makes it explicit and surfaces a refusal as a resolved false
        // rather than an unhandled rejection.
        c.idle().catch((error) => {
          log("warn", "imap_idle_ended", { error: String(error?.message ?? error) });
          finish(false);
        });
      });
    },

    async close() {
      if (!client) return;
      await client.logout().catch(() => {});
      client = null;
    },
  };
}
