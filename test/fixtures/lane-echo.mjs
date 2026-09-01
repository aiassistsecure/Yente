/** A protocol-faithful lane for pool tests: echoes, fails, or dies on command. */
import { parentPort } from "node:worker_threads";

// node --test sweeps everything under test/, including this fixture; run
// outside a worker it must be inert, not a crash.
if (parentPort) parentPort.on("message", ({ id, kind, payload }) => {
  if (kind === "echo") {
    if (payload?.stream) {
      parentPort.postMessage({ id, stream: { phase: "content", delta: "x" } });
    }
    setTimeout(() => parentPort.postMessage({ id, ok: true, result: payload }),
      payload?.delayMs ?? 0);
    return;
  }
  if (kind === "boom") {
    parentPort.postMessage({ id, ok: false, error: { code: "BOOM", message: "kaput" } });
    return;
  }
  if (kind === "die") process.exit(3);
});
