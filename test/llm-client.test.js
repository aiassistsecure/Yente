import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";

import { ModelErrorCode, createModelClient } from "../src/llm/client.js";
import { manifestStop } from "../src/intelligence/manifest.js";
import { startSseServer } from "../test-support/sse-server.mjs";

async function withServer(script, run) {
  const server = await startSseServer(script);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

const client = (baseUrl, overrides = {}) =>
  createModelClient({ baseUrl, model: "qwen3.5-35b-a3b", ...overrides });

test("a streamed completion is accumulated in order", async () => {
  await withServer({ deltas: ["<<<SUBJECT>>>\n", "Hello\n", "<<<END>>>"] }, async (server) => {
    const seen = [];
    const result = await client(server.baseUrl).complete({
      prompt: "<<<TASK>>>\nwrite\n<<<END>>>",
      onToken: (delta) => seen.push(delta),
    });

    assert.equal(result.text, "<<<SUBJECT>>>\nHello\n<<<END>>>");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(seen, ["<<<SUBJECT>>>\n", "Hello\n", "<<<END>>>"]);
    assert.ok(result.elapsedMs >= 0);
  });
});

test("the request is an OpenAI-compatible streaming chat call at temperature 0", async () => {
  await withServer({ deltas: ["ok"] }, async (server) => {
    await client(server.baseUrl).complete({ prompt: "p", system: "s" });
    const [request] = server.requests;

    assert.match(request.url, /\/v1\/chat\/completions$/);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.model, "qwen3.5-35b-a3b");
    assert.equal(request.body.temperature, 0, "determinism is the default, not an option someone remembers");
    assert.deepEqual(request.body.messages, [
      { role: "system", content: "s" },
      { role: "user", content: "p" },
    ]);
  });
});

test("events split across chunk boundaries are reassembled", async () => {
  // The failure mode this guards is silent truncation: a naive reader that
  // treats each socket chunk as an event loses the half that arrived late.
  await withServer({ deltas: ["alpha ", "beta ", "gamma"], splitEvents: true }, async (server) => {
    const result = await client(server.baseUrl).complete({ prompt: "p" });
    assert.equal(result.text, "alpha beta gamma");
  });
});

test("Sentinel closings split across delta.content events are not lost", async () => {
  // The socket can split an SSE event, and the model can also split the delimiter
  // itself across separate deltas. Those are different boundaries. The existing
  // splitEvents test covered only the first one.
  await withServer({
    deltas: [
      '<<<MANIFEST>>>\n{"blocks":0}\n<<<E',
      "ND",
      ">>>",
    ],
    omitDone: true,
    holdOpenMs: 2_000,
  }, async (server) => {
    const started = Date.now();
    const result = await client(server.baseUrl).complete({ prompt: "p", stopWhen: manifestStop });
    assert.equal(result.text, '<<<MANIFEST>>>\n{"blocks":0}\n<<<END>>>');
    assert.equal(result.finishReason, "stop_sequence");
    assert.ok(Date.now() - started < 1_000, "the split closing stops immediately when complete");
  });
});

test("the one-block OBSERVATIONS reply stops on its split closing delimiter", async () => {
  const envelope = '{"entities":[],"intents":[],"relationships":[],"opportunities":[],"observations":[]}';
  await withServer({
    deltas: ["<<<OBSERVATIONS>>>\n", envelope, "\n<<<E", "ND", ">>>"],
    omitDone: true,
    holdOpenMs: 2_000,
  }, async (server) => {
    const started = Date.now();
    const result = await client(server.baseUrl).complete({ prompt: "p", stopWhen: manifestStop });
    assert.equal(result.text, `<<<OBSERVATIONS>>>\n${envelope}\n<<<END>>>`);
    assert.equal(result.finishReason, "stop_sequence");
    assert.ok(Date.now() - started < 1_000);
  });
});

test("content-part arrays are joined as text instead of becoming object strings", async () => {
  await withServer({ rawEvents: [{
    choices: [{
      delta: { content: [
        { type: "text", text: "<<<MANIFEST>>>\n" },
        { type: "output_text", text: '{"blocks":0}\n<<<END>>>' },
      ] },
      finish_reason: "stop",
    }],
  }] }, async (server) => {
    const result = await client(server.baseUrl).complete({ prompt: "p", stopWhen: manifestStop });
    assert.equal(result.text, '<<<MANIFEST>>>\n{"blocks":0}\n<<<END>>>');
    assert.doesNotMatch(result.text, /\[object Object\]/);
  });
});

test("a final choice.message.content is not discarded", async () => {
  await withServer({ rawEvents: [{
    choices: [{
      message: { role: "assistant", content: '<<<MANIFEST>>>\n{"blocks":0}\n<<<END>>>' },
      finish_reason: "stop",
    }],
  }] }, async (server) => {
    const result = await client(server.baseUrl).complete({ prompt: "p", stopWhen: manifestStop });
    assert.equal(result.text, '<<<MANIFEST>>>\n{"blocks":0}\n<<<END>>>');
  });
});

test("keep-alive comments and unreadable events are skipped, not fatal", async () => {
  await withServer({ deltas: ["fine"], keepAlive: true }, async (server) => {
    const result = await client(server.baseUrl).complete({ prompt: "p" });
    assert.equal(result.text, "fine");
  });
});

test("a stream that ends without [DONE] still returns what arrived", async () => {
  await withServer({ deltas: ["partial but complete"], omitDone: true }, async (server) => {
    const result = await client(server.baseUrl).complete({ prompt: "p" });
    assert.equal(result.text, "partial but complete");
  });
});

test("an HTTP error carries the status and a bounded body", async () => {
  await withServer({ status: 503, body: "model is loading" }, async (server) => {
    await assert.rejects(client(server.baseUrl).complete({ prompt: "p" }), (error) => {
      assert.equal(error.code, ModelErrorCode.HTTP_ERROR);
      assert.equal(error.meta.status, 503);
      assert.match(error.meta.body, /model is loading/);
      return true;
    });
  });
});

test("an empty completion is an error, never an empty email", async () => {
  await withServer({ deltas: [] }, async (server) => {
    await assert.rejects(client(server.baseUrl).complete({ prompt: "p" }), (error) => {
      assert.equal(error.code, ModelErrorCode.EMPTY_COMPLETION);
      return true;
    });
  });
});

test("a model that stalls after sending headers trips the first-token deadline", async () => {
  // Distinct from the stream deadline on purpose: a model loading weights is
  // slow before the first token and fast after it, and one timeout cannot tell
  // a cold start from a wedge.
  await withServer({ stallForever: true, flushHeaders: true }, async (server) => {
    await assert.rejects(
      client(server.baseUrl, { firstTokenTimeoutMs: 60, streamTimeoutMs: 5000 }).complete({ prompt: "p" }),
      (error) => {
        assert.equal(error.code, ModelErrorCode.FIRST_TOKEN_TIMEOUT);
        return true;
      },
    );
  });
});

test("a model that never sends headers at all also trips the deadline", async () => {
  // The harsher stall, and the one an earlier version could not survive. The
  // deadlines were created after `await fetch`; a server that accepts the
  // connection and never puts bytes on the wire never resolves that fetch, so
  // the timer meant to catch a wedged model was never created and complete()
  // hung forever. The deadline has to cover connect and headers, not just the
  // token stream. `writeHead` alone sends nothing — this is the common shape,
  // not an exotic one.
  await withServer({ stallForever: true }, async (server) => {
    await assert.rejects(
      client(server.baseUrl, { firstTokenTimeoutMs: 60, streamTimeoutMs: 5000 }).complete({ prompt: "p" }),
      (error) => {
        assert.equal(error.code, ModelErrorCode.FIRST_TOKEN_TIMEOUT);
        return true;
      },
    );
  });
});

test("a run that blows its character budget is cut off at the budget", async () => {
  await withServer({ deltas: ["x".repeat(50), "y".repeat(50), "z".repeat(50)] }, async (server) => {
    await assert.rejects(
      client(server.baseUrl, { maxCharacters: 60 }).complete({ prompt: "p" }),
      (error) => {
        assert.equal(error.code, ModelErrorCode.TOKEN_BUDGET_EXCEEDED);
        assert.ok(error.meta.partial.length > 0, "partial text is what makes it diagnosable");
        return true;
      },
    );
  });
});

test("a caller can abort mid-stream", async () => {
  await withServer({ deltas: ["one ", "two ", "three "], delayMs: 40 }, async (server) => {
    const controller = new AbortController();
    await assert.rejects(
      client(server.baseUrl).complete({
        prompt: "p",
        signal: controller.signal,
        onToken: () => controller.abort(),
      }),
      (error) => {
        assert.equal(error.code, ModelErrorCode.ABORTED);
        return true;
      },
    );
  });
});

test("an already-aborted signal never opens a connection", async () => {
  await withServer({ deltas: ["never"] }, async (server) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      client(server.baseUrl).complete({ prompt: "p", signal: controller.signal }),
      (error) => error.code === ModelErrorCode.ABORTED,
    );
    assert.equal(server.requests.length, 0);
  });
});

test("an unreachable model is a network error, not a crash", async () => {
  const unreachable = createModelClient({ baseUrl: "http://127.0.0.1:1/v1", model: "m" });
  await assert.rejects(unreachable.complete({ prompt: "p" }), (error) => {
    assert.equal(error.code, ModelErrorCode.NETWORK_ERROR);
    return true;
  });
});

test("abort listeners do not accumulate on a reused signal", async () => {
  // A worker holds one shutdown signal for the life of the process and runs
  // every send through it. A per-call listener that is never removed leaks one
  // closure per email — silently, since `{ once: true }` only fires on abort
  // and Node emits no warning for a signal that is never aborted. Measured: 25
  // completions produced 25 listeners before this was fixed.
  await withServer({ deltas: ["ok"] }, async (server) => {
    const model = client(server.baseUrl);
    const controller = new AbortController();
    for (let i = 0; i < 25; i += 1) {
      await model.complete({ prompt: "p", signal: controller.signal });
    }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

test("removing the listener does not break aborting", async () => {
  await withServer({ deltas: ["a", "b", "c"], delayMs: 40 }, async (server) => {
    const controller = new AbortController();
    await assert.rejects(
      client(server.baseUrl).complete({
        prompt: "p",
        signal: controller.signal,
        onToken: () => controller.abort(),
      }),
      (error) => error.code === ModelErrorCode.ABORTED,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

test("a client requires a baseUrl and a model", () => {
  assert.throws(() => createModelClient({ model: "m" }), /baseUrl/);
  assert.throws(() => createModelClient({ baseUrl: "http://x/v1" }), /model name/);
});
