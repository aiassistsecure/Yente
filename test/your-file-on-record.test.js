/**
 * Your file, on record — Mark, 2026-09-02, screenshot IMG_3623: "what do you
 * have on file for me?" came back as
 *
 *   intent.introductionTypes: hiring
 *   intent.introductionTypes: hiring
 *   professional.display_name: Mark Allen Evans   (x6)
 *   professional.employers: World Vapor Expo llc. (x3)
 *
 * Two faults, one letter:
 *   1. profileCard filtered RESOLVED rows by the raw `person:<address>` id.
 *      Resolved rows wear their canonical subject, so a member whose
 *      addresses had been folded (same_as) owned an EMPTY card, the bridge
 *      returned null, and the voice fell back to the desk's raw facts.
 *   2. That fallback was `- field.path: value` per row — system paths,
 *      no dedupe.
 *
 * Now: renderFile — deduped, labelled, with stats (claims, sources, dates),
 * Yente's proposals with grades, intents, and match counts. And the desk
 * fallback is deduped and labelled too.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY, MATCH_STATES } from "../src/store/graph.js";
import { profileCard, renderCard } from "../src/graph/consent.js";
import { renderFile } from "../src/graph/file.js";
import { describeFacts } from "../src/runtime/yente.js";

const T0 = "2026-08-12T09:00:00.000Z";
const T1 = "2026-09-02T14:42:00.000Z";
const MARK = "person:founders@vibecode.test";
const ALIAS = "person:president@worldvaporexpo.test";

function obs(graph, subject, predicate, object, extra = {}) {
  graph.observations.append({
    subject, predicate, object, evidenceId: extra.evidenceId ?? "message:m1",
    quote: object, authority: AUTHORITY.MODEL_VERIFIED, confidence: 0.9,
    observedAt: extra.at ?? T0, ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });
}

function marksGraph() {
  const graph = createGraphRepositories(openInMemory());
  graph.evidence.record({ kind: "message", contentHash: "m1", text: "hi", receivedAt: T0, meta: {} });
  graph.evidence.record({ kind: "attachment", contentHash: "cv", text: "resume", receivedAt: T0, meta: {} });
  // Two addresses, one person. Canonical root is the lexicographically
  // smaller id — founders@… — so MARK's claims are FILED under MARK and the
  // alias's claims fold onto it.
  obs(graph, ALIAS, "same_as", MARK);
  obs(graph, MARK, "is_person", "Mark Allen Evans", { evidenceId: "attachment:cv" });
  obs(graph, ALIAS, "is_person", "Mark", { at: "2026-08-01T00:00:00.000Z" });
  obs(graph, MARK, "role", "Co-founder", { evidenceId: "attachment:cv" });
  obs(graph, ALIAS, "role", "co-founder");
  obs(graph, MARK, "employer", "World Vapor Expo llc.", { evidenceId: "attachment:cv" });
  obs(graph, ALIAS, "employer", "world vapor expo LLC.", { at: T1 });
  obs(graph, MARK, "capability", "Rust");
  obs(graph, MARK, "intent:hiring", "rust backend engineer");
  obs(graph, ALIAS, "intent:hiring", "Rust backend engineer");
  obs(graph, MARK, "proposal:hire_for", "rust backend engineer", { attributes: { grade: "strong" } });
  obs(graph, ALIAS, "proposal:hire_for", "Rust backend engineer", { attributes: { grade: "strong" } });
  return graph;
}

test("a folded alias still finds its card — the live desk's empty card, closed", () => {
  const graph = marksGraph();
  // The bridge asks under the RAW address subject; identity folds it.
  for (const asked of [ALIAS, MARK]) {
    const card = profileCard(graph, asked);
    assert.equal(card.subject, MARK, `${asked} resolves to the canonical file`);
    assert.equal(card.name, "Mark Allen Evans");
    assert.deepEqual(card.fields.get("role"), ["Co-founder"], "case variants are one value");
    assert.deepEqual(card.fields.get("employer"), ["World Vapor Expo llc."]);
    assert.equal(card.intents.length, 1, "intents dedupe case-insensitively");
    assert.equal(card.proposals.length, 1, "proposals dedupe");
    assert.ok(renderCard(card).includes("Role: Co-founder"));
  }
});

test("the file reads like a record: stats, name, deduped fields, proposals, matches", () => {
  const graph = marksGraph();
  const { match } = graph.matches.propose({
    seeker: MARK, offerer: "person:dev@example.test", matchType: "hiring_x_hire_for",
    confidence: 0.8, reasons: [], conflicts: [], evidence: [], at: T1,
  });
  const text = renderFile(graph, ALIAS);

  assert.match(text, /^  On file: 12 claims from 1 document and 1 message · first read 1 Aug 2026 · last updated 2 Sep 2026$/m);
  assert.match(text, /^  Name: Mark Allen Evans \(also seen as: Mark\)$/m);
  assert.match(text, /^  Role: Co-founder$/m);
  assert.match(text, /^  Employer: World Vapor Expo llc\.$/m);
  assert.match(text, /^  Capabilities: Rust$/m);
  assert.match(text, /^  Yente's read \(1\): hire for: rust backend engineer \(strong\)$/m);
  assert.match(text, /^  Looking for: hiring: rust backend engineer$/m);
  assert.match(text, /^  Matches: 1 under review$/m);

  assert.doesNotMatch(text, /professional\.|intent\./, "no system field paths");
  assert.doesNotMatch(text, /dev@example/, "nothing about anyone else, ever");
  const lines = text.split("\n");
  assert.equal(new Set(lines.map((l) => l.toLowerCase())).size, lines.length, "no line repeats");

  assert.equal(match.state, MATCH_STATES.PROPOSED);
});

test("nothing on file renders as nothing, so the caller can say so honestly", () => {
  const graph = createGraphRepositories(openInMemory());
  assert.equal(renderFile(graph, "person:nobody@example.test"), "");
  assert.match(renderFile(marksGraph(), MARK), /Matches: none yet/);
});

test("the desk fallback is labelled and deduped — six display names become one line", () => {
  const facts = [
    ...Array(6).fill({ field: "professional.display_name", value: "Mark Allen Evans" }),
    { field: "professional.display_name", value: "Mark" },
    { field: "intent.introductionTypes", value: "hiring" },
    { field: "intent.introductionTypes", value: "hiring" },
    { field: "professional.employers", value: "World Vapor Expo llc." },
    { field: "professional.employers", value: "World Vapor Expo LLC." },
    { field: "intent.seeks", value: "rust backend engineer" },
  ];
  const text = describeFacts(facts);
  assert.equal(text, [
    "  Name: Mark Allen Evans · Mark",
    "  Where: World Vapor Expo llc.",
    "  Looking for: rust backend engineer",
    "  Useful introductions: hiring",
  ].join("\n"));
  assert.equal(describeFacts([]), "", "no facts, no block");
});
