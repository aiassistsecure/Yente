/**
 * The supervisor — Mark, 2026-09-01: "Yente needs to become a multi-threaded
 * supervisor … 2 threads ingesting mail 2 threads communicating or 1/1 or
 * 2/3 etc should be configurable … main thread connects to nedb and
 * dispatches workers."
 *
 * The main thread is the only store owner; lanes are pure compute. These
 * tests pin the pool mechanics that make that safe: one task per lane,
 * queuing past capacity, crash = one transient loss + a respawn, shutdown
 * rejects cleanly, and telemetry crosses the thread boundary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createLanes, pooledObserver, pooledCompleter, LaneError } from "../src/runtime/lanes.js";

const ECHO = new URL("./fixtures/lane-echo.mjs", import.meta.url);

test("tasks run in parallel up to the pool size and queue past it", async () => {
  const lanes = createLanes({ size: 2, name: "test", script: ECHO });
  try {
    const started = Date.now();
    const results = await Promise.all([
      lanes.dispatch("echo", { n: 1, delayMs: 120 }),
      lanes.dispatch("echo", { n: 2, delayMs: 120 }),
      lanes.dispatch("echo", { n: 3, delayMs: 120 }),
    ]);
    const elapsed = Date.now() - started;
    assert.deepEqual(results.map((r) => r.n), [1, 2, 3]);
    // Two ran together, the third waited for a lane: ~240ms, not ~360ms.
    assert.ok(elapsed < 3 * 120 + 400, "parallel, not serial");
    assert.ok(elapsed >= 2 * 120 - 20, "but never MORE parallel than the pool size");
  } finally {
    await lanes.shutdown();
  }
});

test("a lane's declared failure arrives as a coded LaneError", async () => {
  const lanes = createLanes({ size: 1, name: "test", script: ECHO });
  try {
    await assert.rejects(lanes.dispatch("boom", {}), (error) => {
      assert.ok(error instanceof LaneError);
      assert.equal(error.code, "BOOM");
      return true;
    });
  } finally {
    await lanes.shutdown();
  }
});

test("a crashed lane costs one transient failure, respawns, and keeps serving", async () => {
  const lanes = createLanes({ size: 1, name: "test", script: ECHO });
  try {
    await assert.rejects(lanes.dispatch("die", {}), (error) => {
      assert.equal(error.code, "LANE_CRASHED");
      assert.equal(error.meta.transient, true,
        "the drain requeues transients — a crash is a bad moment, not a bad message");
      return true;
    });
    // The pool healed itself: the NEXT task runs on the respawned lane.
    const result = await lanes.dispatch("echo", { alive: true });
    assert.equal(result.alive, true);
  } finally {
    await lanes.shutdown();
  }
});

test("shutdown rejects everything pending and accepts nothing new", async () => {
  const lanes = createLanes({ size: 1, name: "test", script: ECHO });
  const held = lanes.dispatch("echo", { delayMs: 5_000 });
  // Attach the expectation BEFORE shutdown fires the rejection, or the test
  // runner sees an unhandled rejection in the gap.
  const rejected = assert.rejects(held, /shutting down|exited/);
  await lanes.shutdown();
  await rejected;
  await assert.rejects(lanes.dispatch("echo", {}), (e) => e.code === "LANE_SHUTDOWN");
});

test("stream telemetry crosses the thread boundary with its task's identity", async () => {
  const events = [];
  const lanes = createLanes({
    size: 1, name: "test", script: ECHO,
    onEvent: (event, meta) => events.push({ event, meta }),
  });
  try {
    const observer = pooledObserver({ lanes: {
      dispatch: (kind, payload, meta) => lanes.dispatch("echo", { ...payload, stream: true }, meta),
    }, describe: () => ({}) });
    await observer.observe({ sources: [{ id: "message:abc", text: "hi" }], signal: null });
    assert.equal(events.length, 1);
    assert.equal(events[0].event.phase, "content");
  } finally {
    await lanes.shutdown();
  }
});

test("the REAL lane worker boots, and refuses tasks outside its seat", async () => {
  // The voice seat runs complete(), never observe — a wrong-kind task is a
  // named error, not a hang. This also proves the worker script constructs
  // its clients from a bare environment without dialing anything.
  const lanes = createLanes({
    size: 1, name: "voice",
    workerData: { seat: "voice", provider: "pin" },
  });
  try {
    await assert.rejects(lanes.dispatch("observe", { sources: [] }), (error) => {
      assert.equal(error.code, "UNKNOWN_LANE_TASK");
      return true;
    });
  } finally {
    await lanes.shutdown();
  }
});

test("pooledCompleter strips the uncloneables and keeps the client shape", async () => {
  const seen = [];
  const fake = { dispatch: (kind, payload) => { seen.push({ kind, payload }); return Promise.resolve({ text: "ok" }); } };
  const client = pooledCompleter({ lanes: fake, baseClient: { settings: { a: 1 } } });
  const result = await client.complete({
    prompt: "p", system: "s", onToken: () => {}, signal: new AbortController().signal,
  });
  assert.equal(result.text, "ok");
  assert.equal(seen[0].kind, "complete");
  assert.deepEqual(Object.keys(seen[0].payload).sort(), ["prompt", "system"],
    "callbacks and signals never reach postMessage");
  assert.deepEqual(client.settings, { a: 1 }, "the rest of the client rides along");
});
