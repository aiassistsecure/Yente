/**
 * The two seats — Mark, 2026-08-31: "YENTE_MODEL_DOCUMENT to be the model
 * used for yente ingestion, and YENTE_MODEL_MESSAGE used for the model that
 * speaks to users."
 *
 * The split is by AUDIENCE, not by evidence size. Ingestion talks to the
 * parser: its output dies in verification gates, so it wants the careful
 * reader. The voice talks to people: its output lands in a stranger's inbox
 * wearing Yente's name. extractionClient runs the document seat; emailClient
 * runs the message seat; unset, the voice follows ingestion and nothing
 * changes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntelligenceProvider, inferenceKey, resolveIntelligenceConfig,
} from "../src/intelligence/provider.js";
import { createLlmClients } from "../src/llm/providers.js";

test("the voice is its own client when YENTE_MODEL_MESSAGE is set", () => {
  const held = {
    doc: process.env.YENTE_MODEL_DOCUMENT, msg: process.env.YENTE_MODEL_MESSAGE,
  };
  try {
    process.env.YENTE_MODEL_DOCUMENT = "GLM-4-32B";
    process.env.YENTE_MODEL_MESSAGE = "llama-3.1-8b";
    const clients = createLlmClients({ provider: "pin" });
    assert.equal(clients.describe.model, "GLM-4-32B", "ingestion seat");
    assert.equal(clients.describe.voice_model, "llama-3.1-8b", "voice seat");
    assert.notEqual(clients.emailClient, clients.extractionClient,
      "two seats, two clients");

    delete process.env.YENTE_MODEL_MESSAGE;
    const unsplit = createLlmClients({ provider: "pin" });
    assert.equal(unsplit.emailClient, unsplit.extractionClient,
      "unset, the voice follows ingestion — one client, nothing changes");
    assert.equal(unsplit.describe.voice_model, "GLM-4-32B");
  } finally {
    if (held.doc === undefined) delete process.env.YENTE_MODEL_DOCUMENT;
    else process.env.YENTE_MODEL_DOCUMENT = held.doc;
    if (held.msg === undefined) delete process.env.YENTE_MODEL_MESSAGE;
    else process.env.YENTE_MODEL_MESSAGE = held.msg;
  }
});

test("one variable is a whole config: the message seat follows the document seat", () => {
  const config = resolveIntelligenceConfig({ YENTE_MODEL_DOCUMENT: "GLM-4-32B" });
  assert.equal(config.messageModel, "GLM-4-32B");
  assert.equal(config.documentModel, "GLM-4-32B");
  assert.equal(config.model, "GLM-4-32B", "the client base model IS the document seat");
});

test("the split is two env vars, each independent", () => {
  const config = resolveIntelligenceConfig({
    YENTE_MODEL_DOCUMENT: "GLM-4-32B",
    YENTE_MODEL_MESSAGE: "llama-3.1-8b",
  });
  assert.equal(config.messageModel, "llama-3.1-8b");
  assert.equal(config.documentModel, "GLM-4-32B",
    "an unset half keeps its own seat rather than following the other half");
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
