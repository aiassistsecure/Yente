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
    // A hyphen BETWEEN LETTERS is typography, not content: a PDF extractor
    // breaks "engineering" into "engineer-\ning" at the wrap point, and a
    // model that reads the word whole has not invented anything. Folded on
    // BOTH sides (the optional whitespace makes the wrapped source and the
    // unwrapped quote normalise identically), and only between letters —
    // "2023-present", "e-2", "C-3" keep their hyphens, because a digit next
    // to a hyphen is content. Observed live as SPAN_NOT_FOUND on honest
    // quotes from a wrapped résumé line, 2026-08-29.
    .replace(/(?<=\p{L})-\s*(?=\p{L})/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Where an evidence quote stops matching the source — the debuggable half of
 * a rejection. Binary search over prefix lengths (presence of a prefix is
 * monotone), then report the fork: what the quote says next, and what the
 * source says next at the last place they agreed.
 *
 * Thirteen rejections logged as SPAN_NOT_FOUNDx13 cost a debugging session;
 * one rejection that says 'diverges after "…npm, PyPI, " — the quote
 * continues "and crates.io" but the source continues "crates.io"' is its own
 * diagnosis: that one is the model quoting from memory and drifting a word,
 * which is exactly what INV-5 rejects on purpose.
 */
export function divergenceOf(haystack, needle) {
  let lo = 0;
  let hi = needle.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (haystack.includes(needle.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  // A prefix shorter than the evidence floor is coincidence, not a foothold
  // ("d" matches practically any source). Report it as no match at all.
  if (lo < MIN_EVIDENCE_CHARS) {
    return { matchedChars: lo, detail: "no prefix of the quote occurs in the source" };
  }
  const at = haystack.indexOf(needle.slice(0, lo));
  return {
    matchedChars: lo,
    agreed: needle.slice(Math.max(0, lo - 30), lo),
    quoteContinues: needle.slice(lo, lo + 30),
    sourceContinues: haystack.slice(at + lo, at + lo + 30),
    detail: `diverges after "…${needle.slice(Math.max(0, lo - 30), lo)}" — the quote continues `
      + `"${needle.slice(lo, lo + 30)}" but the source continues "${haystack.slice(at + lo, at + lo + 30)}"`,
  };
}

/**
 * Verify one proposed fact against the source it cites.
 *
 * @param {object} fact  as emitted in a PROFILE_FACTS block
 * @param {Map<string,string>|Record<string,string>} sources  source id -> text
 * @param {object} [options]
 * @param {number} [options.minEvidenceChars] claim-specific evidence floor
 * @returns {{field: string, value: unknown, sourceId: string, evidence: string, offset: number, explicit: boolean, confidence: string}}
 * @throws {GroundingError}
 */
export function verifyFact(fact, sources, { minEvidenceChars = MIN_EVIDENCE_CHARS } = {}) {
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
  const haystack = normaliseForGrounding(sourceText);
  const needle = normaliseForGrounding(evidence);

  if (needle.length < minEvidenceChars) {
    // THE VALUE, QUOTED AS ITSELF. A skills-list résumé discloses capability
    // "Rust", and the shortest honest quote of it IS the word — no
    // twelve-character span supports "Rust" better than "Rust". Observed
    // live as EVIDENCE_TOO_SHORTx4 eating Rust, Python, AI & ML and Founder
    // off a real résumé, 2026-08-29. You cannot paraphrase a single word
    // into itself, so shortness here is not the invention the floor guards
    // against — but a short string finds footholds everywhere, so it must
    // occur as a WHOLE WORD: "Rust" does not ground against "trust". A
    // short quote that is NOT simply the value stays rejected: a truncated
    // fragment supports nothing.
    if (needle !== normaliseForGrounding(String(fact.value ?? ""))) {
      throw new GroundingError("EVIDENCE_TOO_SHORT",
        `Evidence must be at least ${minEvidenceChars} characters`, { evidence });
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordHit = new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u",
    ).exec(haystack);
    if (!wordHit) {
      throw new GroundingError("SPAN_NOT_FOUND",
        "The cited evidence does not occur in the source as a whole word", {
          sourceId: fact.source_id,
          evidence: evidence.slice(0, 120),
        });
    }
    return Object.freeze({
      field: fact.field,
      value: fact.value,
      sourceId: fact.source_id,
      evidence,
      offset: wordHit.index,
      explicit: fact.explicit === true,
      confidence: fact.confidence ?? "unstated",
    });
  }

  const offset = haystack.indexOf(needle);
  if (offset === -1) {
    const divergence = divergenceOf(haystack, needle);
    throw new GroundingError("SPAN_NOT_FOUND",
      `The cited evidence does not occur in the source (${divergence.detail})`, {
        sourceId: fact.source_id,
        evidence: evidence.slice(0, 120),
        divergence,
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
