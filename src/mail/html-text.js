/**
 * HTML mail to readable text.
 *
 * THE BUG THIS EXISTS FOR, AND IT WAS ONE LINE OF MINE
 *
 *   text: parsed.text ?? parsed.html ?? ""
 *
 * When a message has no plain-text part — most HTML mail, most Gmail, every
 * newsletter — that fallback handed the observer RAW HTML SOURCE as the
 * evidence text. Tags, inline CSS, tracking pixels, base64 data URIs, the lot.
 *
 * Two catastrophes in one line:
 *
 * 1. SIZE. A short HTML email is routinely 40-200KB of markup for two sentences
 *    of prose. That prompt cannot prefill inside the upstream's 90-second
 *    silence window, so it is killed before the model speaks — identically on
 *    every retry, because the input never changes. Permanent failure disguised
 *    as a slow model.
 *
 * 2. MEANING. Even when it fit, we were asking a model to find who is hiring
 *    whom inside `<td style="padding:0;mso-line-height-rule:exactly">`, and to
 *    quote it VERBATIM. The honest answer to that prompt is no claims at all,
 *    which is exactly what the graph filled up with.
 *
 * Mark's diagnosis was one line: "it was working before the graph, now it cant
 * understand shit." Right on both counts. The old desk ran mail through the
 * parser registry; the graph's ingest path was new code, and this was the hole
 * in it.
 *
 * WHY WRITE IT RATHER THAN ADD A DEPENDENCY
 *
 * The requirement is narrow and the correctness bar is specific: the output is
 * the string that span verification checks quotes against. A general-purpose
 * converter that prettifies — smart quotes, collapsed ellipses, unicode
 * dashes — silently breaks grounding, because the model quotes what it was
 * shown and the verifier compares against what we stored. Both sides read THIS
 * function's output, so the only requirement is that it be stable and plain.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No prettifying. No markdown. No link rewriting into "text (url)" — a URL
 * pasted into the middle of a sentence would then appear in a quote that exists
 * in no source. Block elements become newlines, inline elements disappear,
 * entities decode to their plain characters, and that is all.
 */

/** Elements whose CONTENT is not prose and must not survive at all. */
const DROP_CONTENT = /<(script|style|head|title|noscript|template|svg|math)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements that imply a line break where they close (or self-close). */
const BLOCK = new Set([
  "p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "table", "thead", "tbody", "section", "article",
  "header", "footer", "ul", "ol", "dl", "dt", "dd", "hr", "figure",
]);

/**
 * The named entities that actually turn up in mail. Deliberately short: a full
 * table invites unicode normalisation, and every character this function invents
 * is a character a verbatim quote can fail on.
 */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", trade: "™", reg: "®", copy: "©",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä",
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+[0-9]*);/gi, (whole, name) => {
      const value = ENTITIES[name.toLowerCase()];
      // An entity we do not know is left EXACTLY as it was. Guessing would put a
      // character in the source that the sender never wrote.
      return value === undefined ? whole : value;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Convert an HTML mail body to plain text.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (typeof html !== "string" || html.length === 0) return "";

  let text = html;

  // Content that is not prose, gone entirely — including its text, which is the
  // whole point for <style>: CSS rules are the bulk of a marketing email.
  text = text.replace(DROP_CONTENT, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Tags to nothing, except block-level ones which become line breaks. Done in
  // one pass so a tag's name decides its replacement.
  text = text.replace(/<\/?([a-z0-9]+)\b[^>]*>/gi, (_, tag) =>
    (BLOCK.has(tag.toLowerCase()) ? "\n" : ""));

  // Any stray tag-like remnant (malformed markup is normal in mail).
  text = text.replace(/<[^>]*>/g, "");

  text = decodeEntities(text);

  // Whitespace. Collapse runs of spaces and tabs, trim each line, and cap blank
  // runs at one — HTML mail is mostly indentation, and it multiplies the token
  // count without adding a word.
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * The body of a parsed message, as text.
 *
 * Prefers the plain-text part, because it is what the sender's client generated
 * from the same content and needs no interpretation. Falls back to CONVERTED
 * html — never to raw html.
 *
 * @param {{text?: string, html?: string}} parsed
 */
export function messageBodyText(parsed) {
  const plain = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (plain.length > 0) return parsed.text;

  const converted = htmlToText(parsed?.html);
  return converted.length > 0 ? converted : "";
}
