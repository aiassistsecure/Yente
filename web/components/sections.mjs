/**
 * Page sections. Each is a pure function of data → HTML, composed by pages/.
 *
 * The counter components render REAL numbers server-side from the seat ledger,
 * and carry `data-capacity-*` hooks so app.js can refresh them without a
 * reload. Server-rendered first is the point: the number is correct before any
 * JavaScript runs, and if JavaScript never runs it is still correct.
 */

import { esc, nf, mailtoFor, SITE } from "./layout.mjs";
import { COHORTS, COHORT_META } from "./cohorts.mjs";

/* ------------------------------------------------------------------ counter */

export function counterBadge(snap) {
  const { total, provisional } = snap;
  return `<p class="badge" data-capacity-status>
    <span class="badge-dot${provisional ? " is-provisional" : ""}" aria-hidden="true"></span>
    <strong data-capacity-total-remaining>${nf(total.remaining)}</strong>
    of ${nf(total.limit)} founding seats left${provisional
      ? ` <span class="muted">· count reconnecting</span>` : ""}
  </p>`;
}

export function cohortMeter(c) {
  const pct = c.limit ? Math.min(100, (c.joined / c.limit) * 100) : 0;
  const meta = COHORT_META[c.cohort];
  return `<article class="cohort" data-cohort="${esc(c.cohort)}">
    <header class="cohort-head">
      <h3>${esc(meta.label)}</h3>
      <p class="cohort-blurb">${esc(meta.blurb)}</p>
    </header>
    <div class="meter" role="img"
         aria-label="${nf(c.joined)} of ${nf(c.limit)} seats claimed">
      <div class="meter-fill" style="width:${pct.toFixed(3)}%"
           data-capacity-fill="${esc(c.cohort)}"></div>
    </div>
    <p class="cohort-count">
      <strong data-capacity-remaining="${esc(c.cohort)}">${nf(c.remaining)}</strong>
      left <span class="muted">of ${nf(c.limit)}</span>
    </p>
    ${c.full
      ? `<p class="cohort-full">This cohort is full. Write anyway — Yente keeps a waiting list.</p>
         <a class="btn btn-quiet" href="mailto:${esc(SITE.inbox)}?subject=${encodeURIComponent("Waiting list — " + meta.label)}">Join the waiting list</a>`
      : `<a class="btn btn-primary" href="${esc(mailtoFor(c.cohort))}">
           Claim a seat by email
         </a>
         <p class="cohort-fine">Opens your mail app with the questions pre-filled.
           No form, no account, no card.</p>`}
  </article>`;
}

/* --------------------------------------------------------------------- hero */

export function hero(snap) {
  return `<section class="hero">
  <div class="wrap hero-inner">
    ${counterBadge(snap)}
    <h1 class="display">Stop networking.<br /><em>Start getting introduced.</em></h1>
    <p class="lede">
      Your next cofounder, investor, employer or acquirer should not depend on
      who you happened to sit next to. Tell Yente who you are and what you need.
      She gathers the missing context, waits for a credible fit, and makes the
      introduction only after both sides have seen it.
    </p>
    <div class="hero-actions">
      <a class="btn btn-primary btn-lg" href="/join">Claim a founding seat</a>
      <a class="btn btn-ghost btn-lg" href="/how-it-works">See how she works</a>
    </div>
    <ul class="hero-marks">
      <li>No cold outreach</li>
      <li>No forced matches</li>
      <li>Never paid for an introduction</li>
    </ul>
  </div>
</section>`;
}

/* ------------------------------------------------------------------- quiet */

export function quiet() {
  return `<section class="band">
  <div class="wrap narrow">
    <p class="eyebrow">A quieter kind of network</p>
    <h2 class="display-2">No feed to perform for.<br />No directory to disappear inside.</h2>
    <p>
      Yente starts with evidence, not reach. A résumé, portfolio or professional
      profile tells her what you have done. A short email exchange tells her what
      you want <em>now</em>.
    </p>
    <p>
      Then you go back to work. She writes again only when something real clears
      the rules on both sides.
    </p>
  </div>
</section>`;
}

/* ---------------------------------------------------------------- cohorts */

export function cohorts(snap) {
  return `<section class="band band-tint" id="cohorts">
  <div class="wrap">
    <p class="eyebrow">Two cohorts</p>
    <h2 class="display-2">Ten thousand founding seats. Then the door closes.</h2>
    <p class="section-lede">
      Founding membership is free for life — five thousand builders, five
      thousand backers. No card, ever. The cap is not a growth tactic: a
      matchmaker who cannot keep the whole network in her head is a mailing list.
    </p>
    <div class="cohort-grid">
      ${Object.entries(snap.cohorts).map(([k, c]) => cohortMeter({ ...c, cohort: k })).join("\n")}
    </div>
  </div>
</section>`;
}

/* ------------------------------------------------------------------- steps */

const STEPS = [
  ["Write to her",
   "Your email is the signup. It is also the first evidence — Yente reads what you actually said, not what a form let you say."],
  ["Send the evidence",
   "A résumé, portfolio or profile. She reads it, extracts what matters, and tells you what she understood so you can correct her before anyone sees it."],
  ["Wait for real fit",
   "You are in the network. Yente will not manufacture a weak match to keep a queue moving. Silence means nothing has cleared the bar yet."],
  ["Choose the introduction",
   "Each side gets a private brief with the reason and the evidence. Reply PASS and it ends quietly. Two yeses and she opens one thread, then leaves."],
];

export function how() {
  return `<section class="band" id="how">
  <div class="wrap">
    <p class="eyebrow">How it works</p>
    <h2 class="display-2">One thoughtful thread at a time.</h2>
    <p class="section-lede">The language is human. The rules are not negotiable.</p>
    <ol class="steps">
      ${STEPS.map(([t, d], i) => `<li class="step">
        <span class="step-n">${String(i + 1).padStart(2, "0")}</span>
        <h3>${esc(t)}</h3>
        <p>${esc(d)}</p>
      </li>`).join("\n")}
    </ol>
  </div>
</section>`;
}

/* -------------------------------------------------------------- the throttle */

export function throttle() {
  return `<section class="band band-ink" id="throttle">
  <div class="wrap narrow">
    <p class="eyebrow eyebrow-light">The part nobody else will promise</p>
    <h2 class="display-2">Never more than five live introductions.</h2>
    <p>
      You hold at most two to five open proposals at any moment. A new one
      appears only when an old one resolves — a pass, a meeting, a decline, or a
      timeout.
    </p>
    <p>
      This is the quality mechanism and the volume control at once. Nobody sends
      an investor forty decks and calls it a service. And a system that
      <em>cannot</em> flood you is worth more than one that merely promises not to.
    </p>
    <p class="pull">
      An empty slot beats a weak fill. Under a cap of five, every introduction is
      expensive — so Yente leaves the slot open rather than spend it on a maybe.
    </p>
  </div>
</section>`;
}

/* --------------------------------------------------------------- match brief */

export function brief() {
  return `<section class="band band-tint" id="brief">
  <div class="wrap brief-grid">
    <div class="brief-copy">
      <p class="eyebrow">Context before contact</p>
      <h2 class="display-2">A reason to talk — not a résumé dump.</h2>
      <p>
        A brief tells you enough to decide: who the person is, what they need,
        and why Yente thinks the conversation may work. Your documents and your
        contact details stay with her until you both say yes.
      </p>
      <p>
        Every claim in it is traceable. Ask why you were matched and you get the
        actual sentence, from the actual document, that caused it.
      </p>
    </div>
    <figure class="letter">
      <figcaption class="letter-cap">Illustrative brief</figcaption>
      <div class="letter-body">
        <p>Hi Alice,</p>
        <p>Someone worth considering: a technical founder building
           infrastructure for regulated teams.</p>
        <p><strong>Why now.</strong> They are opening a seed round and want an
           investor who understands long enterprise sales cycles.</p>
        <p><strong>Why you.</strong> Your stated thesis, stage and operating
           background all clear the policy.</p>
        <p><strong>Evidence.</strong> “We sell to banks; the shortest deal we
           have closed took seven months.” — their intake, 14 Aug.</p>
        <p>Reply <em>PASS</em> if this is not useful. No explanation needed.
           Otherwise I will introduce you, if they agree too.</p>
        <p class="sign">— Yente</p>
      </div>
    </figure>
  </div>
</section>`;
}

/* -------------------------------------------------------------------- trust */

const TRUST = [
  ["Evidence stays private",
   "Your résumé helps Yente understand you. It is never forwarded to a proposed match."],
  ["A pass is enough",
   "Either person can pass privately, or stop entirely. No explanation is required, and the other side is never told who declined."],
  ["No fee, ever",
   "Not on the introduction, not on the round, not on the offer. Yente has no stake in whether you take the meeting — which is the only reason the email is worth opening."],
  ["Deletion is real",
   "Ask to be erased and you are erased, not flagged. Say stop and she stops."],
];

export function trust() {
  return `<section class="band" id="trust">
  <div class="wrap">
    <p class="eyebrow">Before anyone meets</p>
    <h2 class="display-2">The introduction belongs to both people.</h2>
    <div class="trust-grid">
      ${TRUST.map(([t, d]) => `<article class="trust-card">
        <h3>${esc(t)}</h3><p>${esc(d)}</p>
      </article>`).join("\n")}
    </div>
  </div>
</section>`;
}

/* ---------------------------------------------------------------------- faq */

const FAQ = [
  ["Is founding membership really free?",
   "Yes, and free for life — the first 5,000 builders and the first 5,000 backers. No card is required. After that it is pay-what-you-want, and what you pay never affects who you are matched with. That is enforced by a rule in the code, not a promise on a page."],
  ["Does joining guarantee an introduction?",
   "No. Yente would rather wait than manufacture a weak fit. An introduction happens only when both profiles clear the policy and neither person passes. Some people will wait a long time."],
  ["Do I have to send my whole résumé?",
   "No. Send whatever best establishes your background — résumé, portfolio, profile, or a few honest paragraphs. She reads it first and asks only for what is missing."],
  ["Will Yente join the meeting?",
   "No. She opens one shared thread, suggests you trade calendars, and leaves. The conversation is yours."],
  ["What does she do with my data?",
   "Extraction runs on our own hardware, not a third-party inference provider — an unannounced raise or a quiet job search should not be somebody else's training data. Everything she believes about you traces back to a sentence you wrote."],
];

export function faq() {
  return `<section class="band band-tint" id="faq">
  <div class="wrap narrow">
    <p class="eyebrow">The practical questions</p>
    <h2 class="display-2">Before you claim it.</h2>
    <div class="faq">
      ${FAQ.map(([q, a], i) => `<details class="qa"${i === 0 ? " open" : ""}>
        <summary><span>${esc(q)}</span></summary>
        <div class="qa-body"><p>${esc(a)}</p></div>
      </details>`).join("\n")}
    </div>
  </div>
</section>`;
}

/* ---------------------------------------------------------------------- cta */

export function cta(snap) {
  return `<section class="band band-ink cta" id="claim">
  <div class="wrap narrow center">
    <p class="eyebrow eyebrow-light">One email can change your trajectory</p>
    <h2 class="display-2">Make yourself introducible.</h2>
    <p class="section-lede">
      ${nf(snap.total.remaining)} founding seats remain. Give Yente enough truth
      to recognise the conversation worth having.
    </p>
    <div class="hero-actions center-actions">
      <a class="btn btn-primary btn-lg" href="${esc(mailtoFor("foundersDevelopers"))}">
        I build things</a>
      <a class="btn btn-invert btn-lg" href="${esc(mailtoFor("investorsEmployers"))}">
        I invest, hire or acquire</a>
    </div>
    <p class="cohort-fine light">Or simply write to
      <a href="mailto:${esc(SITE.inbox)}">${esc(SITE.inbox)}</a> and say what you need.</p>
  </div>
</section>`;
}
