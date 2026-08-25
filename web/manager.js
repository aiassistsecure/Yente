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

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Handle a mutation. Returns true when the request was consumed.
 *
 * Redirects after a successful POST rather than rendering, so a refresh does not
 * re-submit the same ruling.
 */
export async function handleManagerRequest({ req, res, manager, graph, health }) {
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

  if (req.method !== "POST") return false;

  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const action = form.get("action");
  const note = form.get("note") || null;

  try {
    switch (action) {
      case "confirm":
        manager.confirmMatch({ matchId: form.get("matchId"), note });
        break;
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
    <cite>${esc(shortSubject(e.subject))}${e.evidenceId ? ` · <code>${esc(String(e.evidenceId).slice(0, 12))}</code>` : ""}</cite>
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

export function renderManager({ manager, health = {}, mailSilenceMinutes = null }) {
  const summary = manager.summary();
  const pending = manager.pendingMatches({ limit: 40 });
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
    <span><b>${summary.matches.confirmed}</b> introduced</span>
  </div>
</header>

${mailAlert}

<h2>Needs your judgment</h2>
${pending.length === 0
    ? `<p class="empty">Nothing waiting. ${summary.jobs.READY ?? 0} messages still to interpret.</p>`
    : pending.map(matchCard).join("")}

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
    <td><code>${esc(s.id)}</code></td>
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
