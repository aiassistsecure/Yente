/**
 * Every extracted claim must open the conversation it came from.
 *
 * The overseer of the matchmaker is running an inbox. A graph belief that
 * cannot deep-link back to the mail is a belief you cannot audit.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { handleManagerRequest, renderThread } from "../web/manager.js";

function fresh() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);
  const manager = createGraphManager({ graph, actor: "interchained" });
  return { store, graph, manager };
}

test("a message claim links to /thread of that message", () => {
  const { graph, manager } = fresh();
  const { evidence } = graph.evidence.record({
    kind: "message",
    contentHash: "mail1",
    text: "Here attached is my resume. I’m looking for investors.",
    meta: {
      rfcMessageId: "r1@sender.test",
      threadId: "r1@sender.test",
      from: "evansmark.work@gmail.com",
      to: ["yente@ccme.network"],
      subject: "Resume",
      sentAt: "2026-08-26T18:16:49.000Z",
    },
    receivedAt: "2026-08-26T18:16:50.000Z",
  });
  const href = manager.threadHrefFor(evidence.id, evidence);
  assert.equal(href, `/thread?id=${encodeURIComponent(evidence.id)}`);
});

test("an attachment claim walks to the covering message's thread", () => {
  const { graph, manager } = fresh();
  const { evidence: mail } = graph.evidence.record({
    kind: "message",
    contentHash: "mail2",
    text: "resume attached",
    meta: { rfcMessageId: "r2@s", threadId: "r2@s", subject: "CV", from: "a@b.c" },
    receivedAt: "2026-08-26T18:00:00.000Z",
  });
  const { evidence: doc } = graph.evidence.record({
    kind: "attachment",
    contentHash: "cv2",
    text: "MARK ALLEN EVANS JR.",
    meta: { filename: "resume.docx", messageEvidenceId: mail.id },
    receivedAt: "2026-08-26T18:00:01.000Z",
  });
  const href = manager.threadHrefFor(doc.id, doc);
  assert.equal(href, `/thread?id=${encodeURIComponent(mail.id)}`);
});

test("thread() gathers covering mail, attachment, and mined claims", () => {
  const { graph, manager } = fresh();
  const { evidence: mail } = graph.evidence.record({
    kind: "message",
    contentHash: "mail3",
    text: "I’m looking for investors.",
    meta: {
      rfcMessageId: "r3@s", threadId: "r3@s",
      subject: "Resume", from: "evansmark.work@gmail.com", to: ["yente@ccme.network"],
    },
    receivedAt: "2026-08-26T18:00:00.000Z",
  });
  graph.evidence.record({
    kind: "attachment",
    contentHash: "cv3",
    text: "Founder & Systems Architect",
    meta: { filename: "Mark_Evans_Resume.docx", messageEvidenceId: mail.id },
    receivedAt: "2026-08-26T18:00:01.000Z",
  });
  graph.observations.append({
    subject: "person:evansmark.work@gmail.com",
    predicate: "intent:FUNDRAISING",
    object: "investors",
    evidenceId: mail.id,
    quote: "I’m looking for investors.",
    observedAt: "2026-08-26T18:01:00.000Z",
  });

  const conversation = manager.thread(mail.id);
  assert.equal(conversation.subject, "Resume");
  assert.equal(conversation.from, "evansmark.work@gmail.com");
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.attachments.length, 1);
  assert.equal(conversation.attachments[0].meta.filename, "Mark_Evans_Resume.docx");
  assert.equal(conversation.claims.length, 1);
  assert.equal(conversation.claims[0].predicate, "intent:FUNDRAISING");
});

test("GET /thread renders the conversation and extracted claims", async () => {
  const { graph, manager } = fresh();
  const { evidence: mail } = graph.evidence.record({
    kind: "message",
    contentHash: "mail4",
    text: "I’m looking for investors.",
    meta: { rfcMessageId: "r4@s", threadId: "r4@s", subject: "Resume", from: "a@b.c" },
    receivedAt: "2026-08-26T18:00:00.000Z",
  });
  graph.observations.append({
    subject: "person:a@b.c",
    predicate: "intent:FUNDRAISING",
    object: "investors",
    evidenceId: mail.id,
    quote: "I’m looking for investors.",
    observedAt: "2026-08-26T18:01:00.000Z",
  });

  let status = 0;
  let body = "";
  const res = {
    writeHead(code) { status = code; return this; },
    end(html) { body = String(html ?? ""); },
  };
  const handled = await handleManagerRequest({
    req: { method: "GET", url: `/thread?id=${encodeURIComponent(mail.id)}` },
    res, manager, graph, health: {},
  });
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.match(body, /Resume/);
  assert.match(body, /looking for investors/);
  assert.match(body, /intent:FUNDRAISING/);
});

test("renderThread shows the verbatim source, not a summary", () => {
  const html = renderThread({
    thread: {
      id: "message:x",
      subject: "Help",
      from: "electronerodev@gmail.com",
      to: ["yente@ccme.network"],
      sentAt: "2026-08-27T01:00:00.000Z",
      rfcMessageId: "h@s",
      messages: [{
        id: "message:x", kind: "message",
        text: "I’m a new guy on the block",
        meta: { from: "electronerodev@gmail.com", to: ["yente@ccme.network"], subject: "Help" },
      }],
      attachments: [],
      claims: [],
    },
  });
  assert.match(html, /new guy on the block/);
  assert.match(html, /electronerodev@gmail.com/);
  assert.match(html, /No claims mined from this thread yet/);
});
