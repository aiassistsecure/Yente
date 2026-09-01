/**
 * "Never more than five live introductions." — the front page, verbatim.
 *
 * Until 2026-09-01 nothing in the tree enforced it: no cap, no counter, a
 * marketing sentence floating free of the code. Mark's law — a false claim
 * is a build order — so the cap now exists in BOTH arms, from one constant:
 *
 *   desk   proposeMatches skips a pair when either side already has five
 *          matches mid-process (previews, veto window, queued to introduce);
 *   graph  confirmMatch refuses to make a sixth live (awaiting consent,
 *          confirmed-unsent, mid-send), and the manager surfaces the refusal.
 *
 * Completed introductions and refusals do not count — the cap protects a
 * person's attention, not their history.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LIVE_INTRODUCTIONS } from "../src/domain/policies.js";
import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";

const T0 = "2026-09-01T18:30:00.000Z";
const BUSY = "person:busy@founder.test";

function graphWithLiveMatches(count, state = MATCH_STATES.AWAITING_PARTIES) {
  const graph = createGraphRepositories(openInMemory());
  for (let n = 0; n < count; n += 1) {
    const { match } = graph.matches.propose({
      seeker: BUSY, offerer: `person:other${n}@net.test`,
      matchType: "hiring_x_hire_for", confidence: 0.7,
      reasons: [], conflicts: [], evidence: [], at: T0,
    });
    if (state === MATCH_STATES.AWAITING_PARTIES) {
      graph.matches.awaitParties(match.id, { by: "mark", at: T0 });
    } else {
      graph.matches.decide({ matchId: match.id, state, by: "mark", at: T0 });
    }
  }
  return graph;
}

test("the promise is five, from one constant both arms read", () => {
  assert.equal(MAX_LIVE_INTRODUCTIONS, 5);
});

test("a sixth live introduction is refused, and says whose capacity is full", () => {
  const graph = graphWithLiveMatches(5);
  const manager = createGraphManager({ graph, actor: "mark", partyApproval: true });
  const { match } = graph.matches.propose({
    seeker: BUSY, offerer: "person:sixth@net.test",
    matchType: "hiring_x_hire_for", confidence: 0.9,
    reasons: [], conflicts: [], evidence: [], at: T0,
  });

  const result = manager.confirmMatch({ matchId: match.id });
  assert.equal(result.refused, "at_capacity");
  assert.equal(result.side, BUSY, "the refusal names whose plate is full");
  assert.equal(graph.matches.get(match.id).state, MATCH_STATES.PROPOSED,
    "the match stays in the review queue — refused, not destroyed");
});

test("history does not count: five INTRODUCED matches leave every slot free", () => {
  const graph = graphWithLiveMatches(5, MATCH_STATES.CONFIRMED);
  // Complete all five: confirmed -> introduced.
  for (const row of graph.matches.byState(MATCH_STATES.CONFIRMED)) {
    graph.matches.claimIntroduction(row.id ?? row._id, T0);
    graph.matches.markIntroduced(row.id ?? row._id, { at: T0, messageId: "<m@x>" });
  }
  const manager = createGraphManager({ graph, actor: "mark", partyApproval: false });
  const { match } = graph.matches.propose({
    seeker: BUSY, offerer: "person:next@net.test",
    matchType: "hiring_x_hire_for", confidence: 0.9,
    reasons: [], conflicts: [], evidence: [], at: T0,
  });
  const confirmed = manager.confirmMatch({ matchId: match.id });
  assert.equal(confirmed.state, MATCH_STATES.CONFIRMED,
    "a person who finished five introductions may absolutely start a sixth");
});

test("a decline frees the slot the same moment", () => {
  const graph = graphWithLiveMatches(5);
  const manager = createGraphManager({ graph, actor: "mark", partyApproval: true });

  // One of the five dies: the busy founder declines it.
  const [victim] = graph.matches.byState(MATCH_STATES.AWAITING_PARTIES);
  graph.matches.markPartyPreviewSent(victim.id ?? victim._id, { address: "busy@founder.test", at: T0 });
  graph.matches.recordPartyDecision(victim.id ?? victim._id, {
    address: "busy@founder.test", decision: "decline", at: T0,
  });

  const { match } = graph.matches.propose({
    seeker: BUSY, offerer: "person:sixth@net.test",
    matchType: "hiring_x_hire_for", confidence: 0.9,
    reasons: [], conflicts: [], evidence: [], at: T0,
  });
  const result = manager.confirmMatch({ matchId: match.id });
  assert.equal(result.state, MATCH_STATES.AWAITING_PARTIES,
    "four live plus one dead is room for one more");
});
