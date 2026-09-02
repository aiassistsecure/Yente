/**
 * One letter per side — live, 2026-09-02 18:02: both parties received their
 * preview TWICE, two seconds apart.
 *
 *   party_preview_sent to=president@…   18:02:06
 *   party_preview_sent to=president@…   18:02:08
 *   party_preview_sent to=electronerodev 18:02:09
 *   party_preview_sent to=electronerodev 18:02:11
 *
 * Not two processes, not two lanes, not NEDB — one thread, two ENTRANTS.
 * The manager's confirm hook and the connect tick both ran drainPartyConsent
 * on the same match; each read an empty previews map, each awaited
 * transport.send(), and the "sent" mark was written AFTER the await — so
 * both sends happened before either mark. The classic await-window race.
 *
 * Two fixes, each sufficient alone:
 *   1. claim-before-send: a synchronous read-modify-write claims the slot
 *      BEFORE any await; the second entrant finds it taken and skips.
 *      Failure releases the claim; a crash between claim and send is
 *      released at boot (releaseStrandedPartyPreviews).
 *   2. a drain latch: two concurrent drainPartyConsent calls share one run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { drainPartyConsent } from "../src/graph/consent.js";

const T0 = "2026-09-02T18:02:00.000Z";
const A = "person:president@worldvaporexpo.test";
const B = "person:electronerodev@gmail.test";

function awaiting() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({ kind: "message", contentHash: "m1", text: "hi", receivedAt: T0, meta: {} });
  for (const [subject, name] of [[A, "Mark Allen Evans"], [B, "Mark Evans Jr."]]) {
    graph.observations.append({
      subject, predicate: "is_person", object: name, evidenceId: "message:m1", quote: name,
      authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9, observedAt: T0,
    });
  }
  const manager = createGraphManager({ graph, actor: "mark", partyApproval: true, now: () => T0 });
  const { match } = graph.matches.propose({
    seeker: A, offerer: B, matchType: "hiring_x_hire_for", confidence: 0.8,
    reasons: [], conflicts: [], evidence: [], at: T0,
  });
  manager.confirmMatch({ matchId: match.id });
  return { graph, manager, matchId: match.id };
}

/** A transport whose send() yields to the event loop — the real SMTP shape. */
function slowTransport() {
  const sent = [];
  return {
    sent,
    async send(message) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sent.push(message);
      return { messageId: message.messageId };
    },
  };
}

test("two concurrent drains of the same match send each letter exactly once", async () => {
  const { graph, manager } = awaiting();
  const transport = slowTransport();

  // The live shape: the confirm hook and the connect tick, same instant.
  await Promise.all([
    drainPartyConsent({ graph, manager, transport, now: () => T0 }),
    drainPartyConsent({ graph, manager, transport, now: () => T0 }),
  ]);

  const perAddress = {};
  for (const m of transport.sent) perAddress[m.to[0]] = (perAddress[m.to[0]] ?? 0) + 1;
  assert.deepEqual(perAddress, {
    "president@worldvaporexpo.test": 1,
    "electronerodev@gmail.test": 1,
  }, "one letter per side, however many hands reach for the outbox");
});

test("the claim is taken before the send, so an interleaved pass skips it", async () => {
  const { graph, manager, matchId } = awaiting();
  // Simulate the first entrant mid-send: the slot is claimed, not yet sent.
  assert.ok(graph.matches.claimPartyPreview(matchId, {
    address: "president@worldvaporexpo.test", at: T0,
  }));
  assert.equal(graph.matches.claimPartyPreview(matchId, {
    address: "president@worldvaporexpo.test", at: T0,
  }), null, "a second claim on a held slot is refused");

  const transport = slowTransport();
  await drainPartyConsent({ graph, manager, transport, now: () => T0 });
  const to = transport.sent.map((m) => m.to[0]);
  assert.deepEqual(to, ["electronerodev@gmail.test"],
    "the held side is left alone; the free side is served");
});

test("a failed send releases the claim; a sent slot is never unmarked", async () => {
  const { graph, manager, matchId } = awaiting();
  const failing = {
    sent: [],
    async send() { throw new Error("SMTP 451 greylisted"); },
  };
  await drainPartyConsent({ graph, manager, transport: failing, now: () => T0 });
  const held = graph.matches.get(matchId);
  assert.deepEqual(held.previews, {}, "nothing sent, nothing held — the next pass retries");

  // Now succeed, then try to release the sent slot: refused.
  const ok = slowTransport();
  await drainPartyConsent({ graph, manager, transport: ok, now: () => T0 });
  assert.equal(ok.sent.length, 2);
  graph.matches.releasePartyPreview(matchId, { address: "president@worldvaporexpo.test" });
  assert.ok(graph.matches.get(matchId).previews["president@worldvaporexpo.test"].sentAt,
    "sent is sent — a release cannot unmark it");
});

test("a claim stranded by a crash is released at boot, and sent slots survive", () => {
  const { graph, matchId } = awaiting();
  graph.matches.claimPartyPreview(matchId, { address: "president@worldvaporexpo.test", at: T0 });
  graph.matches.markPartyPreviewSent(matchId, { address: "electronerodev@gmail.test", at: T0 });

  assert.equal(graph.matches.releaseStrandedPartyPreviews(), 1);
  const previews = graph.matches.get(matchId).previews;
  assert.equal(previews["president@worldvaporexpo.test"], undefined, "the stranded claim is freed");
  assert.ok(previews["electronerodev@gmail.test"].sentAt, "the sent slot is untouched");
  assert.equal(graph.matches.get(matchId).state, MATCH_STATES.AWAITING_PARTIES);
});
