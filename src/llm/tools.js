/**
 * Tool definitions Yente offers a model — one source of truth.
 *
 * Measured on imagine (identical weights, temp 0): free-text output produced
 * 2/7 usable structured answers; typed tool schemas produced 6/7. Schema beats
 * prose, and every shape failure tonight — invented predicates, stitched
 * quotes, a model rehearsing the output rules for six minutes — was prose
 * being asked to do a schema's job.
 *
 * The enum IS roles.js's values, imported rather than retyped, so the tool a
 * model fills and the parser a reply falls back to can never disagree about
 * what a role is called.
 *
 * The transport: aias #201 forwards tools through PIN; pin-clientd #23 relays
 * them to the backend and assembles tool_calls back. Until Yente's client
 * speaks it end to end, this module is also the source for the probe:
 *
 *   node -e "import('./src/llm/tools.js').then(m =>
 *     console.log(JSON.stringify(m.DECLARE_ROLE_TOOL)))"
 */

import { ROLES } from "../graph/roles.js";

export const DECLARE_ROLE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "declare_role",
    description:
      "Record which of the four network roles this person declared for "
      + "themselves, in their own words. Only when the message states it — "
      + "never inferred from a document, a skill list, or a domain name.",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          // A fifth role is UNREPRESENTABLE, not rejected after the fact.
          enum: Object.values(ROLES),
        },
        quote: {
          type: "string",
          description:
            "The sentence they said it in, verbatim. Checked against the "
            + "source; a paraphrase is a discarded claim.",
        },
      },
      required: ["role", "quote"],
    },
  },
});

/**
 * Verify a declare_role call the way every claim is verified: the enum bounds
 * the role, and the quote must appear verbatim in the source. Tools fix
 * SHAPE, not TRUTH — a tool call can still carry a quote that is not in the
 * document, so the same gate applies as everywhere else.
 */
export function verifyDeclareRole(args, sourceText) {
  const role = String(args?.role ?? "");
  if (!Object.values(ROLES).includes(role)) {
    return { ok: false, why: `unknown role: ${role}` };
  }
  const quote = String(args?.quote ?? "");
  if (quote.length < 4 || !String(sourceText ?? "").includes(quote)) {
    return { ok: false, why: "quote not found verbatim in the source" };
  }
  return { ok: true, role, quote };
}
