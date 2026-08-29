/**
 * The three loops, lifted out of the entry point so one process can run them
 * alongside the desk.
 *
 * WHY A MODULE
 *
 * These were module-level functions in `bin/graph.mjs`, closing over module-level
 * state — which meant the only way to run them was to BE that process. With the
 * desk and the listener merging into one process, the loops have to be
 * constructible. The alternative was copying them into a second entry point, and
 * a loop that exists twice is a loop that gets fixed once.
 *
 * THE LOOPS RUN AT DIFFERENT SPEEDS ON PURPOSE
 *
 * Listening is cheap and wants to be immediate. Understanding is expensive
 * (40-75s per message through PIN, and the variance is not ours to control) and
 * wants to be steady. Matching is cheap but pointless to run more often than the
 * graph changes. Sharing one interval would pace all three to the slowest, which
 * is the same mistake as a single-threaded queue.
 *
 * WHAT `health` IS FOR, AND WHY IT IS NOT A COUNTER
 *
 * The failure that cost two days was not that IMAP broke — it was that nothing
 * said so. A listener has exactly one job and its silence is indistinguishable
 * from a quiet mailbox unless it reports the difference itself. So mail silence
 * is a first-class, queryable number rather than something you infer from the
 * absence of log lines.
 */

import { ingestMail } from "./ingest.js";
import { drainIntelligence } from "../intelligence/queue.js";
import { proposeIntroductions } from "./matching.js";
import { drainConfirmedIntroductions } from "./introductions.js";

/**
 * @param {object}   deps
 * @param {object}   deps.graph      graph repositories
 * @param {object}   [deps.source]   mail source; null when no mailbox is configured
 * @param {object}   deps.observer   the intelligence provider
 * @param {object}   deps.manager    graph manager (eligibility + pending matches)
 * @param {Function} [deps.log]
 * @param {Function} [deps.begin]    in-flight tracking, for the dashboard
 * @param {Function} [deps.end]
 * @param {AbortSignal} deps.signal  aborts every sleep and in-flight completion
 * @param {Function} deps.isStopping () => boolean — owned by the caller, because
 *                                   the merged process shuts the desk down too
 * @param {number}   [deps.concurrency] how many observations may be in flight.
 *   Passed in rather than read from the environment here, because the entry
 *   point already logs this number at boot: two independent reads of one env var
 *   agree by luck, and when they disagree the log names a value the code is not
 *   using. One read, one owner, passed down.
 */
export function createGraphLoops({
  graph,
  source = null,
  observer,
  manager,
  log = () => {},
  begin = () => {},
  end = () => {},
  signal,
  isStopping = () => false,
  intervals = {},
  concurrency = undefined,
  models = null,
  onMessage = null,
  transport = null,
}) {
  if (!graph) throw new TypeError("createGraphLoops requires the graph repositories");
  if (!observer) throw new TypeError("createGraphLoops requires an observer");
  if (!manager) throw new TypeError("createGraphLoops requires the graph manager");

  const understandIdleMs = Number(intervals.understandIdleMs ?? 15_000);
  const connectMs = Number(intervals.connectMs ?? 60_000);
  const idleWaitMs = Number(intervals.idleWaitMs ?? 15 * 60_000);

  const health = {
    startedAt: new Date().toISOString(),
    lastMailAt: null,
    lastMailError: null,
    consecutiveMailFailures: 0,
    ticks: { listen: 0, understand: 0, connect: 0 },
  };

  /** "I have not successfully read mail in N minutes." */
  function mailSilenceMinutes() {
    const since = health.lastMailAt ?? health.startedAt;
    return Math.round((Date.now() - new Date(since).getTime()) / 60_000);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  /* --- LISTEN ----------------------------------------------------------- */

  async function listen() {
    if (!source) return;
    while (!isStopping()) {
      try {
        const summary = await ingestMail({ source, graph, log, onMessage });
        health.lastMailAt = new Date().toISOString();
        health.consecutiveMailFailures = 0;
        health.lastMailError = null;
        health.ticks.listen += 1;

        // Something arrived: come straight back rather than idling, in case the
        // batch was capped.
        if (summary.fetched > 0) continue;
      } catch (error) {
        health.consecutiveMailFailures += 1;
        health.lastMailError = String(error?.message ?? error);
        log("error", "listen_failed", {
          error: health.lastMailError,
          consecutive: health.consecutiveMailFailures,
          silent_for_min: mailSilenceMinutes(),
        });

        // Back off hard and say it plainly. ECONNREFUSED repeated for a week is
        // how we got banned in the first place; grinding at a closed port is not
        // persistence, it is the thing that caused the problem.
        const backoffMs = Math.min(
          30 * 60_000,
          30_000 * 2 ** Math.min(6, health.consecutiveMailFailures),
        );
        if (health.consecutiveMailFailures === 3) {
          log("error", "mail_unreachable", {
            note: "three consecutive failures. If this is ECONNREFUSED, check "
              + "fail2ban on the mail server before anything else.",
          });
        }
        await sleep(backoffMs);
        continue;
      }

      // Nothing new: wait for the server to tell us, rather than asking again.
      begin("listen", "imap:idle", "waiting on IDLE");
      const arrived = await source.waitForMail({ timeoutMs: idleWaitMs, signal });
      end("imap:idle");
      if (!arrived && !isStopping()) await sleep(30_000);
    }
  }

  /* --- UNDERSTAND ------------------------------------------------------- */

  async function understand() {
    while (!isStopping()) {
      try {
        const summary = await drainIntelligence({
          graph, observer, log, signal, concurrency, models,
        });
        health.ticks.understand += 1;
        if (summary.claimed > 0) {
          log("info", "understood", { ...summary, backlog: graph.jobs.counts().READY });
          continue;   // keep going while there is a backlog
        }
      } catch (error) {
        // The whole drain failing is different from one job failing; the drain
        // already handles the latter. This is a bug or a dead gateway.
        log("error", "understand_failed", { error: String(error?.message ?? error) });
      }
      await sleep(understandIdleMs);
    }
  }

  /* --- CONNECT ---------------------------------------------------------- */

  async function connect() {
    while (!isStopping()) {
      try {
        const observations = graph.observations
          .all()
          // §20: an excluded subject is not a matching candidate. Read here
          // rather than filtered at write time so the exclusion stays reversible.
          //
          // AND they must have approved their own profile. Yente introduced two
          // people on the strength of "both mention resume" while both were
          // still mid-onboarding — neither had seen what she believed about
          // them, let alone agreed to it. Matching an unapproved profile is
          // matching on facts the person has never confirmed.
          .filter((row) => manager.isMatchable(row.subject));

        begin("connect", "match:scan", `scoring ${observations.length} observations`);
        const proposals = proposeIntroductions({ observations });
        let queued = 0;
        for (const proposal of proposals) {
          const { decided } = graph.matches.propose({
            ...proposal, at: new Date().toISOString(),
          });
          // A match a person already ruled on is never re-opened. Without this
          // the review queue is a treadmill.
          if (!decided) queued += 1;
        }
        end("match:scan");
        health.ticks.connect += 1;
        if (queued > 0) {
          log("info", "proposed", { queued, pending: manager.pendingMatches().length });
        }
        await drainConfirmedIntroductions({ graph, manager, transport, log });
      } catch (error) {
        end("match:scan");
        log("error", "connect_failed", { error: String(error?.message ?? error) });
      }
      await sleep(connectMs);
    }
  }

  return Object.freeze({
    listen, understand, connect, health, mailSilenceMinutes, sleep, concurrency,
  });
}
