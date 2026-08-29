/**
 * One GPU, one generation — the choke, fenced at both ends.
 *
 * OBSERVED 2026-08-29: "model online, PIN queue overflowed." The shape of it:
 * Yente aborts a looping stream (correctly), retries (correctly), and the
 * operator keeps generating the aborted attempt because nothing cancels it —
 * while the drain's three workers stack more attempts of the same résumé
 * behind it. Every layer was locally right; the composition drowned a GPU
 * that can only eat one generation at a time — worse than serially, because
 * ollama SPLITS num_ctx across parallel slots, so three 16k requests become
 * three ~5k contexts and a résumé that fits alone stops fitting.
 *
 * Two fences on the Yente side (cancel propagation is aias/pin-clientd work):
 *
 *   1. The CLIENT runs at most maxInflight generations at once (default 1).
 *      Every request passes the gate, retries included, so an abort-and-retry
 *      cycle can never hold more generations open than the limit.
 *   2. The PROVIDER runs at most one inference per CONTENT at a time: two
 *      jobs that resolve to the same letter share one inference instead of
 *      paying for two.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient } from "../src/llm/client.js";
import { createIntelligenceProvider } from "../src/intelligence/provider.js";

/* --- 1. the client gate --------------------------------------------------- */

function gatedStream(events) {
  // A fetch whose stream stays open until told to finish, so the test
  // controls exactly when a generation "completes".
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: {
      async *[Symbol.asyncIterator]() {
        const started = { at: Date.now() };
        events.started.push(started);
        await events.gate;   // held open until the test releases it
        yield new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      },
    },
  });
}

test("maxInflight 1 serialises generations: the second starts after the first ends", async () => {
  let release;
  const events = { started: [], gate: new Promise((r) => { release = r; }) };
  const client = createModelClient({
    baseUrl: "http://localhost:9999/v1", model: "test",
    fetchImpl: gatedStream(events), maxInflight: 1,
  });

  const first = client.complete({ prompt: "a", system: "s" });
  const second = client.complete({ prompt: "b", system: "s" });

  // Give the event loop room: were the gate not there, both fetches would
  // have started by now.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.started.length, 1,
    "the second generation must WAIT, not stack onto the GPU");

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.text, "ok");
  assert.equal(b.text, "ok");
  assert.equal(events.started.length, 2, "and it runs after, not never");
});

test("a failed generation releases its slot — retries cannot leak the gate shut", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return {
      ok: true, status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
        },
      },
    };
  };
  const client = createModelClient({
    baseUrl: "http://localhost:9999/v1", model: "test",
    fetchImpl: failing, maxInflight: 1,
  });

  await assert.rejects(client.complete({ prompt: "a", system: "s" }));
  const result = await client.complete({ prompt: "b", system: "s" });
  assert.equal(result.text, "ok", "the slot came back with the failure");
});

/* --- 2. the provider's single flight per content --------------------------- */

const SOURCES = [{ id: "attachment:cv", text: "I'm Dana Ito, I build in Rust." }];
const REPLY = [
  "<<<OBSERVATIONS>>>",
  JSON.stringify({ claim: "entity", ref: "p1", kind: "PERSON", name: "Dana Ito",
    source_id: "attachment:cv", evidence: "I'm Dana Ito, I build in Rust.",
    explicit: true, confidence: 0.95 }),
  "<<<END>>>",
].join("\n");

test("two concurrent observations of the same letter share ONE inference", async () => {
  let completions = 0;
  let release;
  const held = new Promise((r) => { release = r; });
  const client = {
    async complete() {
      completions += 1;
      await held;
      return { text: REPLY, finishReason: "stop", elapsedMs: 1 };
    },
  };
  const provider = createIntelligenceProvider({
    client, provider: "pin", model: "muse-local:latest",
    sleep: async () => {}, now: () => "2026-08-29T21:00:00.000Z",
  });

  const first = provider.observe({ sources: SOURCES });
  const second = provider.observe({ sources: SOURCES });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(completions, 1,
    "a requeue racing a retry pays for ONE generation, not two");
  assert.equal(a.verified.entities.length, 1);
  assert.deepEqual(a.verified, b.verified, "both callers get the whole answer");
});

test("different letters are not fenced against each other", async () => {
  let completions = 0;
  const client = {
    async complete() {
      completions += 1;
      return { text: REPLY, finishReason: "stop", elapsedMs: 1 };
    },
  };
  const provider = createIntelligenceProvider({
    client, provider: "pin", model: "muse-local:latest",
    sleep: async () => {}, now: () => "2026-08-29T21:00:00.000Z",
  });

  await provider.observe({ sources: SOURCES });
  await provider.observe({
    sources: [{ id: "attachment:cv", text: "I'm Dana Ito, I build in Rust. Also Go." }],
  });
  assert.equal(completions, 2, "distinct content is distinct work");
});

test("the fence lifts when the inference settles — the next call runs fresh", async () => {
  let completions = 0;
  const client = {
    async complete() {
      completions += 1;
      return { text: REPLY, finishReason: "stop", elapsedMs: 1 };
    },
  };
  const held = new Map();
  const cache = {
    async get(key) { return held.get(key) ?? null; },
    async put(key, value) { held.set(key, value); },
  };
  const provider = createIntelligenceProvider({
    client, cache, provider: "pin", model: "muse-local:latest",
    sleep: async () => {}, now: () => "2026-08-29T21:00:00.000Z",
  });

  const first = await provider.observe({ sources: SOURCES });
  const second = await provider.observe({ sources: SOURCES });
  assert.equal(completions, 1, "the SECOND sequential call hits the cache, not the fence");
  assert.equal(second.cached, true);
  assert.equal(first.cached, false);
});
