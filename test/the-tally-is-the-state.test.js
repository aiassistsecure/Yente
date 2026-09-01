/**
 * The tally is the state — Mark, 2026-09-01: "why does yente say 0 matches
 * (its misleading) isnt there a tally?"
 *
 * The dashboard's `matches` was a per-session counter of pairs queued since
 * THIS process booted. Reboot over a review queue holding three and it read
 * "matches 0" — technically counting, practically lying. The connect scan
 * now reports the standing tally read from the graph (pending / confirmed /
 * introduced) and the dashboard renders that: absolute, reboot-proof.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger } from "../src/log.js";
import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES } from "../src/store/graph.js";

function capture(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return written.join("");
}

const graphStub = { jobs: { counts: () => ({ READY: 0, RUNNING: 0 }) } };
const health = { consecutiveMailFailures: 0 };
const beat = (logger) => capture(() =>
  logger.heartbeat({ graph: graphStub, health, mailSilenceMinutes: 1 }));

test("the dashboard shows the standing tally, not the session's", () => {
  const logger = createLogger();

  // A fresh boot over a graph that already holds three pending pairs: the
  // tally event carries state, and the dashboard repeats it verbatim.
  capture(() => logger.log("info", "match_tally", { pending: 3, confirmed: 0, introduced: 0 }));
  assert.match(beat(logger), /matches 3 to review/,
    "a reboot must not zero a queue that still holds three");

  // A ruling and two introductions later, the same line tells the new truth.
  capture(() => logger.log("info", "match_tally", { pending: 1, confirmed: 1, introduced: 2 }));
  const out = beat(logger);
  assert.match(out, /matches 1 to review/);
  assert.match(out, /1 confirmed/);
  assert.match(out, /2 made/);
});

test("an empty desk says 0 to review and keeps the rest off the line", () => {
  const logger = createLogger();
  capture(() => logger.log("info", "match_tally", { pending: 0, confirmed: 0, introduced: 0 }));
  const out = beat(logger);
  assert.match(out, /matches 0 to review/);
  assert.doesNotMatch(out, /confirmed/, "zero confirmed is not worth ink");
  assert.doesNotMatch(out, /made/, "zero introductions either");
});

test("the tally event itself is silent — the dashboard is where a tally lives", () => {
  const logger = createLogger();
  const out = capture(() =>
    logger.log("info", "match_tally", { pending: 3, confirmed: 0, introduced: 0 }));
  assert.equal(out, "", "no per-scan line; the state shows on the next heartbeat");
});

test("byState answers the tally the connect scan reads", () => {
  const graph = createGraphRepositories(openInMemory());
  const at = "2026-09-01T16:47:03.000Z";
  const pair = (n) => ({
    seeker: `person:seeker${n}@a.test`, offerer: `person:offer${n}@b.test`,
    matchType: "hiring_x_hire_for", confidence: 0.7,
    reasons: [], conflicts: [], evidence: [], at,
  });
  graph.matches.propose(pair(1));
  graph.matches.propose(pair(2));
  const { match } = graph.matches.propose(pair(3));
  graph.matches.decide({ matchId: match.id, state: MATCH_STATES.CONFIRMED, by: "mark", at });

  assert.equal(graph.matches.byState(MATCH_STATES.PROPOSED).length, 2);
  assert.equal(graph.matches.byState(MATCH_STATES.CONFIRMED).length, 1);
  assert.equal(graph.matches.byState(MATCH_STATES.INTRODUCED).length, 0);
});
