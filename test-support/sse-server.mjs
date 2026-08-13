/**
 * A real HTTP server that speaks the OpenAI streaming wire format.
 *
 * The adapter's job is to survive what a server actually does — chunk
 * boundaries that fall mid-event, keep-alive comments, `[DONE]`, a stalled
 * socket. A stubbed `fetch` would test the stub's idea of those things, which
 * is the same idea the adapter already has. So: a real socket.
 */

import { createServer } from "node:http";

/**
 * @param {object} script
 * @param {string[]} [script.deltas]      content chunks to stream
 * @param {number}   [script.status]      HTTP status (non-200 skips streaming)
 * @param {string}   [script.body]        body for a non-200 response
 * @param {number}   [script.delayMs]     delay between chunks
 * @param {boolean}  [script.stallForever] accept the request and never write
 * @param {boolean}  [script.flushHeaders] send headers before stalling
 *   Two distinct stalls, and the difference is load-bearing: `writeHead` alone
 *   does not put bytes on the wire, so without this the client never even
 *   resolves its fetch. That is the harsher case and the one a naive deadline
 *   placed after `await fetch` fails to cover.
 * @param {boolean}  [script.omitDone]    end the stream without [DONE]
 * @param {boolean}  [script.keepAlive]   emit an SSE comment and a junk event
 * @param {boolean}  [script.splitEvents] flush each event in two writes
 * @param {string}   [script.finishReason]
 */
export async function startSseServer(script = {}) {
  const {
    deltas = [],
    status = 200,
    body = "",
    delayMs = 0,
    stallForever = false,
    flushHeaders = false,
    omitDone = false,
    keepAlive = false,
    splitEvents = false,
    finishReason = "stop",
  } = script;

  const requests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url,
      headers: req.headers,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });

    if (status !== 200) {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (stallForever) {
      if (flushHeaders) res.flushHeaders();
      return; // never a token
    }

    if (keepAlive) {
      res.write(": keep-alive\n\n");
      res.write("data: not json at all\n\n");
    }

    for (const [index, delta] of deltas.entries()) {
      const payload = JSON.stringify({
        choices: [
          {
            delta: { content: delta },
            finish_reason: index === deltas.length - 1 ? finishReason : null,
          },
        ],
      });
      const event = `data: ${payload}\n\n`;
      if (splitEvents) {
        const cut = Math.floor(event.length / 2);
        res.write(event.slice(0, cut));
        await pause(1);
        res.write(event.slice(cut));
      } else {
        res.write(event);
      }
      if (delayMs > 0) await pause(delayMs);
    }

    if (!omitDone) res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      // Drop live sockets FIRST. `server.close()` waits for open connections to
      // finish, and the stall scripts deliberately never finish — so closing in
      // the other order hangs the test run rather than the request under test.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
