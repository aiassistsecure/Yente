import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleView } from "../src/console/readonly.js";
import { renderConsole, esc } from "../src/console/render.js";
import { startConsole } from "../src/console/server.js";
import { openInMemory } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { seedConsoleStore, SEED_HEALTH } from "../test-support/seed-console.mjs";

const NOW = new Date("2026-08-12T21:40:00.000Z");

function seeded() {
  const { store } = seedConsoleStore({ now: NOW });
  return createConsoleView(store, { health: SEED_HEALTH, invitationDailyCap: 25 });
}

async function withConsole(view, run) {
  const server = await startConsole(view, { version: "v0.1.0-test" });
  try {
    return await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

/* --- read-only is structural, not a promise --------------------------- */

test("the view exposes no method capable of writing — §17.1", () => {
  const view = seeded();
  // If the console can't reach a write, it can't be tricked into one. This is
  // INV-4's argument applied to the operator rather than the model.
  for (const forbidden of ["put", "save", "enqueue", "resolve", "delete", "record", "store", "core", "repos"]) {
    assert.equal(view[forbidden], undefined, `view exposed ${forbidden}`);
  }
  assert.ok(Object.isFrozen(view));
  assert.deepEqual(
    Object.keys(view).sort(),
    ["deliverability", "engine", "introductions", "members", "outbox", "receipt", "reviews"],
  );
});

test("everything the view returns is deeply frozen", () => {
  const view = seeded();
  const outbox = view.outbox();
  assert.ok(Object.isFrozen(outbox));
  assert.ok(Object.isFrozen(outbox.dead));
  if (outbox.dead[0]) {
    assert.ok(Object.isFrozen(outbox.dead[0]));
    assert.throws(() => {
      outbox.dead[0].state = "PENDING";
    }, TypeError);
  }
});

test("the HTTP surface refuses every method that is not a read", async () => {
  await withConsole(seeded(), async (base) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(base, { method });
      assert.equal(response.status, 405, `${method} was not refused`);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
  });
});

/* --- what it shows ----------------------------------------------------- */

test("the page renders the four panes of §17.2", async () => {
  await withConsole(seeded(), async (base) => {
    const html = await (await fetch(base)).text();
    for (const pane of ["Deliverability", "Outbox", "Review queue", "Receipts"]) {
      assert.match(html, new RegExp(pane), `missing pane: ${pane}`);
    }
    assert.match(html, /read only/);
    assert.match(html, /chain verified/);
  });
});

test("a hard bounce is shown as DEAD and never as retryable", () => {
  const view = seeded();
  const { byState, dead } = view.outbox();
  assert.equal(byState.DEAD, 1);
  assert.match(dead[0].lastError, /550 5\.1\.1/);
  const html = renderConsole(view, { now: NOW });
  assert.match(html, /Dead — will never send without a human/);
  assert.match(html, /recipient address rejected/);
});

test("invitations are shown against the §5.4 cap", () => {
  const { invitations } = seeded().deliverability();
  assert.equal(invitations.cap, 25);
  assert.equal(invitations.lifetimeAddresses, 3);
});

test("a missing health probe reports nothing rather than a green tick", () => {
  // A panel that shows "ok" for a probe that never ran is a panel operators
  // learn to ignore, which is worse than no panel.
  const { store } = seedConsoleStore({ now: NOW });
  const view = createConsoleView(store);
  assert.equal(view.deliverability().health, null);
  const html = renderConsole(view, { now: NOW });
  assert.match(html, /No probe has run/);
  assert.doesNotMatch(html, /hostbox\.interchained\.org/);
});

test("the receipt pane renders the causal chain of a real introduction", () => {
  const view = seeded();
  const [introduction] = view.introductions();
  const chain = view.receipt(introduction.matchId);

  assert.equal(chain.length, 6);
  assert.deepEqual(chain.map((node) => node._coll), [
    "introductions",
    "matches",
    "members",
    "members",
    "messages",
    "messages",
  ]);

  const html = renderConsole(view, { now: NOW });
  assert.match(html, /6 nodes/);
});

test("the review queue shows why a job failed twice, and says who resolves it", () => {
  const view = seeded();
  const [review] = view.reviews();
  assert.deepEqual(review.failures.map((f) => f.code), ["UNKNOWN_FACT_ID", "UNAUTHORISED_ADDRESS"]);

  const html = renderConsole(view, { now: NOW });
  assert.match(html, /UNKNOWN_FACT_ID/);
  assert.match(html, /Resolution happens on the CLI/);
});

/* --- what it must not show --------------------------------------------- */

test("no member's correspondence or sources reach the page — §17.3", () => {
  // INV-6 does not stop applying because the reader is an operator.
  const { store } = seedConsoleStore({ now: NOW });
  const repos = createRepositories(store);
  repos.sources.save({
    memberId: "member_dana",
    content: "CONFIDENTIAL RESUME BODY — led infrastructure operations",
    receivedAt: NOW.toISOString(),
  });
  const html = renderConsole(createConsoleView(store, { health: SEED_HEALTH }), { now: NOW });
  assert.doesNotMatch(html, /CONFIDENTIAL RESUME BODY/);
  assert.doesNotMatch(html, /led infrastructure operations/);
});

/* --- rendering hygiene -------------------------------------------------- */

test("values from the outside world are escaped", () => {
  const store = openInMemory();
  const repos = createRepositories(store);
  const job = {
    idempotencyKey: "xss",
    jobId: "xss",
    purpose: "clarification",
    recipients: ['"><script>alert(1)</script>@evil.test'],
    state: "DEAD",
    attempts: 1,
    availableAt: NOW.toISOString(),
    lastError: "<img src=x onerror=alert(1)>",
    history: [],
  };
  repos.outbox.enqueue(job);

  const html = renderConsole(createConsoleView(store), { now: NOW });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("the page is marked no-index, no-store, and carries a restrictive CSP", async () => {
  await withConsole(seeded(), async (base) => {
    const response = await fetch(base);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await response.text(), /noindex,nofollow/);
  });
});

test("HEAD returns headers and no body; unknown paths 404", async () => {
  await withConsole(seeded(), async (base) => {
    const head = await fetch(base, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    assert.equal((await fetch(`${base}/members`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test("healthz fails loudly if the chain does not verify", async () => {
  const view = { ...seeded(), engine: () => ({ verified: false, seq: 12 }) };
  await withConsole(view, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 503);
  });
});
