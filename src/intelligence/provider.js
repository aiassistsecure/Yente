/**
 * IntelligenceProvider — the seam between Yente's graph and whatever interprets
 * evidence for it.
 *
 * WHY THIS EXISTS WHEN src/llm/ ALREADY DOES
 *
 * `src/llm/client.js` is a TRANSPORT abstraction: it hides SSE framing, two
 * deadlines, abort handling and upstream error events behind `complete()`, and
 * it returns text. Text is the wrong currency for the graph pipeline. Every
 * caller that wants observations would otherwise repeat: build the prompt,
 * parse the block, validate the shape, verify the spans, decide what a transient
 * failure means. That repetition is where the last set of bugs came from — the
 * qualification call that existed and was never made, the vocabulary that
 * drifted between three files.
 *
 * So this is a BELIEF abstraction. In: bounded evidence. Out: a validated,
 * span-verified envelope with provenance attached. The graph pipeline depends on
 * this interface and never on Muse, PIN, or an HTTP shape.
 *
 *   IntelligenceProvider
 *       observe({ sources, context, signal }) -> ObservationResult
 *       describe()                            -> { provider, model, schemaVersion }
 *
 *   ObservationResult
 *       { envelope, verified, rejected, discrepancies, provenance, failures,
 *         cached, attempts }
 *
 * WHAT THE PROVIDER DELIBERATELY DOES NOT DO
 *
 * It does not touch the store, resolve identities, or mutate the graph. It
 * cannot: nothing is injected into it that could. `observe` is a function from
 * evidence to proposed beliefs, and the deterministic runtime decides what to do
 * with them. That is the brief's boundary, enforced by what this module can
 * reach rather than by what it promises.
 *
 * THE CACHE IS PART OF THE CONTRACT, NOT AN OPTIMISATION
 *
 * The cache key is (content hash, provider, model, schema version, prompt
 * version). Two consequences, both intended:
 *
 *   - Identical evidence is never re-interpreted, so a mailbox resync or a
 *     restart mid-batch costs nothing. Combined with idempotent ingestion, the
 *     whole pipeline becomes safely replayable.
 *   - Bumping the schema or the prompt invalidates cached inferences BY
 *     CONSTRUCTION. "Re-analyse everything from obs_v1 under obs_v2 without
 *     re-ingesting the mailbox" is then a query over provenance, not a
 *     migration, and nobody has to remember to clear anything.
 */

import { digest } from "../store/keys.js";
import { isTransient, ModelErrorCode } from "../llm/client.js";
import {
  ProtocolError, parseJsonBlock, requireSingleBlock, stripFenceLines, textBlock, BLOCK_TAGS,
} from "../protocol/blocks.js";
import { verifyFact } from "../extract/spans.js";
import { createObservationPrompt, createResultsPrompt, createWakeUpPrompt, OBSERVER_SYSTEM } from "./prompt.js";
import { manifestStop, readManifestBlocks } from "./manifest.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  SchemaError,
  validateEnvelope,
  claimsForVerification,
  claimCount,
  CLAIM_GROUPS,
} from "./schema.js";

/**
 * Bump when the prompt's WORDING changes materially. Separate from the schema
 * version because the two move independently: a reworded task with the same
 * envelope shape still produces different beliefs, and a cache that ignored
 * that would serve stale interpretations forever.
 */
// v13: the whole-letter change (#74). Not a wording edit — the SHAPE of what
// a message job reads changed (its attachments now ride along as SOURCE
// blocks), so every envelope produced under v12 understood half a letter.
// Bumping here is what makes the boot requeue re-read them whole, once,
// automatically — the same lever the version exists for.
// v14: intent is inferred from a career's SHAPE (founder -> investment for
// their company; employee -> employment in the evidenced fields), explicit:
// false, capped confidence — and never about the document itself. Mark's
// direction, verbatim in spirit: "if a resume speaks loudly about tech work,
// we can infer the intent of the submitter."
// v16: proposals — Yente's graded, positive-only read of a resume ("strong
// candidate for Rust backend roles", "good candidate for investment in their
// venture"). The bump is the retroactive lever: the boot requeue re-reads
// every letter under v16 once, so EVERY participant who ever sent a resume
// gets proposals, not just the ones who arrive after the deploy.
// v17: graded rounds + quote-the-item + short source ids all land together.
// The bump is again the retroactive lever: every letter whose cached envelope
// carries historical rejects (hash typos, drifted skills-line quotes) gets
// re-read once under the protocol that would have saved those claims.
export const PROMPT_VERSION = "obs_prompt_v17";

/** Default attempts. Transient failures are retried; deterministic ones are not. */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export class IntelligenceError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "IntelligenceError";
    this.code = code;
    this.meta = meta;
  }
}

/**
 * The cache key. Pure, and exported because a reprocessing tool needs to
 * compute it without constructing a provider.
 *
 * Sources are hashed in a canonical order with an explicit separator, so
 * `[{id:"a",text:"xy"}]` and `[{id:"ax",text:"y"}]` cannot collide.
 */
export function inferenceKey({
  sources, provider, model, schemaVersion, promptVersion,
  context = null, providedRefs = null,
}) {
  const canonical = [...sources]
    .map((source) => `${source.id}${source.text}`)
    .sort()
    .join("");
  return digest([
    provider, model, schemaVersion, promptVersion,
    context ? JSON.stringify(context, Object.keys(context).sort()) : "",
    // Part of the key: the same evidence under a different ref contract is a
    // different inference — an envelope produced when "sender" was a given
    // ref does not mean the same thing as one produced without it.
    providedRefs ? [...providedRefs].sort().join(",") : "",
    canonical,
  ].join(""));
}

/**
 * Source-id aliases that remain unambiguous.
 *
 * Muse repeatedly copied a SOURCE id while dropping only the transport prefix:
 * `message:6e2b...` became `6e2b...`. The evidence quote was exact, but every
 * claim then failed UNKNOWN_SOURCE and a nine-minute completion became 0 claims.
 * Accept that deterministic shorthand only when it maps to exactly one source;
 * an invented or ambiguous id still has nowhere to land.
 */
export function sourceAliases(sources) {
  const aliases = new Map();
  const ambiguous = new Set();
  const add = (alias, canonical) => {
    if (!alias) return;
    const held = aliases.get(alias);
    if (held && held !== canonical) {
      aliases.delete(alias);
      ambiguous.add(alias);
      return;
    }
    if (!ambiguous.has(alias)) aliases.set(alias, canonical);
  };

  for (const source of sources ?? []) {
    const canonical = String(source.id);
    add(canonical, canonical);
    const colon = canonical.indexOf(":");
    if (colon >= 0) add(canonical.slice(colon + 1), canonical);
    const short = shortSourceId(canonical);
    if (short !== canonical) {
      add(short, canonical);
      add(short.slice(colon + 1), canonical);
    }
  }
  return aliases;
}

/**
 * The id a MODEL should be asked to copy.
 *
 * A source id is kind + sha256 — 64 hex characters the model must retype on
 * every claim line. gpt-oss copied them perfectly; GLM-4-32B drifted ONE hex
 * digit mid-hash (…0aa0e9a45cc… became …0aa0e9a42cc…) and every claim in the
 * run died UNKNOWN_SOURCE, 2026-08-31. The full hash's job is collision
 * resistance in the store; the model only ever needs enough of it to name one
 * SOURCE block unambiguously. Twelve hex characters is 48 bits — and ~25
 * fewer output tokens per claim line, twenty-nine times per résumé.
 */
export function shortSourceId(id) {
  const canonical = String(id);
  const colon = canonical.indexOf(":");
  if (colon < 0) return canonical;
  const tail = canonical.slice(colon + 1);
  return /^[0-9a-f]{16,}$/i.test(tail)
    ? canonical.slice(0, colon + 1) + tail.slice(0, 12)
    : canonical;
}

/**
 * The sources as the model should SEE them: short ids where shortening stays
 * unambiguous, canonical ids where it would collide. Everything downstream of
 * canonicalizeSourceIds still runs on canonical ids — this is presentation.
 */
export function displaySourceIds(sources) {
  const counts = new Map();
  for (const source of sources ?? []) {
    const short = shortSourceId(source.id);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return (sources ?? []).map((source) => {
    const short = shortSourceId(source.id);
    return { ...source, id: counts.get(short) === 1 ? short : String(source.id) };
  });
}

/**
 * A cited id that is ALMOST a canonical id — same length, hamming distance
 * at most 2 — is a transcription slip, not an invention: two real sha256
 * hashes differ in roughly half of their 64 characters, so a candidate
 * within 2 of one canonical id cannot also be within 2 of another unless
 * the ids were pathological to begin with. Resolve the slip only when the
 * match is unique; anything further away stays UNKNOWN_SOURCE, because a
 * looser tolerance would be guessing which document the model meant.
 */
function nearestCanonical(id, aliases) {
  const candidate = String(id);
  let found = null;
  for (const canonical of new Set(aliases.values())) {
    if (canonical.length !== candidate.length) continue;
    let distance = 0;
    for (let i = 0; i < canonical.length && distance <= 2; i += 1) {
      if (canonical[i] !== candidate[i]) distance += 1;
    }
    if (distance > 2) continue;
    if (found !== null && found !== canonical) return null;
    found = canonical;
  }
  return found;
}

/** Rewrite accepted aliases to the canonical id before schema and span checks. */
export function canonicalizeSourceIds(raw, aliases) {
  if (!raw || typeof raw !== "object" || !aliases) return raw;
  const copy = structuredClone(raw);
  for (const group of CLAIM_GROUPS) {
    if (!Array.isArray(copy[group])) continue;
    for (const claim of copy[group]) {
      if (!claim || typeof claim !== "object") continue;
      const field = claim.source_id !== undefined ? "source_id"
        : claim.sourceId !== undefined ? "sourceId" : null;
      if (!field) continue;
      const canonical = aliases.get(String(claim[field]))
        ?? nearestCanonical(claim[field], aliases);
      if (canonical) claim[field] = canonical;
    }
  }
  if (Array.isArray(copy.evidence_refs)) {
    copy.evidence_refs = copy.evidence_refs.map((id) =>
      aliases.get(String(id)) ?? nearestCanonical(id, aliases) ?? id);
  }
  return copy;
}

/**
 * Read the envelope out of whatever the model actually sent.
 *
 * WHY THIS IS TOLERANT WHEN THE PROTOCOL IS STRICT
 *
 * The sentinel block exists to stop UNTRUSTED INPUT from forging a boundary:
 * blocks.js refuses to build a prompt whose content carries a delimiter, so a
 * document cannot close its own SOURCE block and open a fake one. That property
 * is about what we SEND, and it is untouched by anything here.
 *
 * Requiring the delimiters on the way BACK bought nothing and cost a great deal.
 * Measured on gemma4:26b through the PIN gateway: three attempts, 190 seconds,
 * two of them thrown away as MALFORMED_ARTIFACT — for a model that had produced
 * a perfectly good envelope and simply hadn't wrapped it in our markers. The
 * same evidence, the same six grounded claims, at three times the cost.
 *
 * And the gateway rewrites the stream. It strips a reasoning channel before we
 * see it (~99 tokens on a request whose visible answer was the word "OK"), so
 * insisting the reply arrive byte-exact in our frame makes us brittle to a
 * transformation happening outside our process.
 *
 * The security argument for strictness does not survive contact either. Nothing
 * downstream trusts this text: validateEnvelope drops any claim it does not
 * recognise, the schema has no verb to smuggle, and every surviving claim must
 * still quote its source. A bare JSON object gets exactly the same treatment as
 * one that arrived in a block. So we read what was sent, and let the gate do the
 * gating.
 *
 * Strict first, so a well-behaved model's output is parsed by the strict path
 * and any drift shows up in `recovered`.
 */
/** The line discriminator -> envelope group. Closed on purpose. */
const LINE_GROUPS = Object.freeze({
  entity: "entities",
  intent: "intents",
  relationship: "relationships",
  disclosure: "disclosures",
  proposal: "proposals",
});

/**
 * Assemble an envelope from one-claim-per-line NDJSON block content.
 *
 * WHY LINES, NOT ONE OBJECT (2026-08-28)
 *
 * A résumé extraction produced ~30 grounded claims over four minutes of
 * generation and died whole at the last character: one extra closing brace,
 * "Unexpected non-whitespace character after JSON at position 5325". A single
 * envelope object makes the blast radius of ANY one-character slip the entire
 * answer. One claim per line makes it one line: JSON.parse per line, a line
 * that fails costs that line, and the failure is REPORTED per line rather
 * than swallowed — the gate philosophy applied to syntax.
 *
 * Returns { raw, malformedLines } — raw is null when NO line parsed, so the
 * caller can tell "a new-format answer with casualties" from "not this
 * format at all".
 */
export function envelopeFromLines(content) {
  const raw = { entities: [], intents: [], relationships: [], disclosures: [], proposals: [] };
  const malformedLines = [];
  // Verdicts on previously-banked claims, from a wake-up review turn:
  // {"claim":"approve","n":12} / {"claim":"reject","n":12}, with the bare-text
  // forms "APPROVE 12" / "REJECT 12" tolerated because a model asked to review
  // one claim at a time will sometimes answer in exactly those words. Outside
  // a review turn these are simply unused, never an error.
  const reviews = [];
  let parsedAny = false;

  const lines = String(content).split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const bareVerdict = /^(approve|reject)\s+#?(\d+)\.?$/i.exec(trimmed);
    if (bareVerdict) {
      reviews.push({ verdict: bareVerdict[1].toLowerCase(), n: Number(bareVerdict[2]) });
      parsedAny = true;
      return;
    }
    let claim;
    try {
      claim = JSON.parse(trimmed);
    } catch (error) {
      malformedLines.push({
        group: "lines", index,
        code: "INVALID_JSON_LINE",
        message: `line ${index + 1}: ${String(error?.message ?? error).slice(0, 120)}`,
      });
      return;
    }
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      malformedLines.push({
        group: "lines", index,
        code: "BAD_LINE",
        message: `line ${index + 1}: not a claim object`,
      });
      return;
    }
    const kind = String(claim.claim ?? "").toLowerCase();
    if (kind === "approve" || kind === "reject") {
      const n = Number(claim.n);
      if (Number.isInteger(n) && n > 0) {
        reviews.push({ verdict: kind, n });
        parsedAny = true;
      } else {
        malformedLines.push({
          group: "lines", index,
          code: "BAD_REVIEW",
          message: `line ${index + 1}: a ${kind} verdict needs a positive integer "n"`,
        });
      }
      return;
    }
    const group = LINE_GROUPS[kind];
    if (!group) {
      malformedLines.push({
        group: "lines", index,
        code: "UNKNOWN_CLAIM_KIND",
        message: `line ${index + 1}: "claim" must be one of ${Object.keys(LINE_GROUPS).join(", ")}, `
          + `got ${claim.claim ?? "(missing)"}`,
      });
      return;
    }
    parsedAny = true;
    const { claim: _discriminator, ...rest } = claim;
    raw[group].push(rest);
  });

  // A reply that is ONLY verdicts is a complete, valid answer: the model
  // reviewed the bank and found nothing missing. raw must not come back null
  // for it, or the reader would call a finished review INVALID_JSON.
  return { raw: parsedAny ? raw : null, malformedLines, reviews };
}

/**
 * Salvage the complete claim lines a dying transport already delivered.
 *
 * 2026-08-28: eleven minutes of generation streamed dozens of complete,
 * individually-parseable claim lines, then the hop between the operator and
 * the gateway failed ("error decoding response body") — and every one of
 * those lines was discarded, to be re-paid in full on retry.
 *
 * One claim per line makes salvage SAFE where it previously was not: a
 * complete line is a finished claim, judged by the same schema and grounding
 * gates as any other. Two rules keep this honest:
 *
 *   1. A salvaged result is marked `partial: true` and is NEVER cached — a
 *      partial answer must never satisfy a replay. The caller keeps the job
 *      open and retries; the graph's content-keyed append makes the overlap
 *      between salvage and retry free instead of duplicated.
 *   2. Salvage never invents completion: no <<<END>>> arrived, so nothing
 *      here claims the message was fully understood. The lines are stored
 *      because they are true; the job stays open because it is unfinished.
 */
export function salvageLines(partialText) {
  if (typeof partialText !== "string") return null;
  const opener = partialText.lastIndexOf("<<<OBSERVATIONS>>>");
  if (opener === -1) return null;
  let content = partialText.slice(opener + "<<<OBSERVATIONS>>>".length);
  const end = content.indexOf("<<<END>>>");
  if (end !== -1) content = content.slice(0, end);
  // The final line is where the stream died; if it is incomplete it fails
  // JSON.parse and is counted malformed by envelopeFromLines — which is
  // correct, not noise: the count says how much the cut cost.
  return envelopeFromLines(content);
}

/**
 * Harvest the claims a model already produced INSIDE ITS OWN THINKING.
 *
 * 2026-08-29: ten minutes of reasoning over one résumé produced ~48 numbered,
 * complete claim lines — "42. {"claim":"disclosure",...}" — and then slid into
 * the compliance checklist it looped on. The loop detector fired correctly;
 * the eviction then discarded a finished harvest, because salvage only knew
 * how to read the content channel and only past an OBSERVATIONS opener.
 *
 * Thinking is prose with claims embedded in it, so this reader inverts the
 * burden: it keeps ONLY lines that look like claim objects (optionally behind
 * a list marker) and never counts the surrounding prose as malformed — prose
 * in thinking is what thinking is, not an error. Every kept line then faces
 * the same schema and grounding gates as any answer; nothing enters the graph
 * on the strength of having been thought.
 */
export function salvageThinking(reasoningText) {
  if (typeof reasoningText !== "string" || reasoningText.length === 0) return null;
  const candidates = [];
  for (const line of reasoningText.split("\n")) {
    // "42. {...}" / "- {...}" / "{...}" — strip the marker, keep the object.
    const stripped = line.trim().replace(/^[-*]?\s*\d*[.)]?\s*/, "");
    if (stripped.startsWith("{") && stripped.includes('"claim"')) {
      candidates.push(stripped);
    }
  }
  if (candidates.length === 0) return null;
  return envelopeFromLines(candidates.join("\n"));
}

/**
 * One claim, one row — the identity that makes two claims "the same claim".
 *
 * Everything semantic participates; evidence and confidence do not, because
 * the same fact quoted from two places in a résumé, or asserted at 0.9 and
 * again at 0.95, is one fact. First occurrence wins, which also means a
 * banked claim beats its own re-derivation.
 */
export function claimKey(group, claim) {
  const semantic = {};
  for (const key of Object.keys(claim).sort()) {
    if (key === "evidence" || key === "confidence" || key === "explicit") continue;
    semantic[key] = claim[key];
  }
  return `${group}:${JSON.stringify(semantic)}`;
}

const GROUP_DISCRIMINATOR = Object.freeze({
  entities: "entity",
  intents: "intent",
  relationships: "relationship",
  disclosures: "disclosure",
  proposals: "proposal",
});

/**
 * A validated claim, serialized back to the wire shape the model writes —
 * snake_case fields behind the `claim` discriminator, sentinels stripped so a
 * quoted string can never draw a block boundary inside a prompt.
 */
export function wireClaimLine(group, claim) {
  const wire = { claim: GROUP_DISCRIMINATOR[group] };
  for (const [key, value] of Object.entries(claim)) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    wire[snake] = typeof value === "string" ? value.replace(/<<<|>>>/g, "") : value;
  }
  return JSON.stringify(wire);
}

/** Flatten a verified envelope into bankable [{ group, claim }] entries. */
export function flattenVerified(verified) {
  const entries = [];
  for (const group of CLAIM_GROUPS) {
    for (const claim of verified?.[group] ?? []) entries.push({ group, claim });
  }
  return entries;
}

/**
 * Union of claim entries with duplicates dropped — first occurrence wins.
 * Returns the deduped entries, an envelope built from them, and the count of
 * what was dropped, because "we stored 48" and "it said 53" should reconcile
 * in a log line rather than in a debugging session.
 */
export function mergeEntries(...entryLists) {
  const seen = new Set();
  const entries = [];
  let duplicates = 0;
  for (const list of entryLists) {
    for (const entry of list) {
      const key = claimKey(entry.group, entry.claim);
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      entries.push(entry);
    }
  }
  const verified = {};
  for (const group of CLAIM_GROUPS) verified[group] = [];
  for (const { group, claim } of entries) verified[group].push(claim);
  for (const group of CLAIM_GROUPS) verified[group] = Object.freeze(verified[group]);
  verified.schemaVersion = OBSERVATION_SCHEMA_VERSION;
  return { entries, verified: Object.freeze(verified), duplicates };
}

/**
 * Apply the model's one-at-a-time review to the banked claims.
 *
 * The review protocol is REJECT-BY-NUMBER on purpose: the model never retypes
 * a claim it keeps, so a kept claim cannot mutate in transcription, and a
 * review cut short by a dying stream loses NOTHING — every claim not
 * explicitly rejected stays, because each one already passed the same schema
 * and grounding gates as any stored answer. The review is the model's
 * opportunity to drop a claim it second-guessed, not a gate its work must
 * re-clear.
 */
export function applyReviews(banked, reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return banked;
  const rejectedNumbers = new Set();
  for (const review of reviews) {
    if (review?.verdict === "reject" && Number.isInteger(review.n)) {
      rejectedNumbers.add(review.n);
    }
  }
  if (rejectedNumbers.size === 0) return banked;
  return banked.filter((_entry, index) => !rejectedNumbers.has(index + 1));
}

export function readEnvelope(rawText) {
  // A finished answer wearing markdown (```json around the sentinel block)
  // is a finished answer. Fence marker lines are dropped before any reader
  // runs; real prose outside blocks still fails, and the REPAIR retry
  // handles it. See stripFenceLines in blocks.js for the live trace.
  const text = stripFenceLines(rawText);
  // 1. THE MANIFEST PROTOCOL. Preferred, because it is the only shape in which a
  //    truncated answer is detectable rather than silently partial.
  try {
    const { raw, declared, found, malformed, missing } = readManifestBlocks(text);

    // NEVER ADVANCE ON AN INCOMPLETE ANSWER. The model said N blocks and fewer
    // arrived: something was cut off. Storing three of four groups as though the
    // message were fully understood is silent data loss, and it is exactly the
    // failure this protocol exists to make impossible. A ProtocolError is
    // transient, so the job goes back to the queue with backoff and is retried
    // until it lands whole.
    if (missing > 0) {
      throw new ProtocolError(
        "TRUNCATED_ANSWER",
        `Manifest declared ${declared} blocks; ${found.length + malformed.length} arrived `
        + `(${missing} missing). Refusing a partial graph.`,
      );
    }
    // Same reasoning, one level down: a group that arrived as unparseable JSON is
    // a group we do not have. Retry rather than store the rest as complete.
    if (malformed.length > 0) {
      throw new ProtocolError(
        "MALFORMED_BLOCK",
        `Unparseable block(s): ${malformed.map((m) => `${m.group} (${m.error})`).join("; ")}`,
      );
    }
    return { raw, recovered: null, blocks: found };
  } catch (manifestError) {
    if (manifestError instanceof ProtocolError
        && (manifestError.code === "TRUNCATED_ANSWER" || manifestError.code === "MALFORMED_BLOCK")) {
      throw manifestError;   // a real incompleteness, not a shape we failed to read
    }

    // 2. One OBSERVATIONS block. Whole-object first (the obs_v1 envelope, and
    //    the bare {} empty answer, still parse in one bite); when that fails,
    //    the canonical one-claim-per-line format — where a stray brace costs
    //    the line it sits on, not the four minutes of extraction around it.
    try {
      const content = requireSingleBlock(text, BLOCK_TAGS.OBSERVATIONS);

      // A SINGLE CLAIM LINE IS ITSELF VALID JSON, AND THAT WAS THE BUG.
      //
      // The reader used to try JSON.parse first and fall back to the line
      // reader only when it threw. That works for many claims — line two breaks
      // the parse — and fails silently for exactly one, because one line parses
      // cleanly as an object. `validateEnvelope` then looked for `entities` and
      // `intents` on `{"claim":"entity","ref":"sender",...}`, found no groups,
      // and reported an empty understanding.
      //
      // Observed live: every short message stored NOTHING while a résumé
      // producing 63 lines extracted perfectly. Same model, same prompt, same
      // minute. The difference was the claim COUNT, and the fingerprint in the
      // log was `recovered=single_block` on every dropped one.
      //
      // So the question is not "does this parse" but "is this an ENVELOPE or a
      // CLAIM", and the two are distinguishable by shape.
      const looksLikeClaim = (value) => value
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof value.claim === "string"
        && !CLAIM_GROUPS.some((group) => Array.isArray(value[group]));

      try {
        const parsed = JSON.parse(content);
        if (!looksLikeClaim(parsed)) {
          return { raw: parsed, recovered: "single_block", blocks: null };
        }
        // Fall through to the line reader, which knows how to route a claim's
        // `claim` discriminator into its group.
      } catch { /* not one object; the line reader is the right path */ }

      const { raw, malformedLines, reviews } = envelopeFromLines(content);
      if (raw) {
        return { raw, recovered: null, blocks: null, malformedLines, reviews };
      }
      throw new ProtocolError("INVALID_JSON",
        `OBSERVATIONS contains neither a JSON object nor parseable claim lines`);
    } catch (blockError) {
      // 3. A fenced code block — the most common deviation, and the one the
      //    contract explicitly asks against, which models still do.
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
      if (fenced) {
        try {
          return { raw: JSON.parse(fenced[1]), recovered: "markdown_fence", blocks: null };
        } catch { /* fall through */ }
      }

      // 4. A bare object, possibly with prose around it.
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first !== -1 && last > first) {
        try {
          return {
            raw: JSON.parse(text.slice(first, last + 1)),
            recovered: "bare_json", blocks: null,
          };
        } catch { /* fall through */ }
      }

      throw blockError;
    }
  }
}

/**
 * The one field per claim group that carries its substance, used to satisfy
 * verifyFact's `value` requirement with something meaningful. A claim group with
 * no substantive value would be a claim group worth deleting.
 */
function claimValue(group, claim) {
  switch (group) {
    case "entities": return claim.name;
    case "intents": return claim.object;
    case "relationships": return claim.predicate;
    // Added with the group itself on 2026-08-28 — this switch was never
    // updated when disclosures replaced opportunities, so every disclosure
    // fell through to `claim.text` (a field disclosures do not have), failed
    // verifyFact's value requirement as INCOMPLETE_FACT, and died at the gate
    // no matter how good its quote was. Found by the one-claim-per-line test,
    // not by the log — the rejection code was buried in a count.
    case "disclosures": return claim.value;
    // The TARGET is the substance a proposal must ground: "backend
    // engineering roles" has to trace to quoted evidence the same way a
    // disclosure's value does. The grade is judgment; the target is fact.
    case "proposals": return claim.target;
    case "opportunities": return claim.summary;
    default: return claim.text;
  }
}

/**
 * Stage two: does each claim's quote actually appear in the source it cites?
 *
 * Reuses `verifyFact` unchanged. That function was written for profile facts and
 * makes exactly one decision — is this excerpt present in this source text after
 * whitespace and unicode-punctuation normalisation — which is the same decision
 * an observation needs. Reusing it means there is ONE grounding rule in the
 * codebase, so it cannot be strict in one place and lax in another.
 */
function verifyEnvelope(envelope, sourceTextById) {
  const verified = {};
  for (const group of CLAIM_GROUPS) verified[group] = [];
  const rejected = [];

  for (const { group, index, claim } of claimsForVerification(envelope)) {
    try {
      // verifyFact's contract is snake_case `source_id` and a non-empty
      // `value`, and it takes the whole source map so it can name UNKNOWN_SOURCE
      // itself. Adapting to it here — rather than widening it to a second
      // shape — keeps one grounding rule in the codebase.
      verifyFact(
        {
          field: `${group}[${index}]`,
          value: claimValue(group, claim),
          source_id: claim.sourceId,
          evidence: claim.evidence,
        },
        sourceTextById,
        // Identity evidence is often legitimately short: "I’m Mark", "Bob",
        // "Acme". Keep the ordinary 12-character floor for substantive intents,
        // relationships and notes; an exact entity name only needs four.
        { minEvidenceChars: group === "entities" ? 4 : undefined },
      );
      verified[group].push(claim);
    } catch (error) {
      rejected.push({
        group, index,
        code: error?.code ?? "UNGROUNDED",
        message: String(error?.message ?? error),
      });
    }
  }

  for (const group of CLAIM_GROUPS) verified[group] = Object.freeze(verified[group]);
  verified.schemaVersion = envelope.schemaVersion;
  return { verified: Object.freeze(verified), rejected };
}

/**
 * Build a provider over an existing model client.
 *
 * @param {object} input
 * @param {{complete: Function}} input.client   from createModelClient
 * @param {string} input.provider               e.g. "pin"
 * @param {string} input.model                  e.g. "muse-local:latest"
 * @param {{get: Function, put: Function}} [input.cache]  content-hash cache
 * @param {Function} [input.now]                injectable clock
 * @param {Function} [input.sleep]              injectable delay, for tests
 */
export function createIntelligenceProvider({
  client,
  provider,
  model,
  cache = null,
  // Optional model-specific prefill string, sent as a trailing assistant turn.
  // A string rather than a flag because the tokens differ per model family,
  // and trying variants from the shell beats shipping a table of guesses.
  //
  // v8 shipped "<think></think>" as the DEFAULT — force-closing an empty
  // reasoning channel so muse-local would stop deliberating for minutes per
  // message. v9 removes that default: the constitution now closes the forks
  // the model was deliberating OVER, which attacks the cause instead of
  // gagging the symptom — and the gag was actively harmful on non-reasoning
  // extractors, which echoed the foreign <think></think> tokens back into
  // their content stream as fake empty thoughts. A model that wants to think
  // now can; the reasoning channel is telemetry the operator watches, and the
  // envelope gate is unaffected either way. A model that needs the old
  // behaviour gets it back with YENTE_LLM_PREFILL="<think></think>" —
  // deliberately, per model, from the shell.
  prefill = process.env.YENTE_LLM_PREFILL ?? null,
  attempts: maxAttempts = DEFAULT_ATTEMPTS,
  // Graded rounds: how many times a PARTLY-verified answer earns a results
  // turn — accepted claims banked, rejects shown with the parser's reasons —
  // before we settle for what verified. 0 disables the protocol.
  rounds: maxRounds = process.env.YENTE_LLM_MAX_ROUNDS === undefined
      || process.env.YENTE_LLM_MAX_ROUNDS === ""
    ? 2
    : Math.max(0, Number(process.env.YENTE_LLM_MAX_ROUNDS) || 0),
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  // Optional live telemetry. The transport still returns only validated text;
  // this observer lets the operator see whether Muse is reasoning, answering,
  // or repeatedly producing a shape the parser rejects.
  onStream = null,
  now = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // In-flight inference per content hash — see the fence note in observe().
  const inFlightObservations = new Map();

  if (!client || typeof client.complete !== "function") {
    throw new TypeError("createIntelligenceProvider requires a model client");
  }
  if (!provider || !model) {
    throw new TypeError("createIntelligenceProvider requires provider and model names");
  }

  function describe() {
    return Object.freeze({
      provider,
      model,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
    });
  }

  async function observe({
    sources, context = null, providedRefs = null, signal,
    // Per-call model, for the message/document split. Part of the cache key
    // and the provenance below, so two models over the same evidence are two
    // inferences — not one poisoned entry — and every observation records
    // which model actually produced it. That is what makes a model swap
    // measurable instead of a vibe.
    model: modelOverride = null,
  } = {}) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new TypeError("observe requires at least one source");
    }

    const effectiveModel = modelOverride || model;
    const contentHash = inferenceKey({
      sources, provider, model: effectiveModel, context,
      providedRefs: providedRefs ? [...providedRefs].sort() : null,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
    });

    if (cache) {
      const hit = await cache.get(contentHash);
      if (hit) return Object.freeze({ ...hit, cached: true });
    }

    // ONE INFERENCE PER CONTENT, AT A TIME. The cache dedupes across time;
    // this dedupes across NOW: two drain workers holding jobs that resolve
    // to the same letter (a covering message and a historical alias, a
    // requeue racing a retry) share one inference instead of stacking two
    // full-résumé generations onto one GPU. Same discipline as the netrows
    // credit dedup in enrich.js, for the same reason — the expensive call is
    // the thing to fence, and a promise is the fence.
    const running = inFlightObservations.get(contentHash);
    if (running) return running;
    const settled = (async () => {

    const sourceTextById = new Map(sources.map((source) => [source.id, source.text]));
    const knownSourceIds = new Set(sourceTextById.keys());
    const aliases = sourceAliases(sources);
    // The model reads and cites SHORT ids; verification runs on canonical
    // ones. canonicalizeSourceIds maps the citation back before the schema
    // and grounding gates, so nothing downstream sees the abbreviation.
    const promptSources = displaySourceIds(sources);
    // Stable identity for stream telemetry. Concurrency means several attempt=1
    // streams coexist; attempt alone cannot keep their token buffers separate.
    const evidence = sources.map((source) => source.id).sort().join(",");
    const basePrompt = createObservationPrompt({ sources: promptSources, context });
    // Set when an attempt aborts on a reasoning loop; consumed by the next one.
    let wokenFrom = null;
    // Claims harvested from a failed attempt's own thinking — already through
    // the same schema and grounding gates as any answer. They seed the wake-up
    // (numbered, for one-at-a-time review) and they survive exhaustion, so an
    // aborted stream never costs finished work again.
    let banked = [];
    // The most recent attempt's reasoning trace, for harvest and for showing
    // the model its own thoughts when it is woken.
    let lastReasoningText = null;

    const failures = [];
    let attempt = 0;
    // Graded rounds — Mark's protocol, 2026-08-31: "make the model submit
    // claims more frequently and show it the results. 200 OK: 9 accepted,
    // 2 rejected: evidence <12 chars." A PARTLY-verified answer earns a
    // results turn: accepted claims bank (numbered, never resent), rejects
    // come back with the parser's own reasons, the model fixes what the
    // source supports and drops what it does not. Each round extends the
    // attempt budget by one, so a round is never paid for with a retry.
    let roundsUsed = 0;
    // The rejected-claims feedback for the next results turn, or null.
    let resultsFeedback = null;
    // A claim rejected TWICE with the same reason is not going to fix
    // itself — it stops being relitigated. Silence is free.
    const rejectSeen = new Map();
    let lastText = null;
    // The full accumulated stream from the most recent mid-generation
    // failure, held OUTSIDE the failure records so result.failures stays
    // log-sized. Used for salvage at exhaustion.
    let lastPartialText = null;
    // Set after a shape failure, sent with the NEXT attempt. "Models fix shape
    // when told" was this file's own justification for retrying — and until
    // 2026-08-28 the retry sent the byte-identical prompt, telling the model
    // nothing. Feedback is OUR deterministic parser message only: the model's
    // failed output is derived from untrusted sources and echoing it back
    // could smuggle forged block boundaries into the prompt, so it stays out.
    let repairNote = null;

    // Harvest claims out of a failed attempt's reasoning trace and add the
    // survivors to the bank. Same gates as any answer — envelopeFromLines for
    // shape, validateEnvelope for schema and referential integrity,
    // verifyEnvelope for verbatim grounding — then deduped against what is
    // already banked. Thinking earns nothing by being thinking.
    const bankThinking = (current, reasoningText) => {
      const harvest = salvageThinking(reasoningText);
      if (!harvest?.raw) return current;
      const canonical = canonicalizeSourceIds(harvest.raw, aliases);
      const { envelope } = validateEnvelope(canonical, { knownSourceIds, providedRefs });
      const { verified } = verifyEnvelope(envelope, sourceTextById);
      const { entries } = mergeEntries(current, flattenVerified(verified));
      return entries;
    };

    while (attempt < maxAttempts + roundsUsed) {
      attempt += 1;
      try {
        // A retry after a loop does NOT resend the prompt that caused it. It
        // names the loop, quotes the line, and points back at the task — the
        // rules stay in the system message rather than being re-supplied, since
        // rehearsing the rules is what the model was stuck doing.
        const prompt = wokenFrom
          ? createWakeUpPrompt({
              sources: promptSources, repeatedLine: wokenFrom, context,
              thoughts: lastReasoningText,
              extracted: banked.map(({ group, claim }) => wireClaimLine(group, claim)),
            })
          : resultsFeedback
            ? createResultsPrompt({
                sources: promptSources, context,
                accepted: banked.map(({ group, claim }) => wireClaimLine(group, claim)),
                rejected: resultsFeedback,
              })
            : basePrompt;

        const completion = await client.complete({
          prompt: repairNote ? `${prompt}\n\n${repairNote}` : prompt,
          system: OBSERVER_SYSTEM, prefill, signal,
          // The client spreads its request last, so a per-call model wins.
          ...(modelOverride ? { model: modelOverride } : {}),
          onReasoning: (delta) => onStream?.({
            phase: "reasoning", delta, attempt, evidence, contentHash,
          }),
          onToken: (delta) => onStream?.({
            phase: "content", delta, attempt, evidence, contentHash,
          }),
          // Stop the moment the manifest's declared block count is satisfied.
          // Everything after that is a model that did not stop when asked, and
          // on a reasoning model through PIN that is tens of seconds a message.
          stopWhen: manifestStop,
        });
        lastText = completion.text;

        // Shape, then meaning. A parse or schema failure is the model answering
        // in the wrong form, which is worth another attempt; an ungrounded claim
        // is the model inventing, which is not.
        // THE GATEWAY'S OWN BUDGET APOLOGY IS NOT A MALFORMED ANSWER. When a
        // reasoning model spends its whole budget thinking, AiAS substitutes a
        // literal placeholder — "_(the model spent its whole token budget
        // reasoning and produced no answer — try raising max tokens)_" — and
        // that string used to reach the parser, fail as MALFORMED_ARTIFACT,
        // and burn a retry on a diagnosis that misnames the problem. Name it:
        // the fix is budget (YENTE_LLM_MAX_TOKENS, or a lighter model), not
        // shape, and the error says so.
        if (/spent its whole token budget/i.test(completion.text)) {
          throw new IntelligenceError("TOKEN_BUDGET_UPSTREAM",
            "the model reasoned through its entire token budget and never "
            + "answered — raise YENTE_LLM_MAX_TOKENS or use a lighter model "
            + "for this evidence kind (YENTE_MODEL_MESSAGE/_DOCUMENT)",
            { transient: true });
        }

        const { raw: receivedRaw, recovered, malformedLines = [], reviews = [] } =
          readEnvelope(completion.text);
        const raw = canonicalizeSourceIds(receivedRaw, aliases);
        // On a review turn the model is told NOT to retype claims from the
        // bank — so a new claim about a banked person legitimately references
        // a ref that is declared only in EXTRACTED_CLAIMS. Those refs count
        // as declared, exactly as providedRefs do: the entity exists, we are
        // holding it.
        const effectiveRefs = banked.length === 0 ? providedRefs
          : new Set([
            ...(providedRefs ?? []),
            ...banked.filter((entry) => entry.group === "entities")
              .map((entry) => entry.claim.ref),
          ]);
        const { envelope, rejected: schemaRejected, discrepancies } =
          validateEnvelope(raw, { knownSourceIds, providedRefs: effectiveRefs });
        const { verified: attemptVerified, rejected: groundingRejected } =
          verifyEnvelope(envelope, sourceTextById);

        // The banked harvest joins the answer — minus whatever the model
        // rejected in its one-at-a-time review — and the union is deduped, so
        // a claim that exists in the bank AND in the fresh reply is stored
        // once. mergeEntries also self-dedupes an ordinary non-wake-up reply,
        // which is the cheap general fix for a model that states one fact
        // twice.
        const kept = applyReviews(banked, reviews);
        const { entries: acceptedEntries, verified, duplicates } =
          mergeEntries(kept, flattenVerified(attemptVerified));

        // THE GRADED ROUND. This answer verified partly: bank what held,
        // grade what did not, and spend one extended attempt showing the
        // model its results — the parser's own codes and messages, which
        // were written to be read (divergenceOf exists for this reader).
        // A reject seen twice with the same grade is dropped from the
        // conversation instead of relitigated; when every reject has been
        // graded twice, the loop settles for what verified.
        resultsFeedback = null;
        if (roundsUsed < maxRounds
            && (schemaRejected.length > 0 || groundingRejected.length > 0)) {
          const feedback = [];
          const grade = (line, code, message) => {
            const key = `${code}|${line}`;
            const seen = (rejectSeen.get(key) ?? 0) + 1;
            rejectSeen.set(key, seen);
            if (seen === 1) feedback.push({ line, code, message });
          };
          for (const row of schemaRejected) {
            const claim = raw?.[row.group]?.[row.index];
            if (!claim || typeof claim !== "object") continue;
            grade(JSON.stringify(claim).replace(/<<<|>>>/g, "").slice(0, 600),
              row.code, row.message);
          }
          for (const row of groundingRejected) {
            const claim = envelope?.[row.group]?.[row.index];
            if (!claim) continue;
            grade(wireClaimLine(row.group, claim).slice(0, 600),
              row.code, row.message);
          }
          if (feedback.length > 0) {
            banked = acceptedEntries;
            resultsFeedback = feedback;
            roundsUsed += 1;
            onStream?.({
              phase: "graded", attempt, evidence, contentHash,
              accepted: acceptedEntries.length, rejected: feedback.length,
              round: roundsUsed,
            });
            continue;
          }
        }

        const result = {
          envelope,
          verified,
          duplicates,
          harvested: kept.length,
          rejected: Object.freeze([...malformedLines, ...schemaRejected, ...groundingRejected]),
          discrepancies,
          failures: Object.freeze(failures),
          attempts: attempt,
          rounds: roundsUsed,
          cached: false,
          // Which reader got it. Null means the strict block path; anything else
          // is drift worth watching, because a model that stops using the frame
          // may be drifting in other ways too.
          recovered,
          provenance: Object.freeze({
            contentHash,
            provider,
            model: effectiveModel,
            schemaVersion: OBSERVATION_SCHEMA_VERSION,
            promptVersion: PROMPT_VERSION,
            inferenceTimestamp: now(),
            elapsedMs: completion.elapsedMs ?? null,
          }),
        };

        // CACHE THE OUTCOME — BUT NOT AN EMPTY ONE.
        //
        // This reverses an earlier decision in this file, and the earlier
        // reasoning was sound as far as it went: "this evidence supports no
        // claims" is a real and expensive answer, so re-deriving it on every
        // replay is waste.
        //
        // What it missed is that we cannot tell that answer apart from a model
        // failing. A real trace: NuExtract3 reasoned correctly about a message —
        // identified the sender as a PERSON, correctly refused to invent a
        // disclosure field for "iPhone", correctly found no intent — and then
        // concluded that the right output was `{}`, discarding the entity it had
        // just found. It cited a rule ("the single line {} is a good answer")
        // that appears NOWHERE in our prompt. It invented the rule and obeyed it.
        //
        // Cached, that becomes permanent. The cache is keyed on the content
        // hash, not on the model — so an empty answer from a bad model would be
        // served to every better model we swap in afterwards, and the swap would
        // look like it changed nothing. Since replacing the model is exactly the
        // plan, caching empties would silently poison the experiment.
        //
        // An empty answer is cheap to re-derive and expensive to be wrong about.
        // So: keep the result, do not persist it.
        // claimCount, not `verified.length` — `verified` is an object of claim
        // groups, so `.length` is undefined and the guard would have cached
        // NOTHING. The existing test for cache hits caught that immediately,
        // which is the argument for having it.
        if (cache && claimCount(verified) > 0) await cache.put(contentHash, result);
        return Object.freeze(result);
      } catch (error) {
        const retryable =
          isTransient(error) ||
          error instanceof ProtocolError ||
          error instanceof SchemaError ||
          // Budget exhaustion IS worth one more try — reasoning length varies
          // run to run, and the retry may land under the cap. The error still
          // names the real fix (raise the cap or split the models) so a
          // pattern of these reads as configuration, not flakiness.
          error?.code === "TOKEN_BUDGET_UPSTREAM";

        // Carry the loop forward so the NEXT attempt is a wake-up rather than a
        // repeat of the prompt that caused it.
        wokenFrom = error?.code === ModelErrorCode.REASONING_LOOP
          ? (error?.meta?.repeatedLine ?? "(unrecorded)")
          : null;

        const failure = {
          code: error?.code ?? "OBSERVE_FAILED",
          message: String(error?.message ?? error),
          transient: retryable,
          attempt,
          // WHAT THE MODEL ACTUALLY SENT. Reporting "malformed" while discarding
          // the malformed thing is the same mistake as logging EMPTY_COMPLETION
          // while the gateway's own explanation sat unread in the stream. If a
          // reply cannot be parsed, the reply is the evidence.
          sample: typeof lastText === "string" ? lastText.slice(0, 1_200) : null,
        };
        failures.push(failure);
        if (typeof error?.meta?.partialText === "string" && error.meta.partialText.length > 0) {
          lastPartialText = error.meta.partialText;
        }
        if (typeof error?.meta?.reasoningText === "string" && error.meta.reasoningText.length > 0) {
          lastReasoningText = error.meta.reasoningText;
        }
        // EAGER HARVEST. The attempt failed; its thinking may not have. Every
        // claim the model already wrote inside its reasoning goes through the
        // same schema and grounding gates NOW, and what survives is banked —
        // shown to the model for review on the wake-up, kept at exhaustion.
        // Ten minutes of deliberation over a résumé is never paid for twice.
        banked = bankThinking(banked, lastReasoningText);
        onStream?.({ phase: "rejected", ...failure, evidence, contentHash });

        // Tell the next attempt what broke. Sentinel tokens are stripped from
        // the message defensively — a REPAIR block must never be able to draw
        // block boundaries of its own, whatever an error message quotes.
        if (error instanceof ProtocolError || error instanceof SchemaError) {
          const said = `${error.code}: ${String(error.message)}`
            .replace(/<<<|>>>/g, "")
            .slice(0, 400);
          repairNote = textBlock(BLOCK_TAGS.REPAIR, [
            `Your previous reply could not be used. The parser said: ${said}.`,
            "Re-emit the complete OBSERVATIONS block from the beginning,",
            "one claim per line, exactly as the examples show. Do not",
            "apologise, do not explain — just the corrected block.",
          ].join(" "));
        }

        if (!retryable || attempt >= maxAttempts) {
          // Last resort before reporting failure: keep what the dying stream
          // already delivered whole. Same gates as any answer; never cached;
          // the caller sees partial: true and keeps the job open.
          const salvage = lastPartialText ? salvageLines(lastPartialText) : null;
          {
            let envelope = null;
            let salvageRejected = [];
            let contentEntries = [];
            if (salvage?.raw) {
              const canonical = canonicalizeSourceIds(salvage.raw, aliases);
              const validated = validateEnvelope(canonical, { knownSourceIds, providedRefs });
              envelope = validated.envelope;
              const groundChecked = verifyEnvelope(validated.envelope, sourceTextById);
              contentEntries = flattenVerified(groundChecked.verified);
              salvageRejected = [
                ...salvage.malformedLines, ...validated.rejected, ...groundChecked.rejected,
              ];
            }
            // The bank joins the content salvage: a loop abort and a dying
            // transport lose work the same way, and both harvests are already
            // through the gates. Content lines win ties — they were the
            // model's ANSWER, the bank was its thinking.
            const { verified, duplicates } = mergeEntries(contentEntries,
              banked.map((entry) => ({ group: entry.group, claim: entry.claim })));
            if (claimCount(verified) > 0) {
              return Object.freeze({
                envelope,
                verified,
                duplicates,
                harvested: banked.length,
                rejected: Object.freeze(salvageRejected),
                discrepancies: Object.freeze([]),
                failures: Object.freeze(failures),
                attempts: attempt,
                cached: false,
                partial: true,
                recovered: contentEntries.length > 0 ? "salvaged_lines" : "salvaged_thinking",
                provenance: Object.freeze({
                  contentHash,
                  provider,
                  model,
                  schemaVersion: OBSERVATION_SCHEMA_VERSION,
                  promptVersion: PROMPT_VERSION,
                  inferenceTimestamp: now(),
                  elapsedMs: null,
                }),
              });
            }
          }
          throw new IntelligenceError(
            error?.code ?? "OBSERVE_FAILED",
            `Observation failed after ${attempt} attempt(s): ${error?.message ?? error}`,
            { failures, contentHash, provider, model },
          );
        }

        // Linear backoff. The failure that motivated this was a 90-second
        // operator silence: retrying instantly burned every attempt inside 7
        // seconds and reported silence, when waiting was the entire remedy.
        await sleep(retryDelayMs * attempt);
      }
    }

      /* c8 ignore next */
      throw new IntelligenceError("OBSERVE_FAILED", "exhausted attempts", { failures });
    })();

    inFlightObservations.set(contentHash, settled);
    try {
      return await settled;
    } finally {
      inFlightObservations.delete(contentHash);
    }
  }

  return Object.freeze({ observe, describe });
}

/**
 * The configured provider, from the environment.
 *
 * TWO MODEL VARS, AND ONLY TWO — Mark, 2026-08-31: "clean up the various env
 * vars we have for models and just use those 2." There were three names for
 * the same knob (YENTE_MODEL, YENTE_LLM_MODEL, and the split pair), which is
 * how a box ends up serving a model nobody remembers choosing. Now:
 *
 *   YENTE_MODEL_DOCUMENT  the heavyweight read — résumés, attachments.
 *                         Also the client's base model.
 *   YENTE_MODEL_MESSAGE   short bodies; defaults to the document model,
 *                         so an unsplit config is one variable.
 *
 * The retired names are not honoured as silent fallbacks: a stale config
 * gets a boot-time error that says exactly what to set, not a quiet third
 * alias that resurrects the sprawl.
 */
export function resolveIntelligenceConfig(env = process.env) {
  for (const legacy of ["YENTE_MODEL", "YENTE_LLM_MODEL"]) {
    if (env[legacy]) {
      throw new TypeError(
        `${legacy} is retired — the model vars are YENTE_MODEL_DOCUMENT `
        + "(the heavyweight read: résumés and attachments; also the default "
        + "for everything) and YENTE_MODEL_MESSAGE (short bodies; optional, "
        + `defaults to the document model). Move "${env[legacy]}" to the seat `
        + "it belongs in and remove the old variable.");
    }
  }
  // THE SPLIT FOLLOWS THE WORK, measured on one live run: a short message
  // took 1m1s of deliberation to decide whether to attach an email address
  // to one entity, while the résumé pass in the same minute produced 63
  // typed claims. Messages are short bodies whose right answer is usually
  // zero or one claim; documents reward a model that thinks.
  const documentModel = env.YENTE_MODEL_DOCUMENT || "muse-local:latest";
  return Object.freeze({
    provider: env.YENTE_INTELLIGENCE_PROVIDER || env.YENTE_LLM_PROVIDER || "pin",
    model: documentModel,
    messageModel: env.YENTE_MODEL_MESSAGE || documentModel,
    documentModel,
  });
}
