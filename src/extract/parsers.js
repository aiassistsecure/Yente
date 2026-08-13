/**
 * PDF and DOCX parsers — the slice §5.3 promised and nothing implemented.
 *
 * These register into the extractor seam in sources.js rather than being wired
 * in directly, so the boundary stays where it was: `extractText` still refuses
 * anything it has no registered parser for, and the refusal message is still
 * the plain request for another format.
 *
 * §13 permits a focused dependency "only when their slice is implemented", and
 * this is that slice. Two libraries, both pure JavaScript, both chosen for what
 * they DON'T do:
 *
 *   unpdf   — a serverless-oriented build of pdf.js with the DOM and worker
 *             machinery stripped out. Text extraction only.
 *   mammoth — converts DOCX by walking the document XML. It ignores embedded
 *             objects rather than resolving them.
 *
 * That last property is the selection criterion, not a footnote. §5.3 says the
 * runtime "does not execute macros, scripts, embedded files, or external
 * resources", and the cheapest way to honour that is to use parsers that have
 * no code path to. A resume is an untrusted file from a stranger; the parser is
 * the largest attack surface in this system.
 */

import { registerExtractor } from "./sources.js";

/**
 * PDF text, page by page, joined with blank lines.
 *
 * Page joins matter for grounding: pdf.js returns text items with no reliable
 * line breaks, so a naive join runs the last line of one page into the first of
 * the next and produces a sentence that exists in neither. verifyFact would
 * then reject an honest citation, or — worse — accept one spanning a boundary
 * the document never had.
 */
export async function extractPdfText(buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text])
    .map((page) => String(page).replace(/[ \t]+\n/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * DOCX text.
 *
 * `extractRawText` rather than the HTML converter: the HTML path resolves
 * images and styling, and Yente wants the words. Mammoth's own warnings are
 * discarded — an unsupported style is not a reason to refuse a resume.
 */
export async function extractDocxText(buffer) {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  const { value } = await mammoth.extractRawText({ buffer });
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Register both. Called once at startup.
 *
 * Kept as an explicit call rather than an import side effect, so a deployment
 * that would rather not parse documents at all simply does not call it — and
 * gets §5.3's refusal for free rather than having to disable something.
 */
export function registerDocumentParsers() {
  registerExtractor("application/pdf", (buffer) => extractPdfText(buffer));
  registerExtractor(DOCX, (buffer) => extractDocxText(buffer));
  registerExtractor("application/msword", () => {
    // Legacy .doc is a different format entirely — OLE compound storage, not
    // OOXML. Refusing by name is clearer than letting the DOCX parser fail with
    // a zip error that reads like corruption.
    throw new Error(
      "Legacy .doc is not supported. Please save as PDF or .docx and send it again.",
    );
  });
  return [DOCX, "application/pdf"];
}
