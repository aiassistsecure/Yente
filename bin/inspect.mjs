#!/usr/bin/env node
/**
 * What does she actually know, and what is stuck?
 *
 *   node bin/inspect.mjs                 # everything, summarised
 *   node bin/inspect.mjs you@example.com # one person, in detail
 *
 * Written because three separate silences today were all invisible from the
 * outside and obvious from the data. A tick that reports `ingested=1 sent=0` is
 * consistent with at least four different states:
 *
 *   - the résumé was never parsed          -> sources is empty
 *   - it parsed but extraction found nothing -> a source with no profile_facts
 *   - extraction worked but nothing queued -> facts but an empty outbox
 *   - it queued and the send failed        -> an outbox row with an error
 *
 * The log cannot tell those apart. The store can, and this prints it.
 *
 * READ-ONLY. Opens the same directory the daemon holds, so run it while the
 * daemon is STOPPED — the engine takes an exclusive lock per directory and
 * exposes no close, so two processes cannot both have it. That is reported
 * plainly rather than as a crash.
 */

import process from "node:process";
import { openDatabase, closeDatabase } from "../src/index.js";

const WHO = process.argv[2] ? String(process.argv[2]).toLowerCase() : null;
const PATH = process.env.YENTE_DATA_PATH || "./data/yente";

let store;
try {
  store = openDatabase(PATH);
} catch (error) {
  const m = String(error?.message ?? error);
  if (/already open|lock/i.test(m)) {
    console.error(
      `The data directory is locked by another process — stop the daemon first.\n`
      + `  systemctl stop yente   (or Ctrl-C the foreground run)\n`,
    );
    process.exit(2);
  }
  console.error(`cannot open ${PATH}: ${m}`);
  process.exit(1);
}

const q = (nql) => { try { return store.query(nql); } catch { return []; } };

/**
 * The failure reason, whatever it is spelled.
 *
 * `markFailed` in domain/outbox.js writes `lastError` — camelCase. This tool
 * read `last_error`, so every send failure printed as blank and the store's own
 * explanation was invisible. A job sat in RETRY_WAIT with attempts=1 and the
 * reason was RIGHT THERE, unread, because a diagnostic tool guessed at a field
 * name instead of checking one.
 *
 * That is the same defect this file exists to catch, committed by this file. Both
 * spellings are read now so it cannot recur through a rename either.
 */
const errorOf = (job) => job?.lastError ?? job?.last_error ?? null;
const one = (v) => (Array.isArray(v) ? v[0] : v);

function section(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

/* ------------------------------------------------------------------ summary */

const members = q("FROM members");
const sources = q("FROM sources");
const facts = q("FROM profile_facts");
const outbox = q("FROM outbox");
const messages = q("FROM messages");
const runs = q("FROM poll_runs");

console.log(`data      ${PATH}`);
console.log(`members   ${members.length}`);
console.log(`messages  ${messages.length}`);
console.log(`sources   ${sources.length}   (attachments parsed and stored)`);
console.log(`facts     ${facts.length}   (what she believes, verified)`);
console.log(`outbox    ${outbox.length}`);
console.log(`ticks     ${runs.length}`);

// The single most useful line: is anything stuck, and why.
const byState = {};
for (const j of outbox) byState[j.state ?? "?"] = (byState[j.state ?? "?"] || 0) + 1;
if (outbox.length) {
  section("outbox by state");
  for (const [state, n] of Object.entries(byState)) console.log(`  ${state.padEnd(14)} ${n}`);
  const broken = outbox.filter((j) => errorOf(j) || /FAIL|DEAD|RETRY/i.test(String(j.state)));
  for (const j of broken.slice(0, 8)) {
    console.log(`  ! ${j.purpose ?? "?"} -> ${(j.recipients || []).join(",")}`);
    console.log(`      state=${j.state} attempts=${j.attempts ?? 0}`);
    console.log(`      error=${String(errorOf(j) ?? "(none recorded)").slice(0, 300)}`);
    console.log(`      next attempt at ${j.availableAt ?? "?"}`);
  }
}

const strandedTicks = runs.filter((r) => !r.finished_at);
if (strandedTicks.length) {
  section("ticks that did not finish");
  for (const r of strandedTicks.slice(-5)) {
    console.log(`  ${r.started_at}  pid=${r.pid}  ${r.error ?? ""}`);
  }
}

/* -------------------------------------------------------------- one person */

if (WHO) {
  section(`member ${WHO}`);
  const m = members.find((x) => String(x.address ?? x._id).toLowerCase() === WHO);
  if (!m) {
    console.log("  no member record — she has never recorded a message from this address");
  } else {
    console.log(`  state           ${m.state}`);
    console.log(`  inbound since   ${m.inbound_established_at ?? m.created_at ?? "?"}`);
    if (m.stopped_at) console.log(`  STOPPED         ${m.stopped_at}`);
    if (m.deleted_at) console.log(`  DELETED         ${m.deleted_at}`);
  }

  const mine = (rows) => rows.filter((r) =>
    String(r.member_id ?? r.memberId ?? r.address ?? "").toLowerCase() === WHO);

  const mySources = mine(sources);
  section(`  attachments stored (${mySources.length})`);
  for (const s of mySources) {
    const text = String(s.extracted_text ?? s.extractedText ?? s.content ?? "");
    console.log(`  ${s.filename ?? "?"}  ${s.mime_type ?? s.mimeType ?? "?"}`);
    console.log(`      ${text.length} chars extracted`);
    console.log(`      first line: ${JSON.stringify(text.split("\n").find(Boolean)?.slice(0, 70) ?? "")}`);
  }
  if (!mySources.length) {
    console.log("  NONE. Either no attachment arrived, or extractText refused it —");
    console.log("  check for a CLARIFICATION job in the outbox saying so.");
  }

  const myFacts = mine(facts);
  section(`  facts she believes (${myFacts.length})`);
  for (const f of myFacts) {
    console.log(`  ${String(f.field).padEnd(30)} ${JSON.stringify(String(f.value).slice(0, 40))}`);
    console.log(`      <- ${JSON.stringify(String(f.evidence ?? "").slice(0, 70))}`);
  }
  if (mySources.length && !myFacts.length) {
    console.log("  NONE, DESPITE A STORED SOURCE. That is the interesting case:");
    console.log("  extraction ran and produced nothing verifiable. Either the model");
    console.log("  never returned a parseable PROFILE_FACTS block, or every excerpt");
    console.log("  it quoted failed grounding. extractProfileFacts records that in a");
    console.log("  failures array the runtime currently discards — run");
    console.log("  bin/extract-once.mjs against this source to see the real reason.");
  }

  const myJobs = outbox.filter((j) => (j.recipients || []).some((r) =>
    String(r).toLowerCase() === WHO));
  section(`  letters to this address (${myJobs.length})`);
  for (const j of myJobs) {
    console.log(`  ${String(j.purpose ?? "?").padEnd(26)} ${j.state}`
      + `  attempts=${j.attempts ?? 0}${j.sent_at ? "  sent " + j.sent_at : ""}`);
    if (j.email?.subject) console.log(`      "${j.email.subject}"`);
    if (errorOf(j)) console.log(`      error=${String(errorOf(j)).slice(0, 300)}`);
    if (j.availableAt) console.log(`      next attempt at ${j.availableAt}`);
  }
  if (!myJobs.length) {
    console.log("  NONE QUEUED. She has decided there is nothing to say — which for a");
    console.log("  member with a stored source and no facts means extraction failed.");
  }
}

closeDatabase(store);
