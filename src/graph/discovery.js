/**
 * "I found some people you might want to look at."
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * Yente can already propose introductions, and a human rules on every one of
 * them before anybody's address is shared. That stays. This is the step BEFORE
 * that: a person writes in, and Yente can tell them that interesting people
 * exist — with enough detail to be worth reading and not enough to act on
 * alone.
 *
 *   introduction   both parties named, addresses exchanged, human-approved
 *   this           "Mark E. — linkedin.com/in/globalvapor — building in AI and
 *                  Web3, which matches your interest in Web3"
 *
 * The difference is not politeness, it is capability. An introduction connects
 * two people; this tells one person that the other exists.
 *
 * THE BOUNDARY IS STRUCTURAL, NOT A RULE THE MODEL FOLLOWS
 *
 * A card carries no email address. Not "the model is told not to share it" —
 * the field is not in the object, so the model composing the reply never
 * receives the one thing it would need to introduce anybody. An instruction
 * can be talked out of; an absent field cannot.
 *
 * That matters because this output goes into a prose reply written by a model,
 * which is the least controllable surface in the system. Everything reachable
 * from there must already be safe to say.
 *
 * WHAT MAY BE DISCLOSED, AND WHY EXACTLY THAT
 *
 * Only from a QUALIFIED person — one who was shown the profile Yente derived
 * about them and approved it. That approval is the consent, and it is why the
 * lifecycle exists: the bio they signed off on is the disclosure surface, so
 * a card may carry what went into it and nothing else.
 *
 *   name           they approved it
 *   public links   they sent us the URL themselves, to be read
 *   intents        what they are seeking or offering — the point of being here
 *   disclosures    typed facts (role, capability, employer) from that profile
 *
 * NOT raw document text. A résumé holds a phone number, a home address, a
 * salary history and a list of former employers who never agreed to anything.
 * "Parts from their résumé" is the right product instinct and typed
 * disclosures are how to serve it safely: `capability: Kubernetes` is the part
 * of the CV worth quoting, and it arrives without the parts that are not.
 *
 * WHY IT RETURNS FALSE
 *
 * Named for what a caller must handle. An empty array reads as success and
 * gets rendered as "here are your matches:" followed by nothing; `false` is
 * one value with one meaning — there is nobody, say so or say nothing. The
 * failure this avoids is Yente writing an enthusiastic email about an empty
 * list, which is worse than not writing at all.
 */

import { isIntakeArtifact } from "./qualification.js";
import { documentFacts, significantWords, sourceKindOf, SOURCE_KINDS } from "./provenance.js";

/** Predicates whose object is a public handle the person sent us to be read. */
const PUBLIC_LINK_PREDICATES = new Set(["linkedin", "profile_url", "website", "portfolio"]);

/** Disclosure fields worth showing on a card, in the order a person reads them. */
const CARD_FIELDS = ["role", "seniority", "employer", "capability", "industry", "geography"];

/**
 * Find people worth mentioning to one person.
 *
 * @param {object}   input
 * @param {object}   input.graph      graph repositories
 * @param {object}   input.manager    graph manager — owns `isMatchable`
 * @param {string}   input.subject    who is asking (never appears in results)
 * @param {string}   [input.query]    optional free text to bias toward
 * @param {number}   [input.limit]
 * @returns {false|Array<object>}  false when there is nobody
 */
export function searchMatches({ graph, manager, subject, query = null, limit = 3 }) {
  if (!subject) throw new TypeError("searchMatches requires the subject asking");

  const all = graph.observations.all();

  // What the asker cares about: their own stated intents, plus anything they
  // put in the query. Intake artefacts are excluded for the same reason they
  // are excluded from scoring — "resume" is not an interest.
  const wanted = new Set([
    ...(query ? significantWords(query) : []),
    ...all
      .filter((row) => row.subject === subject
        && String(row.predicate ?? "").startsWith("intent:")
        && !isIntakeArtifact(row.object))
      .flatMap((row) => significantWords(row.object)),
  ]);
  if (wanted.size === 0) return false;

  const bySubject = new Map();
  for (const row of all) {
    if (row.subject === subject) continue;          // never yourself
    if (row?.attributes?.retracted) continue;
    const held = bySubject.get(row.subject) ?? [];
    held.push(row);
    bySubject.set(row.subject, held);
  }

  const found = [];
  for (const [candidate, rows] of bySubject) {
    // The same gate that governs introductions. A person mid-intake has not
    // agreed to be described to anybody, and mentioning them is a disclosure
    // even when no addresses change hands.
    if (!manager.isMatchable(candidate)) continue;

    const card = describe(candidate, rows, wanted);
    if (card) found.push(card);
  }

  if (found.length === 0) return false;

  return found
    .sort((a, b) => b.overlap.length - a.overlap.length)
    .slice(0, limit);
}

/**
 * One person, reduced to what may be said about them.
 *
 * Returns null when nothing lines up, so a card is never produced for somebody
 * the asker has no reason to hear about.
 */
function describe(id, rows, wanted) {
  const intents = rows.filter((row) => String(row.predicate ?? "").startsWith("intent:")
    && !isIntakeArtifact(row.object));

  const overlap = [...new Set(
    intents
      .flatMap((row) => significantWords(row.object))
      .filter((word) => wanted.has(word)),
  )].sort();

  // A document can substantiate the connection even when the words in their
  // stated intent do not line up — the same asymmetry matching relies on.
  const facts = documentFacts(rows);
  const factOverlap = [...new Set(
    facts
      .flatMap((row) => significantWords(row.object))
      .filter((word) => wanted.has(word)),
  )].sort();

  const shared = [...new Set([...overlap, ...factOverlap])];
  if (shared.length === 0) return null;

  const name = rows.find((row) => row.predicate === "is_person"
    || row.predicate === "is_organization")?.object ?? null;

  return Object.freeze({
    // The graph id, so the operator can open the profile and so a later
    // introduction can be proposed on the same subject. It is not an address.
    id,
    name,
    links: [...new Set(rows
      .filter((row) => PUBLIC_LINK_PREDICATES.has(row.predicate)
        || sourceKindOf(row.evidenceId) === SOURCE_KINDS.VENDOR && row.predicate === "profile_url")
      .map((row) => row.object)
      .filter(Boolean))],
    // What they are seeking or offering, in their words.
    intents: intents.map((row) => ({ type: String(row.predicate).replace(/^intent:/, ""), object: row.object })),
    // Typed facts only. Never the document text they came from.
    facts: CARD_FIELDS
      .flatMap((field) => facts
        .filter((row) => row.predicate === field)
        .map((row) => ({ field, value: row.object })))
      .slice(0, 6),
    overlap: shared,
    // Why this person is being mentioned, in a form the reply can use directly.
    because: `matches your interest in ${shared.slice(0, 3).join(", ")}`,
  });
}

/**
 * The fields a card is allowed to carry.
 *
 * Exported so the test can assert the shape rather than trusting the code that
 * builds it — the guarantee worth defending is "an email address can never
 * reach the model composing the reply", and that is a property of the whole
 * set of keys, not of any one line that produces them.
 */
export const CARD_KEYS = Object.freeze(["id", "name", "links", "intents", "facts", "overlap", "because"]);
