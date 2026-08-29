/**
 * The matchmaker actually runs — three dead switches, one live report.
 *
 * Mark, from production: "the MATCHMAKING is never running... I expected to
 * head to manager and see matches but none happened... matchmaker never runs
 * thats a bug." He was right, and the cause was structural: the QUALIFIED
 * gate (#43) shipped with NO WRITER — nothing in any production path ever
 * appended a profile_state observation — so isMatchable was false for every
 * human forever. declaredRoles (#61) had the same disease: a parser no
 * production code called.
 *
 * A gate with no writer and a parser with no feed are the same bug as a
 * function that is exported, tested, and called by nothing — invisible to any
 * test that supplies the missing call itself. These tests call the PRODUCTION
 * wiring.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { ROLE_PREDICATE } from "../src/graph/roles.js";
import { JOB_STATES } from "../src/store/graph.js";

/* --- roles are read from real inbound mail ------------------------------- */

test("an inbound answer to the four-way is parsed at ingest, quoted history is not", async () => {
  const { ingestMail } = await import("../src/graph/ingest.js");
  const graph = createGraphRepositories(openInMemory());
  const source = {
    async fetchNew() {
      return {
        uidValidity: 1,
        resynced: false,
        messages: [{
          uid: 1,
          rfcMessageId: "<a@x.test>", from: "mark@x.test", to: ["yente@ccme.network"],
          subject: "re: intake", sentAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          text: "We are hiring two backend engineers.\n\n"
            + "> On Aug 29, 2026, Yente <yente@ccme.network> wrote:\n"
            + "> hiring · seeking employment · seeking funding · funding startups",
          attachments: [],
        }],
      };
    },
    commit() {},
  };
  await ingestMail({ source, graph });

  const roles = graph.observations.all().filter((r) => r.predicate === ROLE_PREDICATE);
  assert.equal(roles.length, 1, "one declaration from the reply; Yente's own menu quotes nothing");
  assert.equal(roles[0].object, "hiring");
  assert.equal(roles[0].subject, "person:mark@x.test");
  assert.equal(roles[0].confidence, 1, "a declaration is DETERMINISTIC, not inferred");
});

/* --- the same document, a second sender ---------------------------------- */

test("a DONE job re-opens when the same document arrives from a NEW owner", () => {
  const graph = createGraphRepositories(openInMemory());
  const at = new Date().toISOString();
  graph.jobs.enqueue({ evidenceId: "attachment:abc", subjectHint: "person:first@x.test", at });
  graph.jobs.start("attachment:abc", at);
  graph.jobs.finish("attachment:abc", { at, claims: 5 });

  const reopened = graph.jobs.reassignOwner("attachment:abc", "person:second@x.test", at);
  assert.ok(reopened, "the second sender's copy must teach the graph about THEM");
  assert.equal(reopened.state, JOB_STATES.READY);
  assert.equal(reopened.subjectHint, "person:second@x.test");

  // Same owner again: nothing to do. A running job: not touched (it would race).
  assert.equal(graph.jobs.reassignOwner("attachment:abc", "person:second@x.test", at), null);
});

/* --- the desk-to-graph qualification bridge ------------------------------ */

test("bin/yente.mjs bridges desk qualification into the graph lifecycle", async () => {
  // Source-as-text, the suite's own convention for "it exists and production
  // calls it": the entry point must hand createDesk an onQualified that walks
  // the legal transitions and nudges connect.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bin/yente.mjs", import.meta.url), "utf8");
  assert.match(src, /onQualified:/, "the desk must report qualification to the graph");
  assert.match(src, /setProfileState/, "the bridge is the QUALIFIED gate's missing writer");
  assert.match(src, /nudgeConnect\(\)/, "a new candidate wakes matching immediately");
  assert.match(src, /declined.*return|return.*declined/s,
    "a person who DECLINED is never re-qualified by this bridge");
});

test("boot backfills members the desk qualified BEFORE the bridge existed", async () => {
  // The bridge fires on the tick where qualification HAPPENS. Members already
  // QUALIFIED/ACTIVE in the desk store when this deploy landed would stay
  // unmatchable forever — the gate-with-no-writer bug reborn one layer up.
  // Observed live: a warm boot with 8 subjects, 27 DONE jobs, and no
  // graph_qualified line, because every qualification predated the bridge.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bin/yente.mjs", import.meta.url), "utf8");
  assert.match(src, /qualified_backfilled/, "boot must reconcile historical qualifications");
  assert.match(src, /QUALIFIED.*ACTIVE|ACTIVE.*QUALIFIED/s, "both settled desk states bridge");
  const block = src.slice(src.indexOf("BACKFILL"), src.indexOf("qualified_backfilled"));
  assert.match(block, /declined/, "a DECLINED graph lifecycle is never overridden by backfill");
});

/* --- the nudge race ------------------------------------------------------- */

test("a nudge during a scan survives into the next sleep", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/graph/loops.js", import.meta.url), "utf8");
  // The flag is consumed BEFORE the scan. Clearing it after erased any nudge
  // that arrived mid-scan — the exact race the accumulator comment promised
  // to handle, contradicted three lines later.
  const connect = src.slice(src.indexOf("async function connect"), src.indexOf("return Object.freeze"));
  const reset = connect.indexOf("connectPending = false");
  const scan = connect.indexOf("proposeIntroductions");
  assert.ok(reset !== -1 && scan !== -1 && reset < scan,
    "the pending flag must be consumed before the scan, not after");
});

/* --- HTML mail becomes prose, not markup ---------------------------------- */

test("HTML-only mail reaches the model as prose, and plain text still wins", async () => {
  const { messageBodyText } = await import("../src/mail/html-text.js");
  const html = '<html><body><div style="color:red"><p>Hi — I am <b>hiring</b> two '
    + 'engineers.</p><p>Best,<br>Mark</p></div>'
    + '<img src="data:image/gif;base64,AAAAAAAA"></body></html>';

  const text = messageBodyText({ html });
  assert.match(text, /hiring two\s+engineers/);
  assert.doesNotMatch(text, /<|base64|style/,
    "markup handed to a span-verified model is a prompt that can only fail");
  assert.equal(messageBodyText({ text: "plain wins", html }), "plain wins");
  assert.match(
    (await import("node:fs")).readFileSync(
      new URL("../src/mail/from-env.js", import.meta.url), "utf8"),
    /messageBodyText\(parsed\)/,
    "and production USES it — the raw-html fallback was the hole");
});

test("zero-claim jobs re-open ONCE, so a model swap can re-read consumed mail", () => {
  // 27 DONE jobs from a night of NuExtract answering {} = 27 consumed
  // messages, no facts, nobody qualified, a matchmaker with no candidates.
  // Empty RESULTS were already uncached (#58) so a better model could
  // re-derive them; the JOBS were the half that stayed sealed.
  const graph = createGraphRepositories(openInMemory());
  const at = new Date().toISOString();

  graph.jobs.enqueue({ evidenceId: "message:empty", subjectHint: null, at });
  graph.jobs.start("message:empty", at);
  graph.jobs.finish("message:empty", { at, claims: 0 });

  graph.jobs.enqueue({ evidenceId: "message:full", subjectHint: null, at });
  graph.jobs.start("message:full", at);
  graph.jobs.finish("message:full", { at, claims: 6 });

  assert.equal(graph.jobs.requeueEmptyUnderstandings(at), 1,
    "only the empty one re-opens; real work is never re-bought");
  assert.equal(graph.jobs.counts().READY, 1);

  // The once-ever guard: a genuinely empty message re-runs once under the
  // current model and is never touched a third time — without this every
  // boot would re-buy inference on every quiet message forever.
  graph.jobs.start("message:empty", at);
  graph.jobs.finish("message:empty", { at, claims: 0 });
  assert.equal(graph.jobs.requeueEmptyUnderstandings(at), 0);
});
