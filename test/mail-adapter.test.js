/**
 * The IMAP/SMTP adapter — step 8.
 *
 * SMTP is tested against a REAL smtp-server: nodemailer actually speaks the
 * protocol, over a socket, and the assertions read the envelope the server
 * received. Mocking `sendMail` would test that I can write a mock.
 *
 * IMAP is tested with an injected client, because the alternative is standing
 * up a Dovecot. What is worth pinning there is not "imapflow works" — it is the
 * three ordering rules that a naive poller gets wrong, and those are ours.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SMTPServer } from "smtp-server";

import { createMailTransport, isPermanentSmtp } from "../src/mail/imap-smtp.js";
import { assertTransport } from "../src/mail/transport.js";

/* --- SMTP, against a real server --------------------------------------- */

async function withSmtp(run, { onData } = {}) {
  const received = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        received.push({ raw, envelope: session.envelope });
        if (onData) return onData(callback);
        callback();
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // smtp-server wraps a net.Server; the bound port lives on the inner one.
  const { port } = server.server.address();
  try {
    return await run({ port, received });
  } finally {
    await new Promise((resolve) => {
      const done = setTimeout(resolve, 2000);
      server.close(() => {
        clearTimeout(done);
        resolve();
      });
    });
  }
}

const transportFor = (port) =>
  createMailTransport({
    smtp: { host: "127.0.0.1", port, secure: false, tls: { rejectUnauthorized: false } },
    imap: { host: "127.0.0.1", port: 1, auth: { user: "x", pass: "y" } },
    from: "Yente <yente@ccme.network>",
  });

test("it satisfies the transport interface the runtime expects", () => {
  assert.doesNotThrow(() => assertTransport(transportFor(25)));
});

test("an email actually reaches an SMTP server, with its headers intact", async () => {
  await withSmtp(async ({ port, received }) => {
    const transport = transportFor(port);
    const { messageId } = await transport.send({
      to: ["dana@northwindlog.com"],
      subject: "Alice Chen copied me on a thread with you",
      text: "Hi Dana,\n\nThat is the only reason you are hearing from me.\n",
      headers: {
        "List-Unsubscribe": "<https://ccme.network/u/abc>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    await transport.close();

    assert.match(messageId, /^<.+@.+>$/, "a real RFC Message-ID comes back");
    assert.equal(received.length, 1);
    const { raw, envelope } = received[0];

    assert.equal(envelope.mailFrom.address, "yente@ccme.network");
    assert.deepEqual(envelope.rcptTo.map((r) => r.address), ["dana@northwindlog.com"]);

    // §5.4 makes these mandatory on the invitation class. They have to survive
    // the send, not merely exist on the job.
    assert.match(raw, /List-Unsubscribe: <https:\/\/ccme\.network\/u\/abc>/i);
    assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    assert.match(raw, /Subject: Alice Chen copied me on a thread with you/);
  });
});

test("a joint introduction is addressed to both members on one envelope", async () => {
  await withSmtp(async ({ port, received }) => {
    const transport = transportFor(port);
    await transport.send({
      to: ["bob@example.com", "alice@northwindlog.com"],
      subject: "Yente introduction — Bob x Alice",
      text: "Please reply-all.",
      messageId: "<yente-introduction-fixed@ccme.network>",
    });
    await transport.close();
    assert.deepEqual(
      received[0].envelope.rcptTo.map((r) => r.address).sort(),
      ["alice@northwindlog.com", "bob@example.com"],
    );
    assert.match(received[0].raw, /Message-ID: <yente-introduction-fixed@ccme\.network>/i);
  });
});

test("a hard bounce is reported as permanent so the outbox marks it DEAD", async () => {
  // Retrying a 5xx is how a sending domain earns a reputation it cannot spend.
  await withSmtp(
    async ({ port }) => {
      const transport = transportFor(port);
      await assert.rejects(
        transport.send({ to: ["nobody@example.com"], subject: "x", text: "y" }),
        (error) => {
          assert.equal(error.meta.permanent, true, "must not be retried");
          return true;
        },
      );
      await transport.close();
    },
    {
      onData: (callback) => {
        // smtp-server turns a bare Error into a 450. To make it emit a real
        // hard bounce the response code has to be set — otherwise this test
        // would assert "permanent" against a server that said "try later".
        const bounce = new Error("5.1.1 recipient address rejected: user unknown");
        bounce.responseCode = 550;
        callback(bounce);
      },
    },
  );
});

test("a transient failure is NOT permanent, so the backoff gets its chance", async () => {
  await withSmtp(
    async ({ port }) => {
      const transport = transportFor(port);
      await assert.rejects(
        transport.send({ to: ["busy@example.com"], subject: "x", text: "y" }),
        (error) => {
          assert.equal(error.meta.permanent, false);
          return true;
        },
      );
      await transport.close();
    },
    {
      onData: (callback) => {
        const busy = new Error("4.3.0 temporary local problem");
        busy.responseCode = 451;
        callback(busy);
      },
    },
  );
});

test("the 5xx/4xx judgement lives in one place", () => {
  // Two copies of this rule would eventually disagree, and then either a hard
  // bounce gets retried into a blocklist or a transient failure is discarded.
  assert.equal(isPermanentSmtp({ responseCode: 550 }), true);
  assert.equal(isPermanentSmtp({ responseCode: 421 }), false);
  assert.equal(isPermanentSmtp({ message: "550 5.1.1 user unknown" }), true);
  assert.equal(isPermanentSmtp({ message: "451 4.3.0 try later" }), false);
  assert.equal(isPermanentSmtp({ message: "socket hang up" }), false);
});

test("a send with no recipient is refused before a connection is opened", async () => {
  await assert.rejects(transportFor(1).send({ to: [], subject: "x", text: "y" }), (error) => {
    assert.equal(error.code, "NO_RECIPIENT");
    return true;
  });
});

/* --- IMAP, with an injected client -------------------------------------- */

function fakeImap({ messages = [], failInLoop = false } = {}) {
  const events = [];
  class FakeImapFlow {
    constructor() {
      this.flagged = [];
    }
    async connect() {
      events.push("connect");
    }
    async getMailboxLock() {
      events.push("lock");
      return { release: () => events.push("release") };
    }
    async *fetch() {
      for (const message of messages) {
        if (failInLoop) throw new Error("connection reset mid-fetch");
        yield message;
      }
    }
    async messageFlagsAdd(range, flags) {
      events.push(`flag:${range.uid}:${flags.join(",")}`);
    }
    async logout() {
      events.push("logout");
    }
  }
  return { FakeImapFlow, events };
}

const parsed = (over = {}) => ({
  messageId: "<bob.1@sender.test>",
  from: "bob@example.com",
  to: ["yente@ccme.network"],
  cc: [],
  subject: "Introduction",
  text: "Resume attached.",
  attachments: [{ filename: "cv.pdf", mimeType: "application/pdf", content: Buffer.from("x") }],
  ...over,
});

function imapTransport(deps, parseResult = parsed()) {
  const { FakeImapFlow, events } = deps;
  return {
    events,
    transport: createMailTransport(
      { imap: {}, smtp: {}, from: "yente@ccme.network" },
      { ImapFlow: FakeImapFlow, parseSource: () => parseResult },
    ),
  };
}

test("an inbound message is mapped into the shape the runtime ingests", async () => {
  const { transport } = imapTransport(fakeImap({ messages: [{ uid: 7, source: Buffer.from("raw") }] }));
  const [message] = await transport.fetchUnseen();

  assert.equal(message.uid, 7);
  assert.equal(message.rfcMessageId, "<bob.1@sender.test>");
  assert.equal(message.from, "bob@example.com");
  assert.equal(message.attachments[0].filename, "cv.pdf");
});

test("a message with no Message-ID is skipped, not ingested", async () => {
  // §12.1 dedupes on the Message-ID. Without one, the message would reprocess
  // on every single poll — an infinite loop that looks like enthusiasm.
  const { transport } = imapTransport(
    fakeImap({ messages: [{ uid: 8, source: Buffer.from("raw"), envelope: {} }] }),
    parsed({ messageId: null }),
  );
  assert.deepEqual(await transport.fetchUnseen(), []);
});

test("fetching never sets \\Seen — the runtime does that after recording", async () => {
  // Marking on read means a crash mid-ingest loses the email permanently, and
  // INV-2 then depends on the process not dying.
  const deps = fakeImap({ messages: [{ uid: 9, source: Buffer.from("raw") }] });
  const { transport, events } = imapTransport(deps);
  await transport.fetchUnseen();
  assert.ok(!events.some((e) => e.startsWith("flag:")), "fetch must not flag");

  await transport.markSeen(9);
  assert.ok(events.some((e) => e === "flag:9:\\Seen"), "markSeen must flag");
});

test("a send-only transport REFUSES to mark seen, rather than crashing", async () => {
  // The refusal was written and the name it tested was never bound, so this
  // path raised `ReferenceError: sendOnly is not defined` — a crash standing
  // exactly where a handled error was intended. A caller that catches
  // TransportError, as the desk does, would not have caught it.
  //
  // The distinction matters beyond tidiness: an SMTP-only transport that
  // claimed it could mark mail seen would be asserting ownership of a mailbox
  // the graph's MailSource actually owns, and two readers of one INBOX is the
  // bug that lost résumé attachments.
  const transport = createMailTransport({ smtp: {}, from: "yente@ccme.network" });

  await assert.rejects(
    transport.markSeen(1),
    (error) => {
      assert.equal(error.name, "TransportError", "must be the refusal, not a ReferenceError");
      assert.equal(error.code, "SEND_ONLY");
      return true;
    },
  );
});

test("the mailbox lock is released even when the fetch throws", async () => {
  // imapflow's lock is exclusive. One leaked by an exception wedges every later
  // poll while the process still looks perfectly healthy.
  const deps = fakeImap({ messages: [{ uid: 1, source: Buffer.from("x") }], failInLoop: true });
  const { transport, events } = imapTransport(deps);

  await assert.rejects(transport.fetchUnseen(), /connection reset mid-fetch/);
  assert.deepEqual(events, ["connect", "lock", "release", "logout"]);
});

test("a transport requires a From address", () => {
  assert.throws(() => createMailTransport({ imap: {}, smtp: {} }), (error) => {
    assert.equal(error.code, "BAD_CONFIG");
    return true;
  });
});
