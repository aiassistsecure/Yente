/**
 * A graded candidate answers a live ask.
 *
 * OBSERVED 2026-09-01 on the production desk: a hiring email — "I'm hiring a
 * rust backend engineer. Do you know a good dev?" — sat unanswered next to a
 * person Yente itself had graded `hire_for: exceptional` for "Rust backend
 * engineering roles". No match fired, because the candidate's only intent
 * rows were intake artifacts (refused, correctly) and proposals could WARM a
 * pair but never ESTABLISH one. The feature's founding sentence was "best
 * candidate for job xyz" — this arm is that sentence becoming a match.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { proposeIntroductions } from "../src/graph/matching.js";

const T0 = "2026-09-01T15:30:00.000Z";

const row = (subject, predicate, object, extra = {}) => ({
  subject, predicate, object,
  quote: extra.quote ?? String(object),
  evidenceId: extra.evidenceId ?? "message:m1",
  confidence: 0.9, observedAt: T0,
  ...(extra.attributes ? { attributes: extra.attributes } : {}),
});

const HIRER = "person:vapor@expo.com";
const CANDIDATE = "person:mark@vibecode.com";

function scenario(extra = []) {
  return [
    row(HIRER, "intent:HIRING", "rust backend engineer",
      { quote: "I’m hiring a rust backend engineer." }),
    row(CANDIDATE, "is_person", "Mark Evans Jr."),
    row(CANDIDATE, "proposal:hire_for", "Rust backend engineering roles", {
      quote: "Built the distributed storage layer in Rust.",
      evidenceId: "attachment:cv1",
      attributes: { grade: "exceptional" },
    }),
    // The intake noise that used to be the candidate's ONLY intent.
    row(CANDIDATE, "intent:SEEKING", "confirmation of resume receipt",
      { quote: "Did you get my resume?" }),
    ...extra,
  ];
}

test("a live HIRING ask meets a graded hire_for proposal and becomes a match", () => {
  const matches = proposeIntroductions({ observations: scenario() });

  assert.equal(matches.length, 1, "exactly one introduction, not a page of them");
  const [match] = matches;
  assert.equal(match.seeker, HIRER, "the one asking is the seeker");
  assert.equal(match.offerer, CANDIDATE);
  assert.equal(match.matchType, "hiring_x_hire_for");
  assert.ok(match.confidence >= 0.75, "exceptional opens warm");
  assert.equal(match.reasons[0].id, "graded_candidate");
  assert.ok(match.reasons[0].matched.includes("rust"));

  // Evidence carries BOTH sides' own words — the ask and the resume sentence
  // the grade stands on.
  assert.equal(match.evidence[0].quote, "I’m hiring a rust backend engineer.");
  assert.equal(match.evidence[1].quote, "Built the distributed storage layer in Rust.");
});

test("grades rank the queue: exceptional above good, both above threshold", () => {
  const matches = proposeIntroductions({
    observations: [
      ...scenario(),
      row("person:other@dev.com", "proposal:hire_for", "backend engineer roles", {
        quote: "Shipped backend services.",
        evidenceId: "attachment:cv2",
        attributes: { grade: "good" },
      }),
    ],
  });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].offerer, CANDIDATE, "exceptional first");
  assert.ok(matches[0].confidence > matches[1].confidence);
  assert.ok(matches[1].confidence >= 0.5, "good still clears the default threshold");
});

test("no shared words, no match — a grade is not a wildcard", () => {
  const matches = proposeIntroductions({
    observations: [
      row(HIRER, "intent:HIRING", "senior graphic designer"),
      row(CANDIDATE, "proposal:hire_for", "Rust backend engineering roles", {
        evidenceId: "attachment:cv1", attributes: { grade: "exceptional" },
      }),
    ],
  });
  assert.equal(matches.length, 0);
});

test("a person cannot answer their own ask", () => {
  const matches = proposeIntroductions({
    observations: [
      row(CANDIDATE, "intent:HIRING", "rust backend engineer"),
      row(CANDIDATE, "proposal:hire_for", "Rust backend engineering roles", {
        evidenceId: "attachment:cv1", attributes: { grade: "exceptional" },
      }),
    ],
  });
  assert.equal(matches.length, 0);
});

test("INVESTING asks pair with invest_in grades, and families never cross", () => {
  const matches = proposeIntroductions({
    observations: [
      row("person:vc@fund.com", "intent:INVESTING", "database infrastructure startups"),
      row(CANDIDATE, "proposal:invest_in", "their database infrastructure venture", {
        quote: "Built and shipped NEDB, a versioned causal database engine",
        evidenceId: "attachment:cv1", attributes: { grade: "strong" },
      }),
      row(CANDIDATE, "proposal:hire_for", "database infrastructure roles", {
        evidenceId: "attachment:cv1", attributes: { grade: "exceptional" },
      }),
    ],
  });
  assert.equal(matches.length, 1, "hire_for does not answer an INVESTING ask");
  assert.equal(matches[0].matchType, "investing_x_invest_in");
  assert.equal(matches[0].confidence, 0.7, "strong 0.65 + one extra shared word");
});

test("an intake-artifact ask is refused on this arm like every other", () => {
  const matches = proposeIntroductions({
    observations: [
      row(HIRER, "intent:HIRING", "confirmation of resume receipt",
        { quote: "did you get the resume" }),
      row(CANDIDATE, "proposal:hire_for", "resume screening roles", {
        evidenceId: "attachment:cv1", attributes: { grade: "strong" },
      }),
    ],
  });
  assert.equal(matches.filter((m) => m.reasons[0]?.id === "graded_candidate").length, 0);
});

test("a retracted proposal answers nothing", () => {
  const matches = proposeIntroductions({
    observations: [
      row(HIRER, "intent:HIRING", "rust backend engineer"),
      row(CANDIDATE, "proposal:hire_for", "Rust backend engineering roles", {
        evidenceId: "attachment:cv1",
        attributes: { grade: "exceptional", retracted: true },
      }),
    ],
  });
  assert.equal(matches.length, 0);
});
