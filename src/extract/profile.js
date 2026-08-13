/**
 * Profile extraction — SPEC v2 §6.2, step 7 of §15.
 *
 * The model proposes typed facts with a verbatim excerpt for each; the runtime
 * checks every excerpt against the stored source and keeps only what holds.
 * §11.4 draws the line this module lives on: "Sentinel extraction is not
 * validation." Getting a well-formed PROFILE_FACTS block back means the model
 * answered in the right shape, and nothing whatsoever about whether it told the
 * truth.
 */

import {
  BLOCK_TAGS,
  ProtocolError,
  createPromptArtifact,
  parseJsonBlock,
  textBlock,
} from "../protocol/blocks.js";
import { verifyFacts, qualifyingFacts, factsNeedingConfirmation } from "./spans.js";

/**
 * @param {object} input
 * @param {string} input.sourceId
 * @param {string} input.text        the extracted source text, verbatim
 * @param {object} input.vocabulary  controlled values the model may choose from
 */
export function createExtractionPrompt({ sourceId, text, vocabulary }) {
  return createPromptArtifact([
    {
      tag: BLOCK_TAGS.TASK,
      content:
        "Extract evidenced professional facts from this source. " +
        "For each fact give the field, a value from the controlled vocabulary where one applies, " +
        "the source id, and a VERBATIM excerpt from the source that supports it. " +
        "Copy the excerpt exactly; do not paraphrase, summarise, or join separate sentences. " +
        "Mark a fact explicit only when the source states it outright. " +
        "Mark it inferred when you concluded it. Never invent a fact you cannot quote.",
    },
    { tag: BLOCK_TAGS.SOURCE, argument: sourceId, content: text },
    { tag: BLOCK_TAGS.CONTROLLED_VOCABULARY, json: vocabulary },
    {
      tag: BLOCK_TAGS.OUTPUT_CONTRACT,
      // The delimiters are specified in the SYSTEM message, not here. A block's
      // content cannot contain a sentinel token — requireText throws
      // NESTED_SENTINEL — which is the protocol's whole point: a prompt must not
      // be able to draw its own boundaries, or injected text could forge them.
      // So the shape of the reply is told to the model out of band.
      content:
        "Return exactly one PROFILE_FACTS block and nothing else: no prose "
        + "before or after it, and no markdown code fence. Its content is a "
        + "single JSON object with a facts array. Each fact has exactly these "
        + "keys: field, value, source_id, evidence, explicit. `evidence` must be "
        + "copied character-for-character from the SOURCE block — it is checked "
        + "against the source and any fact whose evidence cannot be found there "
        + "is discarded. `explicit` is true when the source states the fact "
        + "outright, false when you inferred it. If the source supports no "
        + "facts, return an empty facts array.",
    },
  ]);
}

/**
 * Run extraction against one source: at most two model calls, then give up
 * honestly.
 *
 * §11.6 allows a single retry carrying the validation error. Note what counts
 * as a validation error here: a malformed block, yes — but ALSO an extraction
 * in which every proposed fact failed grounding. A model that returned ten
 * beautifully-formed inventions has failed in a way worth telling it about, and
 * the retry says exactly which excerpts could not be found.
 *
 * @returns {Promise<ExtractionResult>}
 * @typedef {object} ExtractionResult
 * @property {Array} verified   facts whose excerpt was found in the source
 * @property {Array} rejected   facts whose excerpt was not
 * @property {Array} qualifying explicit verified facts (§6.4 may use these)
 * @property {Array} questions  inferred verified facts (§6.3 asks about these)
 * @property {number} attempts
 * @property {Array} failures
 */
/**
 * The block syntax, told to the model OUT OF BAND.
 *
 * It cannot go in the prompt: `requireText` rejects any block whose content
 * holds a sentinel token, because a prompt that can draw its own delimiters is a
 * prompt that injected text can forge. The system message is not an artifact, so
 * it is the one place the shape can actually be shown.
 *
 * Naming the tag without showing it was the entire bug. Both llama-3.3-70b and
 * claude-sonnet-5 answered with correct facts wrapped in a markdown fence under
 * a bare `PROFILE_FACTS` line, and the parser rejected every one with
 * MALFORMED_ARTIFACT. Two unrelated models resolving an ambiguity the same way
 * is not two model failures; it is one specification failure.
 */
const EXTRACTION_SYSTEM = [
  "You reply only in Sentinel Blocks. A block is a line containing three",
  "left angle brackets, the tag, then three right angle brackets; then the",
  "content on its own lines; then a closing line of three left angle brackets,",
  "the word END, and three right angle brackets. Exactly like this:",
  "",
  "<<<PROFILE_FACTS>>>",
  '{"facts":[{"field":"professional.title","value":"VP Operations",',
  '"source_id":"src_1","evidence":"VP Operations, Orlando FL.","explicit":true}]}',
  "<<<END>>>",
  "",
  "Emit that one block and nothing else. No preamble, no explanation, no",
  "markdown fence. Copy every evidence string verbatim from the source: it is",
  "verified against the source text and unverifiable facts are thrown away, so",
  "a paraphrase costs you the fact. Prefer fewer facts you can quote over more",
  "you cannot.",
].join("\n");

export async function extractProfileFacts({ client, sourceId, text, vocabulary, signal }) {
  const basePrompt = createExtractionPrompt({ sourceId, text, vocabulary });
  const sources = new Map([[sourceId, text]]);
  const failures = [];
  let prompt = basePrompt;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let completion;
    try {
      completion = await client.complete({ prompt, system: EXTRACTION_SYSTEM, signal });
    } catch (error) {
      failures.push({ attempt, code: error.code ?? "MODEL_ERROR", message: error.message });
      if (attempt === 2) break;
      continue;
    }

    let payload;
    try {
      payload = parseJsonBlock(completion.text, BLOCK_TAGS.PROFILE_FACTS);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      failures.push({ attempt, code: error.code, message: error.message });
      if (attempt === 2) break;
      prompt = withFeedback(basePrompt, `${error.code}: ${error.message}`);
      continue;
    }

    const { verified, rejected } = verifyFacts(payload?.facts, sources);

    if (verified.length === 0 && rejected.length > 0) {
      const detail = rejected
        .slice(0, 3)
        .map((row) => `${row.code} on "${String(row.fact.evidence ?? "").slice(0, 60)}"`)
        .join("; ");
      failures.push({ attempt, code: "ALL_FACTS_UNGROUNDED", message: detail });
      if (attempt === 2) break;
      prompt = withFeedback(
        basePrompt,
        `None of your excerpts were found in the source (${detail}). ` +
          "Copy the excerpt character for character from the SOURCE block.",
      );
      continue;
    }

    return {
      verified,
      rejected,
      qualifying: qualifyingFacts(verified),
      questions: factsNeedingConfirmation(verified),
      attempts: attempt,
      failures,
    };
  }

  // §11.6: never fabricate. An extraction that could not be grounded twice
  // yields nothing, and the member is asked rather than guessed at.
  return { verified: [], rejected: [], qualifying: [], questions: [], attempts: 2, failures };
}

function withFeedback(prompt, message) {
  const detail = String(message).replace(/<<<|>>>/g, "");
  return `${prompt.trimEnd()}\n\n${textBlock(
    BLOCK_TAGS.TASK,
    `Your previous response was rejected: ${detail} Return only the required block.`,
  )}\n`;
}
