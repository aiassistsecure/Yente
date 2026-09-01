/**
 * /directory — the résumé directory, rendered.
 *
 * Server-composed HTML like every other page: no hydration, no client
 * router, a plain GET form for search (CSP form-action 'self'). What ships
 * is Yente's verified read of each résumé — never the document, never an
 * address. The empty states are written as carefully as the full one,
 * because a young network shows the empty state to every early visitor.
 */

import { layout, esc, nf, SITE } from "../components/layout.mjs";

const GRADE_LABEL = Object.freeze({
  exceptional: "Exceptional candidate",
  strong: "Strong candidate",
  good: "Good candidate",
});

const KIND_LABEL = Object.freeze({
  hire_for: "for",
  invest_in: "— investment in",
});

function chipList(label, values, max = 8) {
  if (!values || values.length === 0) return "";
  const shown = values.slice(0, max);
  const more = values.length - shown.length;
  return `<div class="dir-row">
    <span class="dir-row-label">${esc(label)}</span>
    <span class="dir-chips">${shown.map((v) => `<span class="dir-chip">${esc(v)}</span>`).join("")}${
  more > 0 ? `<span class="dir-chip dir-chip-more">+${nf(more)}</span>` : ""}</span>
  </div>`;
}

function proposalLines(proposals, max = 3) {
  if (!proposals || proposals.length === 0) return "";
  return `<ul class="dir-proposals">${proposals.slice(0, max).map((p) => `
    <li><strong>${esc(GRADE_LABEL[p.grade] ?? "Candidate")}</strong> ${esc(KIND_LABEL[p.kind] ?? "for")} ${esc(p.target)}</li>`).join("")}
  </ul>`;
}

function personCard(person) {
  return `<article class="dir-card" id="p-${esc(person.key)}">
  <h3 class="dir-name">${esc(person.name)}</h3>
  ${person.headline ? `<p class="dir-headline">${esc(person.headline)}</p>` : ""}
  ${proposalLines(person.proposals)}
  ${chipList("Capabilities", person.capabilities)}
  ${chipList("Industries", person.industries)}
  ${chipList("Where", person.geographies, 4)}
  ${chipList("Credentials", person.credentials, 4)}
  ${person.intents.length > 0 ? `<p class="dir-intents muted">${
  person.intents.slice(0, 2).map((i) => esc(`${i.type.toLowerCase()}: ${i.object}`)).join(" · ")}</p>` : ""}
  <p class="dir-meta muted">${nf(person.claims)} verified claims</p>
</article>`;
}

export function directoryPage({ cards = [], query = "", total = null } = {}) {
  const count = total ?? cards.length;
  const body = `<section class="band band-top">
  <div class="wrap narrow center">
    <p class="eyebrow">The directory</p>
    <h1 class="display-2">People Yente has actually read.</h1>
    <p class="lede">Every card below is ${SITE.name}'s own verified summary of a
    résumé somebody sent to <strong>${esc(SITE.inbox)}</strong> — assembled claim
    by claim, each one traced to that person's exact words. No documents are
    published, and no contact details. Introductions go through Yente.</p>
  </div>
</section>
<section class="band">
  <div class="wrap">
    <form class="dir-search" method="GET" action="/directory" role="search">
      <label class="dir-search-label" for="dir-q">Search the directory</label>
      <div class="dir-search-row">
        <input class="dir-input" id="dir-q" name="q" type="search"
          placeholder="rust · founder · miami · kubernetes"
          value="${esc(query)}" maxlength="120" />
        <button class="btn btn-primary" type="submit">Search</button>
        ${query ? `<a class="btn btn-quiet" href="/directory">Clear</a>` : ""}
      </div>
    </form>
    <p class="dir-count muted">${
  query
    ? `${nf(count)} ${count === 1 ? "person matches" : "people match"} “${esc(query)}”`
    : `${nf(count)} ${count === 1 ? "person" : "people"} in the directory`}</p>
    ${cards.length > 0
    ? `<div class="dir-grid">${cards.map(personCard).join("\n")}</div>`
    : query
      ? `<p class="dir-empty">Nobody matches those words yet. Try fewer of them —
         the directory searches Yente's verified claims, not full documents.</p>`
      : `<p class="dir-empty">The directory fills as résumés arrive. Send yours to
         <a href="mailto:${esc(SITE.inbox)}">${esc(SITE.inbox)}</a> and Yente will
         read it, verify what it says, and put your card here.</p>`}
  </div>
</section>`;

  return layout({
    title: `Directory — ${SITE.name}`,
    description: "Yente's verified summaries of every résumé on the desk — searchable, deduped, and grounded in each person's own words.",
    path: "/directory",
    active: "/directory",
    body,
  });
}
