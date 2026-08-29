/**
 * The graph, searchable — and the numbers behind the desk.
 *
 * Mark's directive, 2026-08-29: "why isn't the graph searchable? close that
 * gap. upgrade manager with more data and stats and search ability."
 *
 * Before this, every belief Yente held was findable only by knowing which
 * profile page it lived on. searchGraph sweeps subjects, claims, and evidence
 * in one pass with the SAME tokenizer matching uses — so what search finds
 * and what matching sees cannot drift apart — and stats() counts what is
 * actually stored, never estimates, with every count one /search click away
 * from the rows it counts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { handleManagerRequest, renderSearch, renderStats } from "../web/manager.js";

const T0 = "2026-08-29T12:00:00.000Z";

function seeded() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);

  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "I build in Rust and C++.",
    receivedAt: T0, meta: { subject: "Intro from Dana", from: "dana@example.com" },
  });
  graph.evidence.record({
    kind: "attachment", contentHash: "a1", text: "Dana Ito — Platform Engineer",
    receivedAt: T0, meta: { filename: "dana-resume.pdf", messageEvidenceId: "message:m1" },
  });

  const claim = (subject, predicate, object, extra = {}) => graph.observations.append({
    subject, predicate, object,
    evidenceId: extra.evidenceId ?? "message:m1",
    quote: extra.quote ?? `…${object}…`,
    authority: extra.authority ?? AUTHORITY.MODEL_VERIFIED,
    confidence: extra.confidence ?? 0.9,
    observedAt: extra.observedAt ?? T0,
    model: "muse-local:latest",
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });

  claim("person:dana@example.com", "is_person", "Dana Ito");
  claim("person:dana@example.com", "capability", "Rust",
    { evidenceId: "attachment:a1", quote: "I build in Rust and C++." });
  claim("person:dana@example.com", "capability", "c++",
    { evidenceId: "attachment:a1", quote: "I build in Rust and C++." });
  claim("person:dana@example.com", "intent:SEEKING", "a Rust backend role");
  claim("person:dana@example.com", "proposal:hire_for", "Rust backend engineering roles",
    { evidenceId: "attachment:a1", attributes: { grade: "strong" },
      quote: "Dana Ito — Platform Engineer" });
  claim("person:jim@corp.com", "is_person", "Jim Ford");
  claim("person:jim@corp.com", "intent:HIRING", "senior designers");
  claim("person:jim@corp.com", "capability", "recruiting",
    { attributes: { retracted: true } });

  return { graph, manager: createGraphManager({ graph, actor: "test" }) };
}

/* --- search: one query, the whole graph ---------------------------------- */

test("a word sweeps subjects, claims, and evidence in one pass, with hrefs", () => {
  const { manager } = seeded();
  const results = manager.searchGraph({ query: "rust" });

  assert.ok(results.total > 0);
  assert.ok(results.subjects.some((s) => s.id === "person:dana@example.com"),
    "the person who evidences the word is found");
  const capability = results.claims.find((c) => c.predicate === "capability" && c.object === "Rust");
  assert.ok(capability, "the claim itself is a hit");
  assert.equal(capability.sourceKind, "attachment");
  assert.match(capability.subjectHref, /^\/subject\?id=/);
  assert.ok(results.claims.every((c) => c.matched.length > 0),
    "every hit says WHICH words earned it");
});

test("the tokenizer is matching's own: c++ is findable, not stripped", () => {
  const { manager } = seeded();
  const results = manager.searchGraph({ query: "c++" });
  assert.ok(results.claims.some((c) => c.object === "c++"),
    "what search finds and what matching sees cannot drift apart");
});

test("filters compose: every strong hire_for proposal, no words needed", () => {
  const { manager } = seeded();
  const results = manager.searchGraph({ kind: "proposal", grade: "strong" });
  assert.equal(results.claims.length, 1);
  assert.equal(results.claims[0].predicate, "proposal:hire_for");
  assert.equal(results.claims[0].grade, "strong");
  assert.ok(results.subjects.some((s) => s.id === "person:dana@example.com" && s.viaClaims),
    "a filter-only search still says WHO");

  assert.equal(manager.searchGraph({ kind: "proposal", grade: "exceptional" }).claims.length, 0);
});

test("kind sweeps a namespace or names one predicate exactly", () => {
  const { manager } = seeded();
  assert.equal(manager.searchGraph({ kind: "intent" }).claims.length, 2);
  assert.equal(manager.searchGraph({ kind: "capability" }).claims.length, 2,
    "the retracted recruiting claim is not among them");
  assert.equal(manager.searchGraph({ kind: "proposal:hire_for" }).claims.length, 1);
});

test("source narrows to where the claim came from", () => {
  const { manager } = seeded();
  const fromDocuments = manager.searchGraph({ query: "rust", source: "attachment" });
  assert.ok(fromDocuments.claims.every((c) => c.sourceKind === "attachment"));
  assert.ok(fromDocuments.claims.length > 0);
});

test("evidence is searchable by subject line and filename", () => {
  const { manager } = seeded();
  const bySubject = manager.searchGraph({ query: "dana" });
  assert.ok(bySubject.evidence.some((e) => e.subject === "Intro from Dana"));
  assert.ok(bySubject.evidence.some((e) => e.filename === "dana-resume.pdf"));
  assert.ok(bySubject.evidence.every((e) => e.threadHref),
    "every evidence hit opens its thread");
});

test("no words and no filters is an empty answer, not a dump of everything", () => {
  const { manager } = seeded();
  const results = manager.searchGraph({});
  assert.equal(results.total, 0);
});

test("a retracted claim is not findable", () => {
  const { manager } = seeded();
  assert.equal(manager.searchGraph({ query: "recruiting" }).claims.length, 0);
});

/* --- stats: counted, never estimated ------------------------------------- */

test("stats counts what is stored, bucket by bucket", () => {
  const { manager } = seeded();
  const stats = manager.stats();

  assert.equal(stats.people.total, 2);
  assert.ok(stats.claims.total >= 6, "retraction excluded from live count");
  assert.ok(stats.claims.byPredicate.some((p) => p.key === "capability" && p.n === 2));
  assert.ok(stats.claims.bySourceKind.some((p) => p.key === "attachment"));
  assert.ok(stats.claims.byModel.some((p) => p.key === "muse-local:latest"),
    "provenance answers 'which model said all this'");
  assert.ok(stats.claims.averageConfidence > 0);

  assert.equal(stats.proposals.total, 1);
  assert.deepEqual(stats.proposals.byGrade, [{ key: "strong", n: 1 }]);
  assert.deepEqual(stats.proposals.byKind, [{ key: "hire_for", n: 1 }]);
  assert.equal(stats.proposals.graded, 1);

  assert.equal(stats.activity.length, 14, "fourteen days, every day present");
  assert.ok(stats.evidence.byKind.some((e) => e.key === "message"));
  assert.ok(stats.vocabulary.some((w) => w.key === "rust"),
    "the document vocabulary is a stat, and each word links to its search");
});

/* --- the web surface ------------------------------------------------------ */

function fakeRes() {
  const res = {
    statusCode: null, headers: null, body: "",
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; return res; },
    end(chunk) { res.body += chunk ?? ""; return res; },
  };
  return res;
}

test("GET /search?format=json answers with the structured results", async () => {
  const { manager, graph } = seeded();
  const res = fakeRes();
  const handled = await handleManagerRequest({
    req: { url: "/search?q=rust&format=json", method: "GET" },
    res, manager, graph, health: {},
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.ok(parsed.claims.some((c) => c.object === "Rust"));
});

test("GET /stats?format=json answers with the numbers", async () => {
  const { manager, graph } = seeded();
  const res = fakeRes();
  await handleManagerRequest({
    req: { url: "/stats?format=json", method: "GET" },
    res, manager, graph, health: {},
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.proposals.total, 1);
});

test("the HTML pages render the hits and the doorways", () => {
  const { manager } = seeded();
  const searchHtml = renderSearch({ results: manager.searchGraph({ query: "rust" }) });
  assert.match(searchHtml, /Rust backend engineering roles/);
  assert.match(searchHtml, /\/subject\?id=/);

  const statsHtml = renderStats({ stats: manager.stats() });
  assert.match(statsHtml, /proposals/i);
  assert.match(statsHtml, /\/search\?kind=/,
    "every count is a doorway into the rows it counts");
  assert.match(statsHtml, /fourteen days/i);
});
