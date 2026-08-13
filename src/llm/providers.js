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
 * raise or quiet job search. `local` therefore stays the DEFAULT, and any
 * provider that leaves our infrastructure is marked `thirdParty: true` and
 * warns loudly at startup. Nothing here stops you choosing one; it stops the
 * choice being silent while the page still claims otherwise.
 */

import { createModelClient } from "./client.js";

/**
 * A provider is: how to reach it, and what it needs on the wire.
 *
 * `thirdParty` means the document leaves our infrastructure. That flag exists
 * so a routing choice cannot quietly contradict the privacy page.
 */
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
    model: () => process.env.YENTE_LLM_MODEL || "local",
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
    model: () => process.env.YENTE_LLM_MODEL
      || (process.env.YENTE_LLM_UPSTREAM === "pin" ? "pin:auto" : "llama-3.3-70b-versatile"),
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({
      "x-aiassist-provider": process.env.YENTE_LLM_UPSTREAM || "groq",
      "user-agent": BROWSER_UA,
    }),
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
    model: () => process.env.YENTE_LLM_MODEL || "pin:auto",
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({ "x-aiassist-provider": "pin", "user-agent": BROWSER_UA }),
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
    model: () => process.env.YENTE_LLM_MODEL || "default",
    apiKey: () => process.env.YENTE_LLM_API_KEY || "",
    headers: () => ({}),
  },
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
  const name = String(provider || process.env.YENTE_LLM_PROVIDER || "local").toLowerCase();
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
    [/^gpt-|^o[0-9]/i, "openai"],
    [/^llama|^mixtral|^gemma/i, "groq"],
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

  const client = createModelClient({
    baseUrl, model, apiKey,
    fetchImpl: withHeaders(spec.headers()),
  });

  return {
    extractionClient: client,
    emailClient: client,
    describe: { provider: name, label: spec.label, model, baseUrl, thirdParty },
  };
}
