/**
 * The generation loop and the disclosure guard — §11.3 and §11.6.
 *
 * The model is a real HTTP server returning scripted artifacts, not a stubbed
 * client, so these exercise the actual streaming path on the way in.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient } from "../src/llm/client.js";
import { generateEmail, guardEmailDisclosure, withValidationFeedback } from "../src/llm/generate.js";
import {
  createReferenceEnrollmentInvitation,
  enrollmentInvitationExpectation,
} from "../src/domain/email-artifacts.js";
import { startSseServer } from "../test-support/sse-server.mjs";

const EXPECT = enrollmentInvitationExpectation({
  replyAddress: "yente@ccme.network",
  unsubscribeAddress: "unsubscribe@ccme.network",
});

const SLOTS = {
  invitedName: "Dana",
  invitingName: "Alice Chen",
  replyAddress: "yente@ccme.network",
  unsubscribeUrl: "https://ccme.network/u/7f3a91",
};

const fallback = () => createReferenceEnrollmentInvitation(SLOTS);

function artifact({ template = "enrollment_invitation", facts = [], subject = "Alice Chen copied me on a thread with you", text = "Hi Dana,\n\nAlice Chen copied me in. Reply if you would like an introduction." } = {}) {
  return [
    "<<<META>>>",
    JSON.stringify({ template, version: 1, facts_used: facts }),
    "<<<END>>>",
    "",
    "<<<SUBJECT>>>",
    subject,
    "<<<END>>>",
    "",
    "<<<EMAIL_TEXT>>>",
    text,
    "<<<END>>>",
    "",
  ].join("\n");
}

async function withModel(scripts, run) {
  // Each element of `scripts` is one completion, served in order.
  let call = 0;
  const servers = [];
  for (const deltas of scripts) servers.push(await startSseServer({ deltas }));
  const client = {
    async complete(request) {
      const server = servers[Math.min(call, servers.length - 1)];
      call += 1;
      return createModelClient({ baseUrl: server.baseUrl, model: "m" }).complete(request);
    },
  };
  try {
    return await run(client, () => call);
  } finally {
    for (const server of servers) await server.close();
  }
}

test("a valid first response is used as-is", async () => {
  await withModel([[artifact()]], async (client, calls) => {
    const result = await generateEmail({ client, prompt: "<<<TASK>>>\nwrite\n<<<END>>>", expect: EXPECT, fallback });
    assert.equal(result.source, "model");
    assert.equal(result.attempts, 1);
    assert.equal(calls(), 1);
    assert.deepEqual(result.failures, []);
    assert.equal(result.email.meta.template, "enrollment_invitation");
  });
});

test("an invalid response is retried exactly once, carrying the validation error", async () => {
  const scripts = [["not a sentinel artifact at all"], [artifact()]];
  await withModel(scripts, async (client, calls) => {
    const result = await generateEmail({ client, prompt: "<<<TASK>>>\nwrite\n<<<END>>>", expect: EXPECT, fallback });
    assert.equal(result.source, "model");
    assert.equal(result.attempts, 2);
    assert.equal(calls(), 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].attempt, 1);
  });
});

test("two failures fall back to the deterministic template — §11.6", async () => {
  await withModel([["garbage"], ["still garbage"]], async (client, calls) => {
    const result = await generateEmail({ client, prompt: "p", expect: EXPECT, fallback });
    assert.equal(result.source, "fallback");
    assert.equal(calls(), 2, "exactly two model calls, never a third");
    assert.equal(result.failures.length, 2);
    assert.match(result.email.text, /I have not read the thread/);
  });
});

test("with no fallback, two failures make the job reviewable rather than inventing one", async () => {
  await withModel([["garbage"], ["garbage"]], async (client) => {
    const result = await generateEmail({ client, prompt: "p", expect: EXPECT });
    assert.equal(result.source, "review");
    assert.equal(result.artifact, null);
    assert.equal(result.email, null);
  });
});

test("a transport failure is retried without amending the prompt", async () => {
  // Re-asking the same question is right; appending a network error to a
  // sentinel prompt would be nonsense to the model.
  const server = await startSseServer({ status: 503, body: "loading" });
  const good = await startSseServer({ deltas: [artifact()] });
  let call = 0;
  const prompts = [];
  const client = {
    async complete(request) {
      prompts.push(request.prompt);
      const target = call === 0 ? server : good;
      call += 1;
      return createModelClient({ baseUrl: target.baseUrl, model: "m" }).complete(request);
    },
  };
  try {
    const result = await generateEmail({ client, prompt: "<<<TASK>>>\nwrite\n<<<END>>>", expect: EXPECT });
    assert.equal(result.source, "model");
    assert.equal(prompts[0], prompts[1], "the prompt was not amended after a transport error");
    assert.equal(result.failures[0].code, "HTTP_ERROR");
  } finally {
    await server.close();
    await good.close();
  }
});

test("the fallback is held to the same contract as the model", async () => {
  // A template that could leak is worse than a model that might, because nobody
  // re-reads a template.
  const leaky = () => artifact({ text: "Hi — also cc stranger@elsewhere.com about this." });
  await withModel([["garbage"], ["garbage"]], async (client) => {
    await assert.rejects(
      generateEmail({ client, prompt: "p", expect: EXPECT, fallback: leaky }),
      (error) => error.code === "UNAUTHORISED_ADDRESS",
    );
  });
});

/* --- the guard itself -------------------------------------------------- */

test("a fact id that was never supplied is rejected — INV-5", () => {
  const expect = { ...EXPECT, allowedFactIds: ["fact_1", "fact_2"] };
  guardEmailDisclosure(artifact({ facts: ["fact_1"] }), expect);
  assert.throws(
    () => guardEmailDisclosure(artifact({ facts: ["fact_1", "fact_99"] }), expect),
    (error) => {
      assert.equal(error.code, "UNKNOWN_FACT_ID");
      assert.deepEqual(error.meta.unknown, ["fact_99"]);
      return true;
    },
  );
});

test("an evidenced email that cites nothing is rejected", () => {
  const expect = { ...EXPECT, allowedFactIds: ["fact_1"] };
  assert.throws(() => guardEmailDisclosure(artifact({ facts: [] }), expect), /NO_FACTS_CITED|cites no facts/);
});

test("quoted source material is rejected even if re-wrapped — INV-6", () => {
  const secret = "Led infrastructure operations for a fleet of four hundred machines";
  const expect = { ...EXPECT, forbiddenSubstrings: [secret] };

  // Re-wrapped across lines and re-cased: normalising both sides is what stops
  // a trivial reformat from evading the check.
  const leaked = artifact({ text: `Hi Dana,\n\nLED INFRASTRUCTURE OPERATIONS\nfor a fleet of\nfour hundred machines.` });
  assert.throws(() => guardEmailDisclosure(leaked, expect), (error) => {
    assert.equal(error.code, "RAW_SOURCE_DISCLOSED");
    return true;
  });

  guardEmailDisclosure(artifact({ text: "Hi Dana, they run infrastructure at scale." }), expect);
});

test("a short forbidden string cannot trigger a false positive", () => {
  // A 24-character floor. Without it, a forbidden fragment like "operations"
  // would reject every legitimate summary that used the word, and a check that
  // fires on correct output is one people learn to route around.
  const expect = { ...EXPECT, forbiddenSubstrings: ["operations"] };
  guardEmailDisclosure(artifact({ text: "Hi Dana, they work in operations." }), expect);
});

test("an address the runtime did not authorise is rejected — §11.3", () => {
  // A model that writes "cc: someone@else.com" into the body has added a
  // recipient in the only way available to it, and a human forwarding the email
  // completes the act.
  assert.throws(
    () => guardEmailDisclosure(artifact({ text: "Hi Dana — please cc bob@acme.com too." }), EXPECT),
    (error) => {
      assert.equal(error.code, "UNAUTHORISED_ADDRESS");
      assert.deepEqual(error.meta.strangers, ["bob@acme.com"]);
      return true;
    },
  );
  guardEmailDisclosure(artifact({ text: "Hi Dana — reply to yente@ccme.network." }), EXPECT);
});

test("the wrong template is rejected even when the shape is perfect", () => {
  assert.throws(
    () => guardEmailDisclosure(artifact({ template: "joint_introduction" }), EXPECT),
    (error) => {
      assert.equal(error.code, "WRONG_TEMPLATE");
      return true;
    },
  );
});

test("validation feedback travels as a block, with delimiters stripped", () => {
  const prompt = "<<<TASK>>>\nwrite\n<<<END>>>\n";
  const feedback = withValidationFeedback(prompt, {
    code: "UNKNOWN_TAG",
    message: "saw <<<SCHEDULE>>> which is not a tag",
  });

  assert.match(feedback, /UNKNOWN_TAG/);
  // The error text mentioned a delimiter. Embedding it verbatim would inject a
  // frame into the very artifact meant to teach the model to frame things.
  assert.match(feedback, /saw SCHEDULE which is not a tag/);
  assert.equal((feedback.match(/<<<TASK>>>/g) ?? []).length, 2);
  assert.equal((feedback.match(/<<<END>>>/g) ?? []).length, 2);
});
