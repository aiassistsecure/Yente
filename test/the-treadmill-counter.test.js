/**
 * The treadmill counter — live tape, 2026-09-01 16:32–16:40:
 *
 *   16:32:34 CONNECT 3 candidates queued  pending_review=3   matches 3
 *   16:33:42 CONNECT 3 candidates queued  pending_review=3   matches 6
 *   ...
 *   16:40:37 CONNECT 3 candidates queued  pending_review=3   matches 27
 *
 * The SAME three pairs, re-announced every scan, climbing the operator's
 * matches counter on zero new information. propose() was idempotent in
 * storage — one row per pair, correctly refreshed — but it could not say
 * whether the pair was NEW, so the loop counted every re-scoring as a
 * queueing. `fresh` is that answer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES } from "../src/store/graph.js";

const T0 = "2026-09-01T16:32:34.000Z";
const T1 = "2026-09-01T16:33:42.000Z";

const PAIR = {
  seeker: "person:vapor@expo.com",
  offerer: "person:mark@vibecode.com",
  matchType: "hiring_x_hire_for",
  confidence: 0.75,
  reasons: [{ id: "graded_candidate" }],
  conflicts: [],
  evidence: [],
};

test("the first proposal of a pair is fresh; every rescan of it is not", () => {
  const graph = createGraphRepositories(openInMemory());

  const first = graph.matches.propose({ ...PAIR, at: T0 });
  assert.equal(first.fresh, true, "the queue has never held this pair — news");
  assert.equal(first.decided, false);

  const rescan = graph.matches.propose({ ...PAIR, confidence: 0.8, at: T1 });
  assert.equal(rescan.fresh, false, "same pair still awaiting review — not news");
  assert.equal(rescan.decided, false, "and still undecided, so still refreshable");
  assert.equal(rescan.match.confidence, 0.8,
    "the rescan still refreshes the score — silence, not stasis");
  assert.equal(rescan.match.proposedAt, T0, "first sighting is preserved");
});

test("a decided pair is neither fresh nor reopened", () => {
  const graph = createGraphRepositories(openInMemory());
  const { match } = graph.matches.propose({ ...PAIR, at: T0 });
  graph.matches.decide({ matchId: match.id, state: MATCH_STATES.REJECTED, by: "mark", at: T0 });

  const again = graph.matches.propose({ ...PAIR, at: T1 });
  assert.equal(again.decided, true, "a human ruling stands");
  assert.equal(again.fresh, false);
  assert.equal(again.match.state, MATCH_STATES.REJECTED);
});

test("ten scans of an unchanged graph queue a pair exactly once", () => {
  const graph = createGraphRepositories(openInMemory());
  let queued = 0;
  for (let scan = 0; scan < 10; scan += 1) {
    const { fresh } = graph.matches.propose({ ...PAIR, at: new Date().toISOString() });
    if (fresh) queued += 1;
  }
  assert.equal(queued, 1, "the tape announces a pair the day it appears, then holds its tongue");
});
