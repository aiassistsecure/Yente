/**
 * The console's HTTP surface — SPEC v2 §17.1.
 *
 * GET and HEAD. Every other method is 405 before any handler runs, and there is
 * no route that accepts a body. Combined with the read-only view — which has no
 * write method to call even if a handler wanted one — the console is incapable
 * of changing anything, rather than merely declining to.
 *
 * Binds to loopback by default. An operator console is not a public surface,
 * and a default of 0.0.0.0 is how an internal tool ends up indexed.
 */

import { createServer } from "node:http";
import { renderConsole } from "./render.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * @param {ReturnType<import("./readonly.js").createConsoleView>} view
 * @param {object} [options]
 * @param {string} [options.version]
 */
export function createConsoleServer(view, { version } = {}) {
  return createServer((req, res) => {
    if (!READ_METHODS.has(req.method)) {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      res.end("The operator console is read-only (SPEC v2 §17.1)\n");
      return;
    }

    const path = new URL(req.url, "http://localhost").pathname;

    if (path === "/healthz") {
      const engine = view.engine();
      res.writeHead(engine.verified ? 200 : 503, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? "" : JSON.stringify({ verified: engine.verified, seq: engine.seq }));
      return;
    }

    if (path !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found\n");
      return;
    }

    const html = renderConsole(view, { version });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The console renders live state; a cached copy of an outbox is worse
      // than no console, because it is wrong without looking wrong.
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
      "referrer-policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? "" : html);
  });
}

/**
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startConsole(view, { port = 0, host = "127.0.0.1", version } = {}) {
  const server = createConsoleServer(view, { version });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
