/**
 * Pages — each one composes components. Real routes, real documents, no router
 * in the browser and no hydration. /join is its own page rather than a hash
 * anchor so it can be linked, bookmarked and shared.
 */

import { layout, esc, nf, mailtoFor, SITE } from "../components/layout.mjs";
import * as S from "../components/sections.mjs";
import { COHORT_META } from "../components/cohorts.mjs";

export function home(snap) {
  return layout({
    path: "/",
    active: "/",
    body: [
      S.hero(snap),
      S.quiet(),
      S.cohorts(snap),
      S.how(),
      S.throttle(),
      S.brief(),
      S.trust(),
      S.faq(),
      S.cta(snap),
    ].join("\n"),
  });
}

export function join(snap) {
  const card = (id) => {
    const c = snap.cohorts[id];
    const meta = COHORT_META[id];
    return `<article class="pick" data-cohort="${esc(id)}">
      <h2>${esc(meta.label)}</h2>
      <p class="pick-blurb">${esc(meta.blurb)}</p>
      <p class="pick-count">
        <strong data-capacity-remaining="${esc(id)}">${nf(c.remaining)}</strong>
        of ${nf(c.limit)} seats left</p>
      ${c.full
        ? `<a class="btn btn-quiet btn-lg" href="mailto:${esc(SITE.inbox)}?subject=${encodeURIComponent("Waiting list — " + meta.label)}">Join the waiting list</a>`
        : `<a class="btn btn-primary btn-lg" href="${esc(mailtoFor(id))}">Write to Yente</a>`}
    </article>`;
  };

  return layout({
    title: "Claim a founding seat",
    path: "/join",
    active: "/join",
    description: "Claim one of 10,000 free founding seats. No form, no account — "
      + "your email is the signup and Yente takes it from there.",
    body: `<section class="band band-top">
  <div class="wrap narrow">
    <p class="eyebrow">Founding cohort</p>
    <h1 class="display-2">There is no form. That is deliberate.</h1>
    <p class="section-lede">
      A form makes you answer the questions someone guessed you could answer.
      Yente would rather read what you actually wrote, then ask about what is
      missing. So the signup is an email — and it is also her first piece of
      evidence about you.
    </p>
    ${S.counterBadge(snap)}
  </div>
</section>
<section class="band band-tint">
  <div class="wrap">
    <div class="pick-grid">
      ${card("foundersDevelopers")}
      ${card("investorsEmployers")}
    </div>
    <p class="pick-fine">
      Both buttons open your own mail app with a few questions pre-filled. Edit
      them, delete the ones you would rather not answer, attach a résumé or
      portfolio if you have one to hand, and send. You will hear back from Yente
      with your seat number and whatever she still needs.
    </p>
  </div>
</section>
<section class="band">
  <div class="wrap narrow">
    <h2 class="display-3">What happens after you send it</h2>
    <ol class="after">
      <li><strong>Your seat is reserved</strong> the moment the mail arrives, and
        the number on this page moves.</li>
      <li><strong>Yente reads what you sent</strong> and replies with what she
        understood — in your words, with the lines she took it from — so you can
        correct her before anyone else sees a thing.</li>
      <li><strong>She asks two or three questions</strong>, not twenty. Only what
        the evidence did not already answer.</li>
      <li><strong>Then she goes quiet</strong> until something real clears the bar
        on both sides. That silence is the product working, not failing.</li>
    </ol>
  </div>
</section>
${S.trust()}`,
  });
}

export function howItWorks(snap) {
  return layout({
    title: "How it works",
    path: "/how-it-works",
    active: "/how-it-works",
    description: "Evidence first, a short interview, at most five live "
      + "introductions, and a brief that shows its work.",
    body: `<section class="band band-top">
  <div class="wrap narrow">
    <p class="eyebrow">How it works</p>
    <h1 class="display-2">She reads before she writes.</h1>
    <p class="section-lede">
      Yente is not a search box and not a feed. She is a desk that runs on
      correspondence: evidence in, questions back, and an introduction only when
      the case for it is good enough to put in writing.
    </p>
  </div>
</section>
${S.how()}
${S.throttle()}
${S.brief()}
${S.faq()}
${S.cta(snap)}`,
  });
}

export function privacy(snap) {
  return layout({
    title: "What stays private",
    path: "/privacy",
    active: "/privacy",
    description: "What Yente keeps, what she never forwards, what she can prove, "
      + "and how to make her forget you.",
    body: `<section class="band band-top">
  <div class="wrap narrow">
    <p class="eyebrow">What stays private</p>
    <h1 class="display-2">Plain answers about your information.</h1>
    <p class="section-lede">
      A matchmaker only works if you tell her true things. So here is exactly
      what happens to them.
    </p>

    <h2 class="display-3">Your documents are never forwarded</h2>
    <p>A résumé, deck or portfolio is read by Yente and used to understand you.
      It is not attached to a brief and not sent to a proposed match. The other
      person sees a short written case, never your file.</p>

    <h2 class="display-3">Extraction runs on our own hardware</h2>
    <p>The model that reads your documents runs on our own machines rather than a
      third-party inference provider. An unannounced raise, or a quiet job
      search, should not become somebody else's training data. This is a cost
      decision we made on purpose.</p>

    <h2 class="display-3">Every belief traces to a sentence</h2>
    <p>Yente separates what a document <em>said</em> from what she
      <em>concluded</em>. Ask why she thinks something and you get the actual
      line, from the actual file, with the date. A conclusion never quietly
      becomes a fact.</p>

    <h2 class="display-3">Some things are never used to match</h2>
    <p>Sensitive characteristics are not match criteria, and neither is whether
      you have ever paid us anything. Both are enforced by tests in the codebase
      rather than by good intentions.</p>

    <h2 class="display-3">Stop means stop. Deletion is real.</h2>
    <p>Reply <em>stop</em> and she stops writing. Ask to be deleted and the record
      is removed, not flagged as hidden. Either instruction works in plain
      English, in any message, with no link to hunt for.</p>

    <p class="section-lede">
      Questions we have not answered here go to
      <a href="mailto:${esc(SITE.inbox)}">${esc(SITE.inbox)}</a> — a person reads that inbox too.
    </p>
  </div>
</section>
${S.cta(snap)}`,
  });
}

export function notFound() {
  return layout({
    title: "Not found",
    path: "/404",
    body: `<section class="band band-top">
  <div class="wrap narrow">
    <p class="eyebrow">404</p>
    <h1 class="display-2">That page does not exist.</h1>
    <p class="section-lede">Try <a href="/">the front page</a>, or
      <a href="/join">claim a seat</a>.</p>
  </div>
</section>`,
  });
}
