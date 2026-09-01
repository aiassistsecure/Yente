/**
 * The evidence had no name — live tape, 2026-09-01 16:53: a new email is
 * heard, understood, six claims banked — and the desk never replies. Ever.
 *
 * The desk consumes the graph's evidence ledger (the single-IMAP design),
 * keyed by `evidence.id`. But EvidenceRepository.all() returned raw store
 * rows, which carry `_id` — so evidence.id was undefined for EVERY row. The
 * first tick processed one message, added `undefined` to the processed-set,
 * and from then on has(undefined) was true for everything: the desk went
 * deaf one message after boot. The suite never saw it because the test
 * harness hand-built its evidence source WITH `id` — these tests use the
 * PRODUCTION repository, the shape that actually ships.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { createMemoryTransport } from "../src/mail/transport.js";
import { createRuntime } from "../src/runtime/yente.js";

const NOW = new Date("2026-09-01T16:53:03.000Z");

const emptyModel = {
  async complete() {
    return {
      text: ["<<<PROFILE_FACTS>>>", JSON.stringify({ facts: [] }), "<<<END>>>"].join("\n"),
      finishReason: "stop", elapsedMs: 1,
    };
  },
};

function harness() {
  const graph = createGraphRepositories(openInMemory());
  const repositories = createRepositories(openInMemory());
  const transport = createMemoryTransport();
  const runtime = createRuntime({
    repositories, transport, extractionClient: emptyModel,
    graphEvidence: graph.evidence, // the PRODUCTION repository, not a stub
    config: { extractionRetryDelayMs: 0 },
  });
  return { graph, repositories, transport, runtime };
}

function letter(graph, n, from) {
  graph.evidence.record({
    kind: "message", contentHash: `m${n}`,
    text: `Message number ${n}, long enough to be worth storing as a source with `
      + "substance, from a person the desk owes an answer to.",
    receivedAt: NOW.toISOString(),
    meta: { rfcMessageId: `<m${n}@live.test>`, from, to: ["yente@ccme.network"], subject: `hello ${n}` },
  });
}

test("every row leaves the repository wearing its name", () => {
  const graph = createGraphRepositories(openInMemory());
  letter(graph, 1, "a@one.test");
  const [row] = graph.evidence.all();
  assert.equal(row.id, "message:m1",
    "all() must return the same id record() and get() speak");
});

test("the desk hears the SECOND message too — and the tenth", async () => {
  const { graph, repositories, runtime } = harness();
  letter(graph, 1, "first@person.test");
  letter(graph, 2, "second@person.test");

  const boot = await runtime.ingest(NOW);
  assert.equal(boot.length, 2, "two messages on file, two ingested — not one");
  assert.ok(repositories.members.findByAddress("first@person.test"));
  assert.ok(repositories.members.findByAddress("second@person.test"),
    "the second sender exists — the processed-set was not poisoned");

  // The live failure: mail arriving AFTER boot, skipped forever.
  letter(graph, 3, "third@person.test");
  const later = await runtime.ingest(NOW);
  assert.equal(later.length, 1, "new mail after boot is heard, not skipped");
  assert.equal(later[0].outcome, "clarification_sent",
    "and the desk owes — and queues — a continuation");
  assert.ok(repositories.members.findByAddress("third@person.test"));

  // And a genuinely quiet tick is quiet — dedupe still works.
  assert.equal((await runtime.ingest(NOW)).length, 0);
});

test("a nameless row is skipped outright, never keyed on undefined", async () => {
  const repositories = createRepositories(openInMemory());
  const rows = [
    { kind: "message", text: "no id and no _id — a shape from nowhere", meta: { from: "x@y.test" } },
    {
      kind: "message", _id: "message:real", text: "a raw store row, long enough to matter, "
        + "carrying only the engine's underscore name and still owed an answer.",
      meta: { rfcMessageId: "<real@live.test>", from: "real@person.test", to: ["yente@ccme.network"], subject: "hi" },
      receivedAt: NOW.toISOString(),
    },
  ];
  const runtime = createRuntime({
    repositories, transport: createMemoryTransport(), extractionClient: emptyModel,
    graphEvidence: { all: () => rows, get: () => null },
    config: { extractionRetryDelayMs: 0 },
  });

  const first = await runtime.ingest(NOW);
  assert.equal(first.length, 1, "the nameless row is dropped, the _id row is heard");
  assert.ok(repositories.members.findByAddress("real@person.test"));
  assert.equal((await runtime.ingest(NOW)).length, 0,
    "and the _id row was remembered under its real name, not undefined");
});
