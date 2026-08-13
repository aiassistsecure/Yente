/**
 * Render the operator console against a seeded store and write it to disk.
 *
 * The output is the REAL renderer over a REAL engine — every row in it arrived
 * through the same domain functions the runtime uses. It is a preview of the
 * system, not a picture of one.
 *
 *   node scripts/preview-console.mjs [outfile]
 */

import { writeFileSync } from "node:fs";
import { seedConsoleStore, SEED_HEALTH } from "../test-support/seed-console.mjs";
import { createConsoleView } from "../src/console/readonly.js";
import { renderConsole } from "../src/console/render.js";

const out = process.argv[2] ?? "console-preview.html";
const { store, now } = seedConsoleStore();
const view = createConsoleView(store, { health: SEED_HEALTH, invitationDailyCap: 25 });
writeFileSync(out, renderConsole(view, { now, version: "v0.1.0" }));

const engine = view.engine();
console.log(`wrote ${out}`);
console.log(`seq ${engine.seq} · verified ${engine.verified} · outbox ${JSON.stringify(view.outbox().byState)}`);
