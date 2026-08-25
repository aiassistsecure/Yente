/**
 * Bounding the evidence we hand to a model. The place prompt.js promised.
 *
 * WHAT THIS FIXES, AND IT WAS A COMMENT PRETENDING TO BE A DESIGN
 *
 * `createObservationPrompt` says: "'Bounded' is the operative word and the
 * caller's responsibility ... this function does not chunk, so the chunking
 * policy lives in one place upstream." That place did not exist. The queue sent
 * `text: evidence.text` — the whole thing, however long — and the comment made
 * the omission look deliberate.
 *
 * WHY AN UNBOUNDED PROMPT DOES NOT FAIL GENTLY
 *
 * It fails as a TIMEOUT, which reads as a slow model. During prefill a model
 * emits nothing at all: no tokens, no reasoning deltas, no keep-alive. PIN's
 * limit is "operator produced nothing for 90s", so a prompt whose prefill
 * exceeds ninety seconds is killed before it can speak a single token — and
 * killed identically on every retry, because nothing about the input changed.
 *
 * Which is the worst shape of failure: permanent, and disguised as transient.
 * Measured on the box, a 26B model against a long message did this three times
 * in a row for 15 minutes while the queue reported it as busy.
 *
 * SO WHY TRUNCATE RATHER THAN CHUNK
 *
 * Chunking is better and is the next piece of work. But the choice today is not
 * "truncate vs chunk", it is "truncate vs lose the whole document forever",
 * because an unbounded prompt does not eventually succeed. Bounded and marked
 * beats unbounded and dead.
 *
 * HEAD AND TAIL, NOT THE FIRST N CHARACTERS
 *
 * Business correspondence puts the ask at the top and the identity at the
 * bottom: signature block, title, company, phone. Keeping only the head reliably
 * loses the person. So we keep both ends and say plainly, in the text itself,
 * what was dropped — the model is told it is reading an excerpt rather than left
 * to infer that the letter ended mid-sentence.
 *
 * SPAN VERIFICATION IS UNAFFECTED
 *
 * Quotes are checked against the stored source text. A claim quoting the part we
 * kept still verifies; a claim quoting the part we dropped cannot be made at
 * all, because the model never saw it. Truncation can therefore cost us claims,
 * but it cannot manufacture one — the property that matters.
 */

/** Chosen to sit well inside a 90s prefill on a 26B model, with room to spare. */
export const DEFAULT_MAX_SOURCE_CHARS = Number(
  process.env.YENTE_MAX_SOURCE_CHARS || 16_000,
);

/** Rough, and honest about it: ~4 characters per token for English prose. */
export function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / 4);
}

/**
 * Bound one source's text.
 *
 * @returns {{text: string, truncated: boolean, originalChars: number,
 *            keptChars: number, droppedChars: number}}
 */
export function boundSource(text, { maxChars = DEFAULT_MAX_SOURCE_CHARS } = {}) {
  // Only a string is evidence text. `String(text ?? "")` turns 0 into "0" and
  // an object into "[object Object]" — junk that would then be sent to a model
  // and quoted back at us as if it came from the source.
  const source = typeof text === "string" ? text : "";
  const originalChars = source.length;

  if (originalChars <= maxChars) {
    return {
      text: source,
      truncated: false,
      originalChars,
      keptChars: originalChars,
      droppedChars: 0,
    };
  }

  // Two thirds from the top (the ask, the context), one third from the bottom
  // (the signature, the title, the company). The marker is inside the text on
  // purpose: a model that can see the gap will not invent a bridge across it.
  const headChars = Math.floor(maxChars * 0.66);
  const tailChars = maxChars - headChars;
  const dropped = originalChars - maxChars;

  const head = source.slice(0, headChars);
  const tail = source.slice(originalChars - tailChars);
  const marker = `\n\n[... ${dropped.toLocaleString("en-US")} characters omitted `
    + `from the middle of this source. You are reading an excerpt: the beginning `
    + `and the end. Do not quote across the gap, and do not infer what was in `
    + `it. ...]\n\n`;

  return {
    text: head + marker + tail,
    truncated: true,
    originalChars,
    keptChars: maxChars,
    droppedChars: dropped,
  };
}

/**
 * Bound a whole set of sources, returning them alongside what it cost.
 *
 * The report is for the log and for provenance. "How long is the prompt" was
 * unanswerable from outside the process, which is precisely why a prompt that
 * could never succeed looked like a model that was merely slow.
 */
export function boundSources(sources, { maxChars = DEFAULT_MAX_SOURCE_CHARS } = {}) {
  const bounded = [];
  let originalChars = 0;
  let keptChars = 0;
  let truncatedCount = 0;

  for (const source of sources ?? []) {
    const result = boundSource(source?.text, { maxChars });
    originalChars += result.originalChars;
    keptChars += result.text.length;
    if (result.truncated) truncatedCount += 1;
    bounded.push({ ...source, text: result.text, truncated: result.truncated });
  }

  return {
    sources: bounded,
    report: Object.freeze({
      originalChars,
      keptChars,
      truncated: truncatedCount,
      estimatedTokens: estimateTokens(keptChars),
    }),
  };
}
