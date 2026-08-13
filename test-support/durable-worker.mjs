/**
 * A worker process for the durability test.
 *
 * Separate process on purpose. The engine takes an exclusive lock on its data
 * directory, so "does this survive a restart" cannot be asked inside one Node
 * process — a second open in the same process is refused, and rightly so.
 *
 * The result goes to a file rather than stdout, because the engine writes its
 * own start-up line ("[nedbd] cold start …") to stdout on open. Parsing a
 * child's stdout would mean parsing around that, and a runtime that logs to
 * stdout is entitled to.
 *
 * Usage: node durable-worker.mjs <path> <write|read> <resultFile>
 */

import { writeFileSync } from "node:fs";
import { openDatabase, closeDatabase } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";

const [, , path, mode, resultFile] = process.argv;
const T0 = "2026-08-12T12:00:00.000Z";
const store = openDatabase(path);
const { messages, outbox } = createRepositories(store);

if (mode === "reopen") {
  // Opening the same path again must return the same handle, not attempt a
  // second engine. The addon has no close, so the flock outlives any
  // bookkeeping on the JS side.
  closeDatabase(store);
  const again = openDatabase(path);
  writeFileSync(
    resultFile,
    JSON.stringify({ sameHandle: again === store, seq: again.seq(), verify: again.verify() }),
  );
  process.exit(0);
}

if (mode === "write") {
  messages.recordInbound({ rfcMessageId: "<durable@host>", from: "bob@example.com", receivedAt: T0 });
  outbox.enqueue({
    idempotencyKey: "k_durable",
    jobId: "j1",
    purpose: "interview_question",
    recipients: ["bob@example.com"],
    state: "PENDING",
    availableAt: T0,
    attempts: 0,
  });
  writeFileSync(resultFile, JSON.stringify({ seq: store.seq(), verify: store.verify() }));
} else {
  writeFileSync(
    resultFile,
    JSON.stringify({
      seq: store.seq(),
      verify: store.verify(),
      messageSurvived: Boolean(messages.findByRfcId("<durable@host>")),
      stillDeduplicates: messages.recordInbound({
        rfcMessageId: "<durable@host>",
        from: "bob@example.com",
        receivedAt: T0,
      }).duplicate,
      jobState: outbox.find("k_durable")?.state ?? null,
      claimable: outbox.claimable("2026-08-12T13:00:00.000Z").map((j) => j.idempotencyKey),
    }),
  );
}

closeDatabase(store);
