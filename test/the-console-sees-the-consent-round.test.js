/**
 * The console sees the consent round — a free-turn find, 2026-09-01.
 *
 * A match in AWAITING_PARTIES had vanished from the operator's world: gone
 * from the review queue (decided), absent from introduced (it is not), just
 * a number in the tape's tally. Who has been written to, who answered, what
 * they actually said — all on the row, none of it on the page. And the bank
 * lines the graded rounds echo back still spoke full 64-char hashes while
 * the prompt teaches 12-hex short ids; both fixed here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { renderManager } from "../web/manager.js";
import { wireClaimLine } from "../src/intelligence/provider.js";

const T0 = "2026-09-01T19:00:00.000Z";
const HIRER = "person:vapor@expo.test";
const DEV = "person:dev@vibecode.test";

function awaitingWorld() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "hiring rust", receivedAt: T0, meta: {},
  });
  const claim = (subject, predicate, object) => graph.observations.append({
    subject, predicate, object, evidenceId: "message:m1", quote: object,
    authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9, observedAt: T0,
  });
  claim(HIRER, "is_person", "Mark Allen Evans");
  claim(DEV, "is_person", "Dana Ito");

  const manager = createGraphManager({ graph, actor: "mark", partyApproval: true, now: () => T0 });
  const { match } = graph.matches.propose({
    seeker: HIRER, offerer: DEV, matchType: "hiring_x_hire_for", confidence: 0.8,
    reasons: [], conflicts: [], evidence: [], at: T0,
  });
  manager.confirmMatch({ matchId: match.id });
  graph.matches.markPartyPreviewSent(match.id, { address: "vapor@expo.test", at: T0 });
  graph.matches.markPartyPreviewSent(match.id, { address: "dev@vibecode.test", at: T0 });
  graph.matches.recordPartyDecision(match.id, {
    address: "vapor@expo.test", decision: "approve",
    quote: "yes please, make it happen", at: T0,
  });
  return { graph, manager, matchId: match.id };
}

test("awaitingMatches reports both sides: who answered, who is silent, quoted", () => {
  const { manager } = awaitingWorld();
  const [row] = manager.awaitingMatches();
  assert.ok(row, "the consent round is visible to the manager API");

  const hirer = row.sides.find((s) => s.address === "vapor@expo.test");
  const dev = row.sides.find((s) => s.address === "dev@vibecode.test");
  assert.equal(hirer.decision, "approve");
  assert.equal(hirer.quote, "yes please, make it happen");
  assert.equal(hirer.name, "Mark Allen Evans");
  assert.equal(dev.decision, null, "the silent side is visibly silent");
  assert.ok(dev.previewSentAt, "and visibly holding the letter");
});

test("the console page renders the round — quotes, silence, and a withdraw lever", () => {
  const { manager } = awaitingWorld();
  const html = renderManager({ manager, health: {} });

  assert.match(html, /Waiting on the parties/);
  assert.match(html, /said yes/);
  assert.match(html, /yes please, make it happen/);
  assert.match(html, /no legible answer yet/);
  assert.match(html, /awaiting yes/, "the header counts the round");
  assert.match(html, /value="reject"/, "the operator can withdraw it");
});

test("bank lines speak the 12-hex short id the prompt taught, not the full hash", () => {
  const fullHash = "message:" + "ab12".repeat(16); // 64 hex chars
  const line = wireClaimLine("disclosures", {
    subjectRef: "sender", field: "role", value: "Engineer",
    sourceId: fullHash, evidence: "Engineer", explicit: true, confidence: 0.9,
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.source_id, "message:ab12ab12ab12",
    "twelve hex characters, same as the SOURCE block name");
  assert.doesNotMatch(line, /ab12ab12ab12ab12ab12/, "the full hash never appears");
});
