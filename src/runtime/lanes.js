/**
 * Lanes — Yente as a multi-threaded supervisor.
 *
 * Mark's directive, 2026-09-01: "Yente needs to become a multi-threaded
 * supervisor … 2 threads ingesting mail 2 threads communicating or 1/1 or
 * 2/3 etc should be configurable … main thread connects to nedb and
 * dispatches workers."
 *
 * THE DIVISION OF LABOUR IS THE DESIGN
 *
 * NEDB takes an exclusive lock per data directory. That is not a limitation
 * to engineer around — it is the supervisor pattern handed to us: the MAIN
 * thread is the only thing that ever touches the store. It listens to mail,
 * claims jobs, checks caches, applies verified results, runs matching (pure
 * store reads, nudged as understandings land — always on), and owns the
 * outbox. A WORKER owns nothing: it receives a task over postMessage, spends
 * the minutes a model round-trip costs — inference, parsing, span
 * verification, graded rounds — and posts back a plain-data result. A worker
 * that dies loses one attempt of one task; the graph cannot even be reached
 * from where it ran.
 *
 * One pool per SEAT, sized independently: ingest lanes run the document
 * model, voice lanes run the message model, and 2/1, 1/2, 2/3 is an env-var
 * decision, not an architecture change.
 */

import { Worker } from "node:worker_threads";

const LANE_SCRIPT = new URL("./lane-worker.mjs", import.meta.url);

export class LaneError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "LaneError";
    this.code = code;
    this.meta = meta;
  }
}

/**
 * A fixed-size pool of single-tasking workers.
 *
 * Each lane runs ONE task at a time — a lane is a unit of model concurrency,
 * and the GPU budget is planned in those units. Tasks beyond the pool size
 * queue in arrival order. A crashed lane rejects its in-flight task with a
 * TRANSIENT error (the drain's requeue machinery already knows what to do
 * with a bad moment) and is respawned; the queue survives.
 *
 * @param {object}  options
 * @param {number}  options.size        how many workers
 * @param {string}  options.name        for logs: "ingest", "voice"
 * @param {object}  [options.workerData] passed to each worker at spawn
 * @param {URL|string} [options.script] worker script (the lane worker by default)
 * @param {Function} [options.log]
 * @param {Function} [options.onEvent]  (event, taskMeta) — forwarded stream
 *                                      telemetry from inside a task
 */
export function createLanes({
  size,
  name = "lane",
  workerData = {},
  script = LANE_SCRIPT,
  log = () => {},
  onEvent = null,
}) {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError("createLanes requires an integer size >= 1");
  }

  let nextId = 1;
  let shuttingDown = false;
  const pending = new Map();     // id -> { resolve, reject, meta }
  const waiting = [];            // tasks not yet assigned
  const lanes = new Set();       // live workers
  const busy = new Map();        // worker -> task id

  function spawn() {
    const worker = new Worker(script, { workerData });
    lanes.add(worker);

    worker.on("message", (message) => {
      if (message?.stream !== undefined) {
        const id = busy.get(worker);
        const held = id ? pending.get(id) : null;
        onEvent?.(message.stream, held?.meta ?? null);
        return;
      }
      const held = pending.get(message?.id);
      if (!held) return;
      pending.delete(message.id);
      busy.delete(worker);
      if (message.ok) held.resolve(message.result);
      else {
        const info = message.error ?? {};
        held.reject(new LaneError(info.code ?? "LANE_TASK_FAILED",
          info.message ?? "the lane reported failure", info.meta ?? {}));
      }
      pump();
    });

    worker.on("error", (error) => {
      log("error", "lane_error", { lane: name, error: String(error?.message ?? error) });
    });

    worker.on("exit", (code) => {
      lanes.delete(worker);
      const id = busy.get(worker);
      busy.delete(worker);
      if (id && pending.has(id)) {
        const held = pending.get(id);
        pending.delete(id);
        // Transient by declaration: the task did not fail, its runner died.
        // The drain requeues on anything transient, so one crash costs one
        // attempt and nothing else.
        held.reject(new LaneError("LANE_CRASHED",
          `${name} lane exited (code ${code}) mid-task`, { transient: true }));
      }
      if (!shuttingDown) {
        log("warn", "lane_respawned", { lane: name, exit_code: code });
        spawn();
        pump();
      }
    });

    return worker;
  }

  function idleLane() {
    for (const worker of lanes) if (!busy.has(worker)) return worker;
    return null;
  }

  function pump() {
    while (waiting.length > 0) {
      const lane = idleLane();
      if (!lane) return;
      const task = waiting.shift();
      busy.set(lane, task.id);
      lane.postMessage({ id: task.id, kind: task.kind, payload: task.payload });
    }
  }

  /**
   * Run a task on the next free lane. Resolves with the worker's result,
   * rejects with a LaneError carrying the worker's own error code.
   */
  function dispatch(kind, payload, meta = null) {
    if (shuttingDown) {
      return Promise.reject(new LaneError("LANE_SHUTDOWN", "the pool is shutting down"));
    }
    const id = `t${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, meta });
      waiting.push({ id, kind, payload });
      pump();
    });
  }

  async function shutdown() {
    shuttingDown = true;
    for (const [id, held] of pending) {
      pending.delete(id);
      held.reject(new LaneError("LANE_SHUTDOWN", "the pool is shutting down", { transient: true }));
    }
    waiting.length = 0;
    await Promise.allSettled([...lanes].map((worker) => worker.terminate()));
    lanes.clear();
    busy.clear();
  }

  for (let i = 0; i < size; i += 1) spawn();
  log("info", "lanes_up", { lane: name, size });

  return Object.freeze({
    dispatch,
    shutdown,
    size,
    stats: () => ({ size, busy: busy.size, waiting: waiting.length }),
  });
}

/**
 * The observer interface, backed by an ingest pool.
 *
 * drainIntelligence never learns the difference: observe() has the same
 * shape, results and errors have the same codes, and stream telemetry still
 * reaches the operator console — it just crossed a thread boundary on the
 * way. `signal` cannot cross that boundary; shutdown terminates the pool
 * instead, which aborts harder than any signal.
 */
export function pooledObserver({ lanes, describe }) {
  return Object.freeze({
    describe,
    observe({ signal: _signal, ...task }) {
      return lanes.dispatch("observe", task, { evidence: task?.sources?.[0]?.id ?? null });
    },
  });
}

/**
 * A model client whose complete() runs on a voice lane. Everything Yente
 * writes to people renders off the main thread; onToken/signal stay behind
 * (they cannot cross postMessage), which generation treats as optional.
 */
export function pooledCompleter({ lanes, baseClient }) {
  return Object.freeze({
    ...baseClient,
    complete({ onToken: _onToken, onReasoning: _onReasoning, signal: _signal, ...task }) {
      return lanes.dispatch("complete", task);
    },
  });
}
