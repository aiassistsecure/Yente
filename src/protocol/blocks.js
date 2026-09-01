import {
  extractBlocks,
  extractTaggedBlocks,
  wrap,
  wrapNamed,
} from "sentinel-blocks";

export const BLOCK_TAGS = Object.freeze({
  TASK: "TASK",
  SOURCE: "SOURCE",
  CONTROLLED_VOCABULARY: "CONTROLLED_VOCABULARY",
  PROFILE: "PROFILE",
  PROFILE_FACTS: "PROFILE_FACTS",
  /**
   * The observation envelope of the graph redesign — the observer's only
   * output. Registered here because KNOWN_TAGS is closed: an unregistered tag
   * throws UNKNOWN_TAG, which is what stops a model inventing a block we would
   * then have to decide how to interpret.
   */
  OBSERVATIONS: "OBSERVATIONS",
  /**
   * The multi-block protocol of obs_v2.
   *
   * MANIFEST declares how many blocks follow, which turns two things from
   * guesswork into arithmetic: the reader knows exactly when the answer is
   * complete (so it can stop reading rather than waiting out the rest of a
   * generation), and a stream cut short is DETECTABLE instead of arriving as a
   * partial envelope that happens to parse. The second is the one that matters —
   * a truncated answer we believe is complete writes a partial graph and says
   * nothing.
   *
   * One block per claim group, so a malformed INTENTS block costs the intents
   * and not the entities.
   */
  MANIFEST: "MANIFEST",
  ENTITIES: "ENTITIES",
  INTENTS: "INTENTS",
  RELATIONSHIPS: "RELATIONSHIPS",
  OPPORTUNITIES: "OPPORTUNITIES",
  DISCLOSURES: "DISCLOSURES",
  /**
   * Yente's graded, positive-only read of a resume: what this person is a
   * good/strong/exceptional candidate FOR. See PROPOSAL_KINDS in schema.js.
   */
  PROPOSALS: "PROPOSALS",
  /**
   * Sent only on a retry after the model looped. Names what happened and points
   * back at the task — see createWakeUpPrompt in intelligence/prompt.js.
   */
  WAKE_UP: "WAKE_UP",
  /**
   * The model's own reasoning trace from the attempt that stalled, shown back
   * to it on the wake-up so it resumes instead of re-deriving. Sentinel
   * tokens are stripped at insertion; the thoughts are context, never rules.
   */
  PREVIOUS_THOUGHTS: "PREVIOUS_THOUGHTS",
  /**
   * Claims harvested from that reasoning and already through the schema and
   * grounding gates, numbered for one-at-a-time review on the wake-up turn.
   */
  EXTRACTED_CLAIMS: "EXTRACTED_CLAIMS",
  /**
   * The graded-rounds protocol: after an answer verifies PARTLY, the next
   * turn opens with RESULTS (what was accepted, what was not) and lists each
   * rejected claim in REJECTED_CLAIMS with the parser's own reason, so the
   * model can fix a citation the source really supports — or drop it, since
   * silence is free. The rejected lines are re-serialized through the wire
   * form (single-line JSON, sentinels stripped), never echoed raw.
   */
  RESULTS: "RESULTS",
  REJECTED_CLAIMS: "REJECTED_CLAIMS",
  MISSING_FIELDS: "MISSING_FIELDS",
  INTERVIEW_PLAN: "INTERVIEW_PLAN",
  MATCH: "MATCH",
  POLICY: "POLICY",
  META: "META",
  /**
   * Parser feedback on a retry: what the previous reply broke, in OUR words —
   * the deterministic error code and message, never the model's own failed
   * output echoed back (which is derived from untrusted sources and could
   * carry forged block boundaries). Registered because KNOWN_TAGS is closed.
   */
  REPAIR: "REPAIR",
  SUBJECT: "SUBJECT",
  EMAIL_TEXT: "EMAIL_TEXT",
  OUTPUT_CONTRACT: "OUTPUT_CONTRACT",
});

const KNOWN_TAGS = new Set(Object.values(BLOCK_TAGS));
const SAFE_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENTINEL_TOKEN_PATTERN =
  /<<<(?:END|[A-Za-z][A-Za-z0-9_]*(?:[ \t]+[^>\r\n]*)?)>>>/i;
const BLOCK_FRAME_SOURCE =
  String.raw`<<<([A-Za-z][A-Za-z0-9_]*)(?:[ \t]+([^>\r\n]+))?>>>\r?\n([\s\S]*?)\r?\n<<<END>>>`;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function requireKnownTag(tag) {
  if (!KNOWN_TAGS.has(tag)) {
    throw new ProtocolError("UNKNOWN_TAG", `Unknown Sentinel Block tag: ${tag}`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolError("EMPTY_CONTENT", `${label} must be non-empty text`);
  }
  if (SENTINEL_TOKEN_PATTERN.test(value)) {
    throw new ProtocolError(
      "NESTED_SENTINEL",
      `${label} contains a reserved Sentinel Block delimiter`,
    );
  }
  return value;
}

function scanBlockFrames(artifact) {
  if (typeof artifact !== "string" || artifact.trim() === "") {
    throw new ProtocolError("EMPTY_ARTIFACT", "Sentinel artifact must be non-empty text");
  }

  const frames = [];
  const pattern = new RegExp(BLOCK_FRAME_SOURCE, "g");
  let cursor = 0;
  let match;

  while ((match = pattern.exec(artifact)) !== null) {
    if (artifact.slice(cursor, match.index).trim() !== "") {
      throw new ProtocolError(
        "OUTSIDE_BLOCK_TEXT",
        "Sentinel artifact contains text outside canonical blocks",
      );
    }

    const tag = match[1];
    const argument = (match[2] ?? "").trim();
    if (tag !== tag.toUpperCase()) {
      throw new ProtocolError("NON_CANONICAL_TAG", `Block tag must be uppercase: ${tag}`);
    }
    if (argument && !SAFE_ARGUMENT.test(argument)) {
      throw new ProtocolError(
        "INVALID_ARGUMENT",
        `${tag} block argument is not a safe identifier`,
      );
    }
    if (SENTINEL_TOKEN_PATTERN.test(match[3])) {
      throw new ProtocolError(
        "NESTED_SENTINEL",
        `${tag} contains a nested Sentinel Block delimiter`,
      );
    }

    frames.push(Object.freeze({ tag, argument }));
    cursor = pattern.lastIndex;
  }

  if (frames.length === 0) {
    throw new ProtocolError("MALFORMED_ARTIFACT", "No canonical Sentinel Blocks found");
  }
  if (artifact.slice(cursor).trim() !== "") {
    throw new ProtocolError(
      "OUTSIDE_BLOCK_TEXT",
      "Sentinel artifact contains text outside canonical blocks",
    );
  }
  return frames;
}

/**
 * Strip markdown code-fence marker LINES from a model's reply, when — and
 * only when — the reply actually contains a canonical sentinel block.
 *
 * Observed live, 2026-08-31: a model emitted a PERFECT envelope wearing
 * cosmetic markdown — ```json above <<<OBSERVATIONS>>>, ``` below <<<END>>>
 * — and the strict outside-text scan killed a finished, correct answer
 * three attempts in a row. A fence marker is a chat-formatting reflex, not
 * content: the sentinel frame is the answer's real boundary, and it is
 * unambiguous with or without the wrapper.
 *
 * Deliberately narrow:
 *   - fence marker LINES only (``` or ```lang alone on a line) — prose
 *     outside blocks still fails OUTSIDE_BLOCK_TEXT, because commentary is
 *     ambiguity and the retry's REPAIR note handles it;
 *   - only applied when a sentinel opener is present — text with no blocks
 *     keeps its fences and fails MALFORMED_ARTIFACT exactly as before;
 *   - a TOLERANCE FOR READING model output, exported for the reading edges
 *     (readEnvelope, the desk extractor). Never applied to artifacts we
 *     build: our prompts do not wear fences, and a SOURCE block's own
 *     content is extracted from the ORIGINAL text, not this copy.
 */
export function stripFenceLines(artifact) {
  const text = String(artifact ?? "");
  if (!/<<<[A-Za-z][A-Za-z0-9_]*(?:[ \t][^>\r\n]*)?>>>/.test(text)) return text;
  return text
    .split("\n")
    .filter((line) => !/^\s*`{3,}[A-Za-z0-9_-]*\s*$/.test(line))
    .join("\n");
}

export function textBlock(tag, content) {
  requireKnownTag(tag);
  return wrap(tag, requireText(content, tag));
}

export function namedTextBlock(tag, argument, content) {
  requireKnownTag(tag);
  if (!SAFE_ARGUMENT.test(argument)) {
    throw new ProtocolError(
      "INVALID_ARGUMENT",
      `${tag} block argument is not a safe identifier`,
    );
  }
  return wrapNamed(tag, argument, requireText(content, `${tag} ${argument}`));
}

export function jsonBlock(tag, value) {
  requireKnownTag(tag);
  if (value === undefined) {
    throw new ProtocolError("UNDEFINED_JSON", `${tag} cannot encode undefined`);
  }
  return wrap(tag, requireText(JSON.stringify(value, null, 2), tag));
}

export function composeBlocks(...blocks) {
  if (blocks.length === 0) {
    throw new ProtocolError("NO_BLOCKS", "At least one Sentinel Block is required");
  }
  const artifact = `${blocks.join("\n\n")}\n`;
  scanBlockFrames(artifact);
  return artifact;
}

export function blockTags(artifact) {
  return scanBlockFrames(artifact).map(({ tag }) => tag);
}

export function assertOnlyBlockTags(artifact, allowedTags) {
  const allowed = new Set(allowedTags);
  for (const { tag } of scanBlockFrames(artifact)) {
    if (!allowed.has(tag)) {
      throw new ProtocolError("UNEXPECTED_TAG", `Unexpected Sentinel Block: ${tag}`);
    }
  }
}

export function requireSingleBlock(artifact, tag) {
  requireKnownTag(tag);
  scanBlockFrames(artifact);
  const blocks = extractBlocks(artifact, tag);
  if (blocks.length !== 1) {
    throw new ProtocolError(
      "BLOCK_CARDINALITY",
      `Expected exactly one ${tag} block; received ${blocks.length}`,
    );
  }
  return requireText(blocks[0], tag).trim();
}

export function parseJsonBlock(artifact, tag) {
  const content = requireSingleBlock(artifact, tag);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new ProtocolError("INVALID_JSON", `${tag} contains invalid JSON: ${error.message}`);
  }
}

export function parseNamedTextBlocks(artifact, tag) {
  requireKnownTag(tag);
  const frames = scanBlockFrames(artifact).filter((frame) => frame.tag === tag);
  if (frames.some((frame) => frame.argument === "")) {
    throw new ProtocolError("MISSING_ARGUMENT", `${tag} requires a block argument`);
  }
  return extractTaggedBlocks(artifact, tag).map(({ arg, content }) => ({
    argument: arg,
    content: requireText(content, `${tag} ${arg}`).trim(),
  }));
}

export function createEmailArtifact({ meta, subject, text }) {
  const artifact = composeBlocks(
    jsonBlock(BLOCK_TAGS.META, meta),
    textBlock(BLOCK_TAGS.SUBJECT, subject),
    textBlock(BLOCK_TAGS.EMAIL_TEXT, text),
  );
  parseEmailArtifact(artifact);
  return artifact;
}

export function parseEmailArtifact(artifact) {
  assertOnlyBlockTags(artifact, [
    BLOCK_TAGS.META,
    BLOCK_TAGS.SUBJECT,
    BLOCK_TAGS.EMAIL_TEXT,
  ]);
  if (scanBlockFrames(artifact).some((frame) => frame.argument !== "")) {
    throw new ProtocolError(
      "UNEXPECTED_ARGUMENT",
      "Email artifact blocks cannot carry arguments",
    );
  }

  const meta = parseJsonBlock(artifact, BLOCK_TAGS.META);
  const subject = requireSingleBlock(artifact, BLOCK_TAGS.SUBJECT);
  const text = requireSingleBlock(artifact, BLOCK_TAGS.EMAIL_TEXT);

  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new ProtocolError("INVALID_META", "META must be a JSON object");
  }
  if (typeof meta.template !== "string" || !Array.isArray(meta.facts_used)) {
    throw new ProtocolError(
      "INVALID_META",
      "META requires a template string and facts_used array",
    );
  }
  if (/\r|\n/.test(subject) || subject.length > 200) {
    throw new ProtocolError(
      "INVALID_SUBJECT",
      "SUBJECT must be one line and no more than 200 characters",
    );
  }
  if (text.length > 20_000) {
    throw new ProtocolError("EMAIL_TOO_LONG", "EMAIL_TEXT exceeds 20,000 characters");
  }

  return Object.freeze({ meta: Object.freeze(meta), subject, text });
}

export function createPromptArtifact(blocks) {
  const rendered = blocks.map((entry) => {
    if (entry.argument !== undefined) {
      return namedTextBlock(entry.tag, entry.argument, entry.content);
    }
    if (entry.json !== undefined) {
      return jsonBlock(entry.tag, entry.json);
    }
    return textBlock(entry.tag, entry.content);
  });
  return composeBlocks(...rendered);
}
