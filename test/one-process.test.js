/**
 * One process, two directories.
 *
 * WHAT WAS WRONG, AND IT WAS MY CODE
 *
 * `openDatabase` threw when asked for a second directory, and the comment above
 * it explained confidently that the engine's exclusive lock made one-process-two-
 * stores impossible. It doesn't. The lock is per DIRECTORY. That false constraint
 * is why the desk and the listener ran as two processes, which is why the landing
 * page counted subscribers in one database while the listener accumulated people
 * in another — a site advertising a founding network the listener had never met.
 *
 * The first test below is therefore the load-bearing one: it measures the claim
 * rather than restating it.
 *
 * WHY THE REST READ SOURCE AS TEXT
 *
 * Same reason as one-database.test.js. The bug class is "the function exists, it
 * is tested, and nothing in production calls it" — invisible to any test that
 * supplies the missing call itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, openDatabases, openInMemory } from "../src/store/db.js";
import { createGraphLoops } from "../src/graph/loops.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* --- the constraint that was not real ----------------------------------- */

test("one process can own two data directories", () => {
  const a = join(tmpdir(), `yente-two-a-${process.pid}`);
  const b = join(tmpdir(), `yente-two-b-${process.pid}`);
  try {
    const first = openDatabase(a);
    const second = openDatabase(b);

    assert.notEqual(first, second, "two paths must give two handles");
    assert.equal(first.path, a);
    assert.equal(second.path, b);

    // Both still writable after the other opened — the lock is per directory,
    // not per process. This is the whole basis for the merge.
    first.put("probe", "one", { ok: true });
    second.put("probe", "two", { ok: true });
    assert.equal(first.get("probe", "one")?.ok, true);
    assert.equal(second.get("probe", "two")?.ok, true);

    assert.ok(openDatabases().length >= 2, "every handle must be flushable on exit");
  } finally {
    for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true });
  }
});

test("the same path twice returns the same handle, not a second lock", () => {
  // Idempotence is the honest shape: the addon has no close, so a second handle
  // on one directory could never be released and would be a split-brain.
  const dir = join(tmpdir(), `yente-same-${process.pid}`);
  try {
    assert.equal(openDatabase(dir), openDatabase(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --- the merged entry point --------------------------------------------- */

test("bin/yente.mjs runs all four loops", () => {
  const src = read("bin/yente.mjs");
  for (const call of ["loops.listen()", "loops.understand()", "loops.connect()", "deskLoop()"]) {
    assert.ok(src.includes(call), `${call} is never started`);
  }
});

test("bin/yente.mjs refuses to point both stores at one directory", () => {
  // Two env vars that happen to agree would interleave a mutable member ledger
  // with append-only evidence in one namespace. One process owning both is the
  // point; sharing a namespace is not.
  const src = read("bin/yente.mjs");
  assert.match(src, /deskPath === graphPath/);
  assert.match(src, /same_data_path/);
});

test("bin/yente.mjs stops accepting requests before it flushes", () => {
  const src = read("bin/yente.mjs");
  const shutdown = src.slice(src.indexOf("async function shutdown"));
  const closed = shutdown.indexOf("server.close");
  const flushed = shutdown.indexOf("closeDatabase(store)");
  assert.ok(closed > -1, "an accepted decision must not be written to a closing store");
  assert.ok(closed < flushed, "close listeners, then flush");
  assert.match(shutdown, /openDatabases\(\)/,
    "BOTH stores must be flushed, not just one — the second was invisible before");
});

test("a degraded desk does not take the listener down", () => {
  // No SMTP means she cannot send. She can still listen, understand and match,
  // and a listener stopped because the transport failed would be a worse outage.
  const src = read("bin/yente.mjs");
  const block = src.slice(src.indexOf("transport_failed"), src.indexOf("transport_failed") + 400);
  assert.match(block, /listener is unaffected|keeps running|without/i);
  assert.ok(!/process\.exit/.test(block), "a missing transport must not exit the process");
});

test("the entry points share one implementation of the loops", () => {
  // A loop that exists in two files is a loop that gets fixed once.
  for (const entry of ["bin/graph.mjs", "bin/yente.mjs"]) {
    const src = read(entry);
    assert.match(src, /createGraphLoops\(/, `${entry} must compose the shared loops`);
    assert.ok(!/async function listenLoop/.test(src),
      `${entry} still carries its own copy of LISTEN`);
  }
});

/* --- behaviour: the loops are constructible outside a process ----------- */

test("the loops can be built and stopped without a mailbox", () => {
  // `source: null` is a supported state, not an error: the understand and connect
  // loops still have work to do over whatever is already in the graph, so a box
  // with no mail credentials can drain a backlog. Refusing to start would turn a
  // partial outage into a total one.
  const graph = createGraphRepositories(openInMemory());
  const loops = createGraphLoops({
    graph,
    source: null,
    observer: { observe: async () => ({ verified: [], rejected: [], provenance: {} }) },
    manager: createGraphManager({ graph }),
    signal: new AbortController().signal,
    isStopping: () => true,
  });

  assert.equal(typeof loops.listen, "function");
  assert.equal(loops.health.consecutiveMailFailures, 0);
  assert.equal(typeof loops.mailSilenceMinutes(), "number");
});

test("mail silence is measured from the last SUCCESS, not from startup", () => {
  // The failure that cost two days was not that IMAP broke; it was that nothing
  // said so. If this counted from startup it would reset on every restart —
  // which is exactly when somebody is most likely to be looking at it.
  const graph = createGraphRepositories(openInMemory());
  const loops = createGraphLoops({
    graph,
    observer: { observe: async () => ({}) },
    manager: createGraphManager({ graph }),
    signal: new AbortController().signal,
    isStopping: () => true,
  });

  loops.health.lastMailAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  assert.equal(loops.mailSilenceMinutes(), 180);
});
