/**
 * Introduced means introduced — Mark, 2026-09-02 16:40, reading the console
 * header: "11 people · 602 observations · 0 queued · 0 to review ·
 * 0 introduced — but we introduced 2 at least?"
 *
 * Nothing failed. The header (and the /stats header) printed
 * `matches.confirmed` under the word "introduced". CONFIRMED is "the operator
 * said yes, the letter is pending"; the moment the letter goes out the match
 * moves to INTRODUCED and confirmed drops back to zero. The two she made were
 * in `matches.introduced`, which neither header displayed.
 *
 * Now: "introduced" counts INTRODUCED, and a pending letter shows as
 * "sending" while it is pending.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY, MATCH_STATES } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { renderManager, renderStats } from "../web/manager.js";

const T0 = "2026-09-02T20:40:00.000Z";
const A = "person:a@example.test";
const B = "person:b@example.test";
const C = "person:c@example.test";

function world() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({ kind: "message", contentHash: "m1", text: "hi", receivedAt: T0, meta: {} });
  for (const [subject, name] of [[A, "Ann"], [B, "Bob"], [C, "Cy"]]) {
    graph.observations.append({
      subject, predicate: "is_person", object: name, evidenceId: "message:m1", quote: name,
      authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9, observedAt: T0,
    });
  }
  const propose = (seeker, offerer) => graph.matches.propose({
    seeker, offerer, matchType: "hiring_x_hire_for", confidence: 0.8,
    reasons: [], conflicts: [], evidence: [], at: T0,
  }).match;
  const made = [propose(A, B), propose(B, C)];
  const pending = propose(A, C);
  const manager = createGraphManager({ graph, actor: "mark", now: () => T0 });
  for (const m of made) {
    manager.confirmMatch({ matchId: m.id });
    // The real walk: CONFIRMED -> INTRODUCTION_SENDING -> INTRODUCED.
    assert.ok(graph.matches.claimIntroduction(m.id, T0));
    assert.ok(graph.matches.markIntroduced(m.id, { at: T0, messageId: `<intro-${m.id}@test>` }));
  }
  manager.confirmMatch({ matchId: pending.id });
  return { graph, manager };
}

test("the console header counts INTRODUCED as introduced, and a pending letter as sending", () => {
  const { graph, manager } = world();
  assert.equal(graph.matches.all().filter((m) => m.state === MATCH_STATES.INTRODUCED).length, 2);

  const html = renderManager({ manager, health: {} });
  assert.match(html, /<b>2<\/b> introduced/, "two made, two shown");
  assert.match(html, /<b>1<\/b> sending/, "the confirmed-but-unsent one is a letter in flight");
  assert.doesNotMatch(html, /<b>1<\/b> introduced/);
  assert.doesNotMatch(html, /<b>0<\/b> introduced/);
});

test("the /stats header agrees with its own Matches card", () => {
  const { manager } = world();
  const html = renderStats({ stats: manager.stats() });
  assert.match(html, /<b>2<\/b> introduced/);
  assert.doesNotMatch(html, /<b>1<\/b> introduced/, "confirmed is not introduced");
});
