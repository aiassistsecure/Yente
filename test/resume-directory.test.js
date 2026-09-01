/**
 * The résumé directory — Mark's directive, 2026-08-31: "add resume directory
 * — not the file but our pretty printed version of it, deduped of course, on
 * the ccme.network lp. searchable, graph based, pure nedb lookups."
 *
 * The tests defend the four words that matter:
 *   PRETTY-PRINTED — cards are assembled from verified claims, never documents
 *   DEDUPED       — identity resolution makes one card per person; values
 *                   dedupe case-insensitively within a card
 *   SEARCHABLE    — matching's own tokenizer, every word must hit
 *   PUBLIC        — and therefore NO ADDRESSES, enforced by grep
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { buildDirectory } from "../src/graph/directory.js";
import { openWaitlistRepository } from "../src/waitlist/repository.js";
import { createYenteServer } from "../web/server.js";

const T0 = "2026-08-30T12:00:00.000Z";
const T1 = "2026-08-31T12:00:00.000Z";

function seeded() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);

  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "Resume attached.",
    receivedAt: T0, meta: { subject: "Resume", from: "dana@example.com" },
  });
  graph.evidence.record({
    kind: "attachment", contentHash: "a1", text: "DANA ITO — Platform Engineer",
    receivedAt: T0, meta: { filename: "dana.pdf", messageEvidenceId: "message:m1" },
  });

  const claim = (subject, predicate, object, extra = {}) => graph.observations.append({
    subject, predicate, object,
    evidenceId: extra.evidenceId ?? "attachment:a1",
    quote: extra.quote ?? String(object),
    authority: extra.authority ?? AUTHORITY.MODEL_VERIFIED,
    confidence: extra.confidence ?? 0.9,
    observedAt: extra.observedAt ?? T0,
    model: "GLM-4-32B",
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });

  // Dana: a résumé the model read whole.
  claim("person:dana@example.com", "is_person", "Dana Ito");
  claim("person:dana@example.com", "role", "Platform Engineer");
  claim("person:dana@example.com", "employer", "Acme Corp");
  claim("person:dana@example.com", "capability", "Rust");
  claim("person:dana@example.com", "capability", "rust");          // dedupe bait
  claim("person:dana@example.com", "capability", "Kubernetes");
  claim("person:dana@example.com", "geography", "Miami, FL");
  claim("person:dana@example.com", "intent:SEEKING", "a Rust backend role",
    { evidenceId: "message:m1" });
  claim("person:dana@example.com", "proposal:hire_for", "Rust backend engineering roles",
    { attributes: { grade: "strong" } });
  claim("person:dana@example.com", "proposal:hire_for", "platform engineering roles",
    { attributes: { grade: "exceptional" } });
  claim("person:dana@example.com", "capability", "recruiting",
    { attributes: { retracted: true } });

  // Jim: known only from message prose — no résumé, no card.
  claim("person:jim@corp.com", "is_person", "Jim Ford", { evidenceId: "message:m1" });
  claim("person:jim@corp.com", "intent:HIRING", "senior designers",
    { evidenceId: "message:m1" });

  // An organization is a subject, never a directory card.
  claim("org:acme", "is_organization", "Acme Corp");

  // Blake: a second résumé, later, for ordering.
  graph.evidence.record({
    kind: "attachment", contentHash: "a2", text: "BLAKE RAY — Designer",
    receivedAt: T1, meta: { filename: "blake.pdf", messageEvidenceId: "message:m1" },
  });
  claim("person:blake@studio.io", "is_person", "Blake Ray",
    { evidenceId: "attachment:a2", observedAt: T1 });
  claim("person:blake@studio.io", "role", "Designer",
    { evidenceId: "attachment:a2", observedAt: T1 });

  return { graph };
}

/* --- the builder ----------------------------------------------------------- */

test("one deduped card per person who sent a résumé, newest first", () => {
  const { graph } = seeded();
  const cards = buildDirectory({ graph });

  assert.deepEqual(cards.map((c) => c.name), ["Blake Ray", "Dana Ito"],
    "Jim (no résumé) and Acme (an org) are not cards");
  const dana = cards[1];
  assert.equal(dana.headline, "Platform Engineer · Acme Corp");
  assert.deepEqual(
    [...dana.capabilities].map((v) => v.toLowerCase()).sort(),
    ["kubernetes", "rust"],
    "one row per capability however it was capitalised; retracted never appears");
  assert.deepEqual([...dana.geographies], ["Miami, FL"]);
  assert.equal(dana.intents[0].type, "SEEKING");
});

test("proposals ride the card, best grade first", () => {
  const { graph } = seeded();
  const dana = buildDirectory({ graph }).find((c) => c.name === "Dana Ito");
  assert.deepEqual(dana.proposals.map((p) => p.grade), ["exceptional", "strong"]);
  assert.equal(dana.proposals[0].kind, "hire_for");
});

test("search: every word must hit, with matching's own tokenizer", () => {
  const { graph } = seeded();
  assert.equal(buildDirectory({ graph }, { query: "rust" }).length, 1);
  assert.equal(buildDirectory({ graph }, { query: "rust miami" }).length, 1,
    "both words live on Dana's card");
  assert.equal(buildDirectory({ graph }, { query: "rust designer" }).length, 0,
    "words split across two people match nobody");
  assert.equal(buildDirectory({ graph }, { query: "designer" })[0].name, "Blake Ray");
  assert.equal(buildDirectory({ graph }, { query: "recruiting" }).length, 0,
    "a retracted claim is not searchable");
});

test("PUBLIC SURFACE: no address appears anywhere in the directory", () => {
  const { graph } = seeded();
  const serialized = JSON.stringify(buildDirectory({ graph }));
  assert.ok(!serialized.includes("@"),
    "subject ids are emails by design and must never leave the manager surface");
  assert.ok(!serialized.includes("dana@example.com"));
});

/* --- the public route ------------------------------------------------------ */

let server;
let origin;

before(async () => {
  const { graph } = seeded();
  server = createYenteServer({
    repository: openWaitlistRepository({ store: openInMemory() }),
    directory: (query) => buildDirectory({ graph }, { query }),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("/directory renders the cards — names, grades, and no addresses", async () => {
  const response = await fetch(`${origin}/directory`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /Dana Ito/);
  assert.match(html, /Blake Ray/);
  assert.match(html, /Exceptional candidate/);
  assert.match(html, /2 people in the directory/);
  assert.ok(!html.includes("dana@example.com"),
    "the mailto CTA may carry Yente's inbox, never a member's address");
  assert.match(html, /href="\/directory"/, "the nav knows the page exists");
});

test("/directory?q= narrows, and format=json is the same answer as data", async () => {
  const response = await fetch(`${origin}/directory?q=rust`);
  const html = await response.text();
  assert.match(html, /Dana Ito/);
  assert.doesNotMatch(html, /Blake Ray/);
  assert.match(html, /1 person matches/);

  const json = await (await fetch(`${origin}/directory?q=rust&format=json`)).json();
  assert.equal(json.total, 1);
  assert.equal(json.people[0].name, "Dana Ito");
  assert.ok(!JSON.stringify(json).includes("@"));
});

test("a waitlist-only deployment has no directory route, not a broken one", async () => {
  const bare = createYenteServer({
    repository: openWaitlistRepository({ store: openInMemory() }),
  });
  await new Promise((resolve, reject) => {
    bare.once("error", reject);
    bare.listen(0, "127.0.0.1", resolve);
  });
  const port = bare.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/directory`);
  assert.equal(response.status, 404);
  await new Promise((resolve) => bare.close(resolve));
});
