import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CapacityFullError,
  InvalidSubscriptionError,
  openWaitlistRepository,
} from "../src/waitlist/repository.js";
import { subscribersToCsv } from "../src/waitlist/csv.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(HERE, "public");
const JSON_LIMIT_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
});

const STATIC_ROUTES = Object.freeze({
  "/": "index.html",
  "/index.html": "index.html",
  "/join": "join.html",
  "/join.html": "join.html",
  "/how-it-works": "how-it-works.html",
  "/how-it-works.html": "how-it-works.html",
  "/privacy": "privacy.html",
  "/privacy.html": "privacy.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/favicon.svg": "favicon.svg",
  "/admin": "admin/index.html",
  "/admin/": "admin/index.html",
  "/admin/admin.css": "admin/admin.css",
  "/admin/admin.js": "admin/admin.js",
});

function securityHeaders(contentType = null) {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'self' mailto:",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    ...securityHeaders(contentType),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function equalSecret(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

function parseBasicAuth(header) {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function requireAdmin(request, response, credentials) {
  if (!credentials.username || !credentials.password) {
    sendJson(response, 503, {
      error: "ADMIN_NOT_CONFIGURED",
      message: "Admin access is disabled until credentials are configured.",
    });
    return false;
  }

  const presented = parseBasicAuth(request.headers.authorization);
  const accepted =
    presented &&
    equalSecret(presented.username, credentials.username) &&
    equalSecret(presented.password, credentials.password);

  if (!accepted) {
    sendJson(
      response,
      401,
      { error: "AUTHENTICATION_REQUIRED", message: "Admin credentials required." },
      { "WWW-Authenticate": 'Basic realm="Yente Admin", charset="UTF-8"' },
    );
    return false;
  }

  return true;
}

function requestAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers["x-forwarded-for"] ?? "")
      .split(",", 1)[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function makeRateLimiter(clock = () => Date.now()) {
  const buckets = new Map();
  return (key) => {
    const now = clock();
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= RATE_MAX;
  };
}

function serveStatic(response, publicDir, route) {
  const relativePath = STATIC_ROUTES[route];
  if (!relativePath) return false;
  const absolutePath = join(publicDir, relativePath);
  const stat = statSync(absolutePath);
  const contentType = MIME_TYPES[extname(absolutePath)] ?? "application/octet-stream";
  response.writeHead(200, {
    ...securityHeaders(contentType),
    "Cache-Control": relativePath.endsWith(".html")
      ? "no-cache"
      : "public, max-age=300",
    "Content-Length": stat.size,
  });
  createReadStream(absolutePath).pipe(response);
  return true;
}

export function createYenteServer({
  repository,
  publicDir = DEFAULT_PUBLIC_DIR,
  adminUsername = "",
  adminPassword = "",
  trustProxy = false,
  clock,
} = {}) {
  if (!repository) throw new TypeError("A waitlist repository is required");
  const allowRequest = makeRateLimiter(clock);
  const credentials = { username: adminUsername, password: adminPassword };

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        const health = repository.health();
        return sendJson(response, health.ok ? 200 : 503, {
          ok: health.ok,
          storage: "nedb-v2-dag-embedded",
          sequence: health.sequence,
          scanReady: health.scan.scan_complete,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/founding-network/capacity") {
        return sendJson(response, 200, repository.capacity());
      }

      if (request.method === "POST" && url.pathname === "/api/founding-network/subscribers") {
        const address = requestAddress(request, trustProxy);
        if (!allowRequest(address)) {
          return sendJson(
            response,
            429,
            { error: "RATE_LIMITED", message: "Please wait a minute and try again." },
            { "Retry-After": "60" },
          );
        }

        const input = await readJson(request);
        if (String(input.companyWebsite ?? "").trim()) {
          return sendJson(response, 202, {
            accepted: true,
            message: "Your request was received.",
          });
        }

        const result = repository.subscribe(input);
        return sendJson(response, result.created ? 201 : 200, {
          accepted: true,
          created: result.created,
          message: result.created
            ? "You joined Yente’s Founding Network."
            : "Your Yente subscription was updated.",
          capacity: result.capacity,
        });
      }

      const isAdmin = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
      const isAdminApi = url.pathname.startsWith("/api/admin/");
      if ((isAdmin || isAdminApi) && !requireAdmin(request, response, credentials)) {
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/subscribers") {
        const cohort = url.searchParams.get("cohort") || null;
        const status = url.searchParams.get("status") || null;
        const search = url.searchParams.get("search") || "";
        const offset = url.searchParams.get("offset") || 0;
        const limit = url.searchParams.get("limit") || 100;
        return sendJson(response, 200, {
          ...repository.list({ cohort, status, search, offset, limit }),
          capacity: repository.capacity(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/subscribers.csv") {
        const csv = subscribersToCsv(repository.exportAll());
        const date = new Date().toISOString().slice(0, 10);
        response.writeHead(200, {
          ...securityHeaders("text/csv; charset=utf-8"),
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="yente-subscribers-${date}.csv"`,
        });
        return response.end(csv);
      }

      if (request.method === "GET" && serveStatic(response, publicDir, url.pathname)) {
        return;
      }

      if (!["GET", "POST"].includes(request.method ?? "")) {
        return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }, { Allow: "GET, POST" });
      }

      return sendText(response, 404, "Not found");
    } catch (error) {
      if (error instanceof InvalidSubscriptionError) {
        return sendJson(response, 400, {
          error: error.code,
          field: error.field,
          message: error.message,
        });
      }
      if (error instanceof CapacityFullError) {
        return sendJson(response, 409, {
          error: error.code,
          cohort: error.cohort,
          message: error.message,
        });
      }
      if (error?.status) {
        return sendJson(response, error.status, {
          error: "BAD_REQUEST",
          message: error.message,
        });
      }

      console.error("Yente web request failed", error);
      return sendJson(response, 500, {
        error: "INTERNAL_ERROR",
        message: "Yente could not complete that request.",
      });
    }
  });
}

export function startFromEnvironment(environment = process.env) {
  const dataPath = environment.YENTE_WAITLIST_DATA_PATH;
  if (!dataPath) {
    throw new Error(
      "YENTE_WAITLIST_DATA_PATH must point to the waitlist’s dedicated local NEDB directory",
    );
  }

  const repository = openWaitlistRepository({ dataPath });
  const host = environment.YENTE_HOST || "127.0.0.1";
  const port = Number.parseInt(environment.YENTE_PORT || "3000", 10);
  const server = createYenteServer({
    repository,
    adminUsername: environment.YENTE_ADMIN_USERNAME,
    adminPassword: environment.YENTE_ADMIN_PASSWORD,
    trustProxy: environment.YENTE_TRUST_PROXY === "1",
  });

  server.listen(port, host, () => {
    console.log(`Yente web listening on http://${host}:${port}`);
    console.log(`Yente NEDB sequence ${repository.health().sequence}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment();
}
