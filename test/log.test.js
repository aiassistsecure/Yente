/**
 * Tests for the narrator.
 *
 * A logger seems like the last thing worth testing, but this one carries real
 * state: it counts claims, it tracks which jobs are in flight, and the heartbeat
 * reads both. A leak in that map means the dashboard reports work as running
 * forever — which is the exact failure mode (silence indistinguishable from
 * death) the logger exists to prevent. So the tests here are about the
 * bookkeeping, not the colours.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, human } from "../src/log.js";

/** Capture stdout for one synchronous block. */
function capture(fn) {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = original; }
  return written.join("");
}

test("human() reads like a duration a person would say", () => {
  assert.equal(human(800), "800ms");
  assert.equal(human(48_213), "48.2s");
  assert.equal(human(74_000), "1m14s");

  // The rollover. 179.6s used to print "2m60s": the minutes floored to 2 and the
  // remainder rounded to 60, each correct on its own and wrong together. Round
  // to whole seconds first, then split.
  assert.equal(human(179_600), "3m0s");
  assert.equal(human(239_600), "4m0s");
  assert.equal(human(179_400), "2m59s");
  assert.equal(human(undefined), "?");
});

test("an unknown event still prints, with all of its metadata", () => {
  // An event nobody anticipated is the one worth seeing. Dropping it because it
  // has no case in the switch would hide exactly the surprises we want.
  const logger = createLogger();
  const out = capture(() => logger.log("warn", "something_i_did_not_plan_for", {
    weird: 7, note: "hello",
  }));
  assert.match(out, /something_i_did_not_plan_for/);
  assert.match(out, /weird=7/);
  assert.match(out, /note=hello/);
});

test("in-flight work is named while it runs and released when it settles", () => {
  const logger = createLogger();
  const graph = { jobs: { counts: () => ({ READY: 2, RUNNING: 1 }) } };
  const health = { consecutiveMailFailures: 0 };

  logger.log("info", "observe_started", { evidence: "message:0cce4e55", attempt: 1 });

  const during = capture(() =>
    logger.heartbeat({ graph, health, mailSilenceMinutes: 1 }));
  assert.match(during, /message:0cce4e55/,
    "the heartbeat must be able to answer 'what is it doing right now'");

  logger.log("info", "observed", {
    evidence: "message:0cce4e55", claims: 6, elapsed_ms: 1234,
  });

  const after = capture(() =>
    logger.heartbeat({ graph, health, mailSilenceMinutes: 1 }));
  assert.doesNotMatch(after, /message:0cce4e55/,
    "a finished job left in the map reads as permanently stuck");
});

test("the id in observe_started matches the id in observed, or nothing is released", () => {
  // This is the bug this test exists for: queue.js used to truncate the id on
  // completion but not on start, so end() looked up a key that was never there
  // and every job accumulated in the in-flight map. Truncation is the LOGGER's
  // job precisely so the two ends cannot disagree.
  const logger = createLogger();
  const graph = { jobs: { counts: () => ({}) } };
  const health = { consecutiveMailFailures: 0 };

  logger.log("info", "observe_started", { evidence: "attachment:eea45f00deadbeef", attempt: 1 });
  logger.log("warn", "observe_failed", {
    evidence: "attachment:eea45f00deadbeef", code: "TRUNCATED_ANSWER", attempt: 1,
  });

  const out = capture(() => logger.heartbeat({ graph, health, mailSilenceMinutes: 0 }));
  assert.doesNotMatch(out, /eea45f00/);
});

test("a failed observation counts as a retry, and the heartbeat says so", () => {
  const logger = createLogger();
  const graph = { jobs: { counts: () => ({ READY: 1, FAILED: 2 }) } };

  logger.log("warn", "observe_failed", { evidence: "message:a", code: "MALFORMED_BLOCK", attempt: 2 });
  assert.equal(logger.stats.retries, 1);
  assert.equal(logger.stats.failures, 1);

  const out = capture(() => logger.heartbeat({
    graph, health: { consecutiveMailFailures: 0 }, mailSilenceMinutes: 0,
  }));
  assert.match(out, /dead 2/, "jobs the queue gave up on must be visible");
  assert.match(out, /retries 1/);
});

test("mail failure is the loudest thing on the line", () => {
  // Two days of silence went unnoticed once. The state of the sensor is not a
  // detail buried in a counter; it is the first field.
  const logger = createLogger();
  const graph = { jobs: { counts: () => ({}) } };

  const down = capture(() => logger.heartbeat({
    graph, health: { consecutiveMailFailures: 4 }, mailSilenceMinutes: 300,
  }));
  assert.match(down, /mail DOWN 4x/);

  const quietMailbox = capture(() => logger.heartbeat({
    graph, health: { consecutiveMailFailures: 0 }, mailSilenceMinutes: 400,
  }));
  assert.match(quietMailbox, /quiet 400m/,
    "a long-quiet mailbox is not the same as a healthy one and should not read as green");
});

test("ingested and observed totals accumulate across ticks", () => {
  const logger = createLogger({ quiet: true });
  logger.log("info", "ingested", { fetched: 18, new: 18, documents: 7, uid: 18 });
  logger.log("info", "ingested", { fetched: 3, new: 2, documents: 0, uid: 20 });
  logger.log("info", "observed", { evidence: "m:1", claims: 6, elapsed_ms: 40_000 });
  logger.log("info", "observed", { evidence: "m:2", claims: 5, elapsed_ms: 60_000 });

  assert.equal(logger.stats.ingested, 20);
  assert.equal(logger.stats.documents, 7);
  assert.equal(logger.stats.observed, 2);
  assert.equal(logger.stats.claims, 11);
  assert.deepEqual(logger.stats.observeMs, [40_000, 60_000]);
});

test("quiet silences the heartbeat but never the events", () => {
  // YENTE_QUIET is for a supervised run where something else is drawing the
  // dashboard. It must not suppress a failure — a silent error is how the
  // outage stayed invisible.
  const logger = createLogger({ quiet: true });
  const graph = { jobs: { counts: () => ({}) } };

  assert.equal(
    capture(() => logger.heartbeat({
      graph, health: { consecutiveMailFailures: 0 }, mailSilenceMinutes: 0,
    })),
    "",
  );
  assert.match(
    capture(() => logger.log("error", "listen_failed", {
      error: "ECONNREFUSED", consecutive: 3, silent_for_min: 90,
    })),
    /cannot read mail/,
  );
});

test("colour is off when nothing is watching", () => {
  // A log file full of escape codes is worse than no colour: grep stops
  // matching. The test asserts the shape of the decision rather than the codes,
  // because the test runner is itself not a TTY.
  const logger = createLogger();
  const out = capture(() => logger.log("info", "imap_connected", {
    host: "box.example.org", mailbox: "INBOX",
  }));
  if (!process.stdout.isTTY) {
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\[/, "piped output must be plain text");
  }
  assert.match(out, /box\.example\.org/);
});
