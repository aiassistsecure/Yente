/**
 * One model for messages, another for documents — the split follows the work.
 *
 * Measured live: a short message took 1m1s of deliberation to decide whether to
 * attach an email address to one entity; the résumé pass in the same minute
 * produced 63 typed claims. Messages are short bodies whose right answer is
 * usually zero or one claim; documents reward a model that thinks.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntelligenceProvider, inferenceKey, resolveIntelligenceConfig,
} from "../src/intelligence/provider.js";

test("both models default to THE model, so an unsplit config changes nothing", () => {
  const config = resolveIntelligenceConfig({ YENTE_MODEL: "muse-local:latest" });
  assert.equal(config.messageModel, "muse-local:latest");
  assert.equal(config.documentModel, "muse-local:latest");
});

test("the split is two env vars, each independent", () => {
  const config = resolveIntelligenceConfig({
    YENTE_MODEL: "muse-local:latest",
    YENTE_MODEL_MESSAGE: "small:latest",
  });
  assert.equal(config.messageModel, "small:latest");
  assert.equal(config.documentModel, "muse-local:latest",
    "an unset half keeps the default rather than following the other half");
});

test("the cache key changes with the model, so a swap cannot serve stale answers", () => {
  const base = {
    sources: [{ id: "message:a", text: "hello" }],
    provider: "pin", schemaVersion: "obs_v2", promptVersion: "v9",
  };
  assert.notEqual(
    inferenceKey({ ...base, model: "muse-local:latest" }),
    inferenceKey({ ...base, model: "small:latest" }),
  );
});

test("a per-call model reaches the wire AND the provenance", async () => {
  let wireModel = null;
  const client = {
    model: "construction-model",
    complete: async (request) => {
      wireModel = request.model ?? "construction-model";
      return { text: '<<<OBSERVATIONS>>>\n{}\n<<<END>>>', finishReason: "stop", elapsedMs: 5 };
    },
  };
  const provider = createIntelligenceProvider({
    client, provider: "pin", model: "construction-model",
  });

  const result = await provider.observe({
    sources: [{ id: "message:a", text: "hello" }],
    model: "per-call-model",
  });
  assert.equal(wireModel, "per-call-model", "the override must reach the request");
  assert.equal(result.provenance.model, "per-call-model",
    "every observation records which model ACTUALLY produced it — "
    + "that is what makes a swap measurable instead of a vibe");

  const unsplit = await provider.observe({ sources: [{ id: "message:b", text: "hi" }] });
  assert.equal(unsplit.provenance.model, "construction-model",
    "no override means exactly the old behaviour");
});
