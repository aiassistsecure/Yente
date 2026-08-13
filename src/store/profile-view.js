/**
 * Profile views — SPEC v2 §6.1 and §12.
 *
 * "The normalized profile is a materialized view; evidence records remain the
 * source of truth."
 *
 * Until now `qualify()` took a profile from its caller, which meant the runtime
 * asked a question — *what does this member's profile say?* — that only the
 * store could answer, and the D8 test supplied the answer by hand. That is a
 * policy decision sitting in a test fixture.
 *
 * This builds the profile from stored `profile_facts`, so the answer comes from
 * evidence that was span-verified on the way in.
 *
 * TWO RULES, BOTH FROM §6.2 AND INV-3:
 *
 * 1. Only EXPLICIT facts populate the view. An inferred fact is grounded — the
 *    words are in the document — but grounding proves the words exist, not that
 *    the document means what the model concluded. Inferred facts become
 *    interview questions and reach the view only once a member confirms them.
 *
 * 2. `evidenceByField` is built from the same facts, so a field can never be
 *    present without evidence. `evaluateQualification` checks both, and a view
 *    that could satisfy one and not the other would make the check theatre.
 */

import { COLLECTIONS } from "./db.js";
import { quote } from "./db.js";

/** Fields the view carries, in §6.1's shape. */
const SCALAR_FIELDS = new Set(["professional.seniority", "professional.years_experience"]);

/**
 * Materialise one member's profile from stored facts.
 *
 * @param {import("./db.js").Store} store
 * @param {string} memberId
 * @param {object} [options]
 * @param {boolean} [options.includeConfirmed] treat member-confirmed inferred
 *   facts as explicit. Confirmation is recorded on the fact, not here.
 * @returns {object} a profile shaped for evaluateQualification
 */
export function buildProfileView(store, memberId, { includeConfirmed = true } = {}) {
  const facts = store.query(
    `FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(memberId)}`,
  );

  const profile = {
    professional: { roles: [], industries: [], capabilities: [], seniority: null, years_experience: null, geographies: [] },
    intent: { offers: [], seeks: [], introductionTypes: [], constraints: [] },
    evidenceByField: {},
  };

  for (const fact of facts) {
    const usable = fact.explicit === true || (includeConfirmed && fact.confirmed === true);
    if (!usable) continue;

    const path = String(fact.field);
    const target = pathTarget(profile, path);
    if (!target) continue;

    if (SCALAR_FIELDS.has(path)) {
      target.object[target.key] = fact.value;
    } else if (Array.isArray(target.object[target.key])) {
      if (!target.object[target.key].includes(fact.value)) target.object[target.key].push(fact.value);
    } else {
      target.object[target.key] = fact.value;
    }

    // The evidence id is the fact's own hash. Content-addressed, so a field's
    // evidence list is a set of pointers into the DAG rather than a name that
    // has to stay in sync with something.
    (profile.evidenceByField[path] ??= []).push(fact._hash ?? fact._id);
  }

  // Deterministic order, so two runs of the same facts produce the same view —
  // which is what lets §7.1's "same inputs, same breakdown" survive a rebuild.
  for (const group of [profile.professional, profile.intent]) {
    for (const [key, value] of Object.entries(group)) {
      if (Array.isArray(value)) group[key] = [...value].sort();
    }
  }
  for (const key of Object.keys(profile.evidenceByField)) {
    profile.evidenceByField[key] = [...new Set(profile.evidenceByField[key])].sort();
  }

  return profile;
}

/**
 * Materialise and persist. §12 lists `profile_views` as rebuildable, so this is
 * a cache with a provenance chain, not a second source of truth: every view
 * cites the facts it was built from, and dropping the collection loses nothing.
 */
export function saveProfileView(store, memberId, { causedBy = [] } = {}) {
  const facts = store.query(`FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(memberId)}`);
  const view = buildProfileView(store, memberId);
  return store.put(
    COLLECTIONS.PROFILE_VIEWS,
    memberId,
    { memberId, ...view, factCount: facts.length, builtAt: new Date().toISOString() },
    { causedBy: causedBy.length > 0 ? causedBy : facts },
  );
}

function pathTarget(profile, path) {
  const parts = path.split(".");
  if (parts.length !== 2) return null;
  const [group, key] = parts;
  if (!Object.hasOwn(profile, group)) return null;
  if (!Object.hasOwn(profile[group], key)) return null;
  return { object: profile[group], key };
}
