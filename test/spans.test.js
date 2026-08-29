import assert from "node:assert/strict";
import test from "node:test";

import {
  normaliseForGrounding,
  qualifyingFacts,
  factsNeedingConfirmation,
  verifyFact,
  verifyFacts,
} from "../src/extract/spans.js";
import { extractText, registerExtractor, clearExtractors, supportedTypes } from "../src/extract/sources.js";

const SOURCE = [
  "Bob Ferrand",
  "Technical operator, US remote.",
  "",
  "Led infrastructure   operations for a B2B SaaS platform serving 400 machines.",
  "Vice‑President of Platform, 2019–2023.",
].join("\n");

const sources = { src_1: SOURCE };
const fact = (over = {}) => ({
  field: "professional.capabilities",
  value: "infrastructure_operations",
  source_id: "src_1",
  evidence: "Led infrastructure operations for a B2B SaaS platform",
  explicit: true,
  ...over,
});

/* --- the two directions that matter ------------------------------------ */

test("reformatting survives grounding", () => {
  // The whole point of normalising: a model that re-wraps a line, collapses a
  // run of spaces, or reads a non-breaking hyphen out of a PDF has invented
  // nothing, and failing it would train us to loosen the check.
  for (const evidence of [
    "Led infrastructure operations for a B2B SaaS platform",
    "led infrastructure operations for a b2b saas platform",
    "Led  infrastructure\n  operations for a B2B SaaS platform",
    "Vice-President of Platform, 2019-2023.",
  ]) {
    assert.doesNotThrow(() => verifyFact(fact({ evidence }), sources), `rejected: ${evidence}`);
  }
});

test("rewording does not survive grounding — INV-5", () => {
  // A paraphrase is exactly the invented evidence the invariant exists to catch.
  for (const evidence of [
    "Ran infrastructure operations for a B2B SaaS platform",
    "Led infrastructure for a B2B SaaS company",
    "Raised a Series B of forty million dollars",
    "Led infrastructure operations for a B2C marketplace",
  ]) {
    assert.throws(
      () => verifyFact(fact({ evidence }), sources),
      (error) => error.code === "SPAN_NOT_FOUND",
      `accepted a paraphrase: ${evidence}`,
    );
  }
});

test("a citation to a source that was not supplied is caught by name", () => {
  assert.throws(() => verifyFact(fact({ source_id: "src_nope" }), sources), (error) => {
    assert.equal(error.code, "UNKNOWN_SOURCE");
    assert.deepEqual(error.meta.available, ["src_1"]);
    return true;
  });
});

test("a trivially short excerpt is not evidence", () => {
  assert.throws(() => verifyFact(fact({ evidence: "Bob" }), sources), (e) => e.code === "EVIDENCE_TOO_SHORT");
});

test("an incomplete fact is rejected before anything is compared", () => {
  for (const missing of ["field", "value", "source_id", "evidence"]) {
    assert.throws(
      () => verifyFact(fact({ [missing]: undefined }), sources),
      (error) => error.code === "INCOMPLETE_FACT",
    );
  }
});

test("a partly grounded extraction keeps what holds and reports what did not", () => {
  // §6.2 treats inferred facts as useful input to the next question, so
  // discarding a whole extraction because one span was invented would throw
  // away real evidence.
  const { verified, rejected } = verifyFacts(
    [fact(), fact({ evidence: "Raised a Series B", value: "fundraising" }), fact({ field: "professional.geographies", value: "us_remote", evidence: "Technical operator, US remote." })],
    sources,
  );
  assert.equal(verified.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].fact.value, "fundraising");
});

test("inferred facts become questions, never qualification facts — INV-3", () => {
  // Grounding proves the words are in the document. It does not prove the
  // document says what the model concluded.
  const { verified } = verifyFacts(
    [fact(), fact({ field: "professional.seniority", value: "principal", explicit: false })],
    sources,
  );
  assert.equal(qualifyingFacts(verified).length, 1);
  assert.equal(factsNeedingConfirmation(verified).length, 1);
  assert.equal(factsNeedingConfirmation(verified)[0].field, "professional.seniority");
});

test("normalisation folds formatting and nothing else", () => {
  assert.equal(normaliseForGrounding("A  B\nC"), "a b c");
  // The letter-hyphen-letter fold (2026-08-29): both sides normalise to the
  // SAME form, which is the property grounding needs — a unicode hyphen, an
  // ascii hyphen, and a PDF line-wrap hyphenation all land on one spelling.
  assert.equal(normaliseForGrounding("Vice‑President"), "vicepresident");
  assert.equal(normaliseForGrounding("Vice-President"), normaliseForGrounding("Vice‑Pres-\nident"),
    "however the typography broke the word, the normal form is one word");
  assert.equal(normaliseForGrounding("“quoted”"), '"quoted"');
  assert.notEqual(normaliseForGrounding("led operations"), normaliseForGrounding("ran operations"));
});

/* --- the attachment boundary — §5.3 ------------------------------------ */

test("plain text is accepted; a renamed binary is not", async () => {
  const { text } = await extractText({ content: "A short professional summary.", mimeType: "text/plain" });
  assert.match(text, /short professional summary/);

  // A PDF called .txt is still a PDF. Sniffing costs nothing and stops binary
  // reaching a prompt as mojibake, which is how a model "extracts" facts from
  // encoding noise.
  await assert.rejects(
    extractText({ content: Buffer.from("%PDF-1.7\n%\xE2\xE3", "latin1"), mimeType: "text/plain", filename: "cv.txt" }),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_TYPE");
      assert.equal(error.meta.sniffed, "application/pdf");
      return true;
    },
  );
});

test("an unregistered type is refused with a message a person can act on", async () => {
  await assert.rejects(
    extractText({ content: Buffer.from("%PDF-1.7 fake"), mimeType: "application/pdf", filename: "cv.pdf" }),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_TYPE");
      assert.match(error.message, /resume, LinkedIn export, portfolio, or a short written summary/);
      return true;
    },
  );
});

test("a registered extractor is used, and an empty result is still a failure", async () => {
  // A scanned PDF parses fine and yields nothing. §5.3 names that case: images
  // requiring OCR are rejected, not accepted as an empty profile.
  try {
    registerExtractor("application/pdf", () => "Extracted resume text from the PDF.");
    const { text } = await extractText({ content: Buffer.from("%PDF-1.7"), mimeType: "application/pdf" });
    assert.match(text, /Extracted resume text/);
    assert.ok(supportedTypes().includes("application/pdf"));

    registerExtractor("application/pdf", () => "   ");
    await assert.rejects(
      extractText({ content: Buffer.from("%PDF-1.7"), mimeType: "application/pdf" }),
      (error) => error.code === "NO_EXTRACTABLE_TEXT",
    );
  } finally {
    clearExtractors();
  }
});

test("empty and oversized attachments are refused", async () => {
  await assert.rejects(extractText({ content: "", mimeType: "text/plain" }), (e) => e.code === "EMPTY_SOURCE");
  await assert.rejects(
    extractText({ content: "x".repeat(2000), mimeType: "text/plain", maxBytes: 1000 }),
    (e) => e.code === "SOURCE_TOO_LARGE",
  );
});

/* --- typography is forgiven; drift is named ------------------------------- */

// The live 21:05 run: 32 claims landed and 13 died SPAN_NOT_FOUND. Reading
// the trace showed two distinct causes wearing one error code — a PDF
// extractor's line-wrap hyphenation (honest quote, typographic mismatch),
// and the model quoting from memory and drifting a word ("npm, PyPI, and
// crates.io" vs the source's "npm, PyPI, crates.io" — correctly rejected).
// The fix is likewise two-sided: fold the typography, and make every
// remaining rejection name the exact fork so the next log is its own
// diagnosis.

test("a quote wrapped by the PDF extractor's hyphenation still grounds", () => {
  const source = "Led cross-platform release engineer-\ning for npm, PyPI and crates.io targets.";
  const fact = verifyFact({
    field: "capability",
    value: "release engineering",
    source_id: "attachment:cv",
    evidence: "cross-platform release engineering for npm, PyPI and crates.io",
    explicit: true,
  }, { "attachment:cv": source });
  assert.equal(fact.field, "capability", "line-wrap hyphenation is typography, not invention");
});

test("hyphens next to digits stay content", () => {
  const source = "Employed 2023-present at Acme Corp headquarters.";
  assert.throws(() => verifyFact({
    field: "availability", value: "present", source_id: "m",
    evidence: "Employed 2023 present at Acme", explicit: true,
  }, { m: source }), /SPAN_NOT_FOUND|does not occur/,
  "a date range's hyphen is not typography — dropping it changes the text");
});

test("a drifted word still dies, and the rejection names the exact fork", () => {
  const source = "release engineering for npm, PyPI, crates.io and beyond the registries";
  try {
    verifyFact({
      field: "capability", value: "release engineering", source_id: "m",
      evidence: "release engineering for npm, PyPI, and crates.io",
      explicit: true,
    }, { m: source });
    assert.fail("the drifted quote must be rejected");
  } catch (error) {
    assert.equal(error.code, "SPAN_NOT_FOUND");
    assert.match(error.message, /diverges after/,
      "the error is its own diagnosis, not a bare code");
    assert.match(error.message, /npm, pypi,/,
      "it shows where the quote and the source last agreed");
    assert.ok(error.meta.divergence.matchedChars > 20);
    assert.match(error.meta.divergence.quoteContinues, /^and /,
      "…and names the word the model inserted");
  }
});

test("a quote with no foothold in the source says so plainly", () => {
  const source = "A completely unrelated message about gardening begonias.";
  try {
    verifyFact({
      field: "capability", value: "x", source_id: "m",
      evidence: "distributed systems in Rust", explicit: true,
    }, { m: source });
    assert.fail("must reject");
  } catch (error) {
    assert.match(error.message, /no prefix of the quote occurs/);
  }
});
