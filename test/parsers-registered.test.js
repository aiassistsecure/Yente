/* The registry must be populated by the ENTRY POINTS, not only by tests.
 *
 * This exists because it wasn't. registerDocumentParsers() was called from
 * test/parsers.test.js and nowhere else, so production ran with an empty
 * extractor registry: PDF and DOCX support was written, dependencies were
 * installed, and every attachment came back
 *
 *   "Yente cannot read application/vnd.openxmlformats-officedocument
 *    .wordprocessingml.document yet"
 *
 * The suite was green the whole time, because the suite registered the parsers
 * itself. A test that sets up the thing whose absence is the bug cannot see the
 * bug — so this one reads the shipped entry points instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

for (const entry of ["bin/daemon.mjs", "bin/poll.mjs"]) {
  test(`${entry} registers the document parsers`, () => {
    const src = read(entry);
    assert.match(src, /registerDocumentParsers/,
      `${entry} must call registerDocumentParsers() or every attachment is unreadable`);
    assert.match(src, /registerDocumentParsers\s*\(\s*\)/,
      `${entry} imports it but never calls it`);
  });

  test(`${entry} registers before it can receive a message`, () => {
    const src = read(entry);
    const registered = src.indexOf("registerDocumentParsers()");
    const runtime = src.indexOf("createRuntime(");
    assert.ok(registered > 0, "not registered at all");
    assert.ok(runtime > 0, "no runtime created");
    assert.ok(registered < runtime,
      "parsers must be registered before the runtime exists, or the first "
      + "message of the process can arrive with an empty registry");
  });
}

test("the daemon reports its parser types at startup", () => {
  // A silently empty registry is what made this invisible. One line in the
  // journal is the cheapest possible guard against a repeat.
  assert.match(read("bin/daemon.mjs"), /parsers:/,
    "the daemon should log which types it can read");
});
