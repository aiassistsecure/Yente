/**
 * Nobody clicks a lifecycle — Mark, 2026-09-01: "you need to fix the damn
 * code to automate matching, I know I can manually match it but thats not
 * what I want."
 *
 * Intake is autonomous by standing directive; the human gate is the
 * INTRODUCTION review queue. autoQualify() promotes every subject the graph
 * can stand behind to QUALIFIED — and refuses the ones it cannot:
 * unnamed subjects, intake-only intents, thin profiles, the excluded,
 * and above all the DECLINED. No is no, even to a robot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { proposeIntroductions } from "../src/graph/matching.js";

const T0 = "2026-09-01T16:00:00.000Z";

function seeded() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);
  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "hi",
    receivedAt: T0, meta: { from: "x" },
  });
  const claim = (subject, predicate, object, extra = {}) => graph.observations.append({
    subject, predicate, object,
    evidenceId: "message:m1", quote: extra.quote ?? String(object),
    authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9, observedAt: T0,
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });
  const manager = createGraphManager({ graph, actor: "test" });
  return { graph, manager, claim };
}

/** The live shape: Manfred, 13 claims, hiring, sat at `new` forever. */
function manfred(claim) {
  claim("person:president@worldvaporexpo.com", "is_person", "Manfred Winnipeg");
  claim("person:president@worldvaporexpo.com", "role", "Co-founder of World Vapor Expo");
  claim("person:president@worldvaporexpo.com", "employer", "World Vapor Expo llc.");
  claim("person:president@worldvaporexpo.com", "intent:HIRING", "rust backend engineer",
    { quote: "I'm hiring a rust backend engineer." });
}

test("a named person with substance is promoted to QUALIFIED, no clicks", () => {
  const { manager, claim } = seeded();
  manfred(claim);

  const promoted = manager.autoQualify();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].subject, "person:president@worldvaporexpo.com");
  assert.equal(manager.profileStateOf("person:president@worldvaporexpo.com"), "qualified");
  assert.equal(manager.isMatchable("person:president@worldvaporexpo.com"), true);

  assert.deepEqual(manager.autoQualify(), [], "idempotent — one promotion, ever");
});

test("a graded proposal is substance too — the resume path qualifies itself", () => {
  const { manager, claim } = seeded();
  claim("person:mark@vibecode.com", "is_person", "Mark Evans Jr.");
  claim("person:mark@vibecode.com", "capability", "Rust");
  claim("person:mark@vibecode.com", "proposal:hire_for", "Rust backend engineering roles",
    { attributes: { grade: "exceptional" } });
  // Their only intent is intake noise — the proposal carries them anyway.
  claim("person:mark@vibecode.com", "intent:SEEKING", "confirmation of resume receipt");

  assert.equal(manager.autoQualify().length, 1);
  assert.equal(manager.isMatchable("person:mark@vibecode.com"), true);
});

test("the refusals hold: unnamed, intake-only, thin, excluded, declined", () => {
  const { manager, claim } = seeded();

  // Unnamed: intents but no is_person.
  claim("person:ghost@x.com", "intent:HIRING", "rust engineers");
  claim("person:ghost@x.com", "employer", "Ghost LLC");
  claim("person:ghost@x.com", "geography", "US");

  // Intake-only intent, no proposal.
  claim("person:thin@x.com", "is_person", "Thin Person");
  claim("person:thin@x.com", "intent:SEEKING", "confirmation of resume receipt");
  claim("person:thin@x.com", "geography", "US");

  // Too few claims.
  claim("person:tiny@x.com", "is_person", "Tiny");
  claim("person:tiny@x.com", "intent:HIRING", "designers");

  // Declined said no.
  claim("person:no@x.com", "is_person", "Said No");
  claim("person:no@x.com", "intent:HIRING", "rust engineers");
  claim("person:no@x.com", "employer", "No Corp");
  manager.setProfileState({ subject: "person:no@x.com", state: "declined" });

  // Excluded by the operator.
  claim("person:out@x.com", "is_person", "Ruled Out");
  claim("person:out@x.com", "intent:HIRING", "rust engineers");
  claim("person:out@x.com", "employer", "Out Corp");
  manager.excludeSubject({ subject: "person:out@x.com", note: "test" });

  assert.deepEqual(manager.autoQualify(), [], "nobody above earns promotion");
  assert.equal(manager.profileStateOf("person:no@x.com"), "declined", "no is no");
});

test("end to end: two auto-qualified strangers become the first match", () => {
  const { graph, manager, claim } = seeded();
  manfred(claim);
  claim("person:mark@vibecode.com", "is_person", "Mark Evans Jr.");
  claim("person:mark@vibecode.com", "capability", "Rust");
  claim("person:mark@vibecode.com", "proposal:hire_for", "Rust backend engineering roles",
    { quote: "Built the distributed storage layer in Rust.",
      attributes: { grade: "exceptional" } });

  assert.equal(manager.autoQualify().length, 2, "both strangers promoted");

  // The connect scan's own filter, then the matcher — no operator anywhere.
  const observations = graph.observations.all()
    .filter((row) => manager.isMatchable(row.subject));
  const matches = proposeIntroductions({ observations });
  assert.ok(matches.length >= 1, "the first introduction proposes itself");
  const match = matches.find((m) => m.matchType === "hiring_x_hire_for");
  assert.ok(match, "the graded-candidate arm fired");
  assert.equal(match.seeker, "person:president@worldvaporexpo.com");
  assert.equal(match.offerer, "person:mark@vibecode.com");
});
