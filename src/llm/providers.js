/**
 * Which model reads the résumé, and where it runs.
 *
 * `createModelClient` already speaks OpenAI-compatible `/chat/completions`, so
 * every provider here is a base URL, a model name, and — the only part that
 * needed writing — whatever extra headers that host demands. Those go in through
 * the existing `fetchImpl` seam rather than by widening client.js, so the
 * transport, its two deadlines and its abort handling are untouched.
 *
 * WHY AN LLM AT ALL, GIVEN §5.3 IS SUPPOSED TO BE DETERMINISTIC
 *
 * It isn't a contradiction, because the model does not get the last word. It
 * PROPOSES facts; `verifyFact` in extract/spans.js then rejects any whose
 * evidence is not literally present in the document, and only
 * `extraction.verified` is stored. So the untrusted, non-deterministic step is
 * fenced by a deterministic one.
 *
 * That split is why regex extraction was never the right answer. Résumé layouts
 * are unbounded — a hand-rolled LinkedIn chunker written for this project
 * scored 31/31 on five profiles only AFTER a rewrite, because the second layout
 * broke every assumption of the first. A model reads unfamiliar layouts; the
 * verifier is what stops it inventing.
 *
 * PRIVACY IS A ROUTING DECISION, NOT A PREFERENCE
 *
 * The public /privacy page states that extraction runs on our own hardware and
 * not a third-party inference provider — a promise about somebody's unannounced
 * raise or quiet job search. Any provider that leaves our infrastructure is
 * therefore marked `thirdParty: true` and warns loudly at startup. Nothing here
 * stops you choosing one; it stops the choice being silent while the page still
 * claims otherwise.
 *
 * THE DEFAULT IS `pin`, WHICH KEEPS THAT PROMISE
 *
 * It used to be `local`, on the reasoning that our own llama.cpp is the most
 * private option. True, and useless in production, where nothing is listening on
 * 127.0.0.1:8080 — so the "safe" default guaranteed a NETWORK_ERROR on the first
 * résumé. `pin` is also thirdParty:false (it is our own peer network), and it is
 * the path that actually exists. A default that points at nothing is not safe.
 */

import { createModelClient } from "./client.js";

/**
 * A provider is: how to reach it, and what it needs on the wire.
 *
 * `thirdParty` means the document leaves our infrastructure. That flag exists
 * so a routing choice cannot quietly contradict the privacy page.
 */
/**
 * The model name, from the environment.
 *
 * `YENTE_MODEL` is the name the intelligence-runtime brief specifies;
 * `YENTE_LLM_MODEL` is what the existing daemon and every deployed box already
 * set. Both are honoured, new name first, so the cutover does not require
 * editing a live box's environment in the same change that ships the code.
 *
 * One helper rather than four call sites, because the last time a name existed
 * in more than one place with slightly different resolution, all sixteen of a
 * member's verified facts were silently dropped.
 */
function envModel(fallback) {
  return process.env.YENTE_MODEL || process.env.YENTE_LLM_MODEL || fallback;
}

export const PROVIDERS = Object.freeze({
  /**
   * llama.cpp / llama-server on our own box. The benchmarked path: Qwen3.5-35B-
   * A3B took 16/16 clear triage fixtures with 6/7 abstentions and zero
   * misclassifications, which is the behaviour that matters for a desk that
   * would rather say nothing than guess.
   */
  local: {
    label: "local llama.cpp",
    thirdParty: false,
    baseUrl: () => process.env.YENTE_LLM_BASE_URL || "http://127.0.0.1:8080/v1",
    model: () => envModel("local"),
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({}),
  },

  /**
   * AiAssist Secure. Verified working 2026-08-13 against
   * api.aiassist.net/v1/chat/completions.
   *
   * TWO THINGS THAT WILL BITE:
   *  - X-AiAssist-Provider is required, and the account default (anthropic /
   *    claude-fable-5) 400s because the groq fallback keeps the anthropic model
   *    name. ALWAYS send an explicit model.
   *  - Cloudflare rejects unusual User-Agents at the edge with error 1010,
   *    before the app sees the request — an HTML 403 that reads exactly like an
   *    auth failure.
   *
   * `thirdParty` is TRUE unless routed to pin, because anthropic/openai/groq
   * upstreams are third parties whatever the gateway in front of them says.
   */
  aias: {
    label: "AiAssist Secure",
    thirdParty: (process.env.YENTE_LLM_UPSTREAM || "") !== "pin",
    baseUrl: () => process.env.YENTE_LLM_BASE_URL || "https://api.aiassist.net/v1",
    // Same default as the `pin` provider when routed there: "auto" hands the
    // choice of weights to somebody else on every call, and extraction is the
    // one place we want to know exactly which model read the document.
    model: () => envModel(
      process.env.YENTE_LLM_UPSTREAM === "pin" ? "muse-local:latest" : "llama-3.3-70b-versatile",
    ),
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({
      "x-aiassist-provider": process.env.YENTE_LLM_UPSTREAM || "groq",
      "user-agent": BROWSER_UA,
    }),
    get settings() { return AIAS_SETTINGS; },
  },

  /**
   * PIN — the peer inference network, through the AiAS gateway. Same wire
   * protocol, different upstream, and NOT third party: it is our own network.
   *
   * A PIN-scoped key is required on the account; a key without one returns
   * "No API key configured for pin" even for pin:auto, which is a gateway-side
   * credential, not a model that does not exist.
   */
  pin: {
    label: "PIN network (via AiAS)",
    thirdParty: false,
    baseUrl: () => process.env.YENTE_LLM_BASE_URL || "https://api.aiassist.net/v1",
    // muse-local rather than pin:auto, because "auto" is a routing decision made
    // by somebody else on every single call, and extraction is the one place we
    // want to know exactly which weights read the document.
    model: () => envModel("muse-local:latest"),
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({ "x-aiassist-provider": "pin", "user-agent": BROWSER_UA }),

    get settings() { return AIAS_SETTINGS; },
  },

  /**
   * HyperAgent. Requires YENTE_LLM_BASE_URL to be set explicitly, because an
   * endpoint nobody has verified is worse than a missing one: it fails at the
   * first résumé, in production, with a network error that looks like an outage.
   */
  hyperagent: {
    label: "HyperAgent",
    thirdParty: true,
    baseUrl: () => {
      const url = process.env.YENTE_LLM_BASE_URL;
      if (!url) {
        throw new Error(
          "YENTE_LLM_PROVIDER=hyperagent needs YENTE_LLM_BASE_URL pointing at an "
          + "OpenAI-compatible /chat/completions endpoint (the client posts "
          + "{model, messages, stream:true} and reads an SSE stream). Left "
          + "unset deliberately rather than guessed.",
        );
      }
      return url;
    },
    model: () => envModel("default"),
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({}),
  },
});

/**
 * Deadlines for anything fronted by the AiAS gateway.
 *
 * The 90s limit is the GATEWAY's, not one upstream's, so every route through it
 * shares this — `aias` and `pin` alike. It counts SILENCE BETWEEN CHUNKS, not
 * total duration, and it announces itself in the stream:
 *
 *   data: {"error":{"message":"operator produced nothing for 90s
 *          (timeout between chunks, not total duration)"}}
 *
 * A reasoning model emits nothing at all while it thinks — measured on
 * muse-local: 101 completion_tokens to answer "OK", 82 SECONDS of pin_latency on
 * a real extraction prompt. At the default 60s WE gave up first and turned that
 * specific sentence into our own generic FIRST_TOKEN_TIMEOUT. Sitting just past
 * the gateway's limit lets the upstream explain itself, so a diagnosis arrives
 * instead of a shrug.
 */
const AIAS_SETTINGS = Object.freeze({
  // Sit PAST the gateway's idle timeout (now 180s default, PIN_IDLE_TIMEOUT
  // overridable) so Yente never pre-empts a stream the gateway is still happy
  // to carry. muse-local reasons in silence for over 90s before first token;
  // the gateway is the one that used to kill it. Both deadlines are inactivity
  // only and reset on every delta -- never an absolute wall clock.
  firstTokenTimeoutMs: 200_000,
  streamTimeoutMs: 300_000,
});

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/126.0 Safari/537.36";

/** Wrap fetch so a provider's extra headers ride along, without touching client.js. */
function withHeaders(extra, base = fetch) {
  const entries = Object.entries(extra || {}).filter(([, v]) => v);
  if (!entries.length) return base;
  return (url, init = {}) =>
    base(url, { ...init, headers: { ...(init.headers || {}), ...Object.fromEntries(entries) } });
}

/**
 * Build the two clients the runtime wants.
 *
 * Returns `{ extractionClient, emailClient, describe }`. Both are the same
 * client today — one model reads and writes — but they stay separate arguments
 * because they are separate jobs: extraction wants a model that abstains, and
 * composition wants one that writes plainly. Splitting them later is a config
 * change rather than a refactor.
 *
 * @param {object} [opts]
 * @param {string} [opts.provider] overrides YENTE_LLM_PROVIDER
 * @param {(level: string, event: string, fields?: object) => void} [opts.log]
 */
export function createLlmClients({ provider, log } = {}) {
  // DEFAULT IS `pin`, NOT `local`.
  //
  // It was `local` to keep the /privacy promise — documents are read on our own
  // hardware, not a third-party inference provider. `pin` keeps that promise
  // (thirdParty: false — it is our own network) AND is the path that actually
  // exists in production, where no llama.cpp server is running on 127.0.0.1.
  // A default that points at nothing is not a safe default; it is a guaranteed
  // NETWORK_ERROR on the first résumé.
  const name = String(provider || process.env.YENTE_LLM_PROVIDER || "pin").toLowerCase();
  const spec = PROVIDERS[name];
  if (!spec) {
    throw new Error(
      `Unknown YENTE_LLM_PROVIDER "${name}". Known: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }

  const baseUrl = spec.baseUrl();
  const model = spec.model();
  const apiKey = spec.apiKey();
  const thirdParty = typeof spec.thirdParty === "function"
    ? spec.thirdParty() : spec.thirdParty;

  // Loud, once, at startup. The privacy page makes a specific promise about
  // where documents are read; a routing choice that breaks it must not be
  // discoverable only by reading env vars.
  if (thirdParty && log) {
    log("warn", "llm_third_party", {
      provider: name, model,
      note: "documents will leave our infrastructure — /privacy currently "
        + "states extraction runs on our own hardware. Update the page or "
        + "change the provider.",
    });
  }

  // A MODEL NAME THAT DOES NOT BELONG TO THE CHOSEN UPSTREAM IS THE EXACT BUG
  // WE FOUND IN AIAS'S OWN ROUTER: its groq fallback kept the anthropic model
  // name and every request died as "Groq: The model claude-fable-5 does not
  // exist". Switching provider to pin while YENTE_LLM_MODEL is still set to a
  // claude name reproduces it here. Explicit model still wins — the operator may
  // know something we do not — but it must not be silent.
  const upstream = name === "pin" ? "pin" : (process.env.YENTE_LLM_UPSTREAM || "");
  const FAMILIES = [
    [/^claude/i, "anthropic"],
    // gpt-oss is OPEN-WEIGHTS — a gpt-prefixed model that legitimately runs on
    // anybody's hardware, PIN included. The first version of this heuristic
    // matched /^gpt-/ and warned twice per boot about a perfectly valid
    // config, and a warning that fires on correct setups teaches the operator
    // to ignore warnings — which un-catches the real AiAS fallback bug this
    // exists for. Hosted names only: the vendor families no local box serves.
    [/^gpt-[45]|^gpt-3\.5|^o[0-9]\b/i, "openai"],
    [/^llama-|^mixtral/i, "groq"],
    [/^pin:/i, "pin"],
  ];
  const family = (FAMILIES.find(([re]) => re.test(model)) || [])[1];
  if (log && family && upstream && family !== upstream) {
    log("warn", "llm_model_upstream_mismatch", {
      model, upstream, looks_like: family,
      note: `model "${model}" looks like a ${family} model but the upstream is `
        + `${upstream}. This is the shape of the AiAS fallback bug — the gateway `
        + "will likely reject it. Set YENTE_LLM_MODEL to match, or clear it.",
    });
  }

  // Per-provider deadlines. A provider knows how slow its own upstream is; the
  // client should not have to carry one number that suits every host.
  // Overridable by env, because the operator on the box is the one who can see
  // what it is actually doing.
  const settings = {
    ...(spec.settings ?? {}),
    ...(process.env.YENTE_LLM_FIRST_TOKEN_MS
      ? { firstTokenTimeoutMs: Number(process.env.YENTE_LLM_FIRST_TOKEN_MS) } : {}),
    ...(process.env.YENTE_LLM_STREAM_MS
      ? { streamTimeoutMs: Number(process.env.YENTE_LLM_STREAM_MS) } : {}),
  };

  const client = createModelClient({
    baseUrl, model, apiKey,
    fetchImpl: withHeaders(spec.headers()),
    ...settings,
  });

  return {
    extractionClient: client,
    emailClient: client,
    describe: {
      provider: name, label: spec.label, model, baseUrl, thirdParty,
      first_token_ms: client.settings.firstTokenTimeoutMs,
    },
  };
}
