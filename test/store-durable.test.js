/**
 * Durability across a restart — D7's "restarting during any state transition is
 * safe", at the storage layer.
 *
 * Two separate processes, because the engine takes an exclusive lock on its
 * data directory and a second open inside one process is refused. That refusal
 * is correct behaviour (a second handle cannot see the first's writes, so it
 * would be a split-brain rather than a second connection), and it means an
 * honest restart test has to actually restart something.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../test-support/durable-worker.mjs", import.meta.url));

/**
 * The worker writes its result to a file. The engine logs its own start-up line
 * to stdout on open, so a child's stdout is not a clean channel for structured
 * output — and suppressing an engine's logging to make a test parse would be
 * fixing the wrong end.
 */
function run(dir, mode) {
  // The result file lives beside the data directory, never inside it. The
  // engine scans its own directory on warm start; a stray file in there is a
  // hazard waiting for a version that stops ignoring it.
  const resultFile = join(dir, `${mode}.result.json`);
  execFileSync(process.execPath, [WORKER, join(dir, "db"), mode, resultFile], { stdio: "ignore" });
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

test("state and uniqueness survive a process restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "yente-durable-"));
  try {
    const written = run(dir, "write");
    assert.equal(written.verify, true);
    assert.ok(written.seq > 0);

    const reread = run(dir, "read");

    assert.equal(reread.seq, written.seq, "a warm start resumes at the same sequence");
    assert.equal(reread.verify, true, "the hash chain is intact across the restart");
    assert.equal(reread.messageSurvived, true);
    assert.equal(reread.jobState, "PENDING", "an unsent job is still there to be sent");
    assert.deepEqual(reread.claimable, ["k_durable"], "and still claimable by the new process");

    // The point of deriving ids from §12.1 rather than remembering them: the
    // new process has no in-memory record of what it has already seen, and
    // deduplication still holds because identity is addressing.
    assert.equal(reread.stillDeduplicates, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
