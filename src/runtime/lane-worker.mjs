/**
 * The lane worker — one seat, one task at a time, no store.
 *
 * This file is everything a worker thread is ALLOWED to be: it builds its
 * own model client from the environment (the same env the main thread read,
 * so the seats agree), runs the expensive part of a job — inference, envelope
 * parsing, span verification, graded rounds — and posts back plain data. It
 * imports nothing from src/store; the NEDB directory is locked by the main
 * thread and unreachable from here BY CONSTRUCTION, which is what makes a
 * lane crash a one-attempt event instead of a data event.
 *
 * Seats:
 *   ingest  observe tasks — the document model reads evidence
 *   voice   complete tasks — the message model writes to people
 */

import { parentPort, workerData } from "node:worker_threads";

import { createLlmClients } from "../llm/providers.js";
import { createIntelligenceProvider } from "../intelligence/provider.js";

const seat = workerData?.seat === "voice" ? "voice" : "ingest";
const providerName = workerData?.provider ?? undefined;

const clients = createLlmClients({ provider: providerName });

// The id of the task currently running, so stream telemetry can be routed
// to the right dispatch on the supervisor side. One task at a time per lane
// is the pool's contract, which is what makes this a variable and not a map.
let currentId = null;

const observer = seat === "ingest"
  ? createIntelligenceProvider({
    client: clients.extractionClient,
    provider: providerName ?? "pin",
    model: clients.describe.model,
    onStream: (event) => {
      if (currentId !== null) parentPort.postMessage({ id: currentId, stream: event });
    },
  })
  : null;

/** Errors cross the boundary as data; the supervisor rebuilds them. */
function serializeError(error) {
  let meta = {};
  try {
    meta = JSON.parse(JSON.stringify(error?.meta ?? {}));
  } catch {
    meta = {};
  }
  return {
    code: error?.code ?? "LANE_TASK_FAILED",
    message: String(error?.message ?? error),
    meta,
  };
}

parentPort.on("message", async ({ id, kind, payload }) => {
  currentId = id;
  try {
    let result;
    if (kind === "observe" && observer) {
      result = await observer.observe(payload ?? {});
    } else if (kind === "complete") {
      const completion = await clients.emailClient.complete(payload ?? {});
      result = {
        text: completion.text,
        finishReason: completion.finishReason ?? null,
        elapsedMs: completion.elapsedMs ?? null,
      };
    } else {
      throw Object.assign(new Error(`this ${seat} lane does not run "${kind}" tasks`), {
        code: "UNKNOWN_LANE_TASK",
      });
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeError(error) });
  } finally {
    currentId = null;
  }
});
