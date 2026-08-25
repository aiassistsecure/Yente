/**
 * The desk's tick, lifted out of the daemon so two entry points cannot drift.
 *
 * WHY THIS IS A MODULE NOW
 *
 * The desk and the listener used to be two processes because the store refused
 * to open a second directory — my own guard, not the engine's (see the note in
 * store/db.js). With that corrected, one process owns both directories, and the
 * desk's work has to be callable from the merged entry point.
 *
 * Copying the tick into a second file was the alternative, and it is how you get
 * a bug fixed in one loop and not the other. The behaviour here is unchanged
 * from the version that ran in production; only its address is different.
 *
 * ORDER IS THE DESIGN, AND IT IS NOT ARBITRARY
 *
 *   ingest -> propose -> advance deadlines -> drain outbox
 *
 * Propose before advancing, so a match opens its veto window in the same tick
 * it is created. Advance before draining, so a window that expired while the
 * process slept closes BEFORE the outbox runs and the introduction it authorises
 * goes out now rather than one tick later. Drain last, always.
 *
 * Every stage that can fail is caught at its own granularity: matching must not
 * cost us the inbox, and a message already durably recorded must not be lost
 * because a policy was malformed.
 */

import { buildProfileView } from "../store/profile-view.js";
import { COLLECTIONS } from "../store/db.js";

export const POLL_RUNS = "poll_runs";

/**
 * @param {object}   deps
 * @param {object}   deps.store      the desk's store (NOT the graph's)
 * @param {object}   deps.runtime    createRuntime(...)
 * @param {Function} deps.log        (level, event, meta) => void
 * @param {string}   [deps.mode]     recorded on each poll_run row, for auditing
 */
export function createDesk({ store, runtime, log = () => {}, mode = "daemon" }) {
  if (!store) throw new TypeError("createDesk requires the desk store");
  if (!runtime) throw new TypeError("createDesk requires the runtime");

  async function tick() {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const runId = `poll_${startedAt}_${process.pid}`;

    // Written BEFORE the work, so a tick that dies is visible by its missing
    // finished_at rather than by nothing at all. Observability must never block
    // the tick, hence the swallow.
    try {
      store.put(POLL_RUNS, runId, {
        started_at: startedAt, finished_at: null, pid: process.pid, mode,
      });
    } catch { /* ignore */ }

    const now = new Date();
    const ingested = await runtime.ingest(now);
    const outcomes = {};
    // Extraction totals, and the reasons it produced nothing. `ingested=1 sent=0`
    // was true of at least four different states and distinguished none of them:
    // no source stored, a source with no facts, facts with an empty outbox, or a
    // queued letter that failed to send. Recovering the difference took a separate
    // tool re-running extraction by hand. The counts belong in the tick.
    let facts = 0;
    let rejected = 0;
    const failures = [];
    for (const r of ingested) {
      const key = r?.outcome ?? "unknown";
      outcomes[key] = (outcomes[key] || 0) + 1;
      facts += r?.facts ?? 0;
      rejected += r?.rejected ?? 0;
      for (const f of r?.failures ?? []) failures.push(f);
    }

    // A failure here is not a failed tick — the message is durably recorded and
    // she may simply have had nothing to say — so it is logged at its own level
    // rather than thrown. Silent is the one thing it must not be.
    for (const f of failures) {
      log("error", "extraction_failed", { code: f.code, error: String(f.message).slice(0, 300) });
    }
    if (rejected > 0) {
      log("warn", "facts_rejected", {
        rejected,
        note: "the model quoted evidence that is not in the document — grounding "
          + "refused it (INV-5). Not an error; a fact she declined to believe.",
      });
    }

    // MATCHING, WHICH NOTHING IN PRODUCTION USED TO CALL.
    //
    // `proposeMatches` and `advanceDeadlines` were exported by the runtime and
    // invoked by nothing outside the test suite. D8 drives the whole chain — match,
    // two private previews, veto window, one joint introduction — and proves it
    // works. No live process drove any of it, so the desk could take somebody in
    // and then never do the thing it exists to do.
    //
    // Ordering matters. Propose first so a new match opens its window in this same
    // tick; advance deadlines second so a window that expired while we were asleep
    // closes before the outbox drains, and the introduction it authorises goes out
    // now rather than a tick later.
    let proposed = 0;
    let advanced = 0;
    try {
      // The profile view is the materialisation of §6.1 — built from span-verified
      // facts, not handed in. Only ACTIVE members are offered: matchability is a
      // separate gate from qualification (§7.2), and it is enforced here by whose
      // profile is even built.
      const profiles = {};
      for (const member of store.query(`FROM ${COLLECTIONS.MEMBERS}`)) {
        if (member.state !== "ACTIVE") continue;
        const address = member.address ?? member._id;
        profiles[address] = buildProfileView(store, address);
      }
      proposed = (runtime.proposeMatches({ profiles, now }) ?? []).length;
      advanced = (runtime.advanceDeadlines(now) ?? []).length;
    } catch (error) {
      // Matching must not cost us the inbox. A message is already durably recorded
      // by this point and the outbox still has to drain; a bad policy or one
      // malformed opportunity should not strand either.
      log("error", "matching_failed", { error: String(error?.message ?? error).slice(0, 300) });
    }

    const drained = await runtime.drainOutbox(now);
    const sent = Array.isArray(drained)
      ? drained.filter((d) => d?.status === "sent" || d?.sent).length
      : Number(drained?.sent ?? 0);

    try {
      store.put(POLL_RUNS, runId, {
        started_at: startedAt, finished_at: new Date().toISOString(),
        pid: process.pid, mode, status: "ok",
        ingested: ingested.length, sent, outcomes,
        facts, rejected, failures: failures.length, proposed, advanced,
      });
    } catch { /* ignore */ }

    return {
      ingested: ingested.length, sent, outcomes,
      facts, rejected, failures: failures.length, proposed, advanced,
      ms: Date.now() - t0,
    };
  }

  return Object.freeze({ tick });
}
