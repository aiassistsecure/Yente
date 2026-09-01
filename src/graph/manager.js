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
import {
  PROFILE_STATES, PROFILE_STATE_PREDICATE,
  isLegalTransition, isQualified, profileState, isIntakeArtifact,
} from "./qualification.js";
import {
  buildIdentityIndex, resolveObservations, proposeIdentityMerges,
} from "./identity.js";
import { documentVocabulary, groupBySource, significantWords, sourceKindOf } from "./provenance.js";
import { searchMatches } from "./discovery.js";

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
  // Both-parties consent (Mark, 2026-09-01): operator confirmation opens a
  // consent round — each party is mailed the other's evidenced profile card
  // and the introduction sends only when both reply yes. Off restores the
  // operator-only instant send.
  partyApproval = false,
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

  function coveringMessageId(evidenceId, row) {
    if (!evidenceId) return null;
    if (String(evidenceId).startsWith("message:")) return evidenceId;
    return row?.meta?.messageEvidenceId ?? null;
  }

  function threadHrefFor(evidenceId, row = null) {
    const messageId = coveringMessageId(evidenceId, row ?? graph.evidence.get(evidenceId));
    return messageId ? `/thread?id=${encodeURIComponent(messageId)}` : null;
  }

  /**
   * One conversation: covering message, siblings that share threadId, attachments,
   * and every claim mined from that mail. The overseer's way into the inbox from
   * a graph belief.
   */
  function thread(id) {
    const root = graph.evidence.get(id);
    if (!root) return null;
    const coveringId = coveringMessageId(id, root) ?? id;
    const covering = graph.evidence.get(coveringId) ?? root;
    const threadKey = covering.meta?.threadId ?? covering.meta?.rfcMessageId ?? coveringId;
    const messages = graph.evidence.all()
      .filter((row) => {
        if (row.kind !== "message") return false;
        const key = row.meta?.threadId ?? row.meta?.rfcMessageId ?? row.id ?? row._id;
        return key === threadKey || (row.id ?? row._id) === coveringId;
      })
      .sort((a, b) => String(a.meta?.sentAt ?? a.receivedAt ?? "")
        .localeCompare(String(b.meta?.sentAt ?? b.receivedAt ?? "")));
    const messageIds = new Set(messages.map((m) => m.id ?? m._id));
    const attachments = graph.evidence.all().filter((row) =>
      row.kind === "attachment" && (
        messageIds.has(row.meta?.messageEvidenceId)
        // A deduped document carried by a LATER email in this thread. The
        // first covering message keeps its slot; every later carrier is in
        // coveringMessages — without this the manager showed a résumé on one
        // email and nothing on the four that carried the same file.
        || (row.meta?.coveringMessages ?? []).some((id) => messageIds.has(id))
      ));
    const evidenceIds = [...messageIds, ...attachments.map((a) => a.id ?? a._id)];
    const claims = graph.observations.all().filter((row) => evidenceIds.includes(row.evidenceId));
    return {
      id: coveringId,
      threadId: threadKey,
      rfcMessageId: covering.meta?.rfcMessageId ?? null,
      subject: covering.meta?.subject ?? "(no subject)",
      from: covering.meta?.from ?? null,
      to: covering.meta?.to ?? [],
      sentAt: covering.meta?.sentAt ?? covering.receivedAt ?? null,
      messages: messages.map((m) => ({ id: m.id ?? m._id, ...m })),
      attachments: attachments.map((a) => ({ id: a.id ?? a._id, ...a })),
      claims,
    };
  }

  /**
   * The profile. Everything known about one person or organisation.
   *
   * Reads through identity resolution, so a person with two addresses is ONE
   * profile carrying claims that arrived under either — with `originalSubject`
   * marking which, because a merge you cannot audit is a merge you have to
   * trust.
   */
  function subject(id) {
    const resolved = resolveObservations(graph.observations.all());
    const index = buildIdentityIndex(graph.observations.all());
    const canonical = index.canonical(id);
    const mine = resolved.filter((row) => row.subject === canonical);

    // Project over the merged set rather than the stored one, or a claim that
    // arrived under an alias would be invisible on the profile that owns it.
    const byPredicate = new Map();
    for (const row of mine) {
      const key = `${row.predicate}${row.object ?? ""}`;
      const held = byPredicate.get(key);
      const better = !held
        || row.authority > held.authority
        || (row.authority === held.authority
            && String(row.observedAt) > String(held.observedAt));
      if (better) byPredicate.set(key, row);
    }
    const current = [...byPredicate.values()]
      .filter((row) => !row.attributes?.retracted);

    const evidenceIds = [...new Set(mine.map((r) => r.evidenceId).filter(Boolean))];

    return {
      id: canonical,
      aliases: index.aliasesOf(canonical).filter((a) => a !== canonical),
      name: current.find((r) => r.predicate === "is_person" || r.predicate === "is_organization")?.object ?? null,
      kind: current.some((r) => r.predicate === "is_organization") ? "organization" : "person",
      title: current.find((r) => r.attributes?.title)?.attributes?.title ?? null,
      current,
      intents: current.filter((row) => String(row.predicate).startsWith("intent:")),
      // Who they are connected to, and how. §10's Connections.
      relationships: current.filter((row) =>
        ["works_at", "knows", "communicated_with", "introduced", "associated_with"]
          .includes(row.predicate)),
      proposals: current.filter((row) => String(row.predicate).startsWith("proposal:")),
      opportunities: current.filter((row) => row.predicate === "opportunity"),
      notes: current.filter((row) => row.predicate === "note"),
      // §8: the memory, not the row. A reviewer wants to see what a claim
      // replaced, and which claims were retracted.
      history: mine
        .slice()
        .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt))),
      // The documents and messages this profile was built from — §10's Documents
      // tab, and the answer to "where did all this come from".
      //
      // Each one carries the claims IT produced, because the flat list answered
      // "what do we hold" and not "which of this belongs where". A reviewer
      // needs to see that a job title came from a CV and a budget came from an
      // email — those deserve different amounts of trust, and one
      // undifferentiated list of everything Yente believes hides the difference.
      evidence: evidenceIds
        .map((eid) => {
          const row = graph.evidence.get(eid);
          if (!row) return null;
          const claims = mine.filter((r) => r.evidenceId === eid);
          return {
            id: eid,
            ...row,
            sourceKind: sourceKindOf(eid),
            claimCount: claims.length,
            claims,
            threadHref: threadHrefFor(eid, row),
          };
        })
        .filter(Boolean)
        .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))),

      // The same claims, organised by what produced them: what they wrote to
      // us, what their résumé says, what their portfolio says, what a person
      // here corrected by hand.
      sources: groupBySource(current),

      // What their documents can vouch for — the vocabulary that substantiates
      // their stated intents during matching. Surfaced on the profile because
      // "why did this match" and "why did this NOT match" are the same
      // question, and neither is answerable without seeing what Yente can
      // actually evidence about the person.
      substantiated: [...documentVocabulary(mine).values()]
        .sort((a, b) => a.word.localeCompare(b.word)),

      // §14, and labelled as what it is: a calculated signal, not a claim about
      // the relationship itself.
      signal: relationshipSignal(mine),
      eligible: isEligible(canonical),
      profileState: profileState(graph.observations.project(canonical)),
      matchable: isMatchable(canonical),
      matches: graph.matches.all()
        .filter((m) => m.seeker === canonical || m.offerer === canonical)
        .map((m) => ({ ...m, id: matchPairKey(m) })),
    };
  }

  /**
   * Yente's calculated relationship signal.
   *
   * §14 is explicit that this must not pretend to be psychological truth, so it
   * is named for what it is and computed from things we can literally count:
   * how many distinct messages, over how long, how recently, how many documents.
   * No weighting theatre — the inputs are shown so a person can disagree with
   * the number.
   */
  function relationshipSignal(rows) {
    if (rows.length === 0) return { strength: "none", inputs: {} };
    const evidence = new Set(rows.map((r) => r.evidenceId).filter(Boolean));
    const dates = rows.map((r) => String(r.validFrom ?? r.observedAt)).filter(Boolean).sort();
    const spanDays = dates.length > 1
      ? Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86_400_000)
      : 0;
    const lastSeen = dates[dates.length - 1] ?? null;
    const daysSince = lastSeen
      ? Math.round((Date.now() - new Date(lastSeen).getTime()) / 86_400_000)
      : null;

    const inputs = {
      distinctEvidence: evidence.size,
      claims: rows.length,
      spanDays,
      daysSinceLast: daysSince,
    };

    // Deliberately coarse. A finer scale would imply a precision these inputs
    // do not support.
    let strength = "new";
    if (evidence.size >= 8 && (daysSince ?? 999) < 30) strength = "strong";
    else if (evidence.size >= 3) strength = "growing";
    else if ((daysSince ?? 0) > 180) strength = "dormant";

    return { strength, inputs, label: "Yente's calculated signal, not a fact about the person" };
  }

  /**
   * Identity merges worth a human's attention. Never applied automatically —
   * see the asymmetry note in identity.js: a missed merge costs a click, a
   * wrong one conflates two people's intents and then introduces somebody on a
   * claim they never made.
   */
  function pendingIdentities({ limit = 20 } = {}) {
    const observations = graph.observations.all();
    const evidenceById = {};
    for (const id of new Set(observations.map((r) => r.evidenceId).filter(Boolean))) {
      const row = graph.evidence.get(id);
      if (row) evidenceById[id] = row;
    }
    return proposeIdentityMerges({
      observations,
      evidenceById,
      existingSubjects: subjects().map((s) => s.id),
    }).slice(0, limit);
  }

  /** Every subject the graph knows, with enough to render a list. */
  function subjects() {
    const bySubject = new Map();
    for (const row of resolveObservations(graph.observations.all())) {
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
    // Party approval: the operator's yes is gate ONE. The match enters the
    // consent round; both parties get the other's card and the introduction
    // waits for two legible approvals. A match whose sides are not both
    // email-keyed people cannot run a consent round and confirms directly.
    if (partyApproval) {
      const held = graph.matches.get(matchId);
      const bothPeople = held
        && /^person:[^\s@]+@[^\s@]+$/.test(String(held.seeker))
        && /^person:[^\s@]+@[^\s@]+$/.test(String(held.offerer));
      if (bothPeople) {
        const match = graph.matches.awaitParties(matchId, { by: actor, at });
        if (!match) return null;
        graph.decisions.record({
          kind: "match", target: matchId, verdict: MATCH_STATES.AWAITING_PARTIES,
          by: actor, at, detail: { note, seeker: match.seeker, offerer: match.offerer },
        });
        return match;
      }
    }
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

  /**
   * Can this person be introduced to anyone RIGHT NOW?
   *
   * Two conditions, and the second is new: they must not be excluded, AND they
   * must have approved their own profile. Before that approval a person is
   * mid-onboarding — Yente has read a document about them and drawn
   * conclusions, but they have not seen those conclusions or agreed to them.
   *
   * Introducing on unapproved facts is the failure the résumé match exposed:
   * both parties were mid-intake, so no introduction should have existed at
   * all, whatever the scorer made of the word "resume".
   *
   * `isEligible` stays as it was — exclusion is a separate, reversible act by
   * the operator — so the two reasons a person is not matchable never collapse
   * into one unreadable boolean.
   */
  function isMatchable(id) {
    return isEligible(id) && isQualified(graph.observations.project(id));
  }

  /**
   * Move a person along the intake lifecycle.
   *
   * Recorded as an observation rather than a column so that "when did they
   * qualify, and on the strength of what" is answerable by TRACE. An illegal
   * move throws: a lifecycle that silently accepts any transition is a
   * lifecycle that is not enforcing anything.
   */
  function setProfileState({ subject: id, state, evidenceId = null, quote = null, by = null }) {
    const rows = graph.observations.project(id);
    const current = profileState(rows);
    if (!isLegalTransition(current, state)) {
      throw new Error(`cannot move ${id} from ${current} to ${state}`);
    }
    // STRICTLY AFTER the previous state row. The projection orders states by
    // observedAt, and project() returns rows in hash order — so two
    // transitions inside the same millisecond (two quick operator clicks, a
    // scripted walk) would tie and the WINNER would be a coin flip. A
    // lifecycle that can silently lose a step is not enforcing anything, so
    // the clock is bumped rather than trusted here.
    const latestStateAt = rows
      .filter((row) => row.predicate === PROFILE_STATE_PREDICATE)
      .map((row) => String(row.observedAt ?? ""))
      .sort()
      .pop() ?? "";
    let at = now();
    if (at <= latestStateAt) {
      at = new Date(new Date(latestStateAt).getTime() + 1).toISOString();
    }
    const observation = graph.observations.append({
      subject: id,
      predicate: PROFILE_STATE_PREDICATE,
      object: state,
      evidenceId,
      quote: quote || `${current} -> ${state}`,
      // The person's own approval is a correction in the strongest sense: it
      // outranks every inference the pipeline made about them.
      authority: state === PROFILE_STATES.QUALIFIED || by
        ? AUTHORITY.USER_CORRECTION
        : AUTHORITY.DETERMINISTIC,
      confidence: 1,
      observedAt: at,
    });
    graph.decisions.record({
      kind: "profile", target: id, verdict: state,
      by: by || actor, at, detail: { from: current, evidenceId },
    });
    return observation;
  }

  function profileStateOf(id) {
    return profileState(graph.observations.project(id));
  }

  /**
   * AUTO-QUALIFICATION — Mark's directive, 2026-09-01: "fix the damn code to
   * automate matching, I know I can manually match it but thats not what I
   * want." Intake has been autonomous since the same directive put the HITL
   * on the INTRODUCTION queue; the graph lifecycle just never got the memo,
   * and every subject sat at `new` until an operator clicked four buttons.
   *
   * A subject is promoted straight to QUALIFIED when the graph can already
   * stand behind them:
   *   - a NAMED person (is_person; orgs are subjects, not members)
   *   - at least one live intent that is not an intake artifact, OR a graded
   *     proposal (Yente's own read of their documents)
   *   - at least `minClaims` live claims in total
   *   - eligible (not operator-excluded)
   *
   * What it will NEVER do: resurrect a DECLINED person (no is no), touch an
   * excluded subject, or move anybody backwards. Every hop is a normal
   * setProfileState — legal transitions, recorded rulings, TRACE answers
   * "when did they qualify, and on the strength of what" with the reason
   * written here. The human gate stays where the directive put it: the
   * introduction review queue.
   */
  function autoQualify({ minClaims = 3 } = {}) {
    const NEXT = {
      [PROFILE_STATES.NEW]: PROFILE_STATES.RECEIVED,
      [PROFILE_STATES.ASKED]: PROFILE_STATES.RECEIVED,
      [PROFILE_STATES.RECEIVED]: PROFILE_STATES.DRAFTED,
      [PROFILE_STATES.DRAFTED]: PROFILE_STATES.AWAITING_APPROVAL,
      [PROFILE_STATES.AWAITING_APPROVAL]: PROFILE_STATES.QUALIFIED,
    };
    const promoted = [];
    const resolved = resolveObservations(graph.observations.all())
      .filter((row) => !row?.attributes?.retracted);
    const bySubject = new Map();
    for (const row of resolved) {
      const held = bySubject.get(row.subject) ?? [];
      held.push(row);
      bySubject.set(row.subject, held);
    }

    for (const [id, rows] of bySubject) {
      if (!isEligible(id)) continue;
      const state = profileStateOf(id);
      if (state === PROFILE_STATES.QUALIFIED || state === PROFILE_STATES.DECLINED) continue;

      const named = rows.some((row) => row.predicate === "is_person");
      if (!named) continue;
      const substance = rows.some((row) => {
        const predicate = String(row.predicate);
        if (predicate.startsWith("proposal:")) return true;
        return predicate.startsWith("intent:") && !isIntakeArtifact(row.object);
      });
      if (!substance) continue;
      const claims = rows.filter((row) => row.predicate !== PROFILE_STATE_PREDICATE).length;
      if (claims < minClaims) continue;

      const reason = `auto-qualified: named person, ${claims} verified claims, `
        + "live intent or graded proposal on file";
      let current = state;
      while (current !== PROFILE_STATES.QUALIFIED) {
        const next = NEXT[current];
        if (!next) break;
        setProfileState({ subject: id, state: next, quote: reason, by: "yente:auto" });
        current = next;
      }
      if (current === PROFILE_STATES.QUALIFIED) {
        promoted.push({ subject: id, from: state, claims });
      }
    }
    return promoted;
  }


  /** Counts for the header, so the operator can see the loop moving. */
  /**
   * SEARCH THE WHOLE GRAPH — the gap Mark named: every belief Yente holds was
   * findable only by knowing which profile page it lived on. Now one query
   * sweeps subjects, claims, and evidence in a single pass, identity-resolved
   * so a claim that arrived under an alias is found on the profile that owns
   * it, and every hit links to where it lives (/subject, /thread).
   *
   * Word-matched with the SAME tokenizer matching uses (significantWords —
   * keeps c#, c++, node.js), so "what search finds" and "what matching sees"
   * cannot drift apart. Filters compose with the words:
   *
   *   kind    a predicate or namespace: "capability", "intent" (any intent:*),
   *           "proposal" (any proposal:*), "role_declared", "proposal:hire_for"
   *   grade   proposals only: good | strong | exceptional
   *   source  where the claim came from: message | attachment | link | vendor
   *
   * Returns {subjects, claims, evidence, total, query}. Never an email
   * address on a claim or evidence hit beyond what the subject id itself is —
   * this surface is the OPERATOR's, unlike discovery cards, so subject ids
   * (which are addresses by design) do appear, exactly as they do on every
   * other manager page.
   */
  function searchGraph({ query = null, kind = null, grade = null, source = null, limit = 20 } = {}) {
    const words = new Set(significantWords(String(query ?? "")));
    const wantKind = kind ? String(kind).toLowerCase() : null;
    const wantGrade = grade ? String(grade).toLowerCase() : null;
    const wantSource = source ? String(source).toLowerCase() : null;
    const hasFilters = Boolean(wantKind || wantGrade || wantSource);
    if (words.size === 0 && !hasFilters) {
      return { query: query ?? "", subjects: [], claims: [], evidence: [], total: 0 };
    }

    const matchWords = (text) => {
      if (words.size === 0) return [];
      const found = [];
      for (const word of significantWords(String(text ?? ""))) {
        if (words.has(word)) found.push(word);
      }
      return [...new Set(found)];
    };

    const kindMatches = (predicate) => {
      if (!wantKind) return true;
      const p = String(predicate).toLowerCase();
      // "intent" and "proposal" sweep their namespaces; an exact predicate
      // (or exact namespaced form) matches itself.
      if (wantKind === "intent") return p.startsWith("intent:");
      if (wantKind === "proposal") return p.startsWith("proposal:");
      return p === wantKind || p === `intent:${wantKind}` || p === `proposal:${wantKind}`;
    };

    const resolved = resolveObservations(graph.observations.all())
      .filter((row) => !row?.attributes?.retracted);

    // Claims: every filter must agree, and when there ARE query words at
    // least one must appear in the claim's own text.
    const claimHits = [];
    for (const row of resolved) {
      if (!kindMatches(row.predicate)) continue;
      if (wantGrade && String(row.attributes?.grade ?? "").toLowerCase() !== wantGrade) continue;
      if (wantSource && sourceKindOf(row.evidenceId) !== wantSource) continue;
      const matched = matchWords(`${row.predicate} ${row.object ?? ""} ${row.quote ?? ""}`);
      if (words.size > 0 && matched.length === 0) continue;
      claimHits.push({
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        grade: row.attributes?.grade ?? null,
        quote: row.quote ?? null,
        confidence: row.confidence ?? null,
        authority: row.authority ?? null,
        sourceKind: sourceKindOf(row.evidenceId),
        evidenceId: row.evidenceId ?? null,
        observedAt: row.observedAt ?? null,
        matched,
        subjectHref: `/subject?id=${encodeURIComponent(row.subject)}`,
        threadHref: row.evidenceId ? threadHrefFor(row.evidenceId) : null,
      });
    }
    claimHits.sort((a, b) => b.matched.length - a.matched.length
      || String(b.observedAt).localeCompare(String(a.observedAt)));

    // Subjects: matched by name/id words, or swept in via their claim hits so
    // a filter-only search ("every strong hire_for proposal") still says WHO.
    const claimSubjects = new Set(claimHits.map((hit) => hit.subject));
    const subjectHits = subjects()
      .map((entry) => {
        const matched = matchWords(`${entry.name ?? ""} ${entry.id}`);
        const viaClaims = claimSubjects.has(entry.id);
        if (matched.length === 0 && !viaClaims) return null;
        return {
          ...entry,
          matched,
          viaClaims,
          href: `/subject?id=${encodeURIComponent(entry.id)}`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matched.length - a.matched.length || b.claims - a.claims);

    // Evidence: subject lines, senders, filenames — the operator's "which
    // email was that" question, answered without opening profiles.
    const evidenceHits = [];
    if (words.size > 0) {
      for (const row of graph.evidence.all()) {
        const meta = row.meta ?? {};
        const matched = matchWords(
          `${meta.subject ?? ""} ${meta.from ?? ""} ${meta.filename ?? ""} ${meta.name ?? ""}`);
        if (matched.length === 0) continue;
        if (wantSource && sourceKindOf(row.id ?? row._id) !== wantSource) continue;
        evidenceHits.push({
          id: row.id ?? row._id,
          kind: row.kind ?? sourceKindOf(row.id ?? row._id),
          subject: meta.subject ?? null,
          from: meta.from ?? null,
          filename: meta.filename ?? null,
          receivedAt: row.receivedAt ?? null,
          matched,
          threadHref: threadHrefFor(row.id ?? row._id, row),
        });
      }
      evidenceHits.sort((a, b) => b.matched.length - a.matched.length
        || String(b.receivedAt).localeCompare(String(a.receivedAt)));
    }

    return {
      query: query ?? "",
      filters: { kind: wantKind, grade: wantGrade, source: wantSource },
      subjects: subjectHits.slice(0, limit),
      claims: claimHits.slice(0, limit),
      evidence: evidenceHits.slice(0, limit),
      total: subjectHits.length + claimHits.length + evidenceHits.length,
    };
  }

  /**
   * THE NUMBERS BEHIND THE DESK — summary() says how much; this says what,
   * from where, how good, and how it is moving. Everything is counted from
   * rows that exist, no estimation anywhere, so every number here can be
   * clicked through to the rows it counts via /search.
   */
  function stats() {
    const all = graph.observations.all();
    const live = resolveObservations(all).filter((row) => !row?.attributes?.retracted);
    const count = (rows, keyOf) => {
      const held = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        if (key === null || key === undefined || key === "") continue;
        held.set(key, (held.get(key) ?? 0) + 1);
      }
      return [...held.entries()].sort((a, b) => b[1] - a[1])
        .map(([key, n]) => ({ key, n }));
    };

    const confidences = live.map((r) => Number(r.confidence)).filter(Number.isFinite);
    const proposalsRows = live.filter((r) => String(r.predicate).startsWith("proposal:"));
    const roster = subjects();
    const matches = graph.matches.all();

    // Fourteen days of arrival, so "is it moving" is a glance and a stall is
    // a visible flat line rather than a feeling.
    const days = [];
    for (let back = 13; back >= 0; back -= 1) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      days.push({
        day,
        claims: live.filter((r) => String(r.observedAt ?? "").startsWith(day)).length,
        evidence: graph.evidence.all()
          .filter((r) => String(r.receivedAt ?? "").startsWith(day)).length,
      });
    }

    return {
      ...summary(),
      people: {
        total: roster.length,
        byState: count(roster, (s) => profileStateOf(s.id)),
        matchable: roster.filter((s) => isMatchable(s.id)).length,
        organizations: roster.filter((s) => s.kind === "organization").length,
      },
      claims: {
        total: live.length,
        stored: all.length,
        byPredicate: count(live, (r) => r.predicate).slice(0, 25),
        bySourceKind: count(live, (r) => sourceKindOf(r.evidenceId)),
        byAuthority: count(live, (r) => r.authority),
        byModel: count(live, (r) => r.model ?? r.provenance?.model ?? null),
        averageConfidence: confidences.length
          ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3))
          : null,
      },
      proposals: {
        total: proposalsRows.length,
        byKind: count(proposalsRows, (r) => String(r.predicate).slice("proposal:".length)),
        byGrade: count(proposalsRows, (r) => r.attributes?.grade ?? "good"),
        graded: [...new Set(proposalsRows.map((r) => r.subject))].length,
      },
      evidence: {
        total: graph.evidence.all().length,
        byKind: count(graph.evidence.all(), (r) => r.kind ?? sourceKindOf(r.id ?? r._id)),
      },
      vocabulary: count(
        live.flatMap((r) => ["attachment", "link", "vendor"]
          .includes(sourceKindOf(r.evidenceId))
          ? significantWords(String(r.object ?? "")) : []),
        (word) => word,
      ).slice(0, 25),
      matchQuality: {
        averageConfidence: matches.length
          ? Number((matches.reduce((a, b) => a + Number(b.confidence ?? 0), 0)
              / matches.length).toFixed(3))
          : null,
        byType: count(matches, (m) => m.matchType).slice(0, 10),
      },
      activity: days,
    };
  }

  function summary() {
    const matches = graph.matches.all();
    return {
      subjects: subjects().length,
      observations: graph.observations.all().length,
      jobs: graph.jobs.counts(),
      matches: {
        proposed: matches.filter((m) => m.state === MATCH_STATES.PROPOSED).length,
        confirmed: matches.filter((m) => m.state === MATCH_STATES.CONFIRMED).length,
        sending: matches.filter((m) => m.state === MATCH_STATES.INTRODUCTION_SENDING).length,
        introduced: matches.filter((m) => m.state === MATCH_STATES.INTRODUCED).length,
        rejected: matches.filter((m) => m.state === MATCH_STATES.REJECTED).length,
        curated: matches.filter((m) => m.origin === MATCH_ORIGIN.HUMAN).length,
      },
      decisions: graph.decisions.all().length,
    };
  }

  return Object.freeze({
    pendingMatches, pendingIdentities, subject, subjects, thread, threadHrefFor, summary,
    searchGraph, stats,
    // search_matches_or_return_false — the discovery search, bound to this
    // graph. Named for what a caller must handle: false means there is nobody,
    // say so or say nothing; never an empty list rendered enthusiastically.
    // Cards structurally cannot carry an email address (see discovery.js), so
    // this is safe to hand to ANY reply-composing surface, model included.
    searchMatchesOrReturnFalse: ({ subject: who, query = null, limit = 3 } = {}) =>
      searchMatches({ graph, manager: { isMatchable }, subject: who, query, limit }),
    confirmMatch, rejectMatch, createMatch,
    samePerson, differentPeople, wrongClaim, excludeSubject, isEligible,
    // Matchability is deliberately separate from eligibility: one is the
    // operator excluding somebody, the other is the person not having approved
    // their profile yet. Collapsing them would make "why isn't this person
    // matching" unanswerable.
    isMatchable, setProfileState, profileStateOf, autoQualify,
    relationshipSignal,
    actor,
  });
}
