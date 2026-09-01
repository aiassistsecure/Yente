/**
 * The model writes the introduction — Mark, 2026-09-01: "the introduction
 * email sucks make it sound more human and realistic ... let the model write
 * the email???"
 *
 * Both changes, pinned: the deterministic template now reads like a human
 * introducer (each side's own words as the reason, no scoring language, no
 * "cleared review"), and when the voice seat is present the MODEL composes
 * the letter — through the same disclosure guard as every generated email,
 * with the human template as the fallback for a wedged or leaky model.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, MATCH_STATES } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { drainConfirmedIntroductions, composeGraphIntroduction } from "../src/graph/introductions.js";
import { createEmailArtifact } from "../src/protocol/blocks.js";

const T0 = "2026-09-01T17:00:00.000Z";
const SEEKER = "person:vapor@expo.test";
const OFFERER = "person:mark@vibecode.test";

function confirmedMatch() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "I'm hiring a rust backend engineer.",
    receivedAt: T0, meta: { from: "vapor@expo.test" },
  });
  graph.observations.append({
    subject: SEEKER, predicate: "is_person", object: "Mark Allen Evans",
    evidenceId: "message:m1", quote: "Mark Allen Evans", confidence: 0.9, observedAt: T0,
  });
  graph.observations.append({
    subject: OFFERER, predicate: "is_person", object: "Mark Evans Jr.",
    evidenceId: "message:m1", quote: "Mark Evans Jr.", confidence: 0.9, observedAt: T0,
  });
  const manager = createGraphManager({ graph, actor: "mark" });
  const { match } = graph.matches.propose({
    seeker: SEEKER, offerer: OFFERER, matchType: "hiring_x_hire_for",
    confidence: 0.8,
    reasons: [{ id: "graded_candidate", detail: "exceptional for rust backend roles" }],
    conflicts: [],
    evidence: [
      { quote: "I'm hiring a rust backend engineer.", said: "I'm hiring a rust backend engineer." },
      { quote: "Built the distributed storage layer in Rust.", said: "Built the distributed storage layer in Rust." },
    ],
    at: T0,
  });
  graph.matches.decide({ matchId: match.id, state: MATCH_STATES.CONFIRMED, by: "mark", at: T0 });
  return { graph, manager };
}

test("the template reads like a human wrote it, not like a verdict", () => {
  const { graph, manager } = confirmedMatch();
  const [match] = graph.matches.all();
  const letter = composeGraphIntroduction({ match, manager });

  assert.match(letter.subject, /^Intro: /, "the subject line humans actually send");
  assert.match(letter.text, /you two should be talking/);
  assert.match(letter.text, /you told me: "I'm hiring a rust backend engineer\."/,
    "the seeker's reason is their own sentence");
  assert.match(letter.text, /in your own words: "Built the distributed storage layer in Rust\."/,
    "the offerer's proof is their own sentence");
  assert.match(letter.text, /take it from here/);
  assert.doesNotMatch(letter.text, /cleared Yente/);
  assert.doesNotMatch(letter.text, /looking for or offering/);
});

test("the voice seat writes the introduction and it actually sends", async () => {
  const { graph, manager } = confirmedMatch();
  const transport = createMemoryTransport();
  const calls = [];
  const voice = {
    async complete({ prompt, system }) {
      calls.push({ prompt, system });
      return {
        text: createEmailArtifact({
          meta: { template: "joint_introduction", facts_used: [] },
          subject: "Mark, meet Mark — rust, meet rust",
          text: "You two have been circling the same problem from opposite ends. "
            + "Reply-all and compare notes.\n\n— Yente\nyente@ccme.network",
        }),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };

  const summary = await drainConfirmedIntroductions({
    graph, manager, transport, emailClient: voice, now: () => T0,
  });
  assert.equal(summary.sent, 1);
  const [sent] = transport.sent;
  assert.equal(sent.subject, "Mark, meet Mark — rust, meet rust");
  assert.match(sent.text, /circling the same problem/);
  assert.deepEqual(sent.to.sort(), ["mark@vibecode.test", "vapor@expo.test"]);
  assert.match(calls[0].system, /You are Yente/);
  assert.match(calls[0].prompt, /I'm hiring a rust backend engineer/,
    "the prompt carries the seeker's own words");
  assert.match(calls[0].prompt, /Built the distributed storage layer in Rust/,
    "and the offerer's");
});

test("a leaky voice sends NOTHING — the introduction waits for a real letter", async () => {
  // NO DUMB FALLBACK: with a voice configured, the model writes this letter
  // or it does not go out this pass. The failure lands in the introduction
  // retry lane (exponential backoff), and the voice tries again.
  const { graph, manager } = confirmedMatch();
  const matchId = graph.matches.all()[0].id ?? graph.matches.all()[0]._id;
  const transport = createMemoryTransport();
  const leaky = {
    async complete() {
      return {
        text: createEmailArtifact({
          meta: { template: "joint_introduction", facts_used: [] },
          subject: "Also loop in my friend",
          text: "CC stranger@elsewhere.test on this — they'd love it.",
        }),
        finishReason: "stop", elapsedMs: 1,
      };
    },
  };

  const summary = await drainConfirmedIntroductions({
    graph, manager, transport, emailClient: leaky, now: () => T0,
  });
  assert.equal(summary.sent, 0, "a letter the guard refuses is not replaced by a template");
  assert.equal(summary.failed, 1);
  assert.equal(transport.sent.length, 0, "nothing left the desk");

  const held = graph.matches.get(matchId);
  assert.equal(held.state, MATCH_STATES.CONFIRMED, "back in the retry lane");
  assert.match(String(held.introductionLastError), /voice could not compose/);
  assert.ok(String(held.introductionAvailableAt) > T0, "with a backoff deadline");
});

test("no voice seat: the human template, exactly as before", async () => {
  const { graph, manager } = confirmedMatch();
  const transport = createMemoryTransport();
  const summary = await drainConfirmedIntroductions({
    graph, manager, transport, now: () => T0,
  });
  assert.equal(summary.sent, 1);
  assert.match(transport.sent[0].text, /you two should be talking/);
});
