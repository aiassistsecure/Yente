/**
 * PDF and DOCX, against real files.
 *
 * `test-support/documents/` holds an actual reportlab-generated PDF (two pages)
 * and an actual OOXML DOCX. A synthetic byte string would test the parser's
 * error path and nothing else.
 *
 * The assertion that matters is not "text came out" — it is that the text that
 * came out still GROUNDS. An extractor that mangles spacing produces a document
 * whose own sentences fail verifyFact, and every honest citation from it is
 * then rejected as invented.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerDocumentParsers } from "../src/extract/parsers.js";
import { extractText, clearExtractors, supportedTypes } from "../src/extract/sources.js";
import { verifyFact } from "../src/extract/spans.js";

const doc = (name) => readFileSync(fileURLToPath(new URL(`../test-support/documents/${name}`, import.meta.url)));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test.before(() => registerDocumentParsers());
test.after(() => clearExtractors());

test("both document types are registered into the §5.3 seam", () => {
  const types = supportedTypes();
  assert.ok(types.includes("application/pdf"));
  assert.ok(types.includes(DOCX));
});

test("a real PDF extracts its text, across a page boundary", async () => {
  const { text, mimeType } = await extractText({
    content: doc("resume.pdf"),
    mimeType: "application/pdf",
    filename: "resume.pdf",
  });
  assert.equal(mimeType, "application/pdf");
  assert.match(text, /Bob Ferrand/);
  assert.match(text, /Led infrastructure operations for a B2B SaaS platform/);
  // Page two.
  assert.match(text, /Looking for an operating role where I own infrastructure/);

  // pdf.js returns text items with no reliable line breaks. A naive join runs
  // the last line of one page into the first of the next and manufactures a
  // sentence the document never contained — which would then "ground".
  assert.doesNotMatch(text, /two years\.Looking for/);
});

test("text extracted from a PDF still grounds — the property that matters", async () => {
  const { text } = await extractText({ content: doc("resume.pdf"), mimeType: "application/pdf" });
  const sources = { src_1: text };

  // An honest citation from the extracted text must verify.
  assert.doesNotThrow(() =>
    verifyFact(
      {
        field: "professional.capabilities",
        value: "infrastructure_operations",
        source_id: "src_1",
        evidence: "Led infrastructure operations for a B2B SaaS platform",
        explicit: true,
      },
      sources,
    ),
  );

  // And an invention still must not.
  assert.throws(
    () =>
      verifyFact(
        { field: "professional.capabilities", value: "fundraising", source_id: "src_1", evidence: "Raised a Series B of forty million", explicit: true },
        sources,
      ),
    (error) => error.code === "SPAN_NOT_FOUND",
  );
});

test("a real DOCX extracts its text", async () => {
  const { text } = await extractText({ content: doc("resume.docx"), mimeType: DOCX, filename: "resume.docx" });
  assert.match(text, /Dana Reyes/);
  assert.match(text, /VP Operations, Orlando FL\./);
  assert.match(text, /340 person carrier network/);
  assert.doesNotMatch(text, /<w:/, "no XML leaked into the text");
});

test("legacy .doc is refused by name rather than failing as corruption", async () => {
  // .doc is OLE compound storage, not OOXML. Letting the DOCX parser try it
  // produces a zip error that reads like a damaged file, which sends the member
  // off to re-export something that was never wrong.
  await assert.rejects(
    extractText({ content: Buffer.from("\xD0\xCF\x11\xE0fake", "latin1"), mimeType: "application/msword", filename: "cv.doc" }),
    (error) => {
      assert.match(error.message, /Legacy \.doc is not supported/);
      return true;
    },
  );
});

test("a PDF that is really an image yields no text and is refused", async () => {
  // §5.3 names this case: a scan parses fine and returns nothing. Accepting it
  // would create a member with an empty profile and no way to know why.
  const empty = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>",
    "latin1",
  );
  await assert.rejects(
    extractText({ content: empty, mimeType: "application/pdf", filename: "scan.pdf" }),
    (error) => ["NO_EXTRACTABLE_TEXT", "UNSUPPORTED_TYPE"].includes(error.code),
  );
});
