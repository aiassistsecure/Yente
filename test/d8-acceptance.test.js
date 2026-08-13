/**
 * D8 — end-to-end acceptance, SPEC v2 §14.
 *
 * D1–D7 are unit gates. This is the only one that says the product exists:
 *
 *   Given Bob emails Yente with professional material and completes the
 *   interview, and an employer member has previously emailed with an evidenced
 *   need, and both qualify under the same active match policy —
 *
 *   then the deterministic engine produces a bidirectional match, both receive
 *   separate private previews, neither vetoes, exactly ONE shared introduction
 *   is sent to both, it asks them to reply-all, and Yente does nothing further.
 *
 * Real engine, real repositories, real domain functions, real state machines.
 * The transport is in-memory and the model is a real HTTP server returning a
 * scripted extraction — see src/mail/transport.js for why that boundary is the
 * honest one rather than a convenience.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { buildProfileView } from "../src/store/profile-view.js";
import { createRepositories } from "../src/store/repositories.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";
import { createModelClient } from "../src/llm/client.js";
import { startSseServer } from "../test-support/sse-server.mjs";
import {
  matchPolicy,
  memberQualificationPolicy,
  opportunityQualificationPolicy,
} from "../test-support/fixtures.js";

const T = (minutes) => new Date(Date.parse("2026-08-12T09:00:00.000Z") + minutes * 60_000).toISOString();

const BOB_RESUME = [
  "Bob Ferrand",
  "Technical operator, US remote.",
  "",
  "Led infrastructure operations for a B2B SaaS platform serving 400 machines.",
  "Scaled the platform team from four engineers to eleven over two years.",
  "Looking for an operating role where I own infrastructure end to end.",
].join("\n");

/** What a grounded extraction looks like: every excerpt is verbatim from above. */
const EXTRACTION = (sourceId) =>
  [
    "<<<PROFILE_FACTS>>>",
    JSON.stringify({
      facts: [
        { field: "professional.roles", value: "technical_operator", source_id: sourceId, evidence: "Technical operator, US remote.", explicit: true, confidence: "certain" },
        { field: "professional.capabilities", value: "infrastructure_operations", source_id: sourceId, evidence: "Led infrastructure operations for a B2B SaaS platform", explicit: true, confidence: "certain" },
        { field: "professional.industries", value: "b2b_saas", source_id: sourceId, evidence: "a B2B SaaS platform serving 400 machines", explicit: true, confidence: "certain" },
        { field: "professional.geographies", value: "us_remote", source_id: sourceId, evidence: "Technical operator, US remote.", explicit: true, confidence: "certain" },
        { field: "intent.seeks", value: "operating_role", source_id: sourceId, evidence: "Looking for an operating role where I own infrastructure", explicit: true, confidence: "certain" },
        // Deliberately ungrounded: the model inventing a fact it cannot quote.
        // D8 must survive one of these without storing it.
        { field: "professional.capabilities", value: "fundraising", source_id: sourceId, evidence: "Raised a Series B of forty million dollars", explicit: true, confidence: "certain" },
      ],
    }),
    "<<<END>>>",
    "",
  ].join("\n");

const BOB_PROFILE = {
  professional: {
    roles: ["technical_operator"],
    capabilities: ["infrastructure_operations", "scaling_teams"],
    industries: ["b2b_saas"],
    geographies: ["us_remote"],
  },
  intent: { offers: ["infrastructure_leadership"], seeks: ["operating_role"], introductionTypes: ["employer"] },
  evidenceByField: {
    "professional.roles": ["f1"],
    "professional.capabilities": ["f2"],
    "professional.industries": ["f3"],
    "professional.geographies": ["f4"],
    "intent.seeks": ["f5"],
    "intent.introductionTypes": ["f6"],
  },
  disclosure: {
    displayName: "Bob Ferrand",
    summary: "A technical operator with evidenced infrastructure operations experience in B2B SaaS.",
  },
};

const EMPLOYER = {
  id: "alice@northwindlog.com",
  memberId: "alice@northwindlog.com",
  inboundEstablishedAt: T(0),
  state: "ACTIVE",
  types: ["employer"],
  needs: {
    requiredCapabilities: ["infrastructure_operations"],
    industries: ["b2b_saas"],
    geographies: ["us_remote"],
  },
  offers: ["operating_role"],
  discussionTopic: "the infrastructure Northwind is rebuilding and who would own it",
  disclosure: {
    displayName: "Alice Chen",
    summary: "Northwind Logistics is hiring an infrastructure lead for a B2B SaaS platform.",
  },
  evidenceByField: {
    types: ["e1"],
    "needs.requiredCapabilities": ["e2"],
    "needs.industries": ["e3"],
    "needs.geographies": ["e4"],
    offers: ["e5"],
  },
};

const EMPLOYER_PROFILE = {
  professional: {
    roles: ["hiring_manager"],
    capabilities: ["infrastructure_operations"],
    industries: ["b2b_saas"],
    geographies: ["us_remote"],
  },
  intent: { offers: ["operating_role"], seeks: ["operating_role"], introductionTypes: ["employer"] },
  evidenceByField: {
    "professional.roles": ["e1"],
    "professional.capabilities": ["e2"],
    "professional.industries": ["e3"],
    "professional.geographies": ["e4"],
    "intent.seeks": ["e5"],
    "intent.introductionTypes": ["e6"],
  },
  disclosure: EMPLOYER.disclosure,
};

async function harness() {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const transport = createMemoryTransport();
  const model = await startSseServer({ deltas: ["__EXTRACTION__"] });

  // The scripted extraction needs the source id, which only exists after the
  // source is stored — so the client patches it in at call time by reading the
  // SOURCE block out of the prompt it was given.
  const inner = createModelClient({ baseUrl: model.baseUrl, model: "qwen3.5-35b-a3b" });
  const extractionClient = {
    async complete(request) {
      const sourceId = request.prompt.match(/<<<SOURCE ([^>]+)>>>/)?.[1];
      await inner.complete({ prompt: request.prompt });
      return { text: EXTRACTION(sourceId), finishReason: "stop", elapsedMs: 1 };
    },
  };

  const runtime = createRuntime({
    repositories,
    transport,
    extractionClient,
    policies: {
      memberQualification: memberQualificationPolicy,
      opportunityQualification: opportunityQualificationPolicy,
      match: matchPolicy,
    },
    config: { vetoWindowMs: 48 * 60 * 60 * 1000, cycle: "c1" },
  });

  return { store, repositories, transport, runtime, close: () => model.close() };
}

test("D8 — a cold inbound becomes exactly one consented introduction", async (t) => {
  const { store, repositories, transport, runtime, close } = await harness();
  t.after(close);

  /* --- given: the employer wrote in first ----------------------------- */
  transport.deliver({
    rfcMessageId: "<alice.1@northwindlog.com>",
    from: "alice@northwindlog.com",
    to: ["yente@ccme.network"],
    subject: "Hiring an infrastructure lead",
    text: "We are hiring an infrastructure lead for our B2B SaaS platform, US remote. ".repeat(3),
  });
  await runtime.ingest(T(1));
  runtime.saveOpportunity(EMPLOYER);
  runtime.qualify("alice@northwindlog.com", EMPLOYER_PROFILE, T(2));

  /* --- given: Bob emails with professional material -------------------- */
  transport.deliver({
    rfcMessageId: "<bob.1@sender.test>",
    from: "Bob.Ferrand@example.com",
    to: ["yente@ccme.network"],
    subject: "Introduction",
    text: "Hi — resume attached.",
    attachments: [{ filename: "bob.txt", mimeType: "text/plain", content: BOB_RESUME }],
  });
  const ingested = await runtime.ingest(T(5));
  assert.equal(ingested[0].outcome, "intake");

  // The ungrounded fact was rejected and never stored — INV-5.
  const storedFacts = store.query(`FROM ${COLLECTIONS.PROFILE_FACTS}`);
  assert.equal(storedFacts.length, 5, "five grounded facts, not six");
  assert.ok(
    storedFacts.every((fact) => !String(fact.value).includes("fundraising")),
    "the invented fact must not be stored",
  );

  const bob = "bob.ferrand@example.com";
  assert.ok(repositories.members.findByAddress(bob), "address folded to one member");
  runtime.qualify(bob, BOB_PROFILE, T(6));
  assert.equal(repositories.members.findByAddress(bob).state, "ACTIVE");

  /* --- 1. the engine produces a bidirectional match -------------------- */
  const profiles = { [bob]: BOB_PROFILE, "alice@northwindlog.com": EMPLOYER_PROFILE };
  const proposed = runtime.proposeMatches({ profiles, now: T(10) });

  assert.equal(proposed.length, 1, "exactly one match");
  const { evaluation } = proposed[0];
  assert.equal(evaluation.eligible, true);
  assert.ok(evaluation.scores.member.passed, "member fit cleared its threshold");
  assert.ok(evaluation.scores.opportunity.passed, "opportunity fit cleared its threshold");
  assert.ok(evaluation.scores.member.breakdown.length > 0, "a stored score breakdown, not just a number");

  /* --- 2. both sides get a separate private preview -------------------- */
  await runtime.drainOutbox(T(11));
  const previews = transport.sent.filter((m) => m.subject.includes("potential introduction"));
  assert.equal(previews.length, 2, "one preview each, never a joint one");
  assert.deepEqual(previews.map((m) => m.to.length), [1, 1], "previews are never co-addressed");
  assert.deepEqual(previews.flatMap((m) => m.to).sort(), [bob, "alice@northwindlog.com"].sort());

  // INV-6: a preview never carries the other side's raw source.
  for (const preview of previews) {
    assert.doesNotMatch(preview.text, /Scaled the platform team from four engineers/);
    assert.doesNotMatch(preview.text, /400 machines/);
  }

  const match = store.query(`FROM ${COLLECTIONS.MATCHES}`)[0];
  assert.equal(match.state, "VETO_WINDOW", "the window opens only once both previews are delivered");

  /* --- 3. neither vetoes; the deadline passes -------------------------- */
  assert.deepEqual(runtime.advanceDeadlines(T(60), profiles), [], "silence before the deadline advances nothing");

  const afterDeadline = T(60 * 49);
  const introduced = runtime.advanceDeadlines(afterDeadline, profiles);
  assert.equal(introduced.length, 1);

  /* --- 4. exactly one shared introduction ------------------------------ */
  await runtime.drainOutbox(afterDeadline);
  const intros = transport.sent.filter((m) => m.subject.startsWith("Yente introduction"));
  assert.equal(intros.length, 1, "exactly one introduction");
  assert.deepEqual(intros[0].to.sort(), [bob, "alice@northwindlog.com"].sort(), "addressed to both");

  /* --- 5. it hands off, and does not schedule -------------------------- */
  assert.match(intros[0].text, /reply-all/i);
  assert.match(intros[0].text, /calendar link or suggest a couple of times/);
  assert.match(intros[0].text, /I will step out here/);
  // INV-11 and §2.3: Yente never books anything.
  assert.doesNotMatch(intros[0].text, /meet\.google|zoom\.us|calendly|I have scheduled/i);

  /* --- 6. the handoff is recorded, and nothing further happens --------- */
  const introduction = repositories.introductions.find(match._id);
  assert.ok(introduction, "the introduction is recorded");
  assert.equal(introduction.messageId, intros[0].messageId);
  assert.equal(store.query(`FROM ${COLLECTIONS.MATCHES}`)[0].state, "INTRODUCED");

  const sentBefore = transport.sent.length;
  runtime.advanceDeadlines(T(60 * 96), profiles);
  await runtime.drainOutbox(T(60 * 96));
  assert.equal(transport.sent.length, sentBefore, "no follow-up, ever — INV-11");

  /* --- and the receipt holds ------------------------------------------- */
  const chain = repositories.introductions.receipt(match._id);
  assert.ok(chain.length >= 4, `the introduction traces back through its causes (${chain.length} nodes)`);
  assert.ok(chain.some((node) => node._coll === "matches"));
  assert.equal(store.verify(), true, "the hash chain verifies after the whole run");
});

test("D8 variant — a PASS from either side prevents the introduction", async (t) => {
  const { store, transport, runtime, close } = await harness();
  t.after(close);

  transport.deliver({
    rfcMessageId: "<alice.2@northwindlog.com>",
    from: "alice@northwindlog.com",
    to: ["yente@ccme.network"],
    text: "We are hiring an infrastructure lead for our B2B SaaS platform, US remote. ".repeat(3),
  });
  await runtime.ingest(T(1));
  runtime.saveOpportunity(EMPLOYER);
  runtime.qualify("alice@northwindlog.com", EMPLOYER_PROFILE, T(2));

  transport.deliver({
    rfcMessageId: "<bob.2@sender.test>",
    from: "bob.ferrand@example.com",
    to: ["yente@ccme.network"],
    text: "Hi — resume attached.",
    attachments: [{ filename: "bob.txt", mimeType: "text/plain", content: BOB_RESUME }],
  });
  await runtime.ingest(T(5));
  const bob = "bob.ferrand@example.com";
  runtime.qualify(bob, BOB_PROFILE, T(6));

  const profiles = { [bob]: BOB_PROFILE, "alice@northwindlog.com": EMPLOYER_PROFILE };
  runtime.proposeMatches({ profiles, now: T(10) });
  await runtime.drainOutbox(T(11));

  // Bob passes. INV-7: one side is enough.
  transport.deliver({
    rfcMessageId: "<bob.pass@sender.test>",
    from: "bob.ferrand@example.com",
    to: ["yente@ccme.network"],
    text: "PASS — not right for me just now.",
  });
  await runtime.ingest(T(20));

  assert.equal(store.query(`FROM ${COLLECTIONS.MATCHES}`)[0].state, "VETOED");

  const before = transport.sent.length;
  runtime.advanceDeadlines(T(60 * 49), profiles);
  await runtime.drainOutbox(T(60 * 49));
  assert.equal(transport.sent.length, before, "a vetoed match never introduces");
});

test("D8 variant — STOP suppresses everything pending, before anything else", async (t) => {
  const { store, repositories, transport, runtime, close } = await harness();
  t.after(close);

  transport.deliver({
    rfcMessageId: "<alice.3@northwindlog.com>",
    from: "alice@northwindlog.com",
    to: ["yente@ccme.network"],
    text: "We are hiring an infrastructure lead for our B2B SaaS platform, US remote. ".repeat(3),
  });
  await runtime.ingest(T(1));
  runtime.saveOpportunity(EMPLOYER);
  runtime.qualify("alice@northwindlog.com", EMPLOYER_PROFILE, T(2));

  transport.deliver({
    rfcMessageId: "<bob.3@sender.test>",
    from: "bob.ferrand@example.com",
    to: ["yente@ccme.network"],
    text: "Hi — resume attached.",
    attachments: [{ filename: "bob.txt", mimeType: "text/plain", content: BOB_RESUME }],
  });
  await runtime.ingest(T(5));
  const bob = "bob.ferrand@example.com";
  runtime.qualify(bob, BOB_PROFILE, T(6));
  runtime.proposeMatches({
    profiles: { [bob]: BOB_PROFILE, "alice@northwindlog.com": EMPLOYER_PROFILE },
    now: T(10),
  });
  await runtime.drainOutbox(T(11));

  transport.deliver({
    rfcMessageId: "<bob.stop@sender.test>",
    from: "Bob.Ferrand@Example.com",
    to: ["yente@ccme.network"],
    text: "STOP",
  });
  await runtime.ingest(T(20));

  // Folded case must still find the member, or STOP silently misses.
  assert.equal(repositories.members.findByAddress(bob).state, "STOPPED");
  assert.equal(store.query(`FROM ${COLLECTIONS.MATCHES}`)[0].state, "CANCELLED_BY_STOP");

  const before = transport.sent.length;
  runtime.advanceDeadlines(T(60 * 49), {});
  await runtime.drainOutbox(T(60 * 49));
  assert.equal(transport.sent.length, before, "nothing reaches a stopped member");
});

test("a duplicate inbound changes state exactly once — D1, end to end", async (t) => {
  const { store, transport, runtime, close } = await harness();
  t.after(close);

  const message = {
    rfcMessageId: "<dupe@sender.test>",
    from: "carla@example.com",
    to: ["yente@ccme.network"],
    text: "Hello, I would like an introduction. Here is a little about my background and what I do. ".repeat(2),
  };
  transport.deliver(message);
  await runtime.ingest(T(1));
  const seq = store.seq();

  transport.deliver(message);
  const second = await runtime.ingest(T(2));
  assert.equal(second[0].outcome, "duplicate");
  assert.equal(store.seq(), seq, "a redelivery writes nothing");
});

test("qualification can run entirely off extracted facts, with no profile handed in", async (t) => {
  // The last place a policy decision was living in a test fixture. `qualify()`
  // used to take the profile from its caller — so D8 was supplying by hand the
  // very thing the runtime is supposed to derive from span-verified evidence.
  const { store, repositories, transport, runtime, close } = await harness();
  t.after(close);

  transport.deliver({
    rfcMessageId: "<bob.view@sender.test>",
    from: "bob.ferrand@example.com",
    to: ["yente@ccme.network"],
    text: "Hi — resume attached.",
    attachments: [{ filename: "bob.txt", mimeType: "text/plain", content: BOB_RESUME }],
  });
  await runtime.ingest(T(5));
  const bob = "bob.ferrand@example.com";

  // The view is materialised from the facts extraction actually stored.
  const view = buildProfileView(store, bob);
  assert.deepEqual(view.professional.capabilities, ["infrastructure_operations"]);
  assert.deepEqual(view.intent.seeks, ["operating_role"]);
  assert.ok(!JSON.stringify(view).includes("fundraising"), "the ungrounded fact never reaches the view");

  // Two required fields have no evidence in the resume, so the deterministic
  // policy says not yet — and says which. That is §6.3's interview, driven by
  // the evidence rather than by a fixture.
  const attempt = runtime.qualify(bob, null, T(6));
  assert.equal(attempt.qualified, false);
  assert.ok(attempt.qualification.missingFields.includes("intent.introductionTypes"));
  assert.equal(repositories.members.findByAddress(bob).state, "INTERVIEWING");

  // The member answers the interview; the answer is stored as an explicit fact
  // exactly like any other, and now the same call qualifies with no help.
  for (const [field, value] of [["intent.introductionTypes", "employer"], ["professional.industries", "b2b_saas"]]) {
    store.put(COLLECTIONS.PROFILE_FACTS, `${bob}:${field}`, {
      memberId: bob, field, value, explicit: true, sourceId: "interview", evidence: "member confirmed in reply",
    });
  }

  const qualified = runtime.qualify(bob, null, T(7));
  assert.equal(qualified.qualified, true, JSON.stringify(qualified.qualification));
  assert.equal(repositories.members.findByAddress(bob).state, "ACTIVE");

  // And the persisted view carries provenance back to the facts.
  const saved = store.get(COLLECTIONS.PROFILE_VIEWS, bob);
  assert.ok(saved, "the view was materialised and stored");
  assert.ok(saved.caused_by.length >= 5);
});
