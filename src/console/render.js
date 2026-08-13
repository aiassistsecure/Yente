/**
 * The operator console, rendered — SPEC v2 §17.
 *
 * Server-rendered HTML from a frozen read-only view. No client framework, no
 * build step, no API for a browser to call: the page IS the data, which is the
 * cheapest possible way to be certain the console cannot act.
 *
 * The visual language is Relay's — dense, data-forward, coloured state dots,
 * pills, and a status bar that answers the morning question in one glance. What
 * it deliberately does not inherit is the interaction model: nothing here is
 * draggable, nothing advances a stage, and there is no compose window. A card
 * you can drag from one state to another is exactly the human judgment INV-4
 * exists to remove.
 */

const STATE_COLOURS = Object.freeze({
  PENDING: "#94a3b8",
  SENDING: "#3b82f6",
  RETRY_WAIT: "#f97316",
  SENT: "#15803d",
  DEAD: "#be123c",
  NEW: "#94a3b8",
  NEEDS_PROFILE: "#a16207",
  INTERVIEWING: "#3b82f6",
  QUALIFIED: "#8b5cf6",
  ACTIVE: "#15803d",
  STOPPED: "#64748b",
  DELETED: "#be123c",
});

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const dot = (state) =>
  `<span class="dot" style="background:${STATE_COLOURS[state] ?? "#64748b"}"></span>`;

const short = (hash) => (hash ? `${String(hash).slice(0, 12)}…` : "—");

function ago(iso, now) {
  if (!iso) return "—";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  if (ms < 0) return `in ${humanise(-ms)}`;
  return `${humanise(ms)} ago`;
}

function humanise(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/**
 * @param {ReturnType<import("./readonly.js").createConsoleView>} view
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {string} [options.version]
 */
export function renderConsole(view, { now = new Date(), version = "v0.1.0" } = {}) {
  const t = now.getTime();
  const deliverability = view.deliverability();
  const outbox = view.outbox();
  const reviews = view.reviews();
  const members = view.members();
  const engine = view.engine();
  const introductions = view.introductions();

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Yente — Operator console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0b0e14; --panel:#111621; --panel-2:#151b28; --line:#1f2736;
  --ink:#e6eaf2; --ink-2:#93a0b8; --ink-3:#5d6b85;
  --green:#15803d; --amber:#f97316; --red:#be123c; --blue:#3b82f6;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--bg); color:var(--ink);
  font:14px/1.5 Inter,system-ui,sans-serif;
  display:flex; flex-direction:column;
}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
header{
  display:flex; align-items:center; gap:12px;
  padding:0 16px; height:48px; flex:0 0 48px;
  border-bottom:1px solid var(--line); background:var(--panel);
}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em}
.mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);
  display:grid;place-items:center;font-size:12px;font-weight:600;color:#fff}
.sub{color:var(--ink-3);font-weight:400}
.spacer{flex:1}
.badge{
  font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  padding:4px 9px;border-radius:999px;border:1px solid;
}
.badge.ro{color:#c4b5fd;border-color:#4c1d95;background:#2e1065}
.badge.ok{color:#86efac;border-color:#14532d;background:#052e16}
.badge.bad{color:#fda4af;border-color:#881337;background:#4c0519}
main{flex:1;display:grid;grid-template-columns:264px minmax(0,1fr) 320px;min-height:0}
.rail,.aside{overflow:auto;background:var(--panel);padding:14px}
.rail{border-right:1px solid var(--line)}
.aside{border-left:1px solid var(--line)}
.center{overflow:auto;padding:16px;min-width:0}
h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);
  margin:0 0 9px;font-weight:600}
.card{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:14px}
.kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12.5px}
.kv .k{color:var(--ink-2)}
.kv .v{color:var(--ink);text-align:right}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile .n{font-size:24px;font-weight:600;letter-spacing:-.02em}
.tile .l{font-size:11px;color:var(--ink-2);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);
  font-weight:600;padding:0 10px 7px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--ink-2);vertical-align:top}
td.strong{color:var(--ink)}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;font-size:11px;padding:2px 7px;border-radius:999px;
  border:1px solid var(--line);background:var(--panel-2);color:var(--ink-2)}
.pill.warn{color:#fdba74;border-color:#7c2d12;background:#431407}
.empty{color:var(--ink-3);font-size:12.5px;padding:14px 10px;text-align:center}
.gauge{height:5px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:7px}
.gauge > i{display:block;height:100%;background:var(--green)}
.chain{list-style:none;margin:0;padding:0}
.chain li{position:relative;padding:0 0 12px 16px;border-left:1px solid var(--line);margin-left:4px}
.chain li:last-child{border-left-color:transparent;padding-bottom:0}
.chain li::before{content:"";position:absolute;left:-4px;top:5px;width:7px;height:7px;
  border-radius:50%;background:var(--blue)}
.chain .c{font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.chain .h{font-size:11.5px}
footer{
  flex:0 0 30px;display:flex;align-items:center;gap:16px;padding:0 16px;
  border-top:1px solid var(--line);background:var(--panel);
  font-size:11.5px;color:var(--ink-3)
}
footer b{color:var(--ink-2);font-weight:500}
@media (max-width:1100px){main{grid-template-columns:1fr}.rail,.aside{border:0}}
</style>
</head>
<body>
<header>
  <div class="brand"><div class="mark">Y</div>Yente <span class="sub">· operator console</span></div>
  <span class="badge ro">read only</span>
  <div class="spacer"></div>
  <span class="badge ${engine.verified ? "ok" : "bad"}">
    ${engine.verified ? "chain verified" : "chain FAILED"}
  </span>
</header>

<main>
  <section class="rail">
    ${renderDeliverability(deliverability, t)}
    ${renderPopulation(members)}
  </section>

  <section class="center">
    ${renderOutboxTiles(outbox)}
    ${renderProblems(outbox, t)}
    ${renderReviews(reviews, t)}
  </section>

  <aside class="aside">
    ${renderReceipts(view, introductions, t)}
  </aside>
</main>

<footer>
  <span>seq <b class="mono">${engine.seq}</b></span>
  <span>head <b class="mono">${esc(short(engine.head))}</b></span>
  <span>indexed <b>${engine.messages.toLocaleString("en-US")}</b> msgs</span>
  <span>matches <b>${engine.matches}</b></span>
  <span>outbox <b>${outbox.total}</b></span>
  <span class="spacer"></span>
  <span>${esc(engine.path)}</span>
  <span><b>${esc(version)}</b></span>
</footer>
</body>
</html>`;
}

function renderDeliverability({ health, invitations }, now) {
  const rows = health
    ? [
        ["host", esc(health.host ?? "—")],
        ["imap", statusText(health.imap)],
        ["smtp", statusText(health.smtp)],
        ["spf / dkim", `${statusText(health.spf)} · ${statusText(health.dkim)}`],
        ["dmarc", statusText(health.dmarc)],
        ["quota", esc(health.quota ?? "—")],
        ["last sync", esc(ago(health.lastSyncAt, now))],
      ]
    : null;

  const cap = invitations.cap;
  const pct = cap ? Math.min(100, Math.round((invitations.sentToday / cap) * 100)) : 0;

  return `<h2>Deliverability</h2>
<div class="card">
  ${
    rows
      ? rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v mono">${v}</span></div>`).join("")
      : `<div class="empty">No probe has run.<br>Reporting nothing rather than a green tick.</div>`
  }
</div>
<h2>Invitations · §5.4</h2>
<div class="card">
  <div class="kv"><span class="k">sent today</span><span class="v mono">${invitations.sentToday}${cap ? ` / ${cap}` : ""}</span></div>
  ${cap ? `<div class="gauge"><i style="width:${pct}%;background:${pct > 80 ? "var(--amber)" : "var(--green)"}"></i></div>` : ""}
  <div class="kv"><span class="k">addresses, lifetime</span><span class="v mono">${invitations.lifetimeAddresses}</span></div>
</div>`;
}

function statusText(value) {
  if (value === true || value === "pass" || value === "ok") return "ok";
  if (value === false || value === "fail") return "FAIL";
  return esc(value ?? "—");
}

function renderPopulation(members) {
  const order = ["NEW", "NEEDS_PROFILE", "INTERVIEWING", "QUALIFIED", "ACTIVE", "STOPPED", "DELETED"];
  return `<h2>Members</h2>
<div class="card">
  ${order
    .map(
      (state) =>
        `<div class="kv"><span class="k">${dot(state)}${state.toLowerCase().replace("_", " ")}</span><span class="v mono">${members[state] ?? 0}</span></div>`,
    )
    .join("")}
</div>`;
}

function renderOutboxTiles({ byState }) {
  const order = ["PENDING", "SENDING", "RETRY_WAIT", "SENT", "DEAD"];
  return `<h2>Outbox · §10.3</h2>
<div class="tiles">
  ${order
    .map(
      (state) => `<div class="tile">
    <div class="n">${byState[state] ?? 0}</div>
    <div class="l">${dot(state)}${state.toLowerCase().replace("_", " ")}</div>
  </div>`,
    )
    .join("")}
</div>`;
}

function renderProblems({ dead, waiting, sending }, now) {
  const section = (title, rows, columns, mapRow) => `<h2>${title}</h2>
<div class="card" style="padding:4px 2px 2px">
  ${
    rows.length === 0
      ? `<div class="empty">nothing here — good</div>`
      : `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
         <tbody>${rows.map(mapRow).join("")}</tbody></table>`
  }
</div>`;

  return (
    section(
      "Dead — will never send without a human",
      dead,
      ["purpose", "recipients", "attempts", "last error"],
      (job) => `<tr>
      <td class="strong">${esc(job.purpose)}</td>
      <td>${esc((job.recipients ?? []).join(", "))}</td>
      <td class="mono">${job.attempts}</td>
      <td>${esc(job.lastError ?? "—")}</td>
    </tr>`,
    ) +
    section(
      "Waiting on backoff",
      waiting,
      ["purpose", "recipients", "attempt", "due"],
      (job) => `<tr>
      <td class="strong">${esc(job.purpose)}</td>
      <td>${esc((job.recipients ?? []).join(", "))}</td>
      <td class="mono">${job.attempts}</td>
      <td class="mono">${esc(ago(job.availableAt, now))}</td>
    </tr>`,
    ) +
    (sending.length > 0
      ? section(
          "In flight",
          sending,
          ["purpose", "recipients", "attempt", "started"],
          (job) => `<tr>
      <td class="strong">${esc(job.purpose)}</td>
      <td>${esc((job.recipients ?? []).join(", "))}</td>
      <td class="mono">${job.attempts}</td>
      <td class="mono">${esc(ago(job.history?.at(-1)?.at, now))}</td>
    </tr>`,
        )
      : "")
  );
}

function renderReviews(reviews, now) {
  return `<h2>Review queue · §11.6</h2>
<div class="card" style="padding:4px 2px 2px">
  ${
    reviews.length === 0
      ? `<div class="empty">no jobs awaiting a human</div>`
      : `<table><thead><tr><th>purpose</th><th>template</th><th>why it failed twice</th><th>waiting</th></tr></thead>
     <tbody>${reviews
       .map(
         (review) => `<tr>
       <td class="strong">${esc(review.purpose)}</td>
       <td>${esc(review.template ?? "—")}</td>
       <td>${(review.failures ?? [])
         .map((failure) => `<span class="pill warn">${esc(failure.code)}</span>`)
         .join(" ")}</td>
       <td class="mono">${esc(ago(review.recordedAt, now))}</td>
     </tr>`,
       )
       .join("")}</tbody></table>`
  }
  <div class="empty" style="text-align:left;padding:10px">
    Resolution happens on the CLI. §17.1 — the console shows that these need doing, it does not do them.
  </div>
</div>`;
}

function renderReceipts(view, introductions, now) {
  if (introductions.length === 0) {
    return `<h2>Receipts · §12</h2><div class="card"><div class="empty">no introductions yet</div></div>`;
  }

  const latest = introductions
    .slice()
    .sort((a, b) => Date.parse(b.sentAt ?? 0) - Date.parse(a.sentAt ?? 0))[0];
  const chain = view.receipt(latest.matchId);

  return `<h2>Receipts · §12</h2>
<div class="card">
  <div class="kv"><span class="k">introductions</span><span class="v mono">${introductions.length}</span></div>
  <div class="kv"><span class="k">most recent</span><span class="v mono">${esc(ago(latest.sentAt, now))}</span></div>
  <div class="kv"><span class="k">message-id</span><span class="v mono">${esc(latest.messageId ?? "—")}</span></div>
</div>
<h2>Causal chain</h2>
<div class="card">
  <ul class="chain">
    ${chain
      .map(
        (node) => `<li>
      <div class="c">${esc(node._coll)}</div>
      <div class="h mono">${esc(short(node._hash))}</div>
    </li>`,
      )
      .join("")}
  </ul>
  <div class="empty" style="text-align:left;padding:8px 0 0">
    ${chain.length} nodes — the introduction back through the match, both members, and the
    inbound messages that permitted outbound.
  </div>
</div>`;
}
