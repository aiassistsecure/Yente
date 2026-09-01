/**
 * Both parties say yes — Mark, 2026-09-01: "when we find a match we email
 * both parties separately and send them the other users profile cards
 * linkedin resume etc and wait for their approval email, make the LLM read
 * that and decide."
 *
 * Operator confirmation is gate one. It now opens a CONSENT ROUND: each
 * party gets their own letter carrying the OTHER side's evidenced card, the
 * match parks in AWAITING_PARTIES, and the document model reads the replies.
 * Two legible approvals send the joint introduction; one decline kills it;
 * "unclear" moves nothing. Control words stay deterministic and binding.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { drainPartyConsent, interpretConsent, profileCard, renderCard } from "../src/graph/consent.js";
import { drainConfirmedIntroductions } from "../src/graph/introductions.js";
import { composeBlocks, jsonBlock, BLOCK_TAGS } from "../src/protocol/blocks.js";

const T0 = "2026-09-01T18:00:00.000Z";
const T1 = "2026-09-01T18:10:00.000Z";
const HIRER = "person:vapor@expo.test";
const DEV = "person:mark@vibecode.test";

function world() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "I'm hiring a rust backend engineer.",
    receivedAt: T0, meta: { from: "vapor@expo.test" },
  });
  graph.evidence.record({
    kind: "attachment", contentHash: "cv1", text: "MARK EVANS — Rust. Built storage layers.",
    receivedAt: T0, meta: { filename: "mark.pdf" },
  });
  const claim = (subject, predicate, object, extra = {}) => graph.observations.append({
    subject, predicate, object,
    evidenceId: extra.evidenceId ?? "message:m1",
    quote: extra.quote ?? String(object),
    authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9, observedAt: T0,
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });
  claim(HIRER, "is_person", "Mark Allen Evans");
  claim(HIRER, "role", "Co-founder of World Vapor Expo");
  claim(DEV, "is_person", "Mark Evans Jr.", { evidenceId: "attachment:cv1" });
  claim(DEV, "role", "Rust Backend Engineer", { evidenceId: "attachment:cv1" });
  claim(DEV, "capability", "Rust", { evidenceId: "attachment:cv1" });
  claim(DEV, "credential", "linkedin.com/in/markjr", { evidenceId: "attachment:cv1" });
  claim(DEV, "contact", "+1-786-759-5499", { evidenceId: "attachment:cv1" });
  claim(DEV, "proposal:hire_for", "Rust backend engineering roles",
    { evidenceId: "attachment:cv1", attributes: { grade: "exceptional" } });

  const manager = createGraphManager({ graph, actor: "mark", partyApproval: true, now: () => T0 });
  const { match } = graph.matches.propose({
    seeker: HIRER, offerer: DEV, matchType: "hiring_x_hire_for", confidence: 0.8,
    reasons: [{ id: "graded_candidate", detail: "exceptional for rust roles" }],
    conflicts: [],
    evidence: [
      { quote: "I'm hiring a rust backend engineer.", said: "I'm hiring a rust backend engineer." },
      { quote: "Built storage layers.", said: "Built storage layers." },
    ],
    at: T0,
  });
  return { graph, manager, matchId: match.id };
}

/** A reply from a party, landing in the evidence ledger like real mail. */
function reply(graph, n, from, text, at = T1) {
  graph.evidence.record({
    kind: "message", contentHash: `r${n}`, text, receivedAt: at,
    meta: { rfcMessageId: `<r${n}@party.test>`, from, to: ["yente@ccme.network"] },
  });
}

const modelSaying = (decision, quote) => ({
  async complete() {
    return {
      text: composeBlocks(jsonBlock(BLOCK_TAGS.CONSENT, { decision, quote })),
      finishReason: "stop", elapsedMs: 1,
    };
  },
});

test("confirm opens the consent round: two separate letters, each with the OTHER's card", async () => {
  const { graph, manager, matchId } = world();
  const transport = createMemoryTransport();

  const held = manager.confirmMatch({ matchId, note: "looks right" });
  assert.equal(held.state, MATCH_STATES.AWAITING_PARTIES,
    "operator yes no longer sends anything by itself");

  await drainPartyConsent({ graph, manager, transport, now: () => T0 });
  assert.equal(transport.sent.length, 2, "one letter per party, separately");

  const toHirer = transport.sent.find((m) => m.to[0] === "vapor@expo.test");
  const toDev = transport.sent.find((m) => m.to[0] === "mark@vibecode.test");
  assert.ok(toHirer && toDev);

  // The hirer sees the DEV's card — role, capability, linkedin, contact,
  // Yente's grade — and their own ask quoted back.
  assert.match(toHirer.text, /Rust Backend Engineer/);
  assert.match(toHirer.text, /linkedin\.com\/in\/markjr/);
  assert.match(toHirer.text, /\+1-786-759-5499/);
  assert.match(toHirer.text, /exceptional/);
  assert.match(toHirer.text, /I'm hiring a rust backend engineer/);
  assert.doesNotMatch(toHirer.text, /mark@vibecode\.test/,
    "until both say yes, addresses stay with Yente");

  // The dev sees the HIRER's card, not their own.
  assert.match(toDev.text, /Co-founder of World Vapor Expo/);
  assert.doesNotMatch(toDev.text, /vapor@expo\.test/);

  // Idempotent: a second drain resends nothing.
  await drainPartyConsent({ graph, manager, transport, now: () => T0 });
  assert.equal(transport.sent.length, 2);
});

test("two yeses send the joint introduction; the model reads the prose one", async () => {
  const { graph, manager, matchId } = world();
  const transport = createMemoryTransport();
  manager.confirmMatch({ matchId });
  await drainPartyConsent({ graph, manager, transport, now: () => T0 });

  // Hirer answers with a control word; dev answers in prose the model reads.
  reply(graph, 1, "vapor@expo.test", "INTRODUCE — yes please.");
  reply(graph, 2, "mark@vibecode.test", "sounds great, I would love to meet them");
  const consentClient = modelSaying("approve", "sounds great, I would love to meet them");

  await drainPartyConsent({ graph, manager, transport, consentClient, now: () => T1 });
  const held = graph.matches.get(matchId);
  assert.equal(held.state, MATCH_STATES.CONFIRMED, "two legible yeses confirm");
  assert.equal(held.decidedBy, "both parties");
  assert.equal(held.partyDecisions["vapor@expo.test"].decision, "approve");
  assert.equal(held.partyDecisions["mark@vibecode.test"].quote,
    "sounds great, I would love to meet them", "the consent is quoted, on file");

  await drainConfirmedIntroductions({ graph, manager, transport, now: () => T1 });
  const intro = transport.sent.find((m) => m.to.length === 2);
  assert.ok(intro, "the joint introduction went out");
  assert.equal(graph.matches.get(matchId).state, MATCH_STATES.INTRODUCED);
});

test("one PASS kills the match — no introduction, ever", async () => {
  const { graph, manager, matchId } = world();
  const transport = createMemoryTransport();
  manager.confirmMatch({ matchId });
  await drainPartyConsent({ graph, manager, transport, now: () => T0 });

  reply(graph, 1, "vapor@expo.test", "INTRODUCE");
  reply(graph, 2, "mark@vibecode.test", "PASS — not right now");
  await drainPartyConsent({ graph, manager, transport, now: () => T1 });

  const held = graph.matches.get(matchId);
  assert.equal(held.state, MATCH_STATES.REJECTED);
  assert.equal(held.decidedBy, "mark@vibecode.test", "the no is attributed");

  await drainConfirmedIntroductions({ graph, manager, transport, now: () => T1 });
  assert.equal(transport.sent.filter((m) => m.to.length === 2).length, 0);
});

test("an unclear reply moves nothing, and is not re-read on the next pass", async () => {
  const { graph, manager, matchId } = world();
  const transport = createMemoryTransport();
  manager.confirmMatch({ matchId });
  await drainPartyConsent({ graph, manager, transport, now: () => T0 });

  reply(graph, 1, "mark@vibecode.test", "interesting! what company is it?");
  const consentClient = { calls: 0, async complete() { this.calls += 1;
    return { text: composeBlocks(jsonBlock(BLOCK_TAGS.CONSENT,
      { decision: "unclear", quote: "" })), finishReason: "stop", elapsedMs: 1 }; } };

  await drainPartyConsent({ graph, manager, transport, consentClient, now: () => T1 });
  assert.equal(graph.matches.get(matchId).state, MATCH_STATES.AWAITING_PARTIES,
    "a question is not consent");
  const callsAfterFirst = consentClient.calls;
  await drainPartyConsent({ graph, manager, transport, consentClient, now: () => T1 });
  assert.equal(consentClient.calls, callsAfterFirst, "the same reply is read once");
});

test("a chatty consent verdict wrapped in narration still counts", async () => {
  const chatty = {
    async complete() {
      const block = composeBlocks(jsonBlock(BLOCK_TAGS.CONSENT,
        { decision: "approve", quote: "sounds great" }));
      return { text: "Okay, my read:\n```\n" + block + "\n```", finishReason: "stop", elapsedMs: 1 };
    },
  };
  const verdict = await interpretConsent({
    client: chatty, text: "sounds great, set it up", counterpartName: "Dana",
  });
  assert.equal(verdict.decision, "approve",
    "narration around the CONSENT block is transport noise");
});

test("a grounded verdict requires the quote to be IN the reply", async () => {
  const liar = modelSaying("approve", "yes absolutely definitely");
  const verdict = await interpretConsent({
    client: liar, text: "I need to think about it", counterpartName: "Dana",
  });
  assert.equal(verdict.decision, "unclear",
    "a quote the reply does not contain demotes the verdict");
});

test("party approval off: confirm sends immediately, exactly as before", async () => {
  const { graph, matchId } = world();
  const manager = createGraphManager({ graph, actor: "mark", partyApproval: false, now: () => T0 });
  const transport = createMemoryTransport();
  const held = manager.confirmMatch({ matchId });
  assert.equal(held.state, MATCH_STATES.CONFIRMED);
  await drainConfirmedIntroductions({ graph, manager, transport, now: () => T1 });
  assert.equal(transport.sent.filter((m) => m.to.length === 2).length, 1);
});

test("the card renders from evidence and never invents", () => {
  const { graph } = world();
  const card = profileCard(graph, DEV);
  const text = renderCard(card);
  assert.match(text, /Role: Rust Backend Engineer/);
  assert.match(text, /Credentials: linkedin\.com\/in\/markjr/);
  assert.match(text, /Contact: \+1-786-759-5499/);
  assert.match(text, /Yente's read: hire for: Rust backend engineering roles \(exceptional\)/);
});
