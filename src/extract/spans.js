/**
 * Span verification — INV-5 and D2, step 7 of SPEC v2 §15.
 *
 * "Every profile fact and every sentence in a match explanation must cite
 * stored evidence. Unsupported LLM output is rejected, not stored as truth."
 *
 * This module is where that stops being a sentence in a document. The model
 * proposes facts, each carrying a verbatim excerpt it claims came from a source;
 * this checks the claim against the stored source text and throws out anything
 * that cannot be found.
 *
 * The interesting decision is HOW to compare. An exact substring match is too
 * brittle: a model re-wraps a line, collapses a run of spaces, or turns a
 * hyphen into an en dash, and a perfectly honest citation fails. A fuzzy match
 * is too loose: it eventually accepts a paraphrase, and a paraphrase is exactly
 * the invented evidence INV-5 exists to catch.
 *
 * So: normalise whitespace and unicode punctuation, then require an exact
 * substring of the normalised source. Reformatting survives. Rewording does
 * not. There is a test for both directions, because a check that only ever
 * passes is not a check.
 */

export class GroundingError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "GroundingError";
    this.code = code;
    this.meta = meta;
  }
}

/** The shortest excerpt worth treating as evidence. */
export const MIN_EVIDENCE_CHARS = 12;

/**
 * Fold the differences that are formatting, and only those.
 *
 * Unicode punctuation is folded because a model that reads "Vice-President"
 * from a PDF and writes "Vice‑President" with a non-breaking hyphen has not
 * invented anything. Case is folded for the same reason. Word order, wording
 * and numbers are untouched — those are content.
 */
export function normaliseForGrounding(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Verify one proposed fact against the source it cites.
 *
 * @param {object} fact  as emitted in a PROFILE_FACTS block
 * @param {Map<string,string>|Record<string,string>} sources  source id -> text
 * @returns {{field: string, value: unknown, sourceId: string, evidence: string, offset: number, explicit: boolean, confidence: string}}
 * @throws {GroundingError}
 */
export function verifyFact(fact, sources) {
  const lookup = sources instanceof Map ? sources : new Map(Object.entries(sources ?? {}));

  for (const required of ["field", "value", "source_id", "evidence"]) {
    if (fact?.[required] === undefined || fact?.[required] === null || fact[required] === "") {
      throw new GroundingError("INCOMPLETE_FACT", `A proposed fact requires ${required}`, { fact });
    }
  }

  const sourceText = lookup.get(fact.source_id);
  if (sourceText === undefined) {
    // A citation to a source that does not exist is the cheapest kind of
    // invention and the easiest to catch, so catch it first and by name.
    throw new GroundingError("UNKNOWN_SOURCE", `Fact cites source '${fact.source_id}', which was not supplied`, {
      sourceId: fact.source_id,
      available: [...lookup.keys()],
    });
  }

  const evidence = String(fact.evidence);
  if (normaliseForGrounding(evidence).length < MIN_EVIDENCE_CHARS) {
    throw new GroundingError("EVIDENCE_TOO_SHORT", `Evidence must be at least ${MIN_EVIDENCE_CHARS} characters`, {
      evidence,
    });
  }

  const haystack = normaliseForGrounding(sourceText);
  const needle = normaliseForGrounding(evidence);
  const offset = haystack.indexOf(needle);
  if (offset === -1) {
    throw new GroundingError("SPAN_NOT_FOUND", "The cited evidence does not occur in the source", {
      sourceId: fact.source_id,
      evidence: evidence.slice(0, 120),
    });
  }

  return Object.freeze({
    field: fact.field,
    value: fact.value,
    sourceId: fact.source_id,
    evidence,
    offset,
    explicit: fact.explicit === true,
    confidence: fact.confidence ?? "unstated",
  });
}

/**
 * Verify a whole PROFILE_FACTS payload.
 *
 * Returns the facts that hold and the ones that did not, rather than throwing
 * on the first failure. §6.2 is explicit that inferred facts "may inform the
 * next interview question but cannot satisfy qualification" — so a partly
 * grounded extraction is useful, and discarding all of it because one span was
 * invented would throw away real evidence.
 *
 * The caller decides what to do with `rejected`; nothing here stores anything.
 */
export function verifyFacts(facts, sources) {
  const verified = [];
  const rejected = [];

  for (const fact of facts ?? []) {
    try {
      verified.push(verifyFact(fact, sources));
    } catch (error) {
      if (!(error instanceof GroundingError)) throw error;
      rejected.push({ fact, code: error.code, message: error.message });
    }
  }

  return { verified, rejected };
}

/**
 * Facts that may satisfy qualification.
 *
 * INV-3 and §6.2: an INFERRED fact — one the model derived rather than read —
 * becomes an interview question, never a qualification fact, until the member
 * confirms it. Grounding proves the words are in the document. It does not
 * prove the document says what the model concluded.
 */
export function qualifyingFacts(verified) {
  return verified.filter((fact) => fact.explicit);
}

/** Facts that should become questions instead. */
export function factsNeedingConfirmation(verified) {
  return verified.filter((fact) => !fact.explicit);
}
