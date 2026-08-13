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
import { FIELDS, resolveField } from "../domain/profile-schema.js";

/**
 * The empty view, DERIVED from the field schema rather than written out here.
 *
 * It used to be a literal, which is how the view came to disagree with both the
 * extraction prompt and the qualification policy about what a field is called.
 * Sixteen span-verified facts from a real résumé were silently dropped because
 * of it. Building the shape from `FIELDS` means a field cannot exist for the
 * model and not for the view.
 */
function emptyView() {
  const profile = { evidenceByField: {} };
  for (const spec of Object.values(FIELDS)) {
    profile[spec.group] ??= {};
    profile[spec.group][spec.key] = spec.kind === "list" ? [] : null;
  }
  return profile;
}

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

  const profile = emptyView();

  for (const fact of facts) {
    const usable = fact.explicit === true || (includeConfirmed && fact.confirmed === true);
    if (!usable) continue;

    // Resolve through the schema, so a fact stored under a name the model chose
    // still lands in the field it is about. `via: "ignored"` is a deliberate
    // drop (contact details); `via: "unknown"` is a name nobody anticipated,
    // and dropping it is what this whole module exists to make visible rather
    // than silent — see `unmappedFields` below.
    const { field: path, spec } = resolveField(fact.field);
    if (!path || !spec) continue;

    const group = profile[spec.group];
    if (!group) continue;

    if (spec.kind === "scalar") {
      // First writer wins. Facts arrive in content-hash order, not document
      // order, so "last wins" would make the view depend on hashing — and §7.1
      // requires the same facts to produce the same breakdown on a rebuild.
      if (group[spec.key] === null || group[spec.key] === undefined) {
        group[spec.key] = fact.value;
      }
    } else if (!group[spec.key].includes(fact.value)) {
      group[spec.key].push(fact.value);
    }

    // The evidence id is the fact's own hash. Content-addressed, so a field's
    // evidence list is a set of pointers into the DAG rather than a name that
    // has to stay in sync with something. Recorded under the CANONICAL path,
    // because that is the name the qualification policy will look for.
    (profile.evidenceByField[path] ??= []).push(fact._hash ?? fact._id);
  }

  // Deterministic order, so two runs of the same facts produce the same view —
  // which is what lets §7.1's "same inputs, same breakdown" survive a rebuild.
  for (const [name, group] of Object.entries(profile)) {
    if (name === "evidenceByField") continue;
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

/**
 * Stored facts whose field name the schema cannot place.
 *
 * This exists because the failure it reports is invisible by construction: the
 * fact is in the store, its evidence is real, and the view simply does not
 * contain it. No error, no log line, no missing row — just a member who is
 * asked to supply something they already supplied.
 *
 * Anything here is either a field worth adding to `FIELDS` or an alias worth
 * adding to `ALIASES`. It should normally be empty.
 */
export function unmappedFields(store, memberId) {
  const facts = store.query(
    `FROM ${COLLECTIONS.PROFILE_FACTS} WHERE memberId = ${quote(memberId)}`,
  );
  const counts = new Map();
  for (const fact of facts) {
    if (resolveField(fact.field).via !== "unknown") continue;
    counts.set(fact.field, (counts.get(fact.field) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}
