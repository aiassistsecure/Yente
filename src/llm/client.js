/**
 * The local model adapter — SPEC v2 §11.1, §13.
 *
 * An OpenAI-compatible chat client over `fetch`, with no SDK. §13 limits the
 * domain core to Node's standard library and lets a protocol adapter add
 * dependencies "only when their slice is implemented"; a streaming HTTP client
 * is about eighty lines, and eighty lines is cheaper than a dependency whose
 * release cadence becomes ours.
 *
 * Streaming is not for the user's benefit — nobody watches Yente type. It buys
 * three operational things:
 *
 *   - a **first-token deadline** distinct from a total deadline, so a model that
 *     is loading weights is distinguishable from one that has wedged;
 *   - **incremental abort**, so a run that blows its token budget is cut off at
 *     the budget rather than after it;
 *   - **partial text on failure**, which is what makes a rejected generation
 *     diagnosable instead of just absent.
 *
 * Nothing here interprets the model's output. Everything it returns is
 * untrusted text until the protocol layer has validated it.
 */

import { createHash } from "node:crypto";

/** Thrown for transport, protocol, and budget failures. Never for content. */
export class ModelError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.meta = meta;
  }
}

export const ModelErrorCode = Object.freeze({
  HTTP_ERROR: "HTTP_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  FIRST_TOKEN_TIMEOUT: "FIRST_TOKEN_TIMEOUT",
  STREAM_TIMEOUT: "STREAM_TIMEOUT",
  TOKEN_BUDGET_EXCEEDED: "TOKEN_BUDGET_EXCEEDED",
  /**
   * The model is alive and saying the same thing over and over.
   *
   * A reasoning loop defeats every other guard here BY DESIGN: reasoning deltas
   * clear the first-token deadline and reset the stream deadline, and they are
   * never appended to `text`, so neither the character budget nor the token
   * budget sees them. Liveness is exactly what a loop is best at.
   *
   * Retryable, and deliberately so — the caller answers it by waking the model
   * up rather than by failing the job. See provider.js.
   */
  REASONING_LOOP: "REASONING_LOOP",
  EMPTY_COMPLETION: "EMPTY_COMPLETION",
  // The upstream explained itself INSIDE the stream, and we threw it away.
  //
  // A gateway can answer 200, open a text/event-stream, and then send:
  //   data: {"error":{"message":"operator produced nothing for 90s
  //          (timeout between chunks, not total duration)"}}
  //
  // An error event carries no `choices`, so the read loop below skipped it as an
  // unreadable keep-alive and the request fell through to EMPTY_COMPLETION —
  // "the model returned no content", which is true and useless. A whole session
  // went into rediscovering by experiment a sentence the gateway had already
  // written down.
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  ABORTED: "ABORTED",
});

/**
 * Worth trying again, or will it fail identically forever?
 *
 * Not cosmetic. A caller that treats these alike spends every attempt it has on
 * a transient condition, immediately, and then reports the very failure the
 * retry existed to survive — observed on the box as two EMPTY_COMPLETIONs inside
 * a single 6803ms tick.
 *
 * TRANSIENT: the same request might succeed later — a busy peer operator, a
 * stalled stream, a network blip, 429, 5xx.
 * DETERMINISTIC: the request itself is wrong — 400, an oversized prompt, a
 * malformed artifact — and repeating it unchanged is just a slower way to fail.
 */
export function isTransient(error) {
  const code = error?.code;
  if (code === ModelErrorCode.HTTP_ERROR) {
    const status = Number(error?.meta?.status ?? 0);
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return code === ModelErrorCode.NETWORK_ERROR
    || code === ModelErrorCode.FIRST_TOKEN_TIMEOUT
    || code === ModelErrorCode.STREAM_TIMEOUT
    || code === ModelErrorCode.REASONING_LOOP
    || code === ModelErrorCode.EMPTY_COMPLETION
    || code === ModelErrorCode.UPSTREAM_ERROR;
}

const DEFAULTS = Object.freeze({
  temperature: 0,
  // 2048 CHOKED THE MODEL, and it is the likeliest cause of every failure in the
  // first live run.
  //
  // Measured through PIN: muse-local spends ~2,900 tokens on reasoning that is
  // stripped before we see it. With a 2048 ceiling the model never reaches its
  // answer at all — it burns the entire budget thinking and the reply arrives
  // empty or cut mid-block. The generous budget is not extravagance; it is the
  // minimum for a reasoning model whose visible answer starts after 3,000
  // invisible tokens.
  //
  // Overridable, because the right number depends on the model and on num_ctx
  // (input plus output must fit the context window — muse-local is pinned at
  // 16384, so 8192 out leaves ample room for a long email plus an attachment).
  maxTokens: Number(process.env.YENTE_LLM_MAX_TOKENS || 8192),
  firstTokenTimeoutMs: 60_000,
  // How many times one reasoning line may repeat before we treat the stream as
  // going nowhere. Counted per DISTINCT line, so a model that cycles a list of
  // four constraints trips it on the fourth pass rather than the fourth delta.
  //
  // Not a total-repetition budget: legitimate reasoning restates things, and a
  // model working through a long attachment may echo a phrase several times
  // while genuinely progressing. What is never legitimate is the same line
  // arriving over and over with nothing new between.
  maxReasoningRepeats: Number(process.env.YENTE_LLM_MAX_REASONING_REPEATS || 4),
  // REPETITION IS LOCAL. The window of recent phrases a repeat is counted
  // against — Mark's design, from the false positive it fixes: a model
  // walking a per-claim pre-commit checklist ("do we include source_id?
  // Yes.") says the SAME sentence once per claim, legitimately, every ~9
  // lines. The old detector counted every phrase for the WHOLE stream, so a
  // structural phrase hit four lifetime occurrences by the fourth claim and
  // was called a loop while the model was preparing its final commit. A true
  // loop repeats within a few lines of itself; four hits inside a 20-phrase
  // window is going in circles, four hits spread over forty lines is a
  // methodical model. Rolling, not cleared in batches — a clear every N
  // would let a tight loop straddle the boundary and never trip.
  loopWindow: Number(process.env.YENTE_LLM_LOOP_WINDOW || 20),
  streamTimeoutMs: 300_000,
  maxCharacters: 64_000,
  // How much of the reasoning channel is retained for harvest on failure.
  // Generous by design: the observed worst case (19k tokens of deliberation
  // over one résumé) is ~76 KB, so 256 KB means the whole trace in practice.
  maxReasoningCapture: Number(process.env.YENTE_LLM_MAX_REASONING_CAPTURE || 262_144),
  // How many generations this client will run AT ONCE. Default one, because
  // the operator on the other end of PIN is one GPU running a reasoning
  // model: concurrent requests do not run in parallel there, they thrash —
  // ollama SPLITS num_ctx across its parallel slots, so three 16k requests
  // become three 5k contexts, and a résumé that fits alone stops fitting.
  // Observed as "model online, PIN queue overflowed": the drain's three
  // workers each stacked attempts onto a queue the GPU could only eat
  // serially. Raise it only for a backend that genuinely runs parallel.
  maxInflight: Number(process.env.YENTE_LLM_MAX_INFLIGHT || 1),
});

/**
 * @param {object} options
 * @param {string} options.baseUrl e.g. http://127.0.0.1:8080/v1
 * @param {string} options.model
 * @param {string} [options.apiKey] most local servers ignore it
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 */
export function createModelClient({ baseUrl, model, apiKey, fetchImpl = fetch, ...rest }) {
  if (!baseUrl) throw new TypeError("A model client requires a baseUrl");
  if (!model) throw new TypeError("A model client requires a model name");
  const settings = { ...DEFAULTS, ...rest };
  const endpoint = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;

  // The in-flight gate. A plain counter + FIFO of waiters — no dependency,
  // no fairness subtleties at the sizes involved. Every request passes
  // through, including retries, so an abort-and-retry cycle can never hold
  // more generations open than the limit allows.
  let inflight = 0;
  const waiters = [];
  const acquire = () => new Promise((resolve) => {
    if (inflight < settings.maxInflight) { inflight += 1; resolve(); return; }
    waiters.push(resolve);
  });
  const release = () => {
    const next = waiters.shift();
    if (next) { next(); return; }
    inflight -= 1;
  };

  return {
    model,
    endpoint,
    settings,

    /**
     * Run one completion to the end and return the accumulated text.
     *
     * @param {object} request
     * @param {string} request.prompt   the sentinel artifact
     * @param {string} [request.system]
     * @param {(delta: string) => void} [request.onToken]
     * @param {AbortSignal} [request.signal]
     * @returns {Promise<{text: string, finishReason: string|null, elapsedMs: number}>}
     */
    async complete(request) {
      await acquire();
      try {
        return await streamCompletion({ endpoint, model, apiKey, fetchImpl, settings, ...request });
      } finally {
        release();
      }
    },
  };
}

async function streamCompletion({
  endpoint,
  model,
  apiKey,
  fetchImpl,
  settings,
  prompt,
  system,
  prefill,
  onToken,
  // Called for each reasoning delta. Optional — the deadline is cleared whether
  // or not anybody is listening, because liveness is not a subscription.
  onReasoning,
  // Stop reading when this says the answer is complete.
  //
  // A PREDICATE, not a string, because "complete" is a protocol question and
  // this file deliberately knows nothing about the protocol. The observer passes
  // a manifest-aware stop (the model declares how many blocks it will send and
  // we count closings); a simpler caller can pass a first-delimiter check.
  //
  // Called with the accumulated text, never the delta, because a delimiter
  // routinely arrives split across chunks ("<<<E" + "ND>>>").
  stopWhen = null,
  signal,
  temperature = settings.temperature,
  maxTokens = settings.maxTokens,
}) {
  const started = Date.now();
  const controller = new AbortController();
  const abort = (reason) => controller.abort(reason);

  // The caller's signal outlives this call. A worker holds one shutdown signal
  // for the life of the process and runs thousands of completions through it,
  // so a listener that is registered per call and never removed accumulates
  // one closure per email sent — silently, because `{ once: true }` only fires
  // on abort and Node emits no warning for a signal that is never aborted.
  let releaseSignal = () => {};
  if (signal) {
    if (signal.aborted) throw new ModelError(ModelErrorCode.ABORTED, "Aborted before the request began");
    const onAbort = () => abort("caller");
    signal.addEventListener("abort", onAbort, { once: true });
    releaseSignal = () => signal.removeEventListener("abort", onAbort);
  }

  let text = "";
  let finishReason = null;
  let sawToken = false;

  // THE DEADLINES START HERE, BEFORE THE REQUEST — not after the response
  // headers arrive.
  //
  // An earlier version created them after `await fetch`, which looked right and
  // left the worst case completely uncovered: a server that accepts the TCP
  // connection and never sends headers never resolves the fetch, so the timer
  // that was supposed to catch a wedged model was never created. `complete()`
  // hung forever. A wedged model is precisely what the first-token deadline is
  // for, so the deadline has to cover connect and headers too.
  //
  // Two deadlines rather than one: a model loading 21 GB of weights is slow
  // before the first token and fast after it, and a single timeout either kills
  // the cold start or fails to notice a mid-stream stall.
  // Loop detection state. `reasoningLine` buffers the partial line currently
  // arriving, because deltas do not respect line boundaries. `recentHashes`
  // is the rolling window of sha256(normalised phrase) — hashed so identity
  // is the EXACT whole phrase, never a prefix, a tail, or a collision of
  // trimming; compared only against the recent window, so recurrence at
  // structural distance (once per claim) is not repetition.
  const recentHashes = [];
  let reasoningLine = "";
  let loopedLine = null;
  let loopedCount = 0;

  // THE THINKING IS KEPT, NOT JUST COUNTED.
  //
  // 2026-08-29: ten minutes of reasoning produced ~48 complete, numbered,
  // individually-parseable claims — then the model slid into its compliance
  // checklist, the loop detector fired (correctly), and the abort threw away
  // every one of them, because the only things this client retained about the
  // reasoning channel were a repeat-count map and the current partial line.
  // The work was done; we kept the evidence that it stalled and discarded the
  // work itself.
  //
  // So the trace is accumulated and travels on EVERY mid-stream error, the
  // same way `partialText` already carries the content channel: the caller
  // can harvest claims from it and show the model its own thoughts on the
  // next attempt instead of paying for the derivation twice.
  //
  // Bounded from the FRONT: past the cap the oldest thinking goes first,
  // because the claims nearest completion — and the loop the wake-up must
  // name — live at the tail. The cap is far above any observed trace (a 19k
  // token generation is ~76 KB) so eviction is a guard rail, not a policy.
  let reasoningText = "";

  const firstTokenTimer = setTimeout(() => {
    if (!sawToken) abort("first-token");
  }, settings.firstTokenTimeoutMs);

  // STREAM TIMEOUT MEANS INACTIVITY, NOT TOTAL RUNTIME.
  //
  // muse-local can reason for more than five minutes while continuously sending
  // deltas. The previous one-shot timer killed every such request at exactly
  // 300s — including two healthy concurrent streams in the same heartbeat — and
  // then retried the entire inference from zero. Reset this deadline on every
  // reasoning or content delta. A moving stream may run as long as it needs; a
  // socket that stops making progress is still bounded.
  let streamTimer = null;
  const resetStreamTimer = () => {
    clearTimeout(streamTimer);
    streamTimer = setTimeout(() => abort("stream"), settings.streamTimeoutMs);
  };
  resetStreamTimer();

  try {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    // ASSISTANT PREFILL — putting words in the model's mouth to skip a phase it
    // would otherwise spend tokens on.
    //
    // A trailing `assistant` message is treated by most chat templates as the
    // beginning of the reply, which the model then CONTINUES rather than
    // restarts. That makes it the one lever a client has over a phase that the
    // OpenAI-compatible surface does not expose.
    //
    // WHY WE NEED IT. Measured through the PIN gateway on gemma4:26b: a request
    // whose visible answer was ~800 tokens reported `completion_tokens: 3231`.
    // Roughly 2,400 tokens — three quarters of the generation, about 29 of 39
    // seconds — went to a reasoning channel that is stripped before delivery.
    // `max_tokens: 600` did not cap it either, so the budget is not reaching the
    // model. `think:false` works on Ollama's /api/chat and NOT on
    // /v1/chat/completions, and `chat_template_kwargs.enable_thinking` is
    // routinely dropped by OpenAI-compat translation layers. Prefilling an
    // already-closed empty thought channel is the workaround that survives all
    // of that, because it travels as ordinary message content.
    //
    // The exact opener is model-specific, so it is a STRING, not a boolean —
    // set YENTE_LLM_PREFILL and try variants without a code change. Empty or
    // unset means the model behaves normally, which is the safe default.
    if (prefill) messages.push({ role: "assistant", content: prefill });

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
        signal: controller.signal,
      });
    } catch (error) {
      // The repeated line IS the diagnosis, and it is what the wake-up turn
      // quotes back to the model. An error that only said "it looped" would
      // leave the caller nothing to correct with.
      if (controller.signal.aborted) {
        throw translateAbort(controller.signal.reason, error, text,
          loopedLine ? { line: loopedLine, count: loopedCount } : null,
          reasoningText);
      }
      throw new ModelError(ModelErrorCode.NETWORK_ERROR,
        `Cannot reach the model at ${endpoint}: ${error.message}`,
        { partial: text.slice(0, 1000), partialText: text,
          ...(reasoningText ? { reasoningText } : {}) });
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new ModelError(ModelErrorCode.HTTP_ERROR, `Model returned HTTP ${response.status}`, {
        status: response.status,
        body: body.slice(0, 500),
      });
    }

    try {
      for await (const event of readServerSentEvents(response.body, controller.signal)) {
        if (event === "[DONE]") break;

        let parsed;
        try {
          parsed = JSON.parse(event);
        } catch {
          // A server that interleaves a keep-alive or a comment has not failed.
          // Skip what we cannot read; fail only on no content at all.
          continue;
        }

        // BEFORE looking for content. The gateway's own account of what went
        // wrong is worth more than anything we could infer from its absence,
        // and it arrives as a data: event with no `choices` at all.
        if (parsed.error) {
          const upstream = typeof parsed.error === "string"
            ? parsed.error
            : parsed.error.message ?? JSON.stringify(parsed.error);
          throw new ModelError(
            ModelErrorCode.UPSTREAM_ERROR,
            `Upstream: ${upstream}`,
            { upstream: parsed.error, partial: text.slice(0, 500), partialText: text,
              ...(reasoningText ? { reasoningText } : {}) },
          );
        }

        const choice = parsed.choices?.[0];

        // NORMALISE THE GATEWAY'S TEXT SHAPES BEFORE THE PROTOCOL EVER SEES THEM.
        //
        // OpenAI's original streaming shape is `choice.delta.content: string`,
        // but gateways also emit content-part arrays/objects and, on the final
        // event, a non-streaming `choice.message.content`. The old reader accepted
        // only the first shape. An array was concatenated as "[object Object]";
        // a final message was ignored entirely. Both then surfaced downstream as
        // MALFORMED_ARTIFACT / TRUNCATED_ANSWER, blaming the model for text the
        // transport had discarded.
        //
        // One normaliser for content and reasoning keeps the accepted wire shapes
        // identical. It deliberately extracts TEXT only — images, tool calls and
        // unknown content parts have no place in Yente's observation envelope.
        const reasoning = textFromWire(
          choice?.delta?.reasoning
          ?? choice?.delta?.reasoning_content
          ?? choice?.delta?.thinking
          ?? choice?.message?.reasoning
          ?? choice?.message?.reasoning_content
          ?? choice?.message?.thinking,
        );

        // REASONING DELTAS ARE PROOF OF LIFE.
        //
        // A reasoning model emits its thinking FIRST, and the AiAS gateway
        // streams that as `delta.reasoning` (its own feature — "stream
        // reasoning-model thinking as delta.reasoning"). This reader only
        // counted `delta.content`, so for the 30-90 seconds the model spends
        // deliberating — measured at 70-80% of its total tokens — the client saw
        // an empty stream and the first-token deadline expired.
        //
        // The result was FIRST_TOKEN_TIMEOUT on a model that was working
        // perfectly, three times per message, on every message. The gateway was
        // telling us it was alive in a field we discarded. That is the third
        // time in this codebase a failure was really a reason thrown away, and
        // the second time it was thrown away in this exact function.
        //
        // Thinking clears the deadline but is NOT appended to `text`: it is
        // liveness, not content, and the envelope must never contain it.
        if (reasoning) {
          if (!sawToken) {
            sawToken = true;
            clearTimeout(firstTokenTimer);
          }
          resetStreamTimer();
          onReasoning?.(reasoning);

          reasoningText += reasoning;
          if (reasoningText.length > settings.maxReasoningCapture) {
            reasoningText = reasoningText.slice(
              reasoningText.length - settings.maxReasoningCapture);
          }

          // IS IT GETTING ANYWHERE, AS OPPOSED TO STILL BEING ALIVE?
          //
          // Two different questions, and until now only the first was asked. A
          // real trace: four lines cycling for six and a half minutes, one every
          // 1.5s, every guard satisfied — the deadline reset on each delta, the
          // character budget never saw them, and the log read `~142tok 6m30s`,
          // which looks slow rather than stuck.
          //
          // Deltas do not arrive on line boundaries (a sentence can be split
          // across three of them), so repetition is counted over COMPLETED
          // lines assembled from the stream, not over deltas.
          reasoningLine += reasoning;
          let cut = reasoningLine.indexOf("\n");
          while (cut !== -1) {
            const line = normaliseLine(reasoningLine.slice(0, cut));
            reasoningLine = reasoningLine.slice(cut + 1);
            cut = reasoningLine.indexOf("\n");

            // Short fragments repeat innocently — a bare "-" or "**2.**" is
            // punctuation, not an argument going in circles.
            if (line.length < 12) continue;

            // sha of the phrase, compared against the rolling window. The
            // hash makes the comparison exact-whole-phrase — two lines that
            // differ only in their tail are different phrases, full stop —
            // and the WINDOW makes repetition mean "again, recently" rather
            // than "again, ever". Four of the same phrase inside twenty is a
            // loop; the same phrase once per claim across a long commit
            // checklist never accumulates.
            const sha = createHash("sha256").update(line).digest("hex");
            const seen = recentHashes.filter((held) => held === sha).length + 1;
            if (seen >= settings.maxReasoningRepeats) {
              loopedLine = line;
              loopedCount = seen;
              abort("loop");
              break;
            }
            recentHashes.push(sha);
            if (recentHashes.length > settings.loopWindow) recentHashes.shift();
          }
        }

        const delta = textFromWire(
          choice?.delta?.content
          ?? choice?.message?.content
          ?? choice?.text,
        );
        if (delta) {
          if (!sawToken) {
            sawToken = true;
            clearTimeout(firstTokenTimer);
          }
          resetStreamTimer();
          text += delta;
          onToken?.(delta);

          // STOP WHEN THE ANSWER IS COMPLETE.
          //
          // The moment the protocol says we have everything, every further token
          // is a model that did not stop when asked — commentary, another block,
          // or a fresh reasoning trace. Reading it costs real seconds per message
          // and can only make the artifact harder to parse.
          if (stopWhen?.(text)) {
            finishReason = finishReason ?? "stop_sequence";
            break;
          }

          if (text.length > settings.maxCharacters) {
            abort("budget");
            throw new ModelError(
              ModelErrorCode.TOKEN_BUDGET_EXCEEDED,
              `Completion exceeded ${settings.maxCharacters} characters`,
              { partial: text.slice(0, 1000), partialText: text,
                ...(reasoningText ? { reasoningText } : {}) },
            );
          }
        }
        // STOP READING WHEN THE MODEL IS DONE.
        //
        // This used to only RECORD finish_reason and keep looping until `[DONE]`
        // or the socket closed. `[DONE]` is an OpenAI convention, not a
        // guarantee, and the AiAS gateway does not always send it — so a
        // completion that had finished generating sat here until the server got
        // around to closing the connection. Measured against the same gateway:
        // a plain non-streaming curl returned instantly while this client took
        // ~60s for the identical request. The model was never slow. We were.
        //
        // Per the OpenAI streaming contract a non-null finish_reason means that
        // choice is complete, so there is nothing further to wait for.
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
          break;
        }
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      // The loop info travels here too. `abort("loop")` makes the reader throw
      // from inside the iteration, so THIS is the catch that actually converts
      // it — the earlier site handles the pre-iteration case. Passing it in one
      // place and not the other is why the repeated line arrived empty.
      throw translateAbort(controller.signal.reason, error, text,
        loopedLine ? { line: loopedLine, count: loopedCount } : null,
        reasoningText);
    }

    if (text.trim() === "") {
      throw new ModelError(ModelErrorCode.EMPTY_COMPLETION, "The model returned no content", {
        finishReason,
      });
    }

    return { text, finishReason, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(streamTimer);
    releaseSignal();
  }
}

/**
 * Extract text from the content shapes used by OpenAI-compatible gateways.
 *
 * Accepted:
 *   "plain string"
 *   { type: "text", text: "..." }
 *   [{ type: "text", text: "..." }, { type: "output_text", text: "..." }]
 *   nested `{ content: ... }` wrappers seen on some proxy final events
 *
 * Unknown/non-text parts are ignored rather than string-coerced. In particular,
 * an object must never become "[object Object]" inside a Sentinel artifact.
 */
function textFromWire(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromWire).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return textFromWire(value.content);
  }
  return "";
}

/**
 * Two lines are the same line if they differ only in whitespace or list marker.
 *
 * The observed loop alternated between "- I will ensure the `explicit` field is
 * set correctly." and the same sentence arriving without its leading dash,
 * because the dash landed in the previous delta. Comparing raw strings would
 * have called those two different lines and never tripped.
 */
function normaliseLine(line) {
  return String(line ?? "")
    .replace(/^[\s\-*\d.)#]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function translateAbort(reason, error, partial, loop = null, reasoningText = "") {
  // `partial` is the log-friendly excerpt; `partialText` is the whole
  // accumulated stream, carried so a caller can salvage the complete claim
  // lines a dying transport already delivered. See provider.js.
  //
  // The loop detail is passed IN rather than attached afterwards: ModelError
  // freezes its meta, so a post-construction assignment is dropped silently —
  // which is how the repeated line went missing while the code read as correct.
  const meta = {
    partial: partial.slice(0, 1000),
    partialText: partial,
    ...(loop?.line ? { repeatedLine: loop.line, repeats: loop.count } : {}),
    // The thinking that preceded the failure. Aborting a stalled stream is
    // only cheap if the work it already did survives the abort — the caller
    // harvests claims from this and shows the model its own thoughts on the
    // wake-up attempt. Empty when the model never reasoned.
    ...(reasoningText ? { reasoningText } : {}),
  };
  if (reason === "first-token") {
    return new ModelError(ModelErrorCode.FIRST_TOKEN_TIMEOUT, "The model produced no first token in time", meta);
  }
  if (reason === "stream") {
    return new ModelError(ModelErrorCode.STREAM_TIMEOUT, "The model stream stopped making progress", meta);
  }
  if (reason === "loop") {
    return new ModelError(ModelErrorCode.REASONING_LOOP,
      "The model repeated itself instead of answering", meta);
  }
  if (reason === "caller") {
    return new ModelError(ModelErrorCode.ABORTED, "The caller aborted the completion", meta);
  }
  return new ModelError(ModelErrorCode.NETWORK_ERROR, `The model stream failed: ${error.message}`, meta);
}

/**
 * Parse an SSE body into `data:` payloads.
 *
 * Written out rather than pulled in because the subset that matters here is
 * small and the failure mode of getting it wrong is silent truncation. Events
 * are separated by a blank line; a single event may carry several `data:` lines,
 * which are joined with a newline per the spec.
 */
async function* readServerSentEvents(body, signal) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    if (signal.aborted) throw new Error(String(signal.reason ?? "aborted"));
    buffer += decoder.decode(chunk, { stream: true });

    let separator;
    while ((separator = findEventBoundary(buffer)) !== -1) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const payload = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (payload !== "") yield payload;
    }
  }

  const tail = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (tail !== "") yield tail;
}

function findEventBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return -1;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
