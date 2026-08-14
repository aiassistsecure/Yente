#!/usr/bin/env node
/**
 * Move subscribers out of the old standalone waitlist database into the desk's.
 *
 *   node bin/migrate-waitlist.mjs ./data/waitlist            # dry run
 *   node bin/migrate-waitlist.mjs ./data/waitlist --commit   # actually write
 *
 * There used to be two data directories, because the engine takes an exclusive
 * lock per directory and exposes no close, so the web process could not share
 * the daemon's. The consequence was not untidiness: a person who joined on the
 * site lived in one database as a `subscriber` and a person who emailed lived in
 * the other as a `member`, and nothing connected them. The funnel never reached
 * the desk.
 *
 * The daemon now owns one directory and serves the BFF itself, so the old
 * subscribers have to come across.
 *
 * WHY IT OPENS THEM ONE AT A TIME
 *
 * Both directories cannot be held at once — same lock, and no close. So this
 * reads the old one, releases it by exiting that phase, and then writes. It also
 * means the daemon must be STOPPED while this runs, since it holds the target.
 *
 * SAFETY: dry run by default; prints exactly what it would do. Never deletes the
 * source. Idempotent — a subscriber already present by email is skipped, so
 * running it twice does not duplicate anybody.
 */

import process from "node:process";
import { openDatabase, closeDatabase } from "../src/store/db.js";

const SOURCE = process.argv[2];
const COMMIT = process.argv.includes("--commit");
const TARGET = process.env.YENTE_DATA_PATH || "./data/yente";

const SUBSCRIBERS = "subscribers";
const SUBSCRIPTION_EVENTS = "subscription_events";

if (!SOURCE) {
  console.error("usage: node bin/migrate-waitlist.mjs <old-waitlist-dir> [--commit]");
  process.exit(2);
}
if (SOURCE === TARGET) {
  console.error(`Source and target are the same directory (${TARGET}). Nothing to do.`);
  process.exit(0);
}

function open(path, label) {
  try {
    return openDatabase(path);
  } catch (error) {
    const m = String(error?.message ?? error);
    if (/already open|lock/i.test(m)) {
      console.error(`${label} (${path}) is locked by another process.`);
      console.error("Stop the daemon first:  systemctl stop yente");
      process.exit(2);
    }
    console.error(`cannot open ${label} (${path}): ${m}`);
    process.exit(1);
  }
}

/* --- phase 1: read the old directory, then let go of it ------------------ */

let subscribers = [];
let events = [];
{
  const source = open(SOURCE, "old waitlist");
  const read = (c) => { try { return source.query(`FROM ${c}`); } catch { return []; } };
  subscribers = read(SUBSCRIBERS);
  events = read(SUBSCRIPTION_EVENTS);
  closeDatabase(source);
}

console.log(`source   ${SOURCE}`);
console.log(`  subscribers        ${subscribers.length}`);
console.log(`  subscription_events ${events.length}`);

if (subscribers.length === 0 && events.length === 0) {
  console.log("\nNothing to migrate. Unset YENTE_WAITLIST_DATA_PATH and start the daemon.");
  process.exit(0);
}

/* --- phase 2: write into the desk's directory ---------------------------- */

const target = open(TARGET, "desk");
const existing = new Set(
  (() => { try { return target.query(`FROM ${SUBSCRIBERS}`); } catch { return []; } })()
    .map((s) => String(s.email ?? "").toLowerCase()),
);

let copied = 0;
let skipped = 0;
for (const row of subscribers) {
  const email = String(row.email ?? "").toLowerCase();
  if (!email) { skipped += 1; continue; }
  if (existing.has(email)) {
    console.log(`  skip   ${email}  (already present)`);
    skipped += 1;
    continue;
  }
  console.log(`  ${COMMIT ? "copy  " : "would "} ${email}  ${row.cohort ?? "?"}  ${row.status ?? "?"}`);
  if (COMMIT) {
    // Keep the original _id: it is what subscription_events reference, and
    // rewriting it would orphan every event belonging to this subscriber.
    const { _id, _seq, _hash, _coll, ...fields } = row;
    target.put(SUBSCRIBERS, _id, fields);
  }
  copied += 1;
}

let copiedEvents = 0;
for (const row of events) {
  const { _id, _seq, _hash, _coll, ...fields } = row;
  if (COMMIT) target.put(SUBSCRIPTION_EVENTS, _id, fields);
  copiedEvents += 1;
}

closeDatabase(target);

console.log(`\ntarget   ${TARGET}`);
console.log(`  subscribers ${COMMIT ? "copied" : "to copy"}  ${copied}   skipped ${skipped}`);
console.log(`  events      ${COMMIT ? "copied" : "to copy"}  ${copiedEvents}`);

if (!COMMIT) {
  console.log("\nDRY RUN — nothing was written. Re-run with --commit to apply.");
} else {
  console.log("\nDone. Now unset YENTE_WAITLIST_DATA_PATH and start the daemon.");
  console.log(`The old directory is untouched at ${SOURCE}; delete it once you have`);
  console.log("checked the counts above and the site still shows the right capacity.");
}
