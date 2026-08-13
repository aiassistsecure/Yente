#!/usr/bin/env node
/**
 * Run extraction against one stored source and print everything, including the
 * part the runtime discards.
 *
 *   node bin/extract-once.mjs you@example.com
 *
 * `extractProfileFacts` returns a `failures` array — MALFORMED_ARTIFACT,
 * ALL_FACTS_UNGROUNDED, MODEL_ERROR, with the model's own message. The runtime
 * ignores it, so an extraction that failed for a nameable reason is
 * indistinguishable from one that honestly found nothing. This prints the
 * reason.
 *
 * Writes nothing. Stop the daemon first — the engine locks the data directory
 * per process.
 */

import process from "node:process";
import { openDatabase, closeDatabase, extractProfileFacts } from "../src/index.js";
import { createLlmClients } from "../src/llm/providers.js";

const WHO = process.argv[2] ? String(process.argv[2]).toLowerCase() : null;
if (!WHO) {
  console.error("usage: node bin/extract-once.mjs <address>");
  process.exit(2);
}

let store;
try {
  store = openDatabase(process.env.YENTE_DATA_PATH || "./data/yente");
} catch (error) {
  const m = String(error?.message ?? error);
  if (/already open|lock/i.test(m)) {
    console.error("Data directory is locked — stop the daemon first.");
    process.exit(2);
  }
  throw error;
}

const sources = store.query("FROM sources").filter((s) =>
  String(s.member_id ?? s.memberId ?? "").toLowerCase() === WHO);

if (!sources.length) {
  console.error(`No stored source for ${WHO}. Nothing arrived, or the attachment `
    + "was refused before storage.");
  closeDatabase(store);
  process.exit(1);
}

const llm = createLlmClients({
  log: (level, event, fields) => console.log(`[${level}] ${event} ${fields?.note ?? ""}`),
});
console.log(`model ${llm.describe.model} via ${llm.describe.label}\n`);

for (const source of sources) {
  const text = String(source.extracted_text ?? source.extractedText ?? source.content ?? "");
  console.log("=".repeat(70));
  console.log(`${source.filename ?? "?"} — ${text.length} chars`);
  console.log("=".repeat(70));
  console.log(text.split("\n").filter(Boolean).slice(0, 12).map((l) => "  | " + l.slice(0, 90)).join("\n"));

  const alias = `src_${String(source._hash ?? "x").slice(0, 12)}`;
  const t0 = Date.now();
  let out;
  try {
    out = await extractProfileFacts({
      client: llm.extractionClient, sourceId: alias, text, vocabulary: {},
    });
  } catch (error) {
    console.log(`\n  THREW: ${error.code ?? error.name}: ${error.message}`);
    continue;
  }

  console.log(`\n  attempts ${out.attempts}   verified ${(out.verified || []).length}`
    + `   rejected ${(out.rejected || []).length}   ${Date.now() - t0}ms`);

  for (const f of out.verified || []) {
    console.log(`   OK  ${String(f.field).padEnd(28)} ${JSON.stringify(String(f.value).slice(0, 36))}`);
  }

  // The two things the runtime hides, and the only ones that explain silence.
  for (const r of out.rejected || []) {
    console.log(`   REJECTED  ${r.code ?? "?"}`);
    console.log(`      field    ${r.fact?.field}`);
    console.log(`      evidence ${JSON.stringify(String(r.fact?.evidence ?? "").slice(0, 80))}`);
    console.log("      (that string is not in the source — grounding refused it)");
  }
  for (const f of out.failures || []) {
    console.log(`   FAILURE attempt ${f.attempt}: ${f.code}`);
    console.log(`      ${String(f.message).slice(0, 300)}`);
  }

  if (!(out.verified || []).length && !(out.rejected || []).length && !(out.failures || []).length) {
    console.log("   The model returned a well-formed but EMPTY facts array — it read the");
    console.log("   document and declined to claim anything. Under this design that is a");
    console.log("   legitimate answer, not an error.");
  }
}

closeDatabase(store);
