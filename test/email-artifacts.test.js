import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCK_TAGS,
  blockTags,
  createIntroductionPrompt,
  createPrivatePreviewPrompt,
  createReferenceIntroduction,
  createReferencePrivatePreview,
  parseEmailArtifact,
} from "../src/index.js";
import { frozenMatch, matchPolicy } from "../test-support/fixtures.js";

test("private preview context is fully expressed through Sentinel Blocks", () => {
  const artifact = createPrivatePreviewPrompt({
    match: frozenMatch,
    policy: matchPolicy,
    recipientId: "bob",
  });
  assert.deepEqual(blockTags(artifact), [
    BLOCK_TAGS.TASK,
    BLOCK_TAGS.PROFILE,
    BLOCK_TAGS.MATCH,
    BLOCK_TAGS.POLICY,
    BLOCK_TAGS.OUTPUT_CONTRACT,
  ]);
});

test("reference private preview exposes controls but not a raw resume", () => {
  const email = parseEmailArtifact(
    createReferencePrivatePreview({ match: frozenMatch, recipientId: "bob" }),
  );
  assert.match(email.text, /INTRODUCE/);
  assert.match(email.text, /PASS/);
  assert.match(email.text, /CORRECT/);
  assert.match(email.text, /STOP/);
  assert.match(email.text, new RegExp(frozenMatch.vetoDeadlineAt));
  assert.doesNotMatch(email.text, /raw resume/i);
  assert.deepEqual(email.meta.facts_used, [...frozenMatch.factsUsed].sort());
});

test("private preview generation fails closed for a non-member recipient", () => {
  assert.throws(
    () =>
      createPrivatePreviewPrompt({
        match: frozenMatch,
        policy: matchPolicy,
        recipientId: "mallory",
      }),
    /not part of this match/,
  );
});

test("joint introduction context and reference email complete the CCME wedge", () => {
  const prompt = createIntroductionPrompt({ match: frozenMatch, policy: matchPolicy });
  assert.deepEqual(blockTags(prompt), [
    BLOCK_TAGS.TASK,
    BLOCK_TAGS.PROFILE,
    BLOCK_TAGS.MATCH,
    BLOCK_TAGS.POLICY,
    BLOCK_TAGS.OUTPUT_CONTRACT,
  ]);

  const email = parseEmailArtifact(createReferenceIntroduction({ match: frozenMatch }));
  assert.deepEqual(email.meta.recipient_ids, ["bob", "alice"]);
  assert.match(email.subject, /Bob x Alice/);
  assert.match(email.text, /reply-all/i);
  assert.match(email.text, /calendar link/i);
  assert.match(email.text, /step out/i);
});
