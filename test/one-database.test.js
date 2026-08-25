/**
 * One database, one process — and the daemon must actually reach every loop.
 *
 * WHY THIS FILE READS AN ENTRY POINT AS TEXT
 *
 * Every bug it guards against is of the form "the function exists, it is tested,
 * and nothing in production calls it". A test that imports the module and calls
 * the function itself cannot see that: it would supply the very call whose
 * absence is the defect. That is exactly how `qualify()` sat exported and
 * uncalled while a résumé produced sixteen verified facts and no reply, and how
 * `registerDocumentParsers()` was called only by the suite while production
 * rejected every attachment.
 *
 * So the wiring is asserted against the shipped source, and the behaviour is
 * asserted against a real shared store below.
 *
 * WHAT WAS ACTUALLY WRONG
 *
 * Two data directories — YENTE_DATA_PATH for members, YENTE_WAITLIST_DATA_PATH
 * for subscribers — because the engine locks a directory exclusively and offers
 * no close, so two processes could not share one. The cost was product, not
 * tidiness: a person who joined on the site and a person who emailed lived in
 * different databases with nothing joining them, and the weekly letter sequence
 * was orphaned because it needs to read subscribers AND write to the outbox.
 *
 * And the daemon called exactly two runtime functions, `ingest` and
 * `drainOutbox`. `proposeMatches` and `advanceDeadlines` were reachable only
 * from D8. The desk could take somebody in and then never do the thing it exists
 * for.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { openWaitlistRepository } from "../src/waitlist/repository.js";
import { COHORTS } from "../src/waitlist/capacity.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const daemon = read("bin/daemon.mjs");

/**
 * The tick moved into a module, and these assertions followed it.
 *
 * The premise of reading source as text is unchanged and still right: the bug
 * class is "the function exists, it is tested, and nothing in production calls
 * it", which a test that makes the call itself can never see. What changed is
 * WHERE production calls it. The desk's tick now lives in one module because two
 * entry points run it, and asserting against bin/daemon.mjs alone would pass
 * happily while the merged entry point quietly skipped matching.
 *
 * So: the ORDER assertions read the module that owns the tick, and every entry
 * point that claims to run a desk must be shown to construct one.
 */
const desk = read("src/runtime/desk.js");
const ENTRY_POINTS_WITH_A_DESK = ["bin/daemon.mjs", "bin/yente.mjs"];

/* --- the daemon reaches the whole loop ---------------------------------- */

test("the daemon calls matching and the veto clock, not just ingest and drain", () => {
  // The two that were unreachable. D8 proves the chain works; nothing drove it.
  assert.match(desk, /runtime\.proposeMatches\(/,
    "matching was exported and called by nothing outside the test suite");
  assert.match(desk, /runtime\.advanceDeadlines\(/,
    "without this a veto window never expires and no introduction is ever sent");

  // And the two that already worked, so a refactor cannot quietly drop them.
  assert.match(desk, /runtime\.ingest\(/);
  assert.match(desk, /runtime\.drainOutbox\(/);

  // And every entry point that claims to run a desk must actually build one,
  // or the tick above is unreachable from production no matter how correct it is.
  for (const entry of ENTRY_POINTS_WITH_A_DESK) {
    assert.match(read(entry), /createDesk\(/,
      `${entry} must construct the desk, or none of the above runs`);
  }
});

test("matching runs BEFORE the outbox drains", () => {
  // Ordering is load-bearing: a window that expired while the process slept has
  // to close before the drain, or the introduction it authorises waits a whole
  // extra tick for no reason.
  assert.ok(desk.indexOf("runtime.proposeMatches(") < desk.indexOf("runtime.drainOutbox("),
    "propose, then advance, then send");
  assert.ok(desk.indexOf("runtime.advanceDeadlines(") < desk.indexOf("runtime.drainOutbox("));
});

test("a failure in matching cannot cost us the inbox or the outbox", () => {
  // The message is durably recorded by then. One malformed opportunity must not
  // strand a queued letter.
  const block = desk.slice(desk.indexOf("let proposed = 0;"), desk.indexOf("const drained ="));
  assert.match(block, /try \{/);
  assert.match(block, /matching_failed/);
});

test("the daemon serves the BFF from the same process and the same store", () => {
  assert.match(daemon, /openWaitlistRepository\(\{\s*store\s*\}\)/,
    "the waitlist must be built on the daemon's own store, not a second directory");
  assert.match(daemon, /createYenteServer\(/, "the web surface lives in this process now");
  assert.match(daemon, /httpServer\.listen\(/);
});

test("only ACTIVE members are offered to matching", () => {
  // Matchability is a separate gate from qualification (§7.2). Enforced here by
  // whose profile is even built.
  const block = desk.slice(desk.indexOf("const profiles = {}"), desk.indexOf("runtime.proposeMatches"));
  assert.match(block, /state !== "ACTIVE"/);
  assert.match(block, /buildProfileView\(/,
    "profiles are materialised from span-verified facts, never handed in");
});

test("a split data path is refused loudly instead of silently splitting the data", () => {
  assert.match(daemon, /YENTE_WAITLIST_DATA_PATH/);
  assert.match(daemon, /split_data_path/);
  assert.match(daemon, /migrate-waitlist/,
    "and it must say how to bring the old subscribers across");
});

test("shutdown closes the HTTP listener before the store", () => {
  const shutdown = daemon.slice(daemon.indexOf("async function shutdown"));
  const closedHttp = shutdown.indexOf("httpServer.close");
  const closedStore = shutdown.indexOf("closeDatabase(store)");
  assert.ok(closedHttp > -1, "an accepted signup must not be written to a closing store");
  assert.ok(closedHttp < closedStore, "stop accepting requests first, then flush");
});

test("a dead port does not take the desk down with it", () => {
  // Mail and matching do not depend on the BFF. Losing them because a stale
  // process holds 3000 would be a worse outage than losing the landing page.
  assert.match(daemon, /httpServer\.on\("error"/);
  assert.match(daemon, /http_failed/);
});

/* --- and the behaviour: both datasets really do share one store --------- */

test("members and subscribers coexist in one store without colliding", () => {
  const store = openInMemory();
  const repositories = createRepositories(store);
  const waitlist = openWaitlistRepository({ store });

  waitlist.subscribe({
    email: "dev@interchained.org",
    name: "Mark",
    cohort: COHORTS.FOUNDER_DEVELOPER,
    intent: "building",
    consent: true,
  });

  repositories.members.save({
    memberId: "someone@example.com",
    address: "someone@example.com",
    state: "INTERVIEWING",
    inboundEstablishedAt: "2026-08-14T00:00:00Z",
  });

  // Collections are namespaced, so one directory holds both cleanly.
  assert.equal(store.query(`FROM ${COLLECTIONS.SUBSCRIBERS}`).length, 1);
  assert.equal(store.query(`FROM ${COLLECTIONS.MEMBERS}`).length, 1);

  // The join that was impossible across two databases: a subscriber's address
  // can now be looked up in the member ledger in the same query engine.
  const subscriber = store.query(`FROM ${COLLECTIONS.SUBSCRIBERS}`)[0];
  assert.equal(repositories.members.findByAddress(subscriber.email), null,
    "this one has not written in yet — and asking is now possible at all");

  repositories.members.save({
    memberId: subscriber.email,
    address: subscriber.email,
    state: "INTERVIEWING",
    inboundEstablishedAt: "2026-08-14T00:00:00Z",
  });
  assert.ok(repositories.members.findByAddress(subscriber.email),
    "the funnel reaches the desk");
});

test("capacity still reads correctly from the shared store", () => {
  // The landing page's counter is the most visible thing on the site; moving the
  // data must not change what it says.
  const store = openInMemory();
  const waitlist = openWaitlistRepository({ store });

  const before = waitlist.capacity();
  waitlist.subscribe({
    email: "one@example.com", name: "One",
    cohort: COHORTS.FOUNDER_DEVELOPER, intent: "building", consent: true,
  });
  const after = waitlist.capacity();

  // NOTE a real naming seam: the cohort ID you SUBSCRIBE with is snake_case
  // ("founder_developer"), while the capacity SNAPSHOT keys are camelCase
  // ("foundersDevelopers") because that is the shape web/public/app.js reads.
  // Asserted as-is rather than tidied — the page depends on these exact keys,
  // and a rename is a separate change with its own blast radius.
  assert.equal(
    after.cohorts.foundersDevelopers.joined,
    before.cohorts.foundersDevelopers.joined + 1,
  );
  assert.equal(
    after.cohorts.foundersDevelopers.remaining,
    before.cohorts.foundersDevelopers.remaining - 1,
  );
  assert.equal(after.total.joined, before.total.joined + 1, "the 10k total tracks too");
});
