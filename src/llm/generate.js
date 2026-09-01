/**
 * Email generation — SPEC v2 §11.3 and §11.6.
 *
 * The model writes prose inside a contract. This module is the contract's
 * enforcement, and it draws a line the shape-checker in protocol/blocks.js
 * cannot: blocks.js proves the response is *well-formed*, this proves it is
 * *permitted*.
 *
 * Those are different questions. A perfectly-formed email that cites a fact id
 * nobody approved, quotes a paragraph of somebody's resume, or slips a third
 * address into the body passes every structural check and violates INV-5, INV-6
 * and §11.3 respectively. A validator that only parses would wave all three
 * through.
 *
 * §11.6 sets the failure policy exactly: one retry carrying the validation
 * error, then a deterministic fallback where one exists, then the job becomes
 * reviewable. There is no fourth branch in which something plausible is
 * invented.
 */

import { ProtocolError, extractArtifact, parseEmailArtifact, textBlock, BLOCK_TAGS } from "../protocol/blocks.js";

export class DisclosureError extends ProtocolError {
  constructor(code, message, meta = {}) {
    super(code, message);
    this.name = "DisclosureError";
    this.meta = meta;
  }
}

/** Anything shaped like an address. Deliberately greedy — a false positive here costs a retry; a false negative sends mail to a stranger. */
const ADDRESS_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Validate a well-formed email artifact against what the runtime authorised.
 *
 * @param {string} artifact
 * @param {object} expect
 * @param {string}   expect.template            META.template must match exactly
 * @param {string[]} expect.allowedFactIds      the frozen fact ids for this match
 * @param {string[]} [expect.allowedAddresses]  addresses permitted to appear in the body
 * @param {string[]} [expect.forbiddenSubstrings] raw source text that must never be quoted
 * @returns {{meta: object, subject: string, text: string}}
 */
export function guardEmailDisclosure(artifact, expect) {
  const email = parseEmailArtifact(artifact);
  const { template, allowedFactIds = [], allowedAddresses = [], forbiddenSubstrings = [] } = expect;

  if (email.meta.template !== template) {
    throw new DisclosureError(
      "WRONG_TEMPLATE",
      `Expected template '${template}', received '${email.meta.template}'`,
      { expected: template, received: email.meta.template },
    );
  }

  // INV-5: every disclosed claim is evidenced. An id outside the frozen set is
  // a citation to something the match never established.
  const allowed = new Set(allowedFactIds);
  const unknown = email.meta.facts_used.filter((id) => !allowed.has(id));
  if (unknown.length > 0) {
    throw new DisclosureError("UNKNOWN_FACT_ID", `META cites fact ids that were not supplied: ${unknown.join(", ")}`, {
      unknown,
    });
  }
  if (allowedFactIds.length > 0 && email.meta.facts_used.length === 0) {
    throw new DisclosureError("NO_FACTS_CITED", "META cites no facts for an evidenced email");
  }

  // INV-6: raw sources remain private. The check is on normalised text so that
  // re-wrapping a quoted line does not evade it.
  const haystack = normalise(email.text);
  for (const forbidden of forbiddenSubstrings) {
    const needle = normalise(forbidden);
    if (needle.length >= 24 && haystack.includes(needle)) {
      throw new DisclosureError("RAW_SOURCE_DISCLOSED", "EMAIL_TEXT quotes private source material", {
        excerpt: forbidden.slice(0, 80),
      });
    }
  }

  // §11.3: "rejects ... additional recipients". A model that helpfully writes
  // "cc: someone@else.com" into the body has added a recipient in the only way
  // it can, and a human forwarding that email completes the act.
  const permitted = new Set(allowedAddresses.map((address) => address.toLowerCase()));
  const found = [...new Set((email.text.match(ADDRESS_PATTERN) ?? []).map((a) => a.toLowerCase()))];
  const strangers = found.filter((address) => !permitted.has(address));
  if (strangers.length > 0) {
    throw new DisclosureError("UNAUTHORISED_ADDRESS", `EMAIL_TEXT contains addresses that were not authorised: ${strangers.join(", ")}`, {
      strangers,
    });
  }

  return email;
}

function normalise(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Generate one email: at most two model calls, then a deterministic answer.
 *
 * @param {object} input
 * @param {object} input.client   a model client from ./client.js
 * @param {string} input.prompt   the sentinel prompt artifact
 * @param {object} input.expect   passed to guardEmailDisclosure
 * @param {() => string} [input.fallback] deterministic artifact builder
 * @param {string} [input.system]
 * @param {(delta: string) => void} [input.onToken]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<GenerationResult>}
 *
 * @typedef {object} GenerationResult
 * @property {"model"|"fallback"|"review"} source
 * @property {string|null} artifact
 * @property {object|null} email
 * @property {number} attempts
 * @property {Array<{attempt: number, code: string, message: string}>} failures
 */
export async function generateEmail({ client, prompt, expect, fallback, system, onToken, signal }) {
  const failures = [];
  let currentPrompt = prompt;

  // Two attempts, hard. §11.6 says "may retry once", and a loop with a
  // configurable ceiling is how "once" becomes "until it works", which is how a
  // wedged model becomes a send-rate problem.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let completion;
    try {
      completion = await client.complete({ prompt: currentPrompt, system, onToken, signal });
    } catch (error) {
      failures.push({ attempt, code: error.code ?? "MODEL_ERROR", message: error.message });
      // A transport failure is not a content failure: re-asking the same
      // question is right, and amending the prompt with a network error would
      // be nonsense to the model.
      if (attempt === 2) break;
      continue;
    }

    try {
      // Reading tolerance: small models narrate around their blocks. Slice
      // to the artifact before judging it — the guard still validates every
      // byte INSIDE the frames.
      const artifact = extractArtifact(completion.text);
      const email = guardEmailDisclosure(artifact, expect);
      return { source: "model", artifact, email, attempts: attempt, failures };
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      failures.push({ attempt, code: error.code, message: error.message });
      if (attempt === 2) break;
      currentPrompt = withValidationFeedback(prompt, error);
    }
  }

  // §11.6: a deterministic fallback where one exists.
  if (fallback) {
    const artifact = fallback();
    // The fallback is held to the same contract as the model. A template that
    // could leak is worse than a model that might, because nobody re-reads it.
    const email = guardEmailDisclosure(artifact, expect);
    return { source: "fallback", artifact, email, attempts: 2, failures };
  }

  return { source: "review", artifact: null, email: null, attempts: failures.length, failures };
}

/**
 * Append the validation error to the prompt as a TASK block.
 *
 * The correction travels in the same protocol as the request. Appending free
 * prose to a sentinel artifact would put text outside a block, which blocks.js
 * rejects on the way in — so the repair instruction would itself be malformed.
 *
 * The message is stripped of sentinel delimiters first. An error whose text
 * contained `<<<` would inject a frame into the very artifact meant to teach
 * the model to frame things properly.
 */
export function withValidationFeedback(prompt, error) {
  const detail = String(error.message).replace(/<<<|>>>/g, "");
  return `${prompt.trimEnd()}\n\n${textBlock(
    BLOCK_TAGS.TASK,
    `Your previous response was rejected by the validator (${error.code}): ${detail}. ` +
      "Return only the required blocks, with no text outside a block.",
  )}\n`;
}
