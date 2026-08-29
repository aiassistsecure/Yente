/**
 * The manifest protocol — the model tells us how much it is about to say.
 *
 *   <<<MANIFEST>>>
 *   {"blocks": 3}
 *   <<<END>>>
 *   <<<ENTITIES>>>
 *   [...]
 *   <<<END>>>
 *   <<<INTENTS>>>
 *   [...]
 *   <<<END>>>
 *   <<<RELATIONSHIPS>>>
 *   [...]
 *   <<<END>>>
 *
 * TWO THINGS THIS BUYS, AND THE SECOND IS THE POINT
 *
 * 1. A stop condition that is arithmetic instead of a guess. Once we have
 *    `blocks + 1` closings we have the whole answer, and every token after that
 *    is a model that did not stop when asked. On a reasoning model through PIN
 *    that is tens of seconds per message.
 *
 * 2. TRUNCATION BECOMES DETECTABLE. This is the real reason. A stream cut short
 *    — context limit, gateway hiccup, token budget — previously arrived as a
 *    partial envelope that PARSED, and we would store a partial graph believing
 *    it complete. Silent data loss dressed as success, which is the exact shape
 *    of every serious bug in this project so far. With a declared count, two of
 *    three blocks is a countable discrepancy and therefore a retry.
 *
 * WHY ONE BLOCK PER CLAIM GROUP
 *
 * Failure isolation. A malformed INTENTS block costs the intents; the entities
 * and relationships still land. Under the single-envelope protocol one bad
 * character anywhere cost the whole message's meaning.
 *
 * WHY WE DO NOT TRUST THE COUNT
 *
 * The manifest is model output, so it is a CLAIM about the answer, not a fact.
 * It is used for two things only: knowing when to stop reading, and noticing a
 * mismatch. It never decides what is in the graph — the blocks do, and each
 * claim in them still has to survive schema validation and span verification.
 * A model that declares 9 and sends 3 gets a retry, not nine imaginary blocks.
 */

import { BLOCK_TAGS, ProtocolError } from "../protocol/blocks.js";

/** The claim-group blocks, in the order the contract asks for them. */
export const GROUP_BLOCKS = Object.freeze([
  { tag: BLOCK_TAGS.ENTITIES, group: "entities" },
  { tag: BLOCK_TAGS.INTENTS, group: "intents" },
  { tag: BLOCK_TAGS.RELATIONSHIPS, group: "relationships" },
  { tag: BLOCK_TAGS.DISCLOSURES, group: "disclosures" },
  { tag: BLOCK_TAGS.PROPOSALS, group: "proposals" },
]);

const CLOSING = /<<<END>>>/g;
const MANIFEST_FRAME = /<<<MANIFEST>>>\s*([\s\S]*?)\s*<<<END>>>/;

/** How many closings are in this text so far. */
export function countClosings(text) {
  return (String(text ?? "").match(CLOSING) ?? []).length;
}

/**
 * The declared block count, or null while the manifest has not fully arrived.
 *
 * Deliberately tolerant: the manifest is the FIRST thing the model writes, so if
 * it is malformed the whole reply is suspect and the reader will find that out
 * anyway. This function's only job is to answer "how many, if we know yet".
 */
export function declaredBlocks(text) {
  const match = MANIFEST_FRAME.exec(String(text ?? ""));
  if (!match) return null;
  try {
    const value = Number(JSON.parse(match[1]).blocks);
    return Number.isInteger(value) && value >= 0 && value <= GROUP_BLOCKS.length
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * A stop predicate for the streaming client.
 *
 * Stateless across calls on purpose — it re-reads the accumulated text each
 * time rather than caching the count, because caching would need invalidation
 * and the regex is trivial next to the cost of a token.
 *
 * Falls back to "stop at the first closing" when there is no manifest, so a
 * model that ignored the contract and sent one bare block still terminates
 * instead of running to the token ceiling.
 */
export function manifestStop(text) {
  const declared = declaredBlocks(text);
  const closings = countClosings(text);
  if (declared === null) {
    // No manifest yet. If we have already seen a closing AND no manifest frame
    // exists, the model is not speaking this protocol; the tolerant reader will
    // handle whatever it sent, so stop rather than wait it out.
    return closings >= 1 && !MANIFEST_FRAME.test(text);
  }
  return closings >= declared + 1;   // +1 for the manifest's own closing
}

/**
 * Read the multi-block reply into one raw envelope.
 *
 * Returns `{ raw, declared, found, missing }`. Throws only when there is
 * nothing usable at all — a partial answer is reported, not discarded, because
 * three good blocks out of four are worth keeping and the discrepancy is worth
 * knowing about separately.
 */
export function readManifestBlocks(text) {
  const source = String(text ?? "");
  const declared = declaredBlocks(source);

  const raw = {};
  const found = [];
  const malformed = [];

  for (const { tag, group } of GROUP_BLOCKS) {
    // Matched directly rather than through scanBlockFrames, because that
    // function rejects the WHOLE artifact when anything sits outside a block —
    // and a model that adds a stray sentence should not cost us four good
    // blocks. Each block is validated on its own here.
    const frame = new RegExp(`<<<${tag}>>>\\s*([\\s\\S]*?)\\s*<<<END>>>`).exec(source);
    if (!frame) continue;
    try {
      const value = JSON.parse(frame[1]);

      // ARRAY vs OBJECT is the version discriminator, and it matters most for
      // OBSERVATIONS — the one tag both protocols use. In obs_v2 it holds an
      // ARRAY of note claims; in obs_v1 it held the whole envelope as an OBJECT.
      // Wrapping that object in an array would silently file an entire envelope
      // as a single note, so an object here means "not this protocol" and the
      // caller's obs_v1 reader gets it instead.
      if (!Array.isArray(value)) {
        if (declared === null) continue;   // no manifest: this is an obs_v1 reply
        malformed.push({
          group,
          error: `expected a JSON array, received ${value === null ? "null" : typeof value}`,
        });
        continue;
      }

      raw[group] = value;
      found.push(group);
    } catch (error) {
      // One unparseable group, named. Under the old single-envelope protocol
      // this took the entire message's meaning with it.
      malformed.push({ group, error: String(error?.message ?? error) });
    }
  }

  if (found.length === 0 && malformed.length === 0) {
    throw new ProtocolError("MALFORMED_ARTIFACT", "No canonical claim blocks found");
  }

  // THE TRUNCATION CHECK. The model said N; we have fewer. Something was cut
  // off, and a partial graph stored as complete is worse than a retry.
  const missing = declared === null
    ? 0
    : Math.max(0, declared - (found.length + malformed.length));

  return { raw, declared, found, malformed, missing };
}
