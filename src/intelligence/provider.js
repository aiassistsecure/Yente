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
import { isTransient } from "../llm/client.js";
import { ProtocolError, parseJsonBlock, BLOCK_TAGS } from "../protocol/blocks.js";
import { verifyFact } from "../extract/spans.js";
import { createObservationPrompt, OBSERVER_SYSTEM } from "./prompt.js";
import { manifestStop, readManifestBlocks } from "./manifest.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  SchemaError,
  validateEnvelope,
  claimsForVerification,
  CLAIM_GROUPS,
} from "./schema.js";

/**
 * Bump when the prompt's WORDING changes materially. Separate from the schema
 * version because the two move independently: a reworded task with the same
 * envelope shape still produces different beliefs, and a cache that ignored
 * that would serve stale interpretations forever.
 */
export const PROMPT_VERSION = "obs_prompt_v8";

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
export function inferenceKey({ sources, provider, model, schemaVersion, promptVersion, context = null }) {
  const canonical = [...sources]
    .map((source) => `${source.id}${source.text}`)
    .sort()
    .join("");
  return digest([
    provider, model, schemaVersion, promptVersion,
    context ? JSON.stringify(context, Object.keys(context).sort()) : "",
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
  }
  return aliases;
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
      const canonical = aliases.get(String(claim[field]));
      if (canonical) claim[field] = canonical;
    }
  }
  if (Array.isArray(copy.evidence_refs)) {
    copy.evidence_refs = copy.evidence_refs.map((id) => aliases.get(String(id)) ?? id);
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
export function readEnvelope(text) {
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

    // 2. The obs_v1 single envelope, so a run mid-upgrade still works.
    try {
      return {
        raw: parseJsonBlock(text, BLOCK_TAGS.OBSERVATIONS),
        recovered: "single_block",
        blocks: null,
      };
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
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  // Optional live telemetry. The transport still returns only validated text;
  // this observer lets the operator see whether Muse is reasoning, answering,
  // or repeatedly producing a shape the parser rejects.
  onStream = null,
  now = () => new Date().toISOString(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
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

  async function observe({ sources, context = null, signal } = {}) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new TypeError("observe requires at least one source");
    }

    const contentHash = inferenceKey({
      sources, provider, model, context,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
    });

    if (cache) {
      const hit = await cache.get(contentHash);
      if (hit) return Object.freeze({ ...hit, cached: true });
    }

    const sourceTextById = new Map(sources.map((source) => [source.id, source.text]));
    const knownSourceIds = new Set(sourceTextById.keys());
    const aliases = sourceAliases(sources);
    // Stable identity for stream telemetry. Concurrency means several attempt=1
    // streams coexist; attempt alone cannot keep their token buffers separate.
    const evidence = sources.map((source) => source.id).sort().join(",");
    const prompt = createObservationPrompt({ sources, context });

    const failures = [];
    let attempt = 0;
    let lastText = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const completion = await client.complete({
          prompt, system: OBSERVER_SYSTEM, prefill, signal,
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
        const { raw: receivedRaw, recovered } = readEnvelope(completion.text);
        const raw = canonicalizeSourceIds(receivedRaw, aliases);
        const { envelope, rejected: schemaRejected, discrepancies } =
          validateEnvelope(raw, { knownSourceIds });
        const { verified, rejected: groundingRejected } =
          verifyEnvelope(envelope, sourceTextById);

        const result = {
          envelope,
          verified,
          rejected: Object.freeze([...schemaRejected, ...groundingRejected]),
          discrepancies,
          failures: Object.freeze(failures),
          attempts: attempt,
          cached: false,
          // Which reader got it. Null means the strict block path; anything else
          // is drift worth watching, because a model that stops using the frame
          // may be drifting in other ways too.
          recovered,
          provenance: Object.freeze({
            contentHash,
            provider,
            model,
            schemaVersion: OBSERVATION_SCHEMA_VERSION,
            promptVersion: PROMPT_VERSION,
            inferenceTimestamp: now(),
            elapsedMs: completion.elapsedMs ?? null,
          }),
        };

        // Cache the OUTCOME, including an empty one. "This evidence supports no
        // claims" is a real and expensive answer, and re-deriving it on every
        // replay is exactly the waste the cache exists to prevent.
        if (cache) await cache.put(contentHash, result);
        return Object.freeze(result);
      } catch (error) {
        const retryable =
          isTransient(error) ||
          error instanceof ProtocolError ||
          error instanceof SchemaError;

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
        onStream?.({ phase: "rejected", ...failure, evidence, contentHash });

        if (!retryable || attempt >= maxAttempts) {
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
  }

  return Object.freeze({ observe, describe });
}

/**
 * The configured provider, from the environment.
 *
 * `YENTE_INTELLIGENCE_PROVIDER` / `YENTE_MODEL` are the names the brief asks
 * for. The older `YENTE_LLM_*` pair is still honoured as a fallback so a box
 * configured for the current daemon keeps working across the cutover — and the
 * precedence is stated here rather than discovered later.
 */
export function resolveIntelligenceConfig(env = process.env) {
  return Object.freeze({
    provider: env.YENTE_INTELLIGENCE_PROVIDER || env.YENTE_LLM_PROVIDER || "pin",
    model: env.YENTE_MODEL || env.YENTE_LLM_MODEL || "muse-local:latest",
  });
}
