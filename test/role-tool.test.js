/** The declare_role tool: shape from the schema, truth from the source. */
import assert from "node:assert/strict";
import test from "node:test";

import { DECLARE_ROLE_TOOL, verifyDeclareRole } from "../src/llm/tools.js";
import { ROLES } from "../src/graph/roles.js";

test("the enum IS roles.js — one source of truth, drift impossible", () => {
  assert.deepEqual(
    DECLARE_ROLE_TOOL.function.parameters.properties.role.enum,
    Object.values(ROLES),
  );
});

test("tools fix shape, not truth: the quote is still verified", () => {
  const source = "Hi — we are hiring two backend engineers this quarter.";
  assert.deepEqual(
    verifyDeclareRole({ role: "hiring", quote: "we are hiring two backend engineers" }, source),
    { ok: true, role: "hiring", quote: "we are hiring two backend engineers" });

  assert.equal(
    verifyDeclareRole({ role: "hiring", quote: "we're hiring backend folks" }, source).ok,
    false, "a paraphrase is a discarded claim, tool call or not");

  assert.equal(
    verifyDeclareRole({ role: "co_founding", quote: "we are hiring" }, source).ok,
    false, "a fifth role cannot pass even if a lax backend emitted one");
});
