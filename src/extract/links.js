/**
 * A URL somebody emailed us, turned into a source.
 *
 * WHY THIS IS A ROUTER AND NOT A FETCHER
 *
 * People send two different kinds of link during intake, and they want
 * different treatment:
 *
 *   linkedin.com/in/someone   → a DATA VENDOR has this as structured records
 *   anything else             → a web page, which is prose
 *
 * The first goes to netrows `people-profile`, which answers with fields: name,
 * title, company, dates, school. Those are facts we did not infer, so they
 * carry DETERMINISTIC authority and there is nothing to span-verify — you
 * cannot hallucinate a field you were handed. It costs one credit and does not
 * involve a model at all.
 *
 * The second goes to the AiAS extractor, which answers with text. Text is
 * exactly what an attachment produces, so it rejoins the pipeline that already
 * exists: model proposes typed facts with verbatim excerpts, the runtime checks
 * every excerpt against the stored source, MODEL_VERIFIED for what survives.
 *
 * That is the whole design. A portfolio site is not a special case; it is an
 * attachment that arrived over HTTP.
 *
 * WHY WE VALIDATE A URL WE ARE NOT GOING TO FETCH OURSELVES
 *
 * The gateway does the fetching, which means the gateway is the thing with an
 * IP address on a private network. Handing it `http://169.254.169.254/` or
 * `http://localhost:6379/` on the word of a stranger who emailed us makes Yente
 * the confused deputy — we would be the authenticated caller asking an internal
 * service to read its own metadata endpoint. The gateway may well refuse. We do
 * not get to rely on that: we are the ones who chose to forward it.
 *
 * So the guard lives here, before the credential is spent, and it is an
 * allow-list of schemes plus a deny-list of hosts rather than a pattern hunt
 * for "suspicious" URLs.
 *
 * EVERY OUTCOME IS DATA
 *
 * Same rule as documents.js, for the same reason: refused, unreachable, empty,
 * paywalled — all of them return a shape and none of them throw. One person
 * pasting a dead link must not stop the loop that is reading everyone else's
 * mail. The caller has nothing to catch, so there is nothing it can forget to
 * catch.
 */

/** How a link was resolved, which decides the authority of what comes back. */
export const LINK_KINDS = Object.freeze({
  /** A LinkedIn member profile — structured records from the vendor. */
  PERSON_PROFILE: "person_profile",
  /** A LinkedIn company page — also structured. */
  COMPANY_PROFILE: "company_profile",
  /** Anything else: fetch the page, read the prose. */
  WEB_PAGE: "web_page",
  /** We will not fetch this, and the reason is quotable back to the sender. */
  REFUSED: "refused",
});

/**
 * Hosts that must never be fetched on a stranger's say-so.
 *
 * Loopback and link-local are the cloud-metadata attack. The RFC1918 ranges are
 * the internal-service attack. `.local`/`.internal` cover split-horizon DNS,
 * where a name that resolves harmlessly out here resolves to something else
 * from inside the gateway's network — which is the whole trick.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,          // link-local: AWS/GCP/Azure instance metadata
  /^\[?::1\]?$/,          // IPv6 loopback
  /^\[?f[cd][0-9a-f]{2}:/i, // IPv6 unique-local
  /\.local$/i,
  /\.internal$/i,
  /\.localdomain$/i,
];

/** Only these schemes. Not ftp:, not file:, not data:, not gopher:. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Decide what to do with a URL, without touching the network.
 *
 * Pure on purpose: the entire routing decision — including every refusal — is
 * testable without a credential, a gateway, or an authorization to make live
 * calls. The part that can only be verified against the real world is reduced
 * to "did the fetch come back", and everything else is decided here.
 *
 * @param {string} raw
 * @returns {{kind: string, url?: string, host?: string, slug?: string, reason?: string}}
 */
export function classifyLink(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: LINK_KINDS.REFUSED, reason: "empty link" };

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { kind: LINK_KINDS.REFUSED, reason: `"${text}" is not a URL` };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      kind: LINK_KINDS.REFUSED,
      reason: `${parsed.protocol} links are not fetched — send an http or https link`,
    };
  }

  // Credentials in a URL are either an accident worth not forwarding or an
  // attempt to have us authenticate somewhere on someone's behalf.
  if (parsed.username || parsed.password) {
    return { kind: LINK_KINDS.REFUSED, reason: "links carrying credentials are not fetched" };
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { kind: LINK_KINDS.REFUSED, reason: `${host} is not a public address` };
  }

  // A non-standard port on a public host is still usually someone's dev box.
  // Allowed rather than refused, because plenty of real portfolios sit on :8080
  // — but it is recorded, so a pattern of them is visible rather than silent.
  const linkedIn = linkedInTarget(parsed);
  if (linkedIn) return { ...linkedIn, url: parsed.toString(), host };

  return { kind: LINK_KINDS.WEB_PAGE, url: parsed.toString(), host };
}

/**
 * Is this a LinkedIn profile, and whose?
 *
 * Matches the host on a suffix so regional subdomains (`uk.linkedin.com`,
 * `www.linkedin.com`) resolve the same way, and reads the FIRST path segment
 * rather than searching the whole path — `example.com/blog/my-linkedin-in-2024`
 * is not a LinkedIn profile and a substring match would have said it was.
 */
function linkedInTarget(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [kind, slug] = segments;
  if (kind === "in") return { kind: LINK_KINDS.PERSON_PROFILE, slug };
  if (kind === "company" || kind === "school") {
    return { kind: LINK_KINDS.COMPANY_PROFILE, slug };
  }
  return null;   // /feed, /jobs, /posts — a link, not a profile
}

/**
 * Pull the links out of a message body.
 *
 * Deliberately conservative: bare `www.` hosts and trailing punctuation are the
 * two things that actually appear in email, and both are handled. Anything more
 * clever starts inventing URLs out of prose, and a URL we invented is one we
 * would then spend a credit fetching.
 */
export function linksIn(text) {
  const found = new Set();
  const pattern = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

  for (const raw of String(text ?? "").match(pattern) ?? []) {
    // Sentence punctuation clings to the end of a URL in prose.
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    found.add(trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed);
  }
  return [...found];
}

/**
 * The links worth spending anything on, in the order we would use them.
 *
 * A person who sends both a LinkedIn profile and a portfolio has given us a
 * cheap structured answer and an expensive prose one. Take the structured one
 * first: if netrows answers, the portfolio is enrichment rather than the only
 * evidence, and the model has less to invent.
 */
export function rankLinks(links) {
  const order = {
    [LINK_KINDS.PERSON_PROFILE]: 0,
    [LINK_KINDS.COMPANY_PROFILE]: 1,
    [LINK_KINDS.WEB_PAGE]: 2,
  };
  return links
    .map(classifyLink)
    .filter((link) => link.kind !== LINK_KINDS.REFUSED)
    .sort((a, b) => order[a.kind] - order[b.kind]);
}
