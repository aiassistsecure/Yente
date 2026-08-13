/**
 * Turning an attachment into text — SPEC v2 §5.3.
 *
 * The boundary is deliberately narrow: "The runtime does not execute macros,
 * scripts, embedded files, or external resources." So this dispatches on type
 * to a registered extractor and refuses everything else with a message a person
 * can act on, rather than reaching for a parser that will happily follow a
 * reference out of the document.
 *
 * PDF and DOCX extractors are REGISTERED, not implemented here. Both are real
 * parsers with real CVE histories, and §13 permits a focused dependency "only
 * when their slice is implemented" — so the seam exists now and the parser is
 * chosen deliberately when that slice lands, instead of being pulled in as a
 * side effect of wanting to read a resume today. Until then a PDF is rejected
 * with the same plain request for an alternate format that §5.3 already
 * mandates for an unsupported type, which is a worse product and an honest one.
 */

export class SourceError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.meta = meta;
  }
}

/** §16 item 2 is still open; this is the working default. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "message/rfc822", ""]);

/**
 * @typedef {(buffer: Buffer, meta: object) => Promise<string>|string} Extractor
 */

/** @type {Map<string, Extractor>} */
const extractors = new Map();

/**
 * Register a parser for a MIME type. The PDF and DOCX slices call this.
 * @param {string} mimeType
 * @param {Extractor} extractor
 */
export function registerExtractor(mimeType, extractor) {
  extractors.set(mimeType.toLowerCase(), extractor);
}

/** Test seam — forget registered parsers. */
export function clearExtractors() {
  extractors.clear();
}

export function supportedTypes() {
  return [...TEXT_TYPES].filter(Boolean).concat([...extractors.keys()]).sort();
}

/**
 * Extract text from one attachment.
 *
 * @param {object} attachment
 * @param {Buffer|string} attachment.content
 * @param {string} [attachment.mimeType]
 * @param {string} [attachment.filename]
 * @param {number} [attachment.maxBytes]
 * @returns {Promise<{text: string, mimeType: string, bytes: number}>}
 * @throws {SourceError}
 */
export async function extractText({ content, mimeType = "", filename = "", maxBytes = DEFAULT_MAX_BYTES }) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  const type = String(mimeType).toLowerCase().split(";")[0].trim();

  if (buffer.byteLength === 0) {
    throw new SourceError("EMPTY_SOURCE", "The attachment is empty", { filename });
  }
  if (buffer.byteLength > maxBytes) {
    throw new SourceError(
      "SOURCE_TOO_LARGE",
      `The attachment is ${Math.round(buffer.byteLength / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB`,
      { filename, bytes: buffer.byteLength },
    );
  }

  if (extractors.has(type)) {
    const text = await extractors.get(type)(buffer, { filename, mimeType: type });
    return finish(text, type, buffer, filename);
  }

  if (TEXT_TYPES.has(type)) {
    const text = buffer.toString("utf8");
    // A PDF renamed to .txt is still a PDF. Sniffing the magic bytes costs
    // nothing and stops binary reaching a prompt as mojibake, which is how a
    // model ends up "extracting" facts from encoding noise.
    if (looksBinary(buffer)) {
      throw new SourceError(
        "UNSUPPORTED_TYPE",
        "That file appears to be binary rather than text. Please send a resume, LinkedIn export, portfolio, or a short written summary.",
        { filename, sniffed: sniff(buffer) },
      );
    }
    return finish(text, type || "text/plain", buffer, filename);
  }

  throw new SourceError(
    "UNSUPPORTED_TYPE",
    `Yente cannot read ${type || "that file type"} yet. Please send a resume, LinkedIn export, portfolio, or a short written summary.`,
    { filename, mimeType: type, supported: supportedTypes() },
  );
}

function finish(text, mimeType, buffer, filename) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") {
    // A scanned PDF parses fine and yields nothing. §5.3 calls that out
    // specifically: images requiring OCR are rejected, not silently accepted as
    // an empty profile.
    throw new SourceError(
      "NO_EXTRACTABLE_TEXT",
      "That file has no readable text — it may be a scan or an image. Please send a text-based version.",
      { filename },
    );
  }
  return { text: trimmed, mimeType, bytes: buffer.byteLength };
}

const MAGIC = [
  ["%PDF-", "application/pdf"],
  ["PK", "application/zip (docx/xlsx?)"],
  ["ÐÏà", "application/msword (legacy)"],
  ["PNG", "image/png"],
  ["ÿØÿ", "image/jpeg"],
];

function sniff(buffer) {
  const head = buffer.subarray(0, 8).toString("latin1");
  return MAGIC.find(([magic]) => head.startsWith(magic))?.[1] ?? "unknown";
}

function looksBinary(buffer) {
  if (sniff(buffer) !== "unknown") return true;
  const sample = buffer.subarray(0, 1024);
  // A NUL byte in the first kilobyte is the classic text/binary tell.
  return sample.includes(0);
}
