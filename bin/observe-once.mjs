#!/usr/bin/env node
/**
 * Run the observer against real evidence, once, and print what survived.
 *
 *   node bin/observe-once.mjs path/to/email.txt [more-sources...]
 *   node bin/observe-once.mjs --text "Sarah Chen, Founder, Acme. We are hiring."
 *
 * Requires the PIN credential in the environment:
 *   export YENTE_LLM_API_KEY=aai_...
 * Optionally:
 *   export YENTE_INTELLIGENCE_PROVIDER=pin      (default)
 *   export YENTE_MODEL_DOCUMENT=GLM-4-32B        (the heavyweight seat)
 *
 * WHY THIS EXISTS AS A COMMITTED TOOL RATHER THAN A SCRATCH SCRIPT
 *
 * §27 of the redesign brief is a dogfood test — did it discover the people, did
 * it extract useful intent, can every inference show its evidence — and that
 * question has to be asked against the real model on real mail, repeatedly, by
 * whoever is looking. A throwaway script answers it once for one person.
 *
 * It also prints REJECTED claims, not just accepted ones, because the rejects
 * are the more informative half: they tell you whether the model is inventing,
 * and at what rate. A tool that showed only successes would make a model that
 * fabricates nine claims for every good one look like a model that works.
 *
 * This touches no database. Observation is a pure function from evidence to
 * proposed beliefs; nothing here can mutate a graph, which is the same boundary
 * the daemon relies on.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createLlmClients } from "../src/llm/providers.js";
import {
  createIntelligenceProvider,
  resolveIntelligenceConfig,
} from "../src/intelligence/provider.js";
import { claimCount, CLAIM_GROUPS } from "../src/intelligence/schema.js";

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
usage: node bin/observe-once.mjs <file> [file...]
       node bin/observe-once.mjs --text "some evidence"

environment:
  YENTE_LLM_API_KEY               required for the pin provider
  YENTE_INTELLIGENCE_PROVIDER     default pin
  YENTE_MODEL_DOCUMENT            default muse-local:latest
  YENTE_MODEL_MESSAGE             the voice (unused by this tool)
`);
  return 2;
}

async function collectSources(argv) {
  const textIndex = argv.indexOf("--text");
  if (textIndex !== -1) {
    const text = argv[textIndex + 1];
    if (!text) throw new Error("--text needs a value");
    return [{ id: "inline-1", text }];
  }
  const files = argv.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) return null;
  return Promise.all(files.map(async (file, index) => ({
    // The id is what the model must cite, and it appears in every rejection
    // message, so it is worth being readable.
    id: `${basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}-${index + 1}`,
    text: await readFile(file, "utf8"),
  })));
}

function printClaims(label, envelope) {
  const total = claimCount(envelope);
  console.log(`\n${label} (${total})`);
  if (total === 0) {
    console.log("  (none)");
    return;
  }
  for (const group of CLAIM_GROUPS) {
    for (const claim of envelope[group] ?? []) {
      const head =
        group === "entities" ? `${claim.kind} ${claim.name}${claim.title ? ` · ${claim.title}` : ""}`
        : group === "intents" ? `${claim.actorRef} ${claim.type} → ${claim.object}`
        : group === "relationships" ? `${claim.subjectRef} ${claim.predicate} ${claim.objectRef}`
        : group === "opportunities" ? `${claim.subjectRef}: ${claim.summary}`
        : claim.text;
      console.log(`  [${group}] ${head}`);
      console.log(`      confidence ${claim.confidence.toFixed(2)}  ${claim.explicit ? "explicit" : "inferred"}`);
      // The evidence line is the point of the whole system. Print it always.
      console.log(`      evidence  "${claim.evidence.replace(/\s+/g, " ").slice(0, 160)}"  (${claim.sourceId})`);
      if (claim.rawType) console.log(`      raw type  ${claim.rawType}  <-- not in the vocabulary yet`);
    }
  }
}

async function main(argv) {
  const sources = await collectSources(argv);
  if (!sources) return usage("Give me at least one source file, or --text.");

  const { provider: providerName } = resolveIntelligenceConfig();

  // Reuse the daemon's own construction path rather than assembling a client
  // here. It carries the per-provider deadlines, the third-party privacy
  // warning, and the model/upstream mismatch check — all of which exist because
  // something bit us, and none of which should depend on which entry point ran.
  let clients;
  try {
    clients = createLlmClients({
      provider: providerName,
      log: (level, event, meta) => console.error(`[${level}] ${event} ${JSON.stringify(meta)}`),
    });
  } catch (error) {
    return usage(String(error.message ?? error));
  }

  const { model, thirdParty, label, baseUrl, first_token_ms: firstTokenMs } = clients.describe;
  const observer = createIntelligenceProvider({
    client: clients.extractionClient, provider: providerName, model,
  });

  console.log(`provider   ${providerName} · ${label}`
    + `${thirdParty ? "  (THIRD PARTY — evidence leaves our infrastructure)" : ""}`);
  console.log(`model      ${model}`);
  console.log(`endpoint   ${baseUrl}   first token budget ${firstTokenMs}ms`);
  const described = observer.describe();
  console.log(`schema     ${described.schemaVersion} / ${described.promptVersion}`);
  if (process.env.YENTE_LLM_PREFILL) {
    console.log(`prefill    ${JSON.stringify(process.env.YENTE_LLM_PREFILL)}`);
  }
  console.log(`sources    ${sources.map((s) => `${s.id} (${s.text.length}c)`).join(", ")}`);

  const started = Date.now();
  let result;
  try {
    result = await observer.observe({ sources });
  } catch (error) {
    console.error(`\nFAILED  ${error.code ?? "ERROR"}  ${error.message}`);
    for (const failure of error.meta?.failures ?? []) {
      console.error(`  attempt ${failure.attempt}  ${failure.code}  ${failure.message}`);
    }
    return 1;
  }

  console.log(`\nelapsed    ${Date.now() - started}ms  attempts ${result.attempts}`
    + `${result.cached ? "  (CACHED)" : ""}`
    + `${result.recovered ? `  (recovered via ${result.recovered} — model did not use the block frame)` : ""}`);

  printClaims("VERIFIED — quoted evidence found in the source", result.verified);

  // The half that matters for judging the model.
  console.log(`\nREJECTED (${result.rejected.length})`);
  if (result.rejected.length === 0) console.log("  (none)");
  for (const row of result.rejected) {
    console.log(`  [${row.group}[${row.index}]] ${row.code}  ${row.message}`);
  }

  if (result.discrepancies.length > 0) {
    console.log(`\nDISCREPANCIES (${result.discrepancies.length})`);
    for (const row of result.discrepancies) console.log(`  ${row.code}  ${row.message}`);
  }

  for (const failure of result.failures) {
    console.log(`\nretried after  ${failure.code}: ${failure.message}`);
    // The reply is the evidence. Print it, or the next person debugging this
    // guesses at what the model sent — which is how today went.
    if (failure.sample) {
      console.log(`  ---- what the model sent (first 1200 chars) ----`);
      console.log(failure.sample.split("\n").map((line) => `  | ${line}`).join("\n"));
      console.log(`  ------------------------------------------------`);
    }
  }

  const kept = claimCount(result.verified);
  const proposed = kept + result.rejected.length;
  console.log(`\nkept ${kept} of ${proposed} proposed`
    + `${proposed > 0 ? `  (${Math.round((kept / proposed) * 100)}% grounded)` : ""}`);
  console.log(`content hash  ${result.provenance.contentHash}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
