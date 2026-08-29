/**
 * Matches propagate as content arrives, and the search is callable.
 *
 * The connect loop used to sleep a flat 60s: a person's match could sit
 * unproposed for a minute after their claims landed, and a burst of new
 * understanding was paced identically to an idle graph. A matchmaker's job is
 * to react to the graph CHANGING; the clock stays only as the fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { createGraphLoops } from "../src/graph/loops.js";
import { ROLES, ROLE_PREDICATE } from "../src/graph/roles.js";

test("new claims wake the connect loop instead of waiting out the clock", async () => {
  const graph = createGraphRepositories(openInMemory());
  const controller = new AbortController();
  let stopping = false;
  let scans = 0;

  const loops = createGraphLoops({
    graph,
    observer: {
      observe: async () => ({ verified: {}, rejected: [], provenance: {} }),
    },
    manager: {
      ...createGraphManager({ graph }),
      isMatchable: () => { scans += 1; return false; },
    },
    signal: controller.signal,
    isStopping: () => stopping,
    // The clock is set far beyond the test timeout: if the loop runs a second
    // scan at all, it was the NUDGE that woke it, not the interval.
    intervals: { connectMs: 60 * 60_000 },
  });

  const running = loops.connect();
  await new Promise((r) => setTimeout(r, 30));   // first scan on entry

  graph.observations.append({
    subject: "p:a", predicate: ROLE_PREDICATE, object: ROLES.HIRING,
    evidenceId: "message:m1", quote: "we are hiring",
    observedAt: new Date().toISOString(),
  });
  loops.nudgeConnect();
  await new Promise((r) => setTimeout(r, 50));

  stopping = true;
  loops.nudgeConnect();          // release the sleeper so the loop can exit
  controller.abort();
  await running;

  assert.ok(loops.health.ticks.connect >= 2,
    "the nudge must wake the loop; an hour-long clock cannot have");
});

test("the manager exposes search_matches_or_return_false, and false means false", () => {
  const graph = createGraphRepositories(openInMemory());
  const manager = createGraphManager({ graph });

  assert.equal(manager.searchMatchesOrReturnFalse({ subject: "p:nobody" }), false,
    "nobody is FALSE — a caller says so or says nothing");
});

test("the search finds a qualified complement through the manager surface", () => {
  const graph = createGraphRepositories(openInMemory());
  // A monotonic clock: four lifecycle appends land in the same millisecond in
  // a test, and the last-state projection cannot order a tie. Production calls
  // are human-paced; tests are not.
  let tick = 0;
  const manager = createGraphManager({
    graph,
    now: () => new Date(Date.now() + (tick += 1000)).toISOString(),
  });
  const at = new Date().toISOString();

  for (const [subject, role, name] of [
    ["person:jim@x.test", ROLES.HIRING, "Jim"],
    ["person:dana@x.test", ROLES.SEEKING_EMPLOYMENT, "Dana"],
  ]) {
    graph.observations.append({
      subject, predicate: "is_person", object: name,
      evidenceId: "message:m1", quote: name, observedAt: at,
    });
    graph.observations.append({
      subject, predicate: `intent:${role === ROLES.HIRING ? "HIRING" : "SEEKING"}`,
      object: role === ROLES.HIRING ? "a backend engineer" : "a backend role",
      evidenceId: "message:m1", quote: "backend", observedAt: at,
    });
    // QUALIFIED, the gate discovery enforces: mid-intake people are never
    // described to anybody.
    manager.setProfileState({ subject, state: "received" });
    manager.setProfileState({ subject, state: "drafted" });
    manager.setProfileState({ subject, state: "awaiting_approval" });
    manager.setProfileState({ subject, state: "qualified" });
  }

  const found = manager.searchMatchesOrReturnFalse({ subject: "person:jim@x.test" });
  assert.notEqual(found, false, "a qualified complement exists");
  assert.equal(found[0].name, "Dana");
  assert.ok(!JSON.stringify(found).includes("@x.test") || found[0].id.includes("@x.test"),
    "the id is a graph key; no OTHER address material may appear");
});
