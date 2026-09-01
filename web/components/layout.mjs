/**
 * The page shell, and the two primitives every component depends on:
 * `esc` (never interpolate untrusted text raw) and `mailtoFor` (the intake).
 *
 * There is no client-side router and no hydration. Pages are composed from
 * component functions on the server and shipped as HTML. The only JavaScript
 * is a progressive enhancement that refreshes the seat count; with it blocked,
 * every page still renders and every call to action still works, because the
 * call to action is a mailto link and not a form.
 */

export const SITE = {
  name: "Yente",
  domain: "ccme.network",
  inbox: process.env.YENTE_INBOX || "yente@ccme.network",
  tagline: "Stop networking. Start getting introduced.",
  operator: "Interchained LLC",
};

const AMP = /&/g, LT = /</g, GT = />/g, QUOT = /"/g, APOS = /'/g;

/** HTML-escape. Every dynamic value in every component goes through this. */
export function esc(v) {
  return String(v == null ? "" : v)
    .replace(AMP, "&amp;").replace(LT, "&lt;").replace(GT, "&gt;")
    .replace(QUOT, "&quot;").replace(APOS, "&#39;");
}

export function nf(n) {
  return Number(n || 0).toLocaleString("en-US");
}

/**
 * The intake, as a link.
 *
 * A prefilled mailto is the whole signup: no account, no form, no validation
 * round-trip. The body is a short template the person edits in the mail client
 * they already have open, which means the first message Yente receives arrives
 * pre-shaped instead of as freeform prose — better intake data for zero
 * frontend.
 */
export function mailtoFor(cohort) {
  const bodies = {
    foundersDevelopers: [
      "What you build (one or two lines):",
      "",
      "Where you are now (raising / hiring / open to the right room):",
      "",
      "What you want from an introduction:",
      "",
      "Attach a résumé, portfolio, or LinkedIn export if you have one handy —",
      "Yente reads it first and only asks for what is missing.",
      "",
    ],
    investorsEmployers: [
      "What you do (invest / hire / acquire):",
      "",
      "What good looks like for you (stage, sector, check size, role, or thesis):",
      "",
      "What you never want to see:",
      "",
      "Anything else Yente should know before she proposes anyone:",
      "",
    ],
  };
  const subjects = {
    foundersDevelopers: "Founding seat — developer / founder",
    investorsEmployers: "Founding seat — investor / employer / acquirer",
  };
  const subject = subjects[cohort] || "Founding seat";
  const body = (bodies[cohort] || []).join("\n");
  return `mailto:${SITE.inbox}?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
}

function head({ title, description, path }) {
  const t = title ? `${title} — ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  const d = description
    || "Yente is a matchmaker who works out of an inbox. Tell her who you are "
     + "and what you need. She introduces you only when both sides have seen it.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(t)}</title>
<meta name="description" content="${esc(d)}" />
<meta property="og:title" content="${esc(t)}" />
<meta property="og:description" content="${esc(d)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://${SITE.domain}${esc(path || "/")}" />
<meta name="theme-color" content="#12100e" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#f7f4ed" media="(prefers-color-scheme: light)" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css" />
</head>`;
}

function header(active) {
  const link = (href, label) =>
    `<a class="nav-link${active === href ? " is-active" : ""}" href="${esc(href)}">${esc(label)}</a>`;
  return `<header class="site-head">
  <div class="wrap head-inner">
    <a class="wordmark" href="/" aria-label="${esc(SITE.name)} home">
      <span class="wordmark-mark" aria-hidden="true">✳</span>
      <span class="wordmark-text">${esc(SITE.name)}</span>
    </a>
    <nav class="nav" aria-label="Primary">
      ${link("/how-it-works", "How it works")}
      ${link("/directory", "Directory")}
      ${link("/privacy", "What stays private")}
      <a class="nav-cta" href="/join">Claim a seat</a>
    </nav>
  </div>
</header>`;
}

function footer() {
  const year = new Date().getFullYear();
  return `<footer class="site-foot">
  <div class="wrap foot-inner">
    <div class="foot-brand">
      <span class="wordmark-mark" aria-hidden="true">✳</span>
      <p class="foot-line"><strong>${esc(SITE.name)}</strong> — the matchmaker.
        <span class="muted">${esc(SITE.inbox)} is how you reach her.</span></p>
    </div>
    <nav class="foot-nav" aria-label="Footer">
      <a href="/how-it-works">How it works</a>
      <a href="/privacy">What stays private</a>
      <a href="/join">Claim a seat</a>
      <a href="mailto:${esc(SITE.inbox)}">Write to Yente</a>
    </nav>
    <p class="foot-fine">
      Yente is never paid for an introduction — no success fee, no percentage,
      nothing tied to a round closing or an offer signed.
      <br />&copy; ${year} ${esc(SITE.operator)}.
    </p>
  </div>
</footer>`;
}

/** Compose a full document from a page's body HTML. */
export function layout({ title, description, path, active, body }) {
  return `${head({ title, description, path })}
<body>
<a class="skip" href="#main">Skip to content</a>
${header(active || path)}
<main id="main">
${body}
</main>
${footer()}
<script src="/app.js" defer></script>
</body>
</html>`;
}
