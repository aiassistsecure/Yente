/**
 * The manager — the human-in-the-loop surface.
 *
 * NOT AN INBOX, AND NOT A DASHBOARD
 *
 * Two failure modes to avoid. An inbox clone would organise this around
 * messages, and the whole premise is that the message is EVIDENCE while the
 * person is the entity. A dashboard would show counts, and counts do not let
 * anybody decide anything.
 *
 * So this is a decision surface. Every card is something a person can rule on,
 * and every card carries the quotes the ruling depends on — because a match you
 * cannot check is a match you should not send.
 *
 * WHY SERVER-RENDERED HTML WITH FORM POSTS
 *
 * No build step, no client framework, no JSON API to keep in sync with a
 * renderer. It has to work today, from a terminal, over an SSH tunnel, and it
 * has to keep working when nobody has run npm install in a month. A form POST is
 * the most durable interactive primitive there is.
 *
 * EVERY MUTATION IS A POST. A confirmation reachable by GET is a confirmation a
 * link preview can fire.
 */

import { LEGAL_TRANSITIONS } from "../src/graph/qualification.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Handle a mutation. Returns true when the request was consumed.
 *
 * Redirects after a successful POST rather than rendering, so a refresh does not
 * re-submit the same ruling.
 */
export async function handleManagerRequest({ req, res, manager, graph, health, onConfirmed = null }) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ...health,
      // The number that matters and that nothing surfaced last time: how long
      // since we successfully read mail. A listener's silence is otherwise
      // indistinguishable from a quiet mailbox.
      mail_silent_minutes: health.lastMailAt
        ? Math.round((Date.now() - new Date(health.lastMailAt).getTime()) / 60_000)
        : null,
      summary: manager.summary(),
    }, null, 2));
    return true;
  }

  // Profiles. §9/§10 — the person is the entity and the mail is evidence, so a
  // subject gets a page and messages appear on it rather than the reverse.
  // search_matches_or_return_false, as JSON. The operator's (and, once the
  // tool transport lands, the model's) way to ask "who exists for this person
  // right now" without waiting on the connect tick. `false` on no results is
  // the contract: a caller must say so or say nothing, never render an
  // enthusiastic empty list. Cards structurally cannot carry an email address.
  if (url.pathname === "/search_matches" && req.method === "GET") {
    const who = url.searchParams.get("subject");
    if (!who) { res.writeHead(400).end("missing subject"); return true; }
    const found = manager.searchMatchesOrReturnFalse({
      subject: who,
      query: url.searchParams.get("query") || null,
      limit: Number(url.searchParams.get("limit") || 3),
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ found }));
    return true;
  }

  // THE WHOLE GRAPH, SEARCHABLE. One query sweeps subjects, claims, and
  // evidence; filters (kind/grade/source) compose with the words. HTML for
  // the operator, ?format=json for anything programmatic.
  if (url.pathname === "/search" && req.method === "GET") {
    const results = manager.searchGraph({
      query: url.searchParams.get("q") || null,
      kind: url.searchParams.get("kind") || null,
      grade: url.searchParams.get("grade") || null,
      source: url.searchParams.get("source") || null,
      limit: Number(url.searchParams.get("limit") || 20),
    });
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(results, null, 2));
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderSearch({ results }));
    return true;
  }

  // The numbers behind the desk. Every count is clickable through to /search,
  // so a statistic is a doorway rather than a dead end.
  if (url.pathname === "/stats" && req.method === "GET") {
    const stats = manager.stats();
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(stats, null, 2));
      return true;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStats({ stats }));
    return true;
  }

  if (url.pathname === "/subject" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) { res.writeHead(400).end("missing id"); return true; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderProfile({ profile: manager.subject(id) }));
    return true;
  }

  // The inbox view the overseer asked for: from any graph belief, open the
  // conversation it was mined from — covering message, attachments, every
  // claim Yente extracted from that thread. Verbatim source, not a summary.
  if (url.pathname === "/thread" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) { res.writeHead(400).end("missing id"); return true; }
    const thread = manager.thread(id);
    if (!thread) { res.writeHead(404).end("thread not found"); return true; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderThread({ thread }));
    return true;
  }

  if (req.method !== "POST") return false;

  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const action = form.get("action");
  const note = form.get("note") || null;

  try {
    switch (action) {
      case "confirm": {
        const match = manager.confirmMatch({ matchId: form.get("matchId"), note });
        if (match?.refused) {
          // The five-live cap said no. Surfaced, not swallowed — an operator
          // whose click did nothing silently will click it again forever.
          throw new Error(match.note ?? `refused: ${match.refused}`);
        }
        if (match && onConfirmed) await onConfirmed(match);
        break;
      }
      case "reject":
        manager.rejectMatch({ matchId: form.get("matchId"), note });
        break;
      case "create":
        manager.createMatch({
          seeker: form.get("seeker"),
          offerer: form.get("offerer"),
          matchType: form.get("matchType") || "curated",
          note,
        });
        break;
      case "same_person":
        manager.samePerson({ subjectA: form.get("subjectA"), subjectB: form.get("subjectB"), note });
        break;
      case "different_people":
        manager.differentPeople({ subjectA: form.get("subjectA"), subjectB: form.get("subjectB"), note });
        break;
      case "wrong_claim":
        manager.wrongClaim({ observationId: form.get("observationId"), note });
        break;
      case "exclude":
        manager.excludeSubject({ subject: form.get("subject"), note });
        break;
      case "profile_state":
        // The operator moving somebody along the lifecycle — most importantly
        // to QUALIFIED, the only state matching can see (§20). Legal
        // transitions are enforced in the manager; an illegal move throws and
        // surfaces below rather than silently mutating.
        manager.setProfileState({
          subject: form.get("subject"),
          state: form.get("state"),
          quote: note || undefined,
        });
        break;
      default:
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`unknown action: ${action}`);
        return true;
    }
  } catch (error) {
    // Show the operator what went wrong rather than a blank 500. A refused
    // action is usually a refused action for a good reason (introducing somebody
    // to themselves, say) and the reason is the useful part.
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<p>${esc(error.message)}</p><p><a href="/">back</a></p>`);
    return true;
  }

  res.writeHead(303, { location: url.searchParams.get("back") || "/" });
  res.end();
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    // Bounded. An unbounded body on a surface that accepts POSTs is a way to run
    // the process out of memory from outside it.
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error("body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* --- rendering ---------------------------------------------------------- */

const STYLE = `
:root{--ink:#12141a;--dim:#6b7280;--line:#e5e7eb;--bg:#fbfbfd;--card:#fff;
--yes:#0f766e;--no:#9f1239;--warn:#b45309;--curated:#4338ca}
.chip{display:inline-block;font-size:12px;padding:2px 9px;border:1px solid var(--line);
border-radius:99px;color:#374151;background:#fff;margin:2px 3px 2px 0;text-decoration:none}
.chip:hover{border-color:var(--dim)}
.gone{text-decoration:line-through;color:var(--dim)}
details{margin:6px 0}
details summary{cursor:pointer;font-size:12px;color:var(--dim)}
.grade{font-size:11px;padding:2px 7px;border-radius:99px;margin-left:6px;
border:1px solid #a7f3d0;background:#ecfdf5;color:var(--yes);text-transform:uppercase;letter-spacing:.05em}
.kv{font-size:13px;margin:2px 0}
.kv b{display:inline-block;min-width:110px;color:var(--dim);font-weight:600;
font-size:11px;text-transform:uppercase;letter-spacing:.06em}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 80px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;
border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
h1{font-size:19px;margin:0;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
margin:34px 0 12px}
.stats{display:flex;gap:18px;font-size:13px;color:var(--dim);flex-wrap:wrap}
.stats b{color:var(--ink);font-weight:600}
.alert{background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;padding:10px 14px;
border-radius:8px;font-size:13px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:16px 18px;margin-bottom:12px}
.pair{font-weight:600;font-size:15px}
.type{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
margin-left:8px}
.badge{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);
color:var(--dim);margin-left:6px}
.badge.curated{color:var(--curated);border-color:#c7d2fe;background:#eef2ff}
.badge.thin{color:var(--warn);border-color:#fed7aa;background:#fff7ed}
.why{margin:10px 0 0;padding:10px 12px;background:#f8fafc;border-radius:8px;font-size:13px}
.why li{margin:3px 0}
blockquote{margin:8px 0;padding-left:11px;border-left:2px solid var(--line);
color:#374151;font-size:13px}
blockquote cite{display:block;color:var(--dim);font-style:normal;font-size:11px;margin-top:3px}
form.row{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
input[type=text]{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--line);
border-radius:7px;font:inherit;font-size:13px}
button{padding:7px 13px;border-radius:7px;border:1px solid var(--line);background:#fff;
font:inherit;font-size:13px;cursor:pointer}
button.yes{background:var(--yes);border-color:var(--yes);color:#fff}
button.no{background:#fff;border-color:#fecdd3;color:var(--no)}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
a{color:var(--ink)}
.empty{color:var(--dim);font-size:13px;padding:16px 0}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
`;

function matchCard(match) {
  const curated = match.origin === "human";
  return `
<div class="card">
  <div>
    <span class="pair">${esc(shortSubject(match.seeker))} × ${esc(shortSubject(match.offerer))}</span>
    <span class="type">${esc(match.matchType)}</span>
    <span class="badge">${Math.round(Number(match.confidence) * 100)}%</span>
    ${curated ? '<span class="badge curated">curated</span>' : ""}
    ${match.thin ? '<span class="badge thin">no shared specifics</span>' : ""}
  </div>

  <ul class="why">
    ${(match.reasons ?? []).map((r) => `<li>${esc(r.detail)}</li>`).join("")}
    ${(match.conflicts ?? []).map((c) => `<li>⚠ ${esc(c.detail)}</li>`).join("")}
  </ul>

  ${(match.evidence ?? []).filter((e) => e.quote).map((e) => `
  <blockquote>“${esc(e.quote)}”
    <cite>${esc(shortSubject(e.subject))}${e.evidenceId ? ` · <a href="/thread?id=${encodeURIComponent(e.evidenceId)}"><code>${esc(String(e.evidenceId).slice(0, 12))}</code></a>` : ""}</cite>
  </blockquote>`).join("")}

  <form class="row" method="post" action="/">
    <input type="hidden" name="matchId" value="${esc(match.id)}">
    <input type="text" name="note" placeholder="why (optional, and worth writing)">
    <button class="yes" name="action" value="confirm">Introduce</button>
    <button class="no" name="action" value="reject">Not relevant</button>
  </form>
</div>`;
}

function shortSubject(id) {
  const s = String(id ?? "");
  return s.replace(/^person:/, "").replace(/^org:name:/, "").replace(/^person:name:/, "");
}

/**
 * A profile page.
 *
 * §10 — and the ordering is the argument. Intents first, because that is what a
 * matchmaker acts on. Then connections, then the evidence it was all built from.
 * The activity feed at the bottom is real messages and real claims; nothing is
 * invented to fill space, because §10 says do not fake social activity and an
 * empty section is more honest than a generated one.
 */
export function renderProfile({ profile }) {
  const row = (label, value) => value
    ? `<tr><th>${esc(label)}</th><td>${value}</td></tr>` : "";

  const claim = (c) => `
  <div class="card">
    <div><b>${esc(c.predicate.replace(/^intent:/, ""))}</b>
      ${c.object ? `→ ${esc(shortSubject(c.object))}` : ""}
      ${c.authority >= 400 ? '<span class="badge curated">you</span>' : ""}
      ${c.originalSubject ? `<span class="badge">via ${esc(shortSubject(c.originalSubject))}</span>` : ""}
    </div>
    ${Object.keys(c.attributes ?? {}).length
      ? `<div class="empty" style="padding:4px 0">${esc(JSON.stringify(c.attributes))}</div>` : ""}
    ${c.quote ? `<blockquote>“${esc(c.quote)}”<cite>${
      // The whole point of the graph: every claim can show the sentence it came
      // from, and the evidence id it traces to.
      c.evidenceId ? `<code>${esc(String(c.evidenceId).slice(0, 16))}</code>` : "asserted"
    }${c.validFrom ? ` · valid from ${esc(String(c.validFrom).slice(0, 10))}` : ""}</cite></blockquote>` : ""}
    <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
      <input type="hidden" name="observationId" value="${esc(c.id ?? c._id ?? "")}">
      <input type="text" name="note" placeholder="what's wrong with it">
      <button class="no" name="action" value="wrong_claim">Wrong</button>
    </form>
  </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(profile.name ?? profile.id)} · Yente</title><style>${STYLE}</style>
</head><body><div class="wrap">

<header>
  <h1>${esc(profile.name ?? shortSubject(profile.id))}
    <span style="color:var(--dim);font-weight:400">· ${esc(profile.kind)}</span></h1>
  <div class="stats"><a href="/">← manager</a></div>
</header>

<table>
  ${row("subject", `<code>${esc(profile.id)}</code>`)}
  ${row("title", profile.title ? esc(profile.title) : "")}
  ${row("also", profile.aliases.length
    ? profile.aliases.map((a) => `<code>${esc(a)}</code>`).join(" ") : "")}
  ${row("signal", `${esc(profile.signal.strength)}
    <span class="empty">${esc(JSON.stringify(profile.signal.inputs))}</span>`)}
  ${row("matchmaking", profile.eligible ? "eligible" : "<b>excluded</b>")}
  ${row("lifecycle", `<b>${esc(profile.profileState ?? "new")}</b>${
    profile.matchable ? ' <span class="badge curated">matchable</span>'
      : ' <span class="badge thin">not matchable — only QUALIFIED profiles are scored (§20)</span>'}`)}
</table>
<p class="empty" style="padding-top:4px">${esc(profile.signal.label ?? "")}</p>

${profile.proposals.length ? `<h2>Yente's read</h2>
${profile.proposals.map((c) => `
  <div class="card">
    <div><b>${esc(String(c.predicate).replace(/^proposal:/, "").replace(/_/g, " "))}</b>
      → ${esc(c.object ?? "")}
      ${c.attributes?.grade ? `<span class="grade">${esc(c.attributes.grade)}</span>` : ""}
    </div>
    ${c.quote ? `<blockquote>“${esc(c.quote)}”<cite>${
      c.evidenceId ? `<code>${esc(String(c.evidenceId).slice(0, 16))}</code>` : "asserted"
    }</cite></blockquote>` : ""}
    <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
      <input type="hidden" name="observationId" value="${esc(c.id ?? c._id ?? "")}">
      <input type="text" name="note" placeholder="what's wrong with it">
      <button class="no" name="action" value="wrong_claim">Wrong</button>
    </form>
  </div>`).join("")}` : ""}

<h2>Seeking / offering</h2>
${profile.intents.length ? profile.intents.map(claim).join("")
    : `<p class="empty">Nothing yet. Intent is what matchmaking runs on, so this is the section that matters.</p>`}

${(() => {
    // EVERYTHING THEY DISCLOSED — the bulk of a résumé read, and the section
    // this page never had: role, employer, capability, geography, credential…
    // Grouped by field, every value with its verbatim quote one click away,
    // every row correctable. "manager doesn't show all the claims" — it does now.
    const SHOWN = new Set(["is_person", "is_organization", "opportunity", "note"]);
    const disclosures = profile.current.filter((c) => {
      const predicate = String(c.predicate);
      return !SHOWN.has(predicate)
        && !predicate.startsWith("intent:")
        && !predicate.startsWith("proposal:")
        && !predicate.startsWith("matchmaking")
        && !profile.relationships.includes(c);
    });
    if (disclosures.length === 0) return "";
    const byField = new Map();
    for (const c of disclosures) {
      const held = byField.get(c.predicate) ?? [];
      held.push(c);
      byField.set(c.predicate, held);
    }
    return `<h2>What we can evidence (${disclosures.length})</h2>
${[...byField.entries()].map(([field, claims]) => `
  <div class="card">
    <div><b>${esc(field)}</b> <span class="badge">${claims.length}</span></div>
    ${claims.map((c) => `
    <details>
      <summary>${esc(String(c.object ?? ""))}${c.authority >= 400 ? ' <span class="badge curated">you</span>' : ""}</summary>
      ${c.quote ? `<blockquote>“${esc(c.quote)}”<cite>${
        c.evidenceId
          ? `<a href="/thread?id=${encodeURIComponent(c.evidenceId)}"><code>${esc(String(c.evidenceId).slice(0, 16))}</code></a>`
          : "asserted"
      } · ${esc(String(c.observedAt ?? "").slice(0, 16).replace("T", " "))}${
        typeof c.confidence === "number" ? ` · conf ${esc(String(c.confidence))}` : ""}</cite></blockquote>` : ""}
      <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
        <input type="hidden" name="observationId" value="${esc(c.id ?? c._id ?? "")}">
        <input type="text" name="note" placeholder="what's wrong with it">
        <button class="no" name="action" value="wrong_claim">Wrong</button>
      </form>
    </details>`).join("")}
  </div>`).join("")}`;
  })()}

${profile.substantiated.length ? `<h2>Their documents can vouch for</h2>
<div class="card">${profile.substantiated.map((w) =>
    `<a class="chip" href="/search?q=${encodeURIComponent(w.word)}">${esc(w.word)}${
      w.count > 1 ? ` ×${esc(String(w.count))}` : ""}</a>`).join("")}
</div>` : ""}

<h2>Connections</h2>
${profile.relationships.length ? profile.relationships.map(claim).join("")
    : `<p class="empty">None recorded.</p>`}

${profile.opportunities.length ? `<h2>Opportunities</h2>${profile.opportunities.map(claim).join("")}` : ""}
${profile.notes.length ? `<h2>Other observations</h2>${profile.notes.map(claim).join("")}` : ""}

<h2>Matches</h2>
${profile.matches.length === 0 ? `<p class="empty">None proposed.</p>`
    : `<table><tr><th>with</th><th>type</th><th>state</th><th>origin</th></tr>
  ${profile.matches.map((m) => `<tr>
    <td><a href="/subject?id=${encodeURIComponent(m.seeker === profile.id ? m.offerer : m.seeker)}">${
      esc(shortSubject(m.seeker === profile.id ? m.offerer : m.seeker))}</a></td>
    <td>${esc(m.matchType)}</td><td>${esc(m.state)}</td><td>${esc(m.origin)}</td>
  </tr>`).join("")}</table>`}

<h2>Evidence</h2>
${profile.evidence.length === 0 ? `<p class="empty">None.</p>`
    : `<table><tr><th>kind</th><th>what</th><th>received</th></tr>
  ${profile.evidence.map((e) => `<tr>
    <td>${esc(e.kind)}</td>
    <td>${e.threadHref
      ? `<a href="${esc(e.threadHref)}">${esc(e.meta?.subject ?? e.meta?.filename ?? e.id)}</a>`
      : esc(e.meta?.subject ?? e.meta?.filename ?? "—")}
      ${e.meta?.structure && Object.keys(e.meta.structure).length
        ? `<span class="empty">${esc(JSON.stringify(e.meta.structure))}</span>` : ""}
      ${e.claimCount > 0 ? `
      <details>
        <summary>${esc(String(e.claimCount))} claim${e.claimCount === 1 ? "" : "s"} from this ${esc(e.kind)}</summary>
        ${e.claims.map((c) => `<div class="kv"><b>${esc(String(c.predicate).replace(/^intent:/, "").replace(/^proposal:/, ""))}</b> ${
          esc(shortSubject(String(c.object ?? "")))}${c.attributes?.retracted ? ' <span class="gone">retracted</span>' : ""}</div>`).join("")}
      </details>` : ""}</td>
    <td>${esc(String(e.receivedAt ?? "").slice(0, 16).replace("T", " "))}</td>
  </tr>`).join("")}</table>`}

<h2>History</h2>
${profile.history.length === 0 ? `<p class="empty">Nothing recorded.</p>` : `
<details>
  <summary>${esc(String(profile.history.length))} observations, newest first — including retracted and superseded</summary>
  <table><tr><th>when</th><th>claim</th><th>from</th></tr>
  ${profile.history.map((c) => `<tr${c.attributes?.retracted ? ' class="gone"' : ""}>
    <td>${esc(String(c.observedAt ?? "").slice(0, 16).replace("T", " "))}</td>
    <td><b>${esc(String(c.predicate))}</b> ${esc(shortSubject(String(c.object ?? "")))}</td>
    <td>${c.evidenceId
      ? `<a href="/thread?id=${encodeURIComponent(c.evidenceId)}"><code>${esc(String(c.evidenceId).slice(0, 12))}</code></a>`
      : "asserted"}</td>
  </tr>`).join("")}</table>
</details>`}

<h2>Lifecycle</h2>
<div class="card">
  <p class="empty" style="padding:0 0 8px">Matching only sees QUALIFIED profiles —
  people who approved what Yente believes about them. Advancing a state by hand
  asserts that step happened off-channel (a reply, a call); it is recorded as
  your ruling, at your authority, with your note as the quote.</p>
  <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
    <input type="hidden" name="action" value="profile_state">
    <input type="hidden" name="subject" value="${esc(profile.id)}">
    <input type="text" name="note" placeholder="how you know (e.g. approved by reply, 9/1)">
    ${(LEGAL_TRANSITIONS[profile.profileState ?? "new"] ?? [])
      .filter((state) => state !== (profile.profileState ?? "new"))
      .map((state) => `<button name="state" value="${esc(state)}"${
        state === "qualified" ? ' class="yes"' : state === "declined" ? ' class="no"' : ""
      }>${esc(state.replace(/_/g, " "))}</button>`).join("")}
  </form>
</div>

<h2>Corrections</h2>
<div class="card">
  <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
    <input type="hidden" name="subject" value="${esc(profile.id)}">
    <input type="text" name="note" placeholder="why">
    <button class="no" name="action" value="exclude">Exclude from matchmaking</button>
  </form>
  <form class="row" method="post" action="/?back=${encodeURIComponent(`/subject?id=${profile.id}`)}">
    <input type="hidden" name="subjectA" value="${esc(profile.id)}">
    <input type="text" name="subjectB" placeholder="other subject id" required>
    <button name="action" value="same_person">Same person</button>
    <button name="action" value="different_people">Different people</button>
  </form>
</div>

</div></body></html>`;
}

export function renderThread({ thread }) {
  const when = (iso) => esc(String(iso ?? "").slice(0, 16).replace("T", " "));
  const messageCard = (m) => `
  <div class="card">
    <div><b>${esc(m.meta?.subject ?? thread.subject)}</b>
      <span class="badge">${esc(m.kind ?? "message")}</span></div>
    <div class="empty">${esc(m.meta?.from ?? "")} → ${(m.meta?.to ?? []).map(esc).join(", ")}
      · ${when(m.meta?.sentAt ?? m.receivedAt)}</div>
    <pre style="white-space:pre-wrap;font:inherit">${esc(m.text ?? "")}</pre>
  </div>`;
  const attachmentCard = (a) => `
  <div class="card">
    <div><b>${esc(a.meta?.filename ?? a.id)}</b>
      <span class="badge">attachment</span></div>
    <div class="empty">${esc(a.meta?.mimeType ?? "")} · ${a.meta?.bytes ?? "?"} bytes</div>
    <pre style="white-space:pre-wrap;font:inherit">${esc(String(a.text ?? "").slice(0, 4000))}</pre>
  </div>`;
  const claimCard = (c) => `
  <div class="card">
    <div><b>${esc(c.predicate)}</b>${c.object ? ` → ${esc(c.object)}` : ""}
      · <a href="/subject?id=${encodeURIComponent(c.subject)}">${esc(c.subject)}</a></div>
    ${c.quote ? `<blockquote>“${esc(c.quote)}”</blockquote>` : ""}
  </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(thread.subject)} · thread · Yente</title><style>${STYLE}</style>
</head><body><div class="wrap">
<header>
  <h1>${esc(thread.subject)}</h1>
  <div class="stats"><a href="/">← manager</a>
    · ${esc(thread.from ?? "")}
    · ${when(thread.sentAt)}
    ${thread.rfcMessageId ? `· <code>${esc(thread.rfcMessageId)}</code>` : ""}</div>
</header>
<h2>Conversation</h2>
${thread.messages.map(messageCard).join("") || `<p class="empty">No messages in this thread.</p>`}
<h2>Attachments</h2>
${thread.attachments.map(attachmentCard).join("") || `<p class="empty">None.</p>`}
<h2>What Yente extracted</h2>
${thread.claims.map(claimCard).join("") || `<p class="empty">No claims mined from this thread yet.</p>`}
</div></body></html>`;
}

export function renderManager({ manager, health = {}, mailSilenceMinutes = null }) {
  const summary = manager.summary();
  const pending = manager.pendingMatches({ limit: 40 });
  const awaiting = manager.awaitingMatches ? manager.awaitingMatches({ limit: 40 }) : [];
  const identities = manager.pendingIdentities ? manager.pendingIdentities({ limit: 10 }) : [];
  const subjects = manager.subjects().slice(0, 60);

  // The alert that did not exist and cost two days. Surfaced at the top, in
  // words, before anything else on the page.
  const mailAlert = (() => {
    if (health.lastMailError && health.consecutiveMailFailures >= 3) {
      return `<div class="alert"><b>Not reading mail.</b> ${esc(health.lastMailError)}
        — ${health.consecutiveMailFailures} consecutive failures, silent for
        ${mailSilenceMinutes ?? "?"} min. If this is ECONNREFUSED, check fail2ban on the
        mail server first.</div>`;
    }
    if (mailSilenceMinutes !== null && mailSilenceMinutes > 120) {
      return `<div class="alert">No mail read in ${mailSilenceMinutes} minutes.</div>`;
    }
    return "";
  })();

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yente · manager</title><style>${STYLE}</style>
</head><body><div class="wrap">

<header>
  <h1>Yente <span style="color:var(--dim);font-weight:400">· manager</span></h1>
  <div class="stats">
    <span><b>${summary.subjects}</b> people</span>
    <span><b>${summary.observations}</b> observations</span>
    <span><b>${summary.jobs.READY ?? 0}</b> queued</span>
    <span><b>${summary.matches.proposed}</b> to review</span>
    ${awaiting.length > 0 ? `<span><b>${awaiting.length}</b> awaiting yes</span>` : ""}
    ${summary.matches.confirmed + summary.matches.sending > 0
      ? `<span><b>${summary.matches.confirmed + summary.matches.sending}</b> sending</span>` : ""}
    <span><b>${summary.matches.introduced}</b> introduced</span>
    <span><a href="/stats">stats</a></span>
  </div>
</header>

<form class="row" method="get" action="/search" style="margin-bottom:22px">
  <input type="text" name="q" placeholder="search everything Yente knows — people, claims, evidence, quotes">
  <button class="yes">Search</button>
</form>

${mailAlert}

<h2>Needs your judgment</h2>
${pending.length === 0
    ? `<p class="empty">Nothing waiting. ${summary.jobs.READY ?? 0} messages still to interpret.</p>`
    : pending.map(matchCard).join("")}

${awaiting.length === 0 ? "" : `
<h2>Waiting on the parties</h2>
${awaiting.map((m) => `
<div class="card">
  <div><span class="pair">${esc(shortSubject(m.seeker))} ↔ ${esc(shortSubject(m.offerer))}</span>
    <span style="color:var(--dim)"> · ${esc(String(m.matchType ?? ""))}</span></div>
  <ul class="why">
    ${m.sides.map((side) => {
      const who = esc(side.name ?? side.address ?? shortSubject(side.subject));
      if (side.decision === "approve") {
        return `<li>✓ <b>${who}</b> said yes${side.quote ? ` — “${esc(side.quote)}”` : ""}</li>`;
      }
      if (side.decision === "decline") {
        return `<li>✕ <b>${who}</b> declined${side.quote ? ` — “${esc(side.quote)}”` : ""}</li>`;
      }
      return side.previewSentAt
        ? `<li>… <b>${who}</b> has the letter (sent ${esc(String(side.previewSentAt).slice(0, 16))}), no legible answer yet</li>`
        : `<li>✉ <b>${who}</b> — letter not sent yet (next connect pass)</li>`;
    }).join("")}
  </ul>
  <form class="row" method="post" action="/">
    <input type="hidden" name="matchId" value="${esc(m.id)}">
    <input type="text" name="note" placeholder="why withdraw it (optional)">
    <button class="no" name="action" value="reject">Withdraw</button>
  </form>
</div>`).join("")}`}

${identities.length === 0 ? "" : `
<h2>Same person?</h2>
${identities.map((c) => `
<div class="card">
  <div><span class="pair">${esc(shortSubject(c.subjectA))} ≟ ${esc(shortSubject(c.subjectB))}</span></div>
  <ul class="why">
    <li>${esc(c.reason)}</li>
    <li>⚠ ${esc(c.caution)}</li>
  </ul>
  ${c.quote ? `<blockquote>“${esc(c.quote)}”<cite><code>${esc(String(c.evidenceId).slice(0, 16))}</code></cite></blockquote>` : ""}
  <form class="row" method="post" action="/">
    <input type="hidden" name="subjectA" value="${esc(c.subjectA)}">
    <input type="hidden" name="subjectB" value="${esc(c.subjectB)}">
    <button class="yes" name="action" value="same_person">Same person</button>
    <button class="no" name="action" value="different_people">Different people</button>
  </form>
</div>`).join("")}
<p class="empty" style="padding-top:0">
  Never merged automatically. A missed merge costs you one click; a wrong one
  conflates two people's intents and then proposes an introduction based on
  something neither of them said.
</p>`}

<h2>Make a match yourself</h2>
<div class="card">
  <form class="row" method="post" action="/">
    <input type="text" name="seeker" placeholder="seeker (e.g. person:sarah@acme.com)" required>
    <input type="text" name="offerer" placeholder="offerer" required>
    <input type="text" name="note" placeholder="why">
    <button class="yes" name="action" value="create">Create</button>
  </form>
  <p class="empty" style="padding-bottom:0">
    A match you make is the same object as one the scorer proposes — origin
    <code>human</code>, confidence 1 — so it renders, explains and exports
    identically. Your judgment is the ground truth the scorer is approximating.
  </p>
</div>

<h2>The graph</h2>
${subjects.length === 0
    ? `<p class="empty">Nothing yet. Mail arrives, the queue drains, people appear here.</p>`
    : `<table>
  <tr><th>subject</th><th>name</th><th>kind</th><th>claims</th><th>last seen</th></tr>
  ${subjects.map((s) => `<tr>
    <td><a href="/subject?id=${encodeURIComponent(s.id)}"><code>${esc(s.id)}</code></a></td>
    <td>${esc(s.name ?? "—")}</td>
    <td>${esc(s.kind)}</td>
    <td>${s.claims}</td>
    <td>${esc(String(s.lastSeen ?? "").slice(0, 16).replace("T", " "))}</td>
  </tr>`).join("")}
</table>`}

<h2>Corrections</h2>
<div class="card">
  <form class="row" method="post" action="/">
    <input type="text" name="subjectA" placeholder="subject" required>
    <input type="text" name="subjectB" placeholder="other subject" required>
    <button name="action" value="same_person">Same person</button>
    <button name="action" value="different_people">Different people</button>
  </form>
  <form class="row" method="post" action="/">
    <input type="text" name="subject" placeholder="subject to exclude from matchmaking" required>
    <input type="text" name="note" placeholder="why">
    <button class="no" name="action" value="exclude">Exclude</button>
  </form>
  <p class="empty" style="padding-bottom:0">
    Corrections are appended at user authority, never destructive. A later model
    run cannot override one, and asserting the opposite reverses it — there is no
    deleted state to reconstruct.
  </p>
</div>

</div></body></html>`;
}


/**
 * The graph, searched. Three result sections — who, what, and where it came
 * from — every hit a link to the page that owns it, and the form re-renders
 * with its own query so refinement is one keystroke, not a back-button.
 */
export function renderSearch({ results }) {
  const f = results.filters ?? {};
  const gradeBadge = (grade) => grade
    ? `<span class="badge curated">${esc(grade)}</span>` : "";
  const matchedBadge = (matched) => (matched?.length
    ? `<span class="badge">${esc(matched.join(", "))}</span>` : "");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yente · search</title><style>${STYLE}</style>
</head><body><div class="wrap">

<header>
  <h1><a href="/" style="text-decoration:none">Yente</a>
    <span style="color:var(--dim);font-weight:400">· search</span></h1>
  <div class="stats">
    <span><b>${results.total}</b> hits</span>
    <span><a href="/stats">stats</a></span>
  </div>
</header>

<form class="row" method="get" action="/search" style="margin-bottom:8px">
  <input type="text" name="q" value="${esc(results.query)}" placeholder="words — c++, kubernetes, a name, a quote fragment">
  <button class="yes">Search</button>
</form>
<form class="row" method="get" action="/search" style="margin-bottom:22px">
  <input type="hidden" name="q" value="${esc(results.query)}">
  <input type="text" name="kind" value="${esc(f.kind ?? "")}" placeholder="kind: capability · intent · proposal · role_declared">
  <input type="text" name="grade" value="${esc(f.grade ?? "")}" placeholder="grade: good · strong · exceptional">
  <input type="text" name="source" value="${esc(f.source ?? "")}" placeholder="source: message · attachment · link · vendor">
  <button>Filter</button>
</form>

<h2>People &amp; organisations</h2>
${results.subjects.length === 0 ? '<p class="empty">Nobody matched.</p>' : `<table>
  <tr><th>subject</th><th>name</th><th>claims</th><th>matched</th></tr>
  ${results.subjects.map((s2) => `<tr>
    <td><a href="${esc(s2.href)}"><code>${esc(s2.id)}</code></a></td>
    <td>${esc(s2.name ?? "—")}</td>
    <td>${s2.claims}</td>
    <td>${esc(s2.matched.join(", ") || (s2.viaClaims ? "via their claims" : ""))}</td>
  </tr>`).join("")}
</table>`}

<h2>Claims</h2>
${results.claims.length === 0 ? '<p class="empty">No claims matched.</p>'
    : results.claims.map((c) => `
<div class="card">
  <div>
    <a href="${esc(c.subjectHref)}"><span class="pair">${esc(String(c.subject).replace(/^person:/, ""))}</span></a>
    <span class="type">${esc(c.predicate)}</span>
    ${gradeBadge(c.grade)}
    <span class="badge">${esc(c.sourceKind ?? "?")}</span>
    ${matchedBadge(c.matched)}
  </div>
  <div style="margin-top:6px">${esc(c.object ?? "")}</div>
  ${c.quote ? `<blockquote>"${esc(c.quote)}"
    <cite>${c.threadHref ? `<a href="${esc(c.threadHref)}">open the thread</a>` : esc(String(c.evidenceId ?? "").slice(0, 16))}</cite>
  </blockquote>` : ""}
</div>`).join("")}

<h2>Evidence</h2>
${results.evidence.length === 0 ? '<p class="empty">No messages or documents matched.</p>' : `<table>
  <tr><th>kind</th><th>subject / file</th><th>from</th><th>received</th><th></th></tr>
  ${results.evidence.map((e) => `<tr>
    <td>${esc(e.kind ?? "?")}</td>
    <td>${esc(e.subject ?? e.filename ?? "—")}</td>
    <td>${esc(String(e.from ?? "—"))}</td>
    <td>${esc(String(e.receivedAt ?? "").slice(0, 16).replace("T", " "))}</td>
    <td>${e.threadHref ? `<a href="${esc(e.threadHref)}">open</a>` : ""}</td>
  </tr>`).join("")}
</table>`}

</div></body></html>`;
}

/**
 * The numbers behind the desk — and every number is a doorway: counts link
 * into /search with the filter that produces them, so "37 capability claims"
 * is one click from the 37 rows themselves.
 */
export function renderStats({ stats }) {
  const bar = (n, max) => `<div style="background:#e0e7ff;height:8px;border-radius:4px;width:${Math.max(2, Math.round((n / Math.max(1, max)) * 100))}%"></div>`;
  const countTable = (rows, { hrefFor = null, label = "key" } = {}) => {
    if (!rows?.length) return '<p class="empty">Nothing yet.</p>';
    const max = rows[0]?.n ?? 1;
    return `<table>
  <tr><th>${esc(label)}</th><th>count</th><th></th></tr>
  ${rows.map((r) => `<tr>
    <td>${hrefFor ? `<a href="${esc(hrefFor(r.key))}">${esc(String(r.key))}</a>` : esc(String(r.key))}</td>
    <td>${r.n}</td>
    <td style="width:40%">${bar(r.n, max)}</td>
  </tr>`).join("")}
</table>`;
  };
  const spark = (days, field) => {
    const max = Math.max(1, ...days.map((d) => d[field]));
    return days.map((d) =>
      `<div title="${esc(d.day)}: ${d[field]}" style="flex:1;background:#c7d2fe;border-radius:2px 2px 0 0;height:${Math.max(2, Math.round((d[field] / max) * 44))}px"></div>`)
      .join("");
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yente · stats</title><style>${STYLE}</style>
</head><body><div class="wrap">

<header>
  <h1><a href="/" style="text-decoration:none">Yente</a>
    <span style="color:var(--dim);font-weight:400">· stats</span></h1>
  <div class="stats">
    <span><b>${stats.subjects}</b> people</span>
    <span><b>${stats.claims.total}</b> live claims</span>
    <span><b>${stats.proposals.total}</b> proposals</span>
    <span><b>${stats.matches.introduced}</b> introduced</span>
    <span><a href="/search">search</a></span>
  </div>
</header>

<h2>Fourteen days of arrival</h2>
<div class="card">
  <div style="display:flex;align-items:flex-end;gap:2px;height:48px">${spark(stats.activity, "claims")}</div>
  <p class="empty" style="padding-bottom:0">claims per day — a flat line is a stalled pipeline, not a quiet world</p>
</div>

<h2>People</h2>
<div class="card">
  <div class="stats" style="margin-bottom:10px">
    <span><b>${stats.people.total}</b> total</span>
    <span><b>${stats.people.matchable}</b> matchable</span>
    <span><b>${stats.people.organizations}</b> organisations</span>
  </div>
  ${countTable(stats.people.byState, { label: "profile state" })}
</div>

<h2>Claims — what Yente believes, and on whose word</h2>
<div class="card">
  <div class="stats" style="margin-bottom:10px">
    <span><b>${stats.claims.total}</b> live</span>
    <span><b>${stats.claims.stored}</b> stored</span>
    <span>avg confidence <b>${stats.claims.averageConfidence ?? "—"}</b></span>
  </div>
  ${countTable(stats.claims.byPredicate, {
    label: "predicate",
    hrefFor: (k) => `/search?kind=${encodeURIComponent(String(k))}`,
  })}
</div>
<div class="card">${countTable(stats.claims.bySourceKind, {
  label: "source kind",
  hrefFor: (k) => `/search?source=${encodeURIComponent(String(k))}`,
})}</div>
<div class="card">${countTable(stats.claims.byModel, { label: "model" })}</div>

<h2>Proposals — Yente's graded reads</h2>
<div class="card">
  <div class="stats" style="margin-bottom:10px">
    <span><b>${stats.proposals.total}</b> proposals</span>
    <span><b>${stats.proposals.graded}</b> people graded</span>
  </div>
  ${countTable(stats.proposals.byGrade, {
    label: "grade",
    hrefFor: (k) => `/search?kind=proposal&grade=${encodeURIComponent(String(k))}`,
  })}
  ${countTable(stats.proposals.byKind, {
    label: "kind",
    hrefFor: (k) => `/search?kind=${encodeURIComponent(`proposal:${k}`)}`,
  })}
</div>

<h2>Vocabulary the documents can vouch for</h2>
<div class="card">${countTable(stats.vocabulary, {
  label: "word",
  hrefFor: (k) => `/search?q=${encodeURIComponent(String(k))}`,
})}</div>

<h2>Matches</h2>
<div class="card">
  <div class="stats" style="margin-bottom:10px">
    <span><b>${stats.matches.proposed}</b> proposed</span>
    <span><b>${stats.matches.confirmed}</b> confirmed</span>
    <span><b>${stats.matches.introduced}</b> introduced</span>
    <span><b>${stats.matches.rejected}</b> rejected</span>
    <span>avg confidence <b>${stats.matchQuality.averageConfidence ?? "—"}</b></span>
  </div>
  ${countTable(stats.matchQuality.byType, { label: "match type" })}
</div>

<h2>Evidence &amp; work</h2>
<div class="card">${countTable(stats.evidence.byKind, { label: "evidence kind" })}</div>
<div class="card">${countTable(
    Object.entries(stats.jobs ?? {}).map(([key, n]) => ({ key, n }))
      .sort((a, b) => b.n - a.n),
    { label: "job state" },
  )}</div>

</div></body></html>`;
}
