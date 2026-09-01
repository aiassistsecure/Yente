/**
 * The lifecycle lever — why "matches 0" survived every other fix.
 *
 * OBSERVED 2026-09-01: a valid HIRING×hire_for pair sat in the graph and the
 * connect scan scored ZERO observations — because matching only sees
 * QUALIFIED profiles (§20: never introduce people on beliefs they haven't
 * approved), and the manager UI had NO control to move anybody along the
 * lifecycle. The gate was right; the missing lever was not.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { renderProfile, handleManagerRequest } from "../web/manager.js";

const T0 = "2026-09-01T15:00:00.000Z";

function seeded() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);
  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "hi",
    receivedAt: T0, meta: { from: "dana@example.com" },
  });
  graph.observations.append({
    subject: "person:dana@example.com", predicate: "is_person", object: "Dana Ito",
    evidenceId: "message:m1", quote: "Dana Ito", authority: AUTHORITY.MODEL_VERIFIED,
    confidence: 0.9, observedAt: T0,
  });
  return { graph, manager: createGraphManager({ graph, actor: "mark" }) };
}

test("the operator can walk a person to QUALIFIED, and matchable flips", () => {
  const { manager } = seeded();
  const id = "person:dana@example.com";

  assert.equal(manager.isMatchable(id), false, "nobody is matchable by default");
  manager.setProfileState({ subject: id, state: "received", quote: "resume arrived" });
  manager.setProfileState({ subject: id, state: "drafted" });
  manager.setProfileState({ subject: id, state: "awaiting_approval" });
  manager.setProfileState({ subject: id, state: "qualified", quote: "approved by reply, 9/1" });
  assert.equal(manager.profileStateOf(id), "qualified");
  assert.equal(manager.isMatchable(id), true, "QUALIFIED is the only matchable state");
});

test("two transitions in the same millisecond both take, in order", () => {
  // project() returns rows in hash order; with tied observedAt the current
  // state was a coin flip. setProfileState now bumps the clock so a scripted
  // walk (or two quick clicks) can never silently lose a step.
  const { graph } = seeded();
  const manager = createGraphManager({
    graph, actor: "mark", now: () => "2026-09-01T15:00:00.000Z",
  });
  const id = "person:dana@example.com";
  manager.setProfileState({ subject: id, state: "received" });
  manager.setProfileState({ subject: id, state: "drafted" });
  manager.setProfileState({ subject: id, state: "awaiting_approval" });
  manager.setProfileState({ subject: id, state: "qualified" });
  assert.equal(manager.profileStateOf(id), "qualified",
    "a frozen clock cannot make the lifecycle forget a step");
});

test("an illegal jump throws instead of silently qualifying", () => {
  const { manager } = seeded();
  assert.throws(
    () => manager.setProfileState({ subject: "person:dana@example.com", state: "qualified" }),
    /cannot move .* from new to qualified/,
    "new -> qualified skips the person's own approval and is not a legal move");
});

test("the profile page shows the lifecycle and offers only legal next steps", () => {
  const { manager } = seeded();
  const html = renderProfile({ profile: manager.subject("person:dana@example.com") });
  assert.match(html, /<h2>Lifecycle<\/h2>/);
  assert.match(html, /not matchable/);
  assert.match(html, /value="received"/, "new -> received is legal");
  assert.doesNotMatch(html, /<button name="state" value="qualified"/,
    "qualified is NOT offered from new — the lever respects the lifecycle");
});

test("the POST action moves the state and records the operator's note", async () => {
  const { manager } = seeded();
  manager.setProfileState({ subject: "person:dana@example.com", state: "received" });
  manager.setProfileState({ subject: "person:dana@example.com", state: "drafted" });
  manager.setProfileState({ subject: "person:dana@example.com", state: "awaiting_approval" });

  const body = Buffer.from(
    "action=profile_state&subject=person%3Adana%40example.com&state=qualified&note=approved+by+reply");
  const req = {
    method: "POST",
    url: "/?back=%2Fsubject",
    headers: {},
    on(event, callback) {
      if (event === "data") callback(body);
      if (event === "end") callback();
      return req;
    },
  };
  const res = {
    statusCode: null, headers: null, body: "",
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; return res; },
    end(chunk) { res.body += chunk ?? ""; return res; },
  };
  const handled = await handleManagerRequest({ req, res, manager, graph: null, health: {} });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 303, "redirect after POST — refresh must not re-rule");
  assert.equal(manager.profileStateOf("person:dana@example.com"), "qualified");
  assert.equal(manager.isMatchable("person:dana@example.com"), true);
});
