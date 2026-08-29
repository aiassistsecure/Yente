/**
 * What a person came here for, in their own words, from a closed list.
 *
 * WHY THIS EXISTS — EVERY BAD MATCH CAME FROM INFERRED INTENT
 *
 * Yente's intent claims were mined out of email prose by a model. Every failure
 * so far traces to that one decision:
 *
 *   - "Interchained Core is looking for or offering: resume" — the intake
 *     conversation read as business intent
 *   - `capability: "resume"` — a document artefact typed as a skill
 *   - `OFFERING: "professional services and expertise"` — true, and useless
 *     for matching anyone to anyone
 *   - five of six messages producing nothing at all, because the body of a
 *     reply is "Sent from my iPhone"
 *
 * Meanwhile the résumé pass produced 63 correctly typed, span-verified claims.
 * The lesson is not that the model is bad. It is that DOCUMENTS CARRY SIGNAL AND
 * EMAIL PROSE DOES NOT, and we were asking prose to carry the most important
 * fact of all.
 *
 * So we stop inferring it. We ask.
 *
 *   "Are you hiring, seeking employment, seeking funding, or funding startups?"
 *
 * An answer to that is not a claim about the world that needs a quote to be
 * trusted — it is the person telling us what they want. It needs no model, no
 * span verification, and no confidence score, which is why it carries
 * DETERMINISTIC authority: derived by rule from what they wrote, not proposed by
 * an inference we then have to check.
 *
 * WHY FOUR, AND WHY THESE FOUR
 *
 * Because they close into exactly two complementary pairs, and a matchmaker's
 * whole job is complementarity:
 *
 *   HIRING           ↔  SEEKING_EMPLOYMENT
 *   SEEKING_FUNDING  ↔  FUNDING_STARTUPS
 *
 * Twelve INTENT_TYPES could not do this. `DISCUSSING` and `CONSIDERING`
 * complement nothing; `OFFERING` complements almost anything, which is the same
 * as complementing nothing useful. Four roles that pair cleanly are worth more
 * than a rich ontology nobody can match on.
 *
 * A PERSON MAY DECLARE MORE THAN ONE
 *
 * A founder can be hiring AND raising, and that is not a contradiction to
 * resolve — it is two true facts. Declarations are appended like any other
 * observation, matching is per pair anyway, and forcing exclusivity would make
 * us wrong about the most interesting people on the network.
 *
 * WHAT DOCUMENTS DO NOW
 *
 * Exactly what they should: substantiate. The résumé and the LinkedIn profile
 * say what a person can DO; the declaration says what they WANT. Ranking uses
 * both, in that order of authority — which is already how the document
 * corroboration arm in matching.js is weighted.
 */

/** The four. Closed, because the whole value is that they pair. */
export const ROLES = Object.freeze({
  HIRING: "hiring",
  SEEKING_EMPLOYMENT: "seeking_employment",
  SEEKING_FUNDING: "seeking_funding",
  FUNDING_STARTUPS: "funding_startups",
});

export const ROLE_PREDICATE = "role_declared";

/**
 * Who answers whom. Symmetric by construction — if A's role is answered by B's,
 * B's is answered by A's, and an asymmetric table here would silently make some
 * introductions possible in only one direction.
 */
export const ROLE_COMPLEMENTS = Object.freeze({
  [ROLES.HIRING]: ROLES.SEEKING_EMPLOYMENT,
  [ROLES.SEEKING_EMPLOYMENT]: ROLES.HIRING,
  [ROLES.SEEKING_FUNDING]: ROLES.FUNDING_STARTUPS,
  [ROLES.FUNDING_STARTUPS]: ROLES.SEEKING_FUNDING,
});

/**
 * The side that is ASKING, in each pair.
 *
 * Direction is not ambiguous here the way it is for mined intents, so it should
 * not be guessed twice. Somebody seeking work is the seeker and somebody hiring
 * is the offerer — the introduction reads one way, and emitting it in both
 * directions would put the same meeting in the review queue twice.
 */
export const SEEKING_ROLES = Object.freeze(new Set([
  ROLES.SEEKING_EMPLOYMENT,
  ROLES.SEEKING_FUNDING,
]));

/** Is this the asking side of its pair? */
export function isSeekingRole(role) {
  return SEEKING_ROLES.has(role);
}

/** Do these two roles answer each other? */
export function rolesComplement(a, b) {
  return Boolean(a && b && ROLE_COMPLEMENTS[a] === b);
}

/** How Yente says each one back to a person, in a sentence they'd recognise. */
export const ROLE_LABELS = Object.freeze({
  [ROLES.HIRING]: "hiring",
  [ROLES.SEEKING_EMPLOYMENT]: "looking for work",
  [ROLES.SEEKING_FUNDING]: "raising funding",
  [ROLES.FUNDING_STARTUPS]: "funding startups",
});

/**
 * Phrases that declare a role, longest-first within each role.
 *
 * DELIBERATELY NOT A KEYWORD BAG. "funding" alone cannot decide between
 * SEEKING_FUNDING and FUNDING_STARTUPS — they are opposites that share the
 * word — so every pattern here carries the DIRECTION, not just the topic. That
 * is the same mistake as matching on "resume", and it would be worse: pairing
 * two founders who both need money.
 *
 * Order matters. "not hiring" and "looking to hire" both contain "hiring", so
 * the negative and the more specific forms are tested before the bare word.
 */
const DECLARATIONS = Object.freeze([
  // --- funding, sought ---
  [ROLES.SEEKING_FUNDING, /\b(?:seeking|raising|looking for|need(?:ing)?|want(?:ing)?)\s+(?:\w+\s+){0,3}(?:funding|investment|capital|investors?|a\s+round|pre-?seed|seed|series\s+[a-d])\b/i],
  [ROLES.SEEKING_FUNDING, /\b(?:we|i|our\s+\w+)\s+(?:are|am|is)\s+(?:currently\s+)?(?:raising|fundraising)\b/i],
  [ROLES.SEEKING_FUNDING, /\bfund(?:ing)?\s*raising\b/i],

  // --- funding, offered ---
  [ROLES.FUNDING_STARTUPS, /\b(?:fund(?:ing)?|invest(?:ing)?|back(?:ing)?|writ(?:e|ing)\s+cheques?|writ(?:e|ing)\s+checks?)\s+(?:in\s+)?(?:early[- ]stage\s+)?(?:startups?|founders?|compan(?:y|ies)|teams?)\b/i],
  [ROLES.FUNDING_STARTUPS, /\b(?:i|we)\s+(?:am|are)\s+an?\s+(?:angel|investor|vc|venture\s+capitalist|lp|gp)\b/i],
  [ROLES.FUNDING_STARTUPS, /\b(?:deploy(?:ing)?\s+capital|looking\s+to\s+invest)\b/i],

  // --- employment, offered ---
  [ROLES.HIRING, /\b(?:we|i|our\s+\w+)\s+(?:are|am|is)\s+(?:currently\s+)?hiring\b/i],
  [ROLES.HIRING, /\b(?:looking|want(?:ing)?|need(?:ing)?|trying)\s+to\s+hire\b/i],
  [ROLES.HIRING, /\b(?:filling|recruiting\s+for|have\s+an?\s+open(?:ing)?)\b/i],

  // --- employment, sought ---
  [ROLES.SEEKING_EMPLOYMENT, /\b(?:seeking|looking\s+for|open\s+to|want(?:ing)?|need(?:ing)?)\s+(?:\w+\s+){0,3}(?:employment|a\s+job|a\s+role|a\s+position|work|opportunities)\b/i],
  [ROLES.SEEKING_EMPLOYMENT, /\b(?:i|i'?m)\s+(?:am\s+)?(?:currently\s+)?(?:unemployed|between\s+roles|job\s*hunting|job\s*searching|on\s+the\s+market)\b/i],
  [ROLES.SEEKING_EMPLOYMENT, /\blooking\s+for\s+(?:my\s+next|a\s+new)\s+(?:role|job|position|challenge)\b/i],
]);

/**
 * Negations, tested FIRST. "We are not hiring right now" must never declare
 * HIRING, and a bag-of-words reading of that sentence says the opposite of what
 * the person said.
 */
const NEGATED = /\b(?:not|no longer|aren'?t|isn'?t|am not|don'?t|do not|stopped|never)\s+(?:\w+\s+){0,2}(?:hiring|raising|investing|fundraising|looking)\b/i;

/**
 * The exact phrases Yente offers, matched as ANSWERS rather than as prose.
 *
 * The intake email lists four options and asks the person to pick. Most will
 * reply with the option and nothing else — "Hiring", "seeking employment",
 * "• funding startups" — and NONE of the prose patterns above catch those,
 * because every one requires a verb phrase ("we are hiring", "looking to
 * hire").
 *
 * That gap would have been invisible until real replies started arriving and
 * declared nothing: the ask and the parser have to agree, and the cheapest way
 * to guarantee that is for the parser to accept the exact words the ask used.
 *
 * Matched per LINE and anchored at its start, so "hiring" as an answer is
 * caught while "hiring is hard these days" in a paragraph is not.
 */
const ANSWER_PHRASES = Object.freeze([
  // Longest first: "seeking funding" must be tested before "funding".
  [ROLES.SEEKING_EMPLOYMENT, /^(?:seeking\s+employment|looking\s+for\s+work|job\s*seeking)/i],
  [ROLES.FUNDING_STARTUPS, /^(?:funding\s+startups?|i\s+fund\s+startups?|investing)/i],
  [ROLES.SEEKING_FUNDING, /^(?:seeking\s+funding|raising\s+funding|fundraising|raising)/i],
  [ROLES.HIRING, /^hiring/i],
]);

/** Lines a reply is made of, stripped of quoting and list punctuation. */
function answerLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*•\-–—\d.)\]]+/, "").trim())
    .filter(Boolean);
}

/**
 * Read the roles a person declared, from their own reply.
 *
 * Returns EVERY role the text supports, because a founder who is hiring and
 * raising said two true things. Empty means they did not answer — which is a
 * real outcome that means "ask again", not "assume something".
 *
 * @param {string} text  the current reply only, quoted history already stripped
 * @returns {string[]}   role values, deduplicated, in declaration order
 */
export function declaredRoles(text) {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  const found = [];

  // ANSWERS FIRST. Somebody replying with the option we offered has answered
  // unambiguously, and the prose patterns must not get a chance to read a
  // second meaning into a one-word reply.
  for (const line of answerLines(source)) {
    for (const [role, pattern] of ANSWER_PHRASES) {
      if (!found.includes(role) && pattern.test(line)) {
        if (NEGATED.test(line)) continue;
        found.push(role);
        break;   // one declaration per line
      }
    }
  }

  for (const [role, pattern] of DECLARATIONS) {
    if (found.includes(role)) continue;
    const match = pattern.exec(source);
    if (!match) continue;

    // A negation anywhere in the same sentence disqualifies the declaration.
    // Sentence-scoped rather than whole-message, because "We're not hiring
    // engineers but we are raising" contains both a negation and a real
    // declaration, and rejecting the whole message would lose the second.
    if (NEGATED.test(sentenceAround(source, match.index))) continue;

    found.push(role);
  }
  return found;
}

/** The sentence containing a given offset — the scope a negation applies to. */
function sentenceAround(text, index) {
  const start = Math.max(
    text.lastIndexOf(".", index),
    text.lastIndexOf("!", index),
    text.lastIndexOf("?", index),
    text.lastIndexOf("\n", index),
  );
  const candidates = [".", "!", "?", "\n"]
    .map((mark) => text.indexOf(mark, index))
    .filter((at) => at !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : text.length;
  return text.slice(start + 1, end);
}

/**
 * Is this a clean, single answer we can act on without asking again?
 *
 * Multiple roles are legal and stored, but they are worth surfacing separately:
 * "hiring and raising" is a real person, whereas a reply that trips three
 * patterns is more likely prose we misread than someone with three jobs.
 */
export function isUnambiguous(roles) {
  return roles.length >= 1 && roles.length <= 2;
}

/** The roles a person currently holds, from their observations. */
export function rolesOf(observations) {
  return [...new Set((observations ?? [])
    .filter((row) => row?.predicate === ROLE_PREDICATE && !row?.attributes?.retracted)
    .map((row) => row.object))];
}

/**
 * Does anything this person declared answer anything that one declared?
 * @returns {{seeker: string, offerer: string}|null} the matching pair, or null
 */
export function complementaryPair(theirRoles, otherRoles) {
  for (const mine of theirRoles ?? []) {
    for (const theirs of otherRoles ?? []) {
      if (rolesComplement(mine, theirs)) return { seeker: mine, offerer: theirs };
    }
  }
  return null;
}
