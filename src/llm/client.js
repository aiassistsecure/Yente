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
    || code === ModelErrorCode.EMPTY_COMPLETION
    || code === ModelErrorCode.UPSTREAM_ERROR;
}

const DEFAULTS = Object.freeze({
  temperature: 0,
  maxTokens: 2048,
  firstTokenTimeoutMs: 60_000,
  streamTimeoutMs: 300_000,
  maxCharacters: 64_000,
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
      return streamCompletion({ endpoint, model, apiKey, fetchImpl, settings, ...request });
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
  onToken,
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
  const firstTokenTimer = setTimeout(() => {
    if (!sawToken) abort("first-token");
  }, settings.firstTokenTimeoutMs);
  const streamTimer = setTimeout(() => abort("stream"), settings.streamTimeoutMs);

  try {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

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
      if (controller.signal.aborted) throw translateAbort(controller.signal.reason, error, text);
      throw new ModelError(ModelErrorCode.NETWORK_ERROR, `Cannot reach the model at ${endpoint}: ${error.message}`);
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
            { upstream: parsed.error, partial: text.slice(0, 500) },
          );
        }

        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.text ?? "";
        if (delta) {
          if (!sawToken) {
            sawToken = true;
            clearTimeout(firstTokenTimer);
          }
          text += delta;
          onToken?.(delta);
          if (text.length > settings.maxCharacters) {
            abort("budget");
            throw new ModelError(
              ModelErrorCode.TOKEN_BUDGET_EXCEEDED,
              `Completion exceeded ${settings.maxCharacters} characters`,
              { partial: text.slice(0, 1000) },
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
      throw translateAbort(controller.signal.reason, error, text);
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

function translateAbort(reason, error, partial) {
  const meta = { partial: partial.slice(0, 1000) };
  if (reason === "first-token") {
    return new ModelError(ModelErrorCode.FIRST_TOKEN_TIMEOUT, "The model produced no first token in time", meta);
  }
  if (reason === "stream") {
    return new ModelError(ModelErrorCode.STREAM_TIMEOUT, "The model stream did not complete in time", meta);
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
