/**
 * Oldest first survives a restart — Mark, live tape 18:44: "on reboot yente
 * seems to be picking randomly from the queue? or is it ordered?"
 *
 * It IS ordered — ready() serves oldest-due first — but a Ctrl-C made it
 * LOOK random: the two in-flight jobs died with LANE_SHUTDOWN, which
 * counted as a failed ATTEMPT and stamped 30s/120s of backoff. Next boot,
 * those two were not yet due, so the queue served the next-oldest pair —
 * every restart rotated the backlog and inflated attempt counts for jobs
 * that never got a fair run (the tape's attempt=#3 was mostly interruptions).
 *
 * A shutdown is OUR event, not the job's failure: release() refunds the
 * attempt and makes the job due immediately, so the next boot resumes
 * exactly where this one stopped.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, JOB_STATES } from "../src/store/graph.js";

const T0 = "2026-09-01T18:44:00.000Z";
const T1 = "2026-09-01T18:45:00.000Z";
const T2 = "2026-09-01T18:46:00.000Z";

function fresh() {
  return createGraphRepositories(openInMemory());
}

test("release refunds the attempt and the job is due immediately", () => {
  const graph = fresh();
  graph.jobs.enqueue({ evidenceId: "message:aaa", at: T0 });
  graph.jobs.start("message:aaa", T1); // attempts -> 1

  const released = graph.jobs.release("message:aaa", { at: T1, reason: "interrupted by shutdown" });
  assert.equal(released.state, JOB_STATES.READY);
  assert.equal(released.attempts, 0, "an interruption consumes no attempt");
  assert.equal(released.availableAt, T0,
    "and restores the job's ORIGINAL place in line — no backoff, no rotation");
  assert.match(released.lastError, /interrupted by shutdown/,
    "the interruption is on the record, just not on the bill");

  const [next] = graph.jobs.ready(10, T1);
  assert.equal(next.evidenceId, "message:aaa", "due on the very next drain");
});

test("the queue is oldest-due first, and a restart no longer rotates it", () => {
  const graph = fresh();
  // Three messages arrive in order.
  graph.jobs.enqueue({ evidenceId: "message:first", at: "2026-09-01T10:00:00.000Z" });
  graph.jobs.enqueue({ evidenceId: "message:second", at: "2026-09-01T11:00:00.000Z" });
  graph.jobs.enqueue({ evidenceId: "message:third", at: "2026-09-01T12:00:00.000Z" });

  // Boot 1 claims the two oldest, then dies mid-inference.
  const [a, b] = graph.jobs.ready(2, T0);
  assert.deepEqual([a.evidenceId, b.evidenceId], ["message:first", "message:second"],
    "oldest first, deterministically");
  graph.jobs.start(a.evidenceId, T0);
  graph.jobs.start(b.evidenceId, T0);
  graph.jobs.release(a.evidenceId, { at: T1, reason: "interrupted by shutdown" });
  graph.jobs.release(b.evidenceId, { at: T1, reason: "interrupted by shutdown" });

  // Boot 2: the SAME two jobs lead the queue — no rotation, no penalty.
  const next = graph.jobs.ready(2, T2).map((j) => j.evidenceId);
  assert.deepEqual(next, ["message:first", "message:second"],
    "the restart resumes exactly where the last boot stopped");
});

test("a real failure still pays: backoff defers, release does not erase history", () => {
  const graph = fresh();
  graph.jobs.enqueue({ evidenceId: "message:flaky", at: T0 });
  graph.jobs.enqueue({ evidenceId: "message:patient", at: "2026-09-01T18:44:05.000Z" });

  // A genuine model failure on the older job: it backs off...
  graph.jobs.start("message:flaky", T0);
  graph.jobs.fail("message:flaky", { at: T0, error: new Error("gateway 503") });
  // ...and the younger job rightly goes first while the older one waits
  // out its 30s (checked at +10s, safely inside the backoff window).
  const due = graph.jobs.ready(10, "2026-09-01T18:44:10.000Z").map((j) => j.evidenceId);
  assert.deepEqual(due, ["message:patient"],
    "real backoff still defers — release is for interruptions only");
});
