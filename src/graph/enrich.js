/**
 * Turning a shared URL into evidence — netrows for LinkedIn, AiAS for the web.
 *
 * WHY TWO BACKENDS, AND WHY THE SPLIT LIVES IN links.js
 *
 * A LinkedIn profile has a STRUCTURED answer available from a data vendor:
 * netrows `people-profile` returns fields — name, title, company, dates —
 * that no model produced, so there is nothing to span-verify and nothing to
 * hallucinate. Everything else is a web page: AiAS `/v1/web/extract` returns
 * prose, which is exactly what an attachment produces, so it rejoins the
 * pipeline that already exists (model proposes, spans verified).
 *
 * classifyLink() decides which is which, and it also carries the SSRF guard:
 * the fetcher on the other end has an internal IP, and forwarding it
 * 169.254.169.254 on a stranger's say-so would make Yente the confused deputy.
 * Nothing here re-checks that; a link that reaches this module has already
 * been judged safe to fetch, and two copies of a security rule is one that
 * drifts.
 *
 * ENV-GATED, HONESTLY
 *
 * NETROWS_API_KEY and AIAS_API_KEY live on the box, not in this repo. When a
 * key is absent the enrichment REPORTS itself skipped — `{ skipped: reason }`
 * — rather than failing or pretending. A poller whose prerequisite is missing
 * must say so once, not error every tick.
 *
 * COST DISCIPLINE
 *
 * netrows is 1 credit per call. Evidence is content-addressed and the URL is
 * part of the content, so re-enriching the same profile URL is a cache hit at
 * the evidence layer before any credit is spent — checked here explicitly so
 * the guarantee does not depend on remembering how evidenceKey works.
 */

import { createHash } from "node:crypto";

/**
 * In-flight enrichments, keyed by evidence id.
 *
 * The idempotency check is check-then-fetch: three copies of one URL arriving
 * in a single ingest tick all passed `evidence.get()` before any had recorded,
 * and netrows was paid THREE TIMES for one profile — observed live,
 * `enriched claims=18` three times in two seconds. The graph survived
 * (observation keys dedupe) but the credits did not.
 *
 * Concurrent callers now share ONE promise per evidence id. Per-process is the
 * right scope: the race is same-tick, and cross-restart the evidence row
 * already exists so the ordinary check holds.
 */
const inFlight = new Map();

import { LINK_KINDS, classifyLink } from "../extract/links.js";
import { AUTHORITY } from "../store/graph.js";

const NETROWS_BASE = process.env.NETROWS_API_URL || "https://www.netrows.com/api/v1";
const AIAS_BASE = process.env.AIASSIST_BASE_URL || "https://api.aiassist.net";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Enrich one URL somebody sent, into graph evidence and observations.
 *
 * @param {object} input
 * @param {string} input.url        the link, verbatim as they sent it
 * @param {string} input.subject    the person it belongs to (graph subject id)
 * @param {object} input.graph      graph repositories
 * @param {object} [input.env]      injectable for tests
 * @param {typeof fetch} [input.fetchImpl]
 * @param {Function} [input.log]
 * @returns {Promise<{outcome: string, evidenceId?: string, claims?: number, skipped?: string}>}
 */
export async function enrichLink({
  url, subject, graph,
  env = process.env, fetchImpl = fetch, log = () => {},
  now = () => new Date().toISOString(),
}) {
  const link = classifyLink(url);

  if (link.kind === LINK_KINDS.REFUSED) {
    // The reason is quotable and the refusal is an outcome, not an error — a
    // stranger's bad link must never stop the loop reading everyone's mail.
    return { outcome: "refused", skipped: link.reason };
  }

  // IDEMPOTENT BEFORE ANY CREDIT IS SPENT. The evidence id is derived from the
  // normalised URL, so a re-sent link is a lookup, not a purchase.
  const kind = link.kind === LINK_KINDS.PERSON_PROFILE
    || link.kind === LINK_KINDS.COMPANY_PROFILE ? "vendor" : "link";
  const contentHash = sha256(`${kind}:${link.url}`);
  const existingId = `${kind}:${contentHash}`;
  if (graph.evidence.get(existingId)) {
    return { outcome: "already_enriched", evidenceId: existingId };
  }
  if (inFlight.has(existingId)) {
    // Somebody in this same tick is already paying for this URL. Share their
    // answer instead of buying a second copy.
    await inFlight.get(existingId).catch(() => {});
    return { outcome: "already_enriched", evidenceId: existingId };
  }

  const run = (async () => {
    if (kind === "vendor") {
      const key = env.NETROWS_API_KEY;
      if (!key) return { outcome: "skipped", skipped: "NETROWS_API_KEY is not set" };
      return enrichViaNetrows({ link, subject, graph, key, fetchImpl, log, now, contentHash });
    }
    const key = env.AIASSIST_API_KEY;
    if (!key) return { outcome: "skipped", skipped: "AIASSIST_API_KEY is not set" };
    return enrichViaWebExtract({ link, subject, graph, key, fetchImpl, log, now, contentHash });
  })();

  inFlight.set(existingId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(existingId);
  }
}

/* --- netrows: structured fields, DETERMINISTIC --------------------------- */

/**
 * The vendor's fields become typed observations directly. No model touched
 * them, so there is nothing to verify — DETERMINISTIC, the same authority as
 * a MIME header, and each one quotes the field it came from so TRACE still
 * answers "on the strength of what".
 */
export async function enrichViaNetrows({
  link, subject, graph, key, fetchImpl = fetch, log = () => {},
  now = () => new Date().toISOString(), contentHash,
}) {
  const endpoint = `${NETROWS_BASE}/people/profile?url=${encodeURIComponent(link.url)}`;
  let payload;
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      log("warn", "enrich_failed", { url: link.url, status: response.status, backend: "netrows" });
      return { outcome: "failed", skipped: `netrows HTTP ${response.status}` };
    }
    payload = await response.json();
  } catch (error) {
    log("warn", "enrich_failed", { url: link.url, error: String(error?.message ?? error), backend: "netrows" });
    return { outcome: "failed", skipped: String(error?.message ?? error) };
  }

  // Verbatim evidence first — the projection the claims cite must exist before
  // any claim does, or TRACE dead-ends.
  const { evidence } = graph.evidence.record({
    kind: "vendor",
    contentHash,
    text: JSON.stringify(payload, null, 2),
    meta: { url: link.url, slug: link.slug, backend: "netrows", subjectHint: subject },
    receivedAt: now(),
  });
  const evidenceId = `vendor:${contentHash}`;

  const at = now();
  let claims = 0;
  const append = (predicate, object, quote) => {
    if (!object) return;
    graph.observations.append({
      subject, predicate, object: String(object),
      evidenceId, quote: quote ?? `${predicate}: ${object}`,
      authority: AUTHORITY.DETERMINISTIC,
      confidence: 1,
      observedAt: at,
    });
    claims += 1;
  };

  // The vendor's shape, read defensively: fields the plan tier omits are
  // simply absent, and an absent field is not an error.
  const profile = payload?.data ?? payload ?? {};
  append("is_person", profile.fullName ?? profile.name);
  append("role", profile.headline ?? profile.title);
  append("geography", profile.location ?? profile.geo);
  append("profile_url", link.url);
  for (const position of [].concat(profile.positions ?? profile.experience ?? []).slice(0, 5)) {
    append("employer", position?.companyName ?? position?.company,
      position?.title ? `${position.title} at ${position.companyName ?? position.company}` : undefined);
  }
  for (const skill of [].concat(profile.skills ?? []).slice(0, 15)) {
    append("capability", typeof skill === "string" ? skill : skill?.name);
  }

  log("info", "enriched", { url: link.url, backend: "netrows", claims });
  return { outcome: "enriched", evidenceId, claims };
}

/* --- AiAS web extract: prose, into the existing model pipeline ----------- */

/**
 * A portfolio is an attachment that arrived over HTTP: the page text becomes
 * `link:` evidence and a normal intelligence job, so the model proposes facts
 * with verbatim quotes and the span verifier keeps only what holds. No new
 * trust path — MODEL_VERIFIED like any document.
 */
export async function enrichViaWebExtract({
  link, subject, graph, key, fetchImpl = fetch, log = () => {},
  now = () => new Date().toISOString(), contentHash,
}) {
  let payload;
  try {
    const response = await fetchImpl(`${AIAS_BASE}/v1/web/extract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: link.url, max_content_length: 15_000 }),
    });
    if (!response.ok) {
      log("warn", "enrich_failed", { url: link.url, status: response.status, backend: "web_extract" });
      return { outcome: "failed", skipped: `web extract HTTP ${response.status}` };
    }
    payload = await response.json();
  } catch (error) {
    log("warn", "enrich_failed", { url: link.url, error: String(error?.message ?? error), backend: "web_extract" });
    return { outcome: "failed", skipped: String(error?.message ?? error) };
  }

  if (!payload?.success || !payload?.content) {
    return {
      outcome: "failed",
      skipped: payload?.error_message ?? "extraction returned no content",
    };
  }

  const { evidence, duplicate } = graph.evidence.record({
    kind: "link",
    contentHash,
    text: String(payload.content),
    meta: {
      url: link.url,
      title: payload.title ?? null,
      fetchMethod: payload.fetch_method ?? null,   // how it was obtained is part of the evidence
      cached: payload.cached ?? null,
      backend: "web_extract",
      subjectHint: subject,
    },
    receivedAt: now(),
  });
  const evidenceId = `link:${contentHash}`;

  // A normal intelligence job: the model reads it like any document, and every
  // fact must quote a span. Enqueue is idempotent on the evidence id.
  graph.jobs.enqueue({ evidenceId, subjectHint: subject, at: now() });

  log("info", "enriched", {
    url: link.url, backend: "web_extract",
    chars: String(payload.content).length, queued: !duplicate,
  });
  return { outcome: "queued", evidenceId };
}
