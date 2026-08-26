import assert from "node:assert/strict";
import test from "node:test";

import { currentReplyOnly } from "../src/mail/quoted.js";

test("iOS quoted Yente history is excluded from the model analysis view", () => {
  const full = [
    "From: dev@interchained.org",
    "To: yente@ccme.network",
    "Subject: Re: Two quick questions",
    "",
    "I’m a founder looking for investors.",
    "Sent from my iPhone",
    "",
    "> On Aug 14, 2026, at 3:29 PM, Yente <yente@ccme.network> wrote:",
    ">",
    "> Thanks — I read that and it is on file.",
    "> Role: Founder & Systems Architect",
    "> Works with: Rust, Python, TypeScript",
  ].join("\n");

  const current = currentReplyOnly(full);
  assert.match(current, /I’m a founder looking for investors/);
  assert.match(current, /Sent from my iPhone/);
  assert.doesNotMatch(current, /Role: Founder/);
  assert.doesNotMatch(current, /Thanks — I read that/);
  assert.ok(full.includes("Role: Founder"),
    "the canonical stored source remains complete; only the analysis view is reduced");
});

test("a message with no quoted history is unchanged", () => {
  const source = "From: a@example.com\n\nI am hiring a Rust engineer.";
  assert.equal(currentReplyOnly(source), source);
});

test("traditional original-message separators are also bounded", () => {
  const source = "Current reply\n\n----- Original Message -----\nold quoted text";
  assert.equal(currentReplyOnly(source), "Current reply");
});
