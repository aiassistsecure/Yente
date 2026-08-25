/**
 * The manager — where a person outranks the machine.
 *
 * Yente is a matchmaker, and a matchmaker's judgment is the product. The scorer
 * exists to surface candidates a person would never have found by reading their
 * own inbox; it does not exist to decide. So every operation here writes human
 * judgment into the same graph the model writes into, at a HIGHER AUTHORITY, and
 * the projection sorts on authority before recency — which means a correction
 * cannot be undone by a later model run, however confident or recent.
 *
 * That property is enforced in one place (ObservationRepository.project) rather
 * than at every write site, because a rule spread across call sites is a rule
 * that will eventually be forgotten by whoever adds the next one.
 *
 * A HUMAN MATCH IS NOT A DIFFERENT KIND OF OBJECT
 *
 * `createMatch` writes to the same collection as the scorer, with
 * `origin: "human"` and `confidence: 1`. That is deliberate. Give human matches
 * their own table and you need a second renderer, a second explainer, a second
 * export path — and within a month one of the three has drifted and a curated
 * introduction renders wrong on the page that matters most. One collection, one
 * shape, one code path; the origin is a field.
 *
 * The scorer is then forbidden from re-opening anything a person has ruled on
 * (see GraphMatchRepository.propose). Running it again is safe by construction,
 * which matters because it will run on every tick forever.
 *
 * CORRECTIONS ARE OBSERVATIONS, NOT DELETIONS
 *
 * "These are the same person" does not merge two rows and lose the fact that we
 * once thought otherwise. It appends a claim, at user authority, that supersedes
 * the model's. So a merge is explainable — `TRACE caused_by` still reaches the
 * message — and reversible, because reversing it is another append rather than
 * an attempt to reconstruct deleted state.
 */

import { AUTHORITY, MATCH_ORIGIN, MATCH_STATES, matchPairKey } from "../store/graph.js";

export const CORRECTION = Object.freeze({
  SAME_PERSON: "same_person",
  DIFFERENT_PEOPLE: "different_people",
  WRONG_CLAIM: "wrong_claim",
  NOT_BUSINESS: "not_business",
  EXCLUDE_SUBJECT: "exclude_subject",
});

/**
 * @param {object} input
 * @param {object} input.graph  createGraphRepositories(store)
 * @param {string} [input.actor] who is deciding — recorded on every ruling
 */
export function createGraphManager({
  graph,
  actor = process.env.YENTE_OPERATOR || "operator",
  now = () => new Date().toISOString(),
}) {
  /* --- review queue --------------------------------------------------- */

  /**
   * What needs a human. Undecided proposals, best first, each carrying both
   * sides' quotes so the decision can be made from this payload alone without a
   * second round of lookups.
   */
  function pendingMatches({ limit = 50 } = {}) {
    return graph.matches
      .byState(MATCH_STATES.PROPOSED)
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))
      .slice(0, limit)
      .map((match) => ({
        ...match,
        id: matchPairKey(match),
        // Surfaced rather than buried: a proposal whose only merit is that the
        // predicates complement is exactly the "both mentioned AI" case, and the
        // person reviewing should see that before deciding, not after.
        thin: (match.conflicts ?? []).some((c) => c.id === "no_shared_specifics"),
      }));
  }

  /** Everything known about one subject, projected, newest-authority-first. */
  function subject(id) {
    const projected = graph.observations.project(id);
    const all = graph.observations.forSubject(id);
    return {
      id,
      // The current view — what Yente believes now.
      current: projected,
      // The full history, because §8 says a relationship is a memory and not a
      // row, and because a person reviewing a claim wants to see what it
      // replaced.
      history: all.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt))),
      intents: projected.filter((row) => String(row.predicate).startsWith("intent:")),
    };
  }

  /** Every subject the graph knows, with enough to render a list. */
  function subjects() {
    const bySubject = new Map();
    for (const row of graph.observations.all()) {
      const held = bySubject.get(row.subject) ?? {
        id: row.subject, claims: 0, lastSeen: null, name: null, kind: "person",
      };
      held.claims += 1;
      if (!held.lastSeen || String(row.observedAt) > String(held.lastSeen)) {
        held.lastSeen = row.observedAt;
      }
      if (row.predicate === "is_person") { held.name = row.object; held.kind = "person"; }
      if (row.predicate === "is_organization") { held.name = row.object; held.kind = "organization"; }
      bySubject.set(row.subject, held);
    }
    return [...bySubject.values()]
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  }

  /* --- ruling on matches ---------------------------------------------- */

  function confirmMatch({ matchId, note = null }) {
    const at = now();
    const match = graph.matches.decide({
      matchId, state: MATCH_STATES.CONFIRMED, by: actor, at, note,
    });
    if (!match) return null;
    graph.decisions.record({
      kind: "match", target: matchId, verdict: MATCH_STATES.CONFIRMED,
      by: actor, at, detail: { note, seeker: match.seeker, offerer: match.offerer },
    });
    return match;
  }

  /**
   * Reject, with a reason if there is one.
   *
   * §19's "this match isn't relevant" — and because the scorer will not re-open
   * a decided match, this is durable rather than advisory. Saying no once is
   * enough, which is the difference between a review queue and a treadmill.
   */
  function rejectMatch({ matchId, note = null }) {
    const at = now();
    const match = graph.matches.decide({
      matchId, state: MATCH_STATES.REJECTED, by: actor, at, note,
    });
    if (!match) return null;
    graph.decisions.record({
      kind: "match", target: matchId, verdict: MATCH_STATES.REJECTED,
      by: actor, at, detail: { note },
    });
    return match;
  }

  /**
   * A match a person made themselves.
   *
   * Confidence 1 — not as flattery, but because confidence here means "how sure
   * is the system that this pairing is real", and a person asserting it IS the
   * ground truth the scorer is trying to approximate. The reason is stated as
   * curation rather than dressed up as a computed breakdown, so nobody later
   * mistakes it for a score.
   */
  function createMatch({ seeker, offerer, matchType = "curated", note = null }) {
    if (!seeker || !offerer) throw new TypeError("a match needs both sides");
    if (seeker === offerer) throw new TypeError("cannot introduce a subject to itself");

    const at = now();
    const { match } = graph.matches.propose({
      seeker, offerer, matchType,
      confidence: 1,
      reasons: [{ id: "curated", weight: 1, detail: note || `curated by ${actor}` }],
      conflicts: [],
      // Evidence still comes from the graph, so a curated match is as
      // explainable as a scored one. If the person is right, the quotes exist;
      // if there are none, that absence is worth seeing on the card.
      evidence: [seeker, offerer].map((id) => {
        const intent = graph.observations.project(id)
          .find((row) => String(row.predicate).startsWith("intent:"));
        return {
          subject: id,
          quote: intent?.quote ?? null,
          evidenceId: intent?.evidenceId ?? null,
          said: intent?.object ?? null,
        };
      }),
      origin: MATCH_ORIGIN.HUMAN,
      at, note,
    });

    graph.decisions.record({
      kind: "match", target: matchPairKey({ seeker, offerer, matchType }),
      verdict: "CREATED", by: actor, at, detail: { note, seeker, offerer },
    });
    return { ...match, id: matchPairKey({ seeker, offerer, matchType }) };
  }

  /* --- correcting the graph ------------------------------------------- */

  /**
   * "These are the same person."
   *
   * Written as a claim at user authority rather than by rewriting rows. The
   * merge therefore keeps its provenance and can be reversed by asserting the
   * opposite, which is what §19 means by improving subsequent behaviour without
   * fighting the user.
   */
  function samePerson({ subjectA, subjectB, note = null }) {
    const at = now();
    const observation = graph.observations.append({
      subject: subjectA,
      predicate: "same_as",
      object: subjectB,
      evidenceId: null,
      quote: note || `asserted by ${actor}`,
      authority: AUTHORITY.USER_CORRECTION,
      confidence: 1,
      observedAt: at,
    });
    graph.decisions.record({
      kind: "identity", target: subjectA, verdict: CORRECTION.SAME_PERSON,
      by: actor, at, detail: { subjectB, note },
    });
    return observation;
  }

  function differentPeople({ subjectA, subjectB, note = null }) {
    const at = now();
    const observation = graph.observations.append({
      subject: subjectA,
      predicate: "not_same_as",
      object: subjectB,
      evidenceId: null,
      quote: note || `asserted by ${actor}`,
      authority: AUTHORITY.USER_CORRECTION,
      confidence: 1,
      observedAt: at,
    });
    graph.decisions.record({
      kind: "identity", target: subjectA, verdict: CORRECTION.DIFFERENT_PEOPLE,
      by: actor, at, detail: { subjectB, note },
    });
    return observation;
  }

  /**
   * "This interpretation is wrong."
   *
   * Supersedes the claim instead of deleting it. The wrong reading stays
   * queryable — which is how we ever learn that a particular model and schema
   * version got a particular kind of sentence wrong.
   */
  function wrongClaim({ observationId, note = null }) {
    const at = now();
    const target = graph.observations.all().find((row) => row.id === observationId)
      ?? graph.observations.all().find((row) => row._id === observationId);
    if (!target) return null;

    const observation = graph.observations.append({
      subject: target.subject,
      predicate: target.predicate,
      object: target.object,
      attributes: { retracted: true },
      evidenceId: target.evidenceId,
      quote: note || `retracted by ${actor}`,
      authority: AUTHORITY.USER_CORRECTION,
      confidence: 0,
      observedAt: at,
      supersedes: observationId,
    });
    graph.decisions.record({
      kind: "observation", target: observationId, verdict: CORRECTION.WRONG_CLAIM,
      by: actor, at, detail: { note, subject: target.subject },
    });
    return observation;
  }

  /**
   * "Don't use this person for matchmaking."
   *
   * §20. Recorded as a claim so it is visible and reversible rather than a
   * hidden filter somebody has to remember exists. `isEligible` is the one place
   * that reads it.
   */
  function excludeSubject({ subject: id, note = null }) {
    const at = now();
    const observation = graph.observations.append({
      subject: id,
      predicate: "matchmaking_excluded",
      object: "true",
      evidenceId: null,
      quote: note || `excluded by ${actor}`,
      authority: AUTHORITY.USER_CORRECTION,
      confidence: 1,
      observedAt: at,
    });
    graph.decisions.record({
      kind: "privacy", target: id, verdict: CORRECTION.EXCLUDE_SUBJECT,
      by: actor, at, detail: { note },
    });
    return observation;
  }

  function isEligible(id) {
    return !graph.observations
      .project(id)
      .some((row) => row.predicate === "matchmaking_excluded" && row.object === "true");
  }

  /** Counts for the header, so the operator can see the loop moving. */
  function summary() {
    const matches = graph.matches.all();
    return {
      subjects: subjects().length,
      observations: graph.observations.all().length,
      jobs: graph.jobs.counts(),
      matches: {
        proposed: matches.filter((m) => m.state === MATCH_STATES.PROPOSED).length,
        confirmed: matches.filter((m) => m.state === MATCH_STATES.CONFIRMED).length,
        rejected: matches.filter((m) => m.state === MATCH_STATES.REJECTED).length,
        curated: matches.filter((m) => m.origin === MATCH_ORIGIN.HUMAN).length,
      },
      decisions: graph.decisions.all().length,
    };
  }

  return Object.freeze({
    pendingMatches, subject, subjects, summary,
    confirmMatch, rejectMatch, createMatch,
    samePerson, differentPeople, wrongClaim, excludeSubject, isEligible,
    actor,
  });
}
