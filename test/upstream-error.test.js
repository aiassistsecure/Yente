/**
 * When the upstream says why, say why.
 *
 * THE INCIDENT
 *
 * Extraction failed in production and the log said:
 *
 *   [yente] extraction_failed code=EMPTY_COMPLETION error=The model returned no content
 *
 * True, and useless. The gateway had in fact explained itself, inside the stream:
 *
 *   data: {"error":{"message":"operator produced nothing for 90s
 *          (timeout between chunks, not total duration)"}}
 *
 * An error event carries no `choices`, so the read loop skipped it as an
 * unreadable keep-alive and fell through to "no content". Recovering that one
 * sentence took a nine-knob sweep, a concurrency test, a context-size ladder and
 * a 35-minute idle re-test — all to rediscover something already written down.
 *
 * The second half is the retry policy. Transient and deterministic failures were
 * treated identically, so the box burned both attempts on EMPTY_COMPLETION inside
 * 6803ms and reported silence. Time was the entire remedy and it never waited.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient, ModelError, ModelErrorCode, isTransient } from "../src/llm/client.js";
import { extractProfileFacts } from "../src/extract/profile.js";
import { startSseServer } from "../test-support/sse-server.mjs";

const GATEWAY_SENTENCE =
  "operator produced nothing for 90s (timeout between chunks, not total duration)";

/* --- the client reads the error it used to skip ------------------------- */

test("an in-stream error becomes UPSTREAM_ERROR carrying the upstream's words", async (t) => {
  const server = await startSseServer({ errorEvent: GATEWAY_SENTENCE });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "muse-local:latest" });

  await assert.rejects(
    () => client.complete({ prompt: "<<<TASK>>>hello<<<END>>>" }),
    (error) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.code, ModelErrorCode.UPSTREAM_ERROR,
        "must NOT be EMPTY_COMPLETION — that is what hid this for a whole session");
      assert.match(error.message, /operator produced nothing for 90s/,
        "the upstream's own sentence has to survive to the caller");
      assert.match(error.message, /timeout between chunks/,
        "including the part that identifies it as a SILENCE budget, not a total one");
      return true;
    },
  );
});

test("a structured error object is preserved, not flattened to a guess", async (t) => {
  const server = await startSseServer({
    errorEvent: { message: "model overloaded", type: "capacity", code: "operator_busy" },
  });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  await assert.rejects(
    () => client.complete({ prompt: "<<<TASK>>>x<<<END>>>" }),
    (error) => {
      assert.equal(error.code, ModelErrorCode.UPSTREAM_ERROR);
      assert.match(error.message, /model overloaded/);
      assert.equal(error.meta.upstream.code, "operator_busy",
        "the whole object is kept, so a caller can branch on it later");
      return true;
    },
  );
});

test("a genuinely empty stream is still EMPTY_COMPLETION", async (t) => {
  // The new branch must not swallow the old case. No error event and no content
  // is a different fact about the world, and it keeps its own name.
  const server = await startSseServer({ deltas: [] });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  await assert.rejects(
    () => client.complete({ prompt: "<<<TASK>>>x<<<END>>>" }),
    (error) => {
      assert.equal(error.code, ModelErrorCode.EMPTY_COMPLETION);
      return true;
    },
  );
});

test("content still arrives normally — the error check is not in the way", async (t) => {
  const server = await startSseServer({ deltas: ["<<<PROFILE", "_FACTS>>>{}", "<<<END>>>"] });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  const out = await client.complete({ prompt: "<<<TASK>>>x<<<END>>>" });
  assert.match(out.text, /PROFILE_FACTS/);
  assert.equal(out.finishReason, "stop");
});

/* --- a finished completion must return when it finishes ------------------ */

test("the client stops reading at finish_reason instead of waiting for [DONE]", async (t) => {
  // THE BUG, as Mark found it: "pure CURL works instantly, and your script is
  // taking FOREVER to return responses from completions that are DONE."
  //
  // The read loop RECORDED finish_reason and kept looping until `[DONE]` or the
  // socket closed. `[DONE]` is an OpenAI convention, not a guarantee, and the
  // AiAS gateway does not reliably send it — so a completion that had finished
  // generating sat here until the server hung up. Every observation paid it, and
  // across three retry attempts it became minutes. The model was never slow.
  const server = await startSseServer({
    deltas: ["<<<OBSERVATIONS>>>", "{}", "<<<END>>>"],
    omitDone: true,
    holdOpenMs: 5_000,   // the gateway, sitting there
  });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });

  const started = Date.now();
  const out = await client.complete({ prompt: "<<<TASK>>>x<<<END>>>" });
  const elapsed = Date.now() - started;

  assert.match(out.text, /OBSERVATIONS/);
  assert.equal(out.finishReason, "stop");
  assert.ok(elapsed < 2_000,
    `returned in ${elapsed}ms — must not wait out a server holding the socket open`);
});

test("content in the same chunk as finish_reason is not lost to the early break", async (t) => {
  // The break must happen AFTER the delta is appended. Servers routinely put the
  // last token and the finish_reason in one chunk, and an early break that
  // skipped it would silently truncate every completion.
  const server = await startSseServer({ deltas: ["alpha", "beta", "GAMMA"] });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  const out = await client.complete({ prompt: "<<<TASK>>>x<<<END>>>" });
  assert.equal(out.text, "alphabetaGAMMA", "the final chunk's content survives");
});

/* --- assistant prefill --------------------------------------------------- */

test("a prefill is sent as a trailing assistant turn, after the user message", async (t) => {
  // Order is the whole mechanism: the model CONTINUES a reply that has already
  // begun. A prefill anywhere but last is just a stray turn in the history.
  const server = await startSseServer({ deltas: ["{}"] });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  await client.complete({
    prompt: "<<<TASK>>>x<<<END>>>",
    system: "sys",
    prefill: "<|channel>thought\n<channel|>",
  });

  const { messages } = server.requests[0].body;
  assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.equal(messages[2].content, "<|channel>thought\n<channel|>");
});

test("no prefill means no assistant turn — normal behaviour is the default", async (t) => {
  const server = await startSseServer({ deltas: ["{}"] });
  t.after(() => server.close());

  const client = createModelClient({ baseUrl: server.baseUrl, model: "m" });
  await client.complete({ prompt: "<<<TASK>>>x<<<END>>>", system: "sys" });

  const { messages } = server.requests[0].body;
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
});

/* --- transient vs deterministic ----------------------------------------- */

test("the codes that mean try again are separated from the ones that do not", () => {
  const transient = [
    ModelErrorCode.UPSTREAM_ERROR,
    ModelErrorCode.EMPTY_COMPLETION,
    ModelErrorCode.FIRST_TOKEN_TIMEOUT,
    ModelErrorCode.STREAM_TIMEOUT,
    ModelErrorCode.NETWORK_ERROR,
  ];
  for (const code of transient) {
    assert.equal(isTransient(new ModelError(code, "x")), true, `${code} should be transient`);
  }

  // Deterministic: repeating the same request cannot help.
  assert.equal(isTransient(new ModelError(ModelErrorCode.TOKEN_BUDGET_EXCEEDED, "x")), false);
  assert.equal(isTransient(new ModelError(ModelErrorCode.ABORTED, "x")), false);

  // HTTP splits on the status, because 400 and 503 are opposite situations.
  assert.equal(isTransient(new ModelError(ModelErrorCode.HTTP_ERROR, "x", { status: 400 })), false);
  assert.equal(isTransient(new ModelError(ModelErrorCode.HTTP_ERROR, "x", { status: 401 })), false);
  assert.equal(isTransient(new ModelError(ModelErrorCode.HTTP_ERROR, "x", { status: 429 })), true);
  assert.equal(isTransient(new ModelError(ModelErrorCode.HTTP_ERROR, "x", { status: 503 })), true);
});

/* --- the retry actually waits, and only when waiting can help ----------- */

function failingClient(error, succeedOnAttempt = null) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async complete() {
      calls += 1;
      if (succeedOnAttempt && calls >= succeedOnAttempt) {
        return {
          // Delimiters on their own lines — that is what the protocol requires,
          // and a one-line block is exactly the MALFORMED_ARTIFACT shape.
          text: [
            "<<<PROFILE_FACTS>>>",
            JSON.stringify({ facts: [{
              field: "professional.roles", value: "Founder", source_id: "s",
              evidence: "Founder at Interchained", explicit: true,
            }] }),
            "<<<END>>>",
          ].join("\n"),
          finishReason: "stop", elapsedMs: 1,
        };
      }
      throw error;
    },
  };
}

test("a transient failure is retried WITH a delay, and can then succeed", async () => {
  const client = failingClient(
    new ModelError(ModelErrorCode.UPSTREAM_ERROR, GATEWAY_SENTENCE),
    3,   // succeeds on the third call
  );
  const waits = [];

  const out = await extractProfileFacts({
    client, sourceId: "s", text: "Founder at Interchained", vocabulary: {},
    sleep: async (ms) => { waits.push(ms); },
    retryDelayMs: 5_000,
  });

  assert.equal(client.calls, 3, "it kept trying");
  assert.deepEqual(waits, [5_000, 10_000],
    "and it WAITED between attempts — the old code retried instantly and failed twice in 6.8s");
  assert.equal(out.verified.length, 1, "the third attempt landed");
  assert.equal(out.failures.length, 2, "both transient failures are still reported, not hidden");
  assert.equal(out.failures[0].code, ModelErrorCode.UPSTREAM_ERROR);
  assert.match(out.failures[0].message, /operator produced nothing/);
  assert.equal(out.failures[0].transient, true);
});

test("a deterministic failure is NOT retried — repeating it is a slower way to fail", async () => {
  const client = failingClient(
    new ModelError(ModelErrorCode.HTTP_ERROR, "Model returned HTTP 400", { status: 400 }),
  );
  const waits = [];

  const out = await extractProfileFacts({
    client, sourceId: "s", text: "Founder at Interchained", vocabulary: {},
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(client.calls, 1, "one call: a 400 will be a 400 again");
  assert.deepEqual(waits, [], "and nothing was gained by waiting, so it did not");
  assert.equal(out.verified.length, 0);
  assert.equal(out.failures.length, 1, "reported once, not three identical copies");
  assert.equal(out.failures[0].transient, false);
});

test("exhausting the attempts reports every failure rather than none", async () => {
  const client = failingClient(new ModelError(ModelErrorCode.EMPTY_COMPLETION, "no content"));
  const out = await extractProfileFacts({
    client, sourceId: "s", text: "Founder at Interchained", vocabulary: {},
    sleep: async () => {}, attempts: 3,
  });

  assert.equal(client.calls, 3);
  assert.equal(out.verified.length, 0, "§11.6: never fabricate — it yields nothing");
  assert.equal(out.failures.length, 3, "and says so three times, with reasons");
  assert.ok(out.failures.every((f) => f.transient === true));
});
