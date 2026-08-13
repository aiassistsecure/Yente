/**
 * What a profile field is called — in ONE place.
 *
 * WHY THIS FILE EXISTS
 *
 * Three modules each held their own idea of what a field is named, and nothing
 * tied them together:
 *
 *   - the extraction prompt was handed `vocabulary: {}` — an EMPTY controlled
 *     vocabulary — so the model chose its own paths;
 *   - `buildProfileView` hardcoded a different set of names;
 *   - the qualification policy referenced a third set, and existed only in
 *     `test-support/fixtures.js`.
 *
 * The result, measured on a real résumé: 16 facts extracted, every one of them
 * span-verified against the document, and ALL SIXTEEN dropped by the view.
 * `education.degree` (no such group), `professional.employer.current` and
 * `professional.skills.languages` (three segments, where pathTarget accepts
 * exactly two), `professional.role` against a schema spelling it `roles`,
 * `professional.experience_years` against `years_experience`,
 * `professional.location` against `geographies`, and `name`/`email`/`title`
 * with no slot at all. She believed sixteen true things and could act on none
 * of them.
 *
 * Nothing failed. That is what made it expensive: grounding passed, the facts
 * were correct, and the loss happened in a name mismatch no error could report.
 * A single vocabulary is the only fix that does not decay — any of the three
 * copies can be corrected in isolation and drift back.
 *
 * TWO KINDS OF NAME, DELIBERATELY
 *
 * `FIELDS` is canonical: what the store, the view, and the policy agree on, and
 * what the model is TOLD to use. `ALIASES` maps the names a model reasonably
 * reaches for onto canonical ones.
 *
 * The aliases are not sloppiness. Two independent reasons to keep them:
 *
 *  1. Facts already stored under old names stay usable. Re-extraction costs a
 *     model call per source and, worse, is not guaranteed to reproduce — the
 *     document is the source of truth, but the phrasing of a field name is the
 *     model's choice.
 *  2. A controlled vocabulary constrains a model, it does not bind it. When one
 *     writes `professional.location` anyway, the choice is to drop a verified
 *     fact or to understand it. Dropping is what we just did for sixteen.
 *
 * An alias is a RENAME, never a reinterpretation: `location -> geographies`
 * keeps the value and its evidence untouched. Anything needing the value
 * changed is not an alias and does not belong here.
 */

/**
 * @typedef {object} FieldSpec
 * @property {"list"|"scalar"} kind   list fields accumulate; scalars are single
 * @property {string} group          top-level group in the profile view
 * @property {string} key            key within that group
 * @property {string} describes      what it means, shown to the model verbatim
 * @property {string} asks           how to ask a PERSON for it, in plain words
 */

/**
 * The canonical fields, grouped as the profile view stores them.
 *
 * `professional.*` is what somebody IS; `intent.*` is what they WANT. That split
 * matters because a résumé answers the first and almost never the second — which
 * is precisely why an interview question exists, and why a member who sends a
 * perfect résumé is still, correctly, not yet qualified.
 */
export const FIELDS = Object.freeze({
  "professional.roles": {
    kind: "list", group: "professional", key: "roles",
    describes: "job titles held, e.g. \"DevOps Engineer\", \"Founder\"",
    asks: "what your role is now",
  },
  "professional.capabilities": {
    kind: "list", group: "professional", key: "capabilities",
    describes: "concrete skills, languages, and tools",
    asks: "what you build or operate day to day",
  },
  "professional.industries": {
    kind: "list", group: "professional", key: "industries",
    describes: "industries or sectors worked in, e.g. \"aviation\", \"blockchain\"",
    asks: "which industries you work in",
  },
  "professional.geographies": {
    kind: "list", group: "professional", key: "geographies",
    describes: "places they are based in or work from",
    asks: "where you are based, and whether you are open to remote",
  },
  "professional.employers": {
    kind: "list", group: "professional", key: "employers",
    describes: "organisations worked for, current or past",
    asks: "where you work now",
  },
  "professional.seniority": {
    kind: "scalar", group: "professional", key: "seniority",
    describes: "one of: junior, mid, senior, lead, executive, founder",
    asks: "how senior the work is",
  },
  "professional.years_experience": {
    kind: "scalar", group: "professional", key: "years_experience",
    describes: "total years of professional experience, as stated",
    asks: "roughly how long you have been doing this",
  },
  "professional.display_name": {
    kind: "scalar", group: "professional", key: "display_name",
    describes: "the person's own name as written",
    asks: "what to call you",
  },
  "professional.education": {
    kind: "list", group: "professional", key: "education",
    describes: "degrees and institutions",
    asks: "any formal training worth noting",
  },
  "intent.seeks": {
    kind: "list", group: "intent", key: "seeks",
    describes: "what they are looking for — only if the source says so",
    asks: "what you are looking for",
  },
  "intent.offers": {
    kind: "list", group: "intent", key: "offers",
    describes: "what they can offer others — only if the source says so",
    asks: "what you can offer someone else",
  },
  "intent.introductionTypes": {
    kind: "list", group: "intent", key: "introductionTypes",
    describes: "kinds of introduction wanted, e.g. \"hiring\", \"investment\"",
    asks: "the kind of introduction that would be useful — hiring, investment, a co-founder, an acquirer",
  },
  "intent.constraints": {
    kind: "list", group: "intent", key: "constraints",
    describes: "stated limits — remote only, no crypto, notice period",
    asks: "anything that would rule an introduction out",
  },
});

/**
 * Non-canonical -> canonical. Every left-hand side here was produced by a real
 * model against a real résumé, not imagined.
 *
 * The three-segment paths are the interesting ones: `professional.employer.current`
 * and `professional.skills.languages` are perfectly sensible field names that
 * `pathTarget` could never accept, because it splits on "." and requires exactly
 * two parts. The model was not wrong; the contract was never stated to it.
 */
export const ALIASES = Object.freeze({
  "professional.role": "professional.roles",
  "professional.title": "professional.roles",
  "professional.employer.current": "professional.employers",
  "professional.employer.past": "professional.employers",
  "professional.employer": "professional.employers",
  "professional.location": "professional.geographies",
  "professional.geography": "professional.geographies",
  "professional.experience_years": "professional.years_experience",
  "professional.name": "professional.display_name",
  "professional.skills.languages": "professional.capabilities",
  "professional.skills": "professional.capabilities",
  "professional.skill": "professional.capabilities",
  "education.degree": "professional.education",
  "education.institution": "professional.education",
  "professional.industry": "professional.industries",
  "intent.seek": "intent.seeks",
  "intent.offer": "intent.offers",
});

/**
 * Fields we deliberately do NOT store, even when a model extracts them and the
 * evidence is real.
 *
 * `professional.email` is the case that prompted this. It is contact detail, not
 * matching signal: we already know the member's address — it is how they reached
 * us — and a second address lifted from a résumé is a way to email somebody at
 * a channel they did not establish. §5.1's inbound-only rule is about the
 * relationship, not the string, so this is dropped SILENTLY and on purpose
 * rather than surviving as an unused row.
 */
export const IGNORED_FIELDS = Object.freeze(new Set([
  "professional.email",
  "professional.phone",
  "professional.links",
  "professional.url",
]));

/**
 * Resolve any field name to a canonical one.
 *
 * @param {string} field
 * @returns {{field: string|null, spec: FieldSpec|null, via: "canonical"|"alias"|"ignored"|"unknown"}}
 */
export function resolveField(field) {
  const name = String(field ?? "").trim();
  if (FIELDS[name]) return { field: name, spec: FIELDS[name], via: "canonical" };
  if (IGNORED_FIELDS.has(name)) return { field: null, spec: null, via: "ignored" };

  const aliased = ALIASES[name];
  if (aliased && FIELDS[aliased]) {
    return { field: aliased, spec: FIELDS[aliased], via: "alias" };
  }

  // A prefix fallback for paths that extend a canonical one — `intent.seeks.roles`
  // is about intent.seeks. Longest match wins so `professional.skills.languages`
  // prefers its explicit alias over a shorter accidental prefix.
  const candidates = Object.keys(ALIASES)
    .concat(Object.keys(FIELDS))
    .filter((known) => name.startsWith(known + "."))
    .sort((a, b) => b.length - a.length);
  for (const known of candidates) {
    const target = FIELDS[known] ? known : ALIASES[known];
    if (target && FIELDS[target]) {
      return { field: target, spec: FIELDS[target], via: "alias" };
    }
  }

  return { field: null, spec: null, via: "unknown" };
}

/**
 * The controlled vocabulary block for the extraction prompt.
 *
 * This is the whole point of the file: the model is now told the exact field
 * names that count, so agreement is the default rather than a coincidence. It
 * was `{}`.
 */
export function extractionVocabulary() {
  const fields = {};
  for (const [path, spec] of Object.entries(FIELDS)) {
    fields[path] = spec.kind === "list"
      ? `${spec.describes} (one fact per item — do not join with commas)`
      : spec.describes;
  }
  return {
    fields,
    rules: [
      "Use ONLY these field names. A fact with any other field name is discarded.",
      "One fact per value. Three skills is three facts, not one comma-joined fact.",
      "intent.* only when the source states what the person WANTS. A résumé "
        + "usually does not; leave it out rather than inferring it from their history.",
      "Do not extract email addresses, phone numbers, or URLs.",
    ],
  };
}

/** Canonical field paths, for a policy that wants to name them. */
export function canonicalFields() {
  return Object.freeze(Object.keys(FIELDS));
}

/**
 * Turn missing field paths into a question a human can answer.
 *
 * The interview email used to interpolate the raw paths — a real member would
 * have received "To match you well I still need: intent.seeks and
 * intent.introductionTypes." That is a schema leaking into somebody's inbox,
 * and it is unanswerable: nobody knows what an introductionType is.
 *
 * Unknown paths fall back to the path itself rather than being dropped. A weird
 * question is recoverable; silently asking for nothing is the bug we are here
 * to fix.
 */
export function questionsFor(fields) {
  return (fields ?? []).map((path) => {
    const { spec } = resolveField(path);
    return spec?.asks ?? String(path);
  });
}
