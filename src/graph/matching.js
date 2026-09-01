/**
 * Who should know whom.
 *
 * This is the payoff, and it is deliberately deterministic. The model's job
 * finished upstream: it read the mail and proposed observations, each of which
 * had to quote its source to survive. By the time we get here every input is a
 * verified claim with a traceable quote, and the question left is arithmetic
 * over predicates.
 *
 * "A match must not simply be 'both emails mentioned AI'." That is the failure
 * mode this file exists to avoid, and the guard against it is not a cleverer
 * scorer — it is that a match must name COMPLEMENTARY INTENT between two
 * different people, with the quote that supports each side. Topic overlap alone
 * cannot produce a match here because topic overlap is not one of the inputs.
 *
 * WHY NOT ASK THE MODEL TO DO THE MATCHING
 *
 * Because §16 is right: deterministic systems are better at the deterministic
 * part, and a scored pair with a stated breakdown can be explained, replayed,
 * and argued with. An LLM asked "who should meet?" produces a confident sentence
 * with no auditable structure underneath, and the one thing a matchmaker cannot
 * afford is an introduction it cannot justify.
 *
 * The confidence is a stated function of matched attributes, never a number a
 * model chose. Every observation we have carries `confidence: 1.00` from the
 * model — five of six on one real run — which is a constant, not a calibration,
 * and ranking on it would be ranking on noise.
 */

/**
 * Which intents answer which. The pairing is directional: A's SEEKING is
 * answered by B's OFFERING, not the other way round, and the introduction reads
 * differently depending on which way it runs.
 */
export const COMPLEMENTS = Object.freeze({
  SEEKING: ["OFFERING", "SELLING", "REFERRING"],
  HIRING: ["SEEKING", "OFFERING", "REFERRING"],
  FUNDRAISING: ["INVESTING"],
  BUYING: ["SELLING", "OFFERING"],
  SELLING: ["BUYING", "SEEKING"],
  INVESTING: ["FUNDRAISING"],
  OFFERING: ["SEEKING", "HIRING", "BUYING"],
  PARTNERING: ["PARTNERING"],
});

import { isIntakeArtifact, intakeRefusal } from "./qualification.js";
import { indexDocumentVocabulary, significantWords, sourceKindOf } from "./provenance.js";
import { ROLE_LABELS, ROLE_PREDICATE, isSeekingRole, rolesComplement } from "./roles.js";

const STOP = new Set([
  "a", "an", "and", "the", "for", "with", "who", "that", "this", "of", "in", "on",
  "to", "at", "is", "are", "was", "were", "be", "been", "some", "any", "our", "we",
  "i", "my", "their", "his", "her", "someone", "looking", "need", "needs", "want",
]);

/**
 * Content words shared between two intent objects.
 *
 * Crude by design, and bounded by what it feeds: overlap here is one input to a
 * score, never the whole basis of a match. A stemmer or an embedding would be
 * better at recall and would also make the reason harder to print, and a reason
 * you cannot print is a match a person cannot check.
 */
function overlap(a, b) {
  const words = (s) => new Set(
    String(s ?? "").toLowerCase().split(/[^a-z0-9+#.]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
  const left = words(a);
  const shared = [...words(b)].filter((w) => left.has(w));
  return shared.sort();
}

function attributeValues(attributes) {
  const out = [];
  for (const value of Object.values(attributes ?? {})) {
    if (Array.isArray(value)) out.push(...value.map(String));
    else if (value !== null && value !== undefined && typeof value !== "object") {
      out.push(String(value));
    }
  }
  return out;
}

/**
 * Score one directed pair of intents.
 *
 * Weights are stated here rather than tuned, because with no labelled corpus a
 * tuned weight is a guess wearing a decimal point. What matters for now is that
 * the breakdown is legible: every point has a name and a quote behind it.
 */
function scorePair(seeker, offerer, documents = EMPTY_DOCUMENTS, seekerProposals = null) {
  const reasons = [];
  const conflicts = [];
  let score = 0;

  // 0. NEITHER SIDE IS TALKING ABOUT THE INTAKE PROCESS.
  //
  //    Yente sent a real introduction reading "both mention resume", built from
  //    one person sending a résumé and Yente confirming she got it. The scorer
  //    was not wrong; its inputs were the onboarding conversation dressed as
  //    business intent. A résumé is how a profile gets BUILT — it is never what
  //    one person wants from another — so this is refused before anything is
  //    scored, and the refusal is named rather than expressed as a low number.
  if (isIntakeArtifact(seeker.object) || isIntakeArtifact(offerer.object)) {
    return {
      score: 0,
      reasons: [],
      conflicts: [{
        id: "intake_artifact",
        detail: intakeRefusal(
          isIntakeArtifact(seeker.object) ? seeker.object : offerer.object),
      }],
    };
  }

  // 1. The predicates complement each other at all. Without this there is no
  //    match to make, whatever else lines up.
  const seekType = seeker.predicate.replace(/^intent:/, "");
  const offerType = offerer.predicate.replace(/^intent:/, "");
  if (!(COMPLEMENTS[seekType] ?? []).includes(offerType)) return null;
  score += 0.4;
  reasons.push({
    id: "complementary_intent",
    weight: 0.4,
    detail: `${seekType} is answered by ${offerType}`,
  });

  // 2. They are about the same thing.
  const objectOverlap = overlap(seeker.object, offerer.object);
  if (objectOverlap.length > 0) {
    const weight = Math.min(0.3, 0.1 * objectOverlap.length);
    score += weight;
    reasons.push({
      id: "subject_overlap",
      weight,
      detail: `both mention ${objectOverlap.join(", ")}`,
      matched: objectOverlap,
    });
  }

  // 3. Specifics agree — skills, sector, stage, timing. This is the arm that
  //    separates a real match from a thematic one, so it carries real weight.
  const seekAttrs = attributeValues(seeker.attributes);
  const offerAttrs = attributeValues(offerer.attributes);
  const attrOverlap = seekAttrs
    .filter((v) => offerAttrs.some((o) => o.toLowerCase() === v.toLowerCase()))
    .sort();
  if (attrOverlap.length > 0) {
    const weight = Math.min(0.3, 0.15 * attrOverlap.length);
    score += weight;
    reasons.push({
      id: "attribute_match",
      weight,
      detail: `specifics agree: ${attrOverlap.join(", ")}`,
      matched: attrOverlap,
    });
  }

  // 4. THE DOCUMENTS BACK IT UP.
  //
  //    Everything above reads two sentences people typed into email. A résumé,
  //    a portfolio and a vendor profile are the most considered things a person
  //    gives us and, until now, they scored nothing at all: `proposeIntroductions`
  //    filtered the graph down to `intent:` rows and discarded every fact those
  //    documents had produced.
  //
  //    The direction matters. What we want to know is whether the OFFERER can
  //    actually do the thing the SEEKER is asking for — so the seeker's words
  //    are checked against the offerer's evidence, not against their own. A
  //    person whose CV lists React answering somebody looking for React is a
  //    different proposition from two people who both typed the word.
  //
  //    Deliberately weighted below the stated intent. A document proves
  //    capability, not desire: "knows Rust" is not "wants a Rust job", and a
  //    scorer that let capability outvote a stated intent would introduce a
  //    contented employee to a recruiter on the strength of a skills list.
  const backing = corroboration(seeker.object, documents.offerer);
  if (backing.length > 0) {
    const weight = Math.min(0.2, 0.07 * backing.length);
    score += weight;
    reasons.push({
      id: "document_corroboration",
      weight,
      detail: `their ${sourceLabel(backing)} evidences ${backing.map((b) => b.word).join(", ")}`,
      matched: backing.map((b) => b.word),
      // The quote travels with the reason. An introduction that says "David's
      // CV lists React" is one the recipient can check; "the vocabularies
      // overlapped" is not, and INV-5 applies to a match's stated reason as
      // much as to the claim underneath it.
      quotes: backing.map((b) => ({ quote: b.quote, evidenceId: b.evidenceId })),
    });
  }

  // 5. YENTE'S OWN GRADED READ of the seeker's documents, family-gated and
  //    target-checked against the offerer's ask. Positive-only by schema:
  //    this arm can add weight or stay silent; a negative branch is
  //    unrepresentable. It deliberately does not count as a shared specific
  //    below — a proposal RANKS a match, it never establishes one.
  const offerWords = new Set(significantWords(offerer.object));
  const endorsed = proposalSupport(
    seekerProposals, PROPOSAL_FAMILY[seekType], offerWords);
  if (endorsed && (objectOverlap.length > 0 || attrOverlap.length > 0 || backing.length > 0)) {
    score += endorsed.weight;
    reasons.push(endorsed);
  }

  // A pair that only shares a predicate shape and nothing else is the "both
  // mentioned AI" case. Recorded as a conflict so the reason survives into the
  // output instead of being silently filtered — a match we refuse is worth
  // showing to whoever is calibrating the threshold.
  //
  // Document corroboration counts as a shared specific. It is a stronger one
  // than a word appearing in both emails, because only one side authored it and
  // the other side had no way to echo it.
  if (objectOverlap.length === 0 && attrOverlap.length === 0 && backing.length === 0) {
    conflicts.push({
      id: "no_shared_specifics",
      detail: "the intents complement in shape but share no subject or attribute",
    });
  }

  return { score: Math.min(1, score), reasons, conflicts };
}

/** No documents on either side — the shape callers get when nothing is indexed. */
const EMPTY_DOCUMENTS = Object.freeze({ seeker: new Map(), offerer: new Map() });

/**
 * Which of the words in one person's stated intent the OTHER person's documents
 * can vouch for.
 */
function corroboration(intentObject, vocabulary) {
  if (!vocabulary || vocabulary.size === 0) return [];
  const seen = new Set();
  const found = [];
  for (const word of significantWords(intentObject)) {
    const entry = vocabulary.get(word);
    if (entry && !seen.has(word)) {
      seen.add(word);
      found.push(entry);
    }
  }
  return found.sort((a, b) => a.word.localeCompare(b.word));
}

/** "résumé" reads better than "attachment" in a reason a person will read. */
function sourceLabel(backing) {
  const kinds = new Set(backing.map((b) => sourceKindOf(b.evidenceId)));
  if (kinds.size > 1) return "documents";
  const [only] = kinds;
  return { attachment: "résumé", link: "portfolio", vendor: "profile" }[only] ?? "documents";
}

/**
 * Which proposal kind vouches for which side of a pair.
 *
 * A hire_for proposal is about a CANDIDATE, so it speaks when that person is
 * the one seeking employment (declared) or SEEKING/OFFERING against a HIRING
 * counterpart (inferred). invest_in speaks for a founder seeking funding. A
 * proposal of the wrong family says nothing about this pair — an exceptional
 * engineering candidate is not thereby an investment.
 */
const PROPOSAL_FAMILY = Object.freeze({
  seeking_employment: "hire_for",
  seeking_funding: "invest_in",
  SEEKING: "hire_for",
  OFFERING: "hire_for",
  FUNDRAISING: "invest_in",
});

/** Grade-scaled weight. Below document corroboration on purpose: the grade is
 * the model's judgment of a document, one inference further from a quote than
 * the document itself. It ranks; it never establishes. */
const PROPOSAL_WEIGHTS = Object.freeze({ good: 0.05, strong: 0.1, exceptional: 0.15 });

/** Every graded proposal in the graph, by subject. */
export function gradedProposals(observations) {
  const bySubject = new Map();
  for (const row of observations) {
    const predicate = String(row?.predicate ?? "");
    if (!predicate.startsWith("proposal:")) continue;
    if (row?.attributes?.retracted) continue;
    const held = bySubject.get(row.subject) ?? [];
    held.push({
      kind: predicate.slice("proposal:".length),
      target: row.object,
      grade: row.attributes?.grade ?? "good",
      quote: row.quote,
      evidenceId: row.evidenceId,
    });
    bySubject.set(row.subject, held);
  }
  return bySubject;
}

/**
 * The graded-proposal arm, shared by the declared and inferred paths.
 *
 * Positive-only by inheritance: the schema can only store what someone is
 * GOOD for, so this arm can only add. There is no negative branch to write.
 */
function proposalSupport(candidateProposals, family, counterpartWords) {
  if (!family || !candidateProposals?.length) return null;
  for (const proposal of candidateProposals) {
    if (proposal.kind !== family) continue;
    const targetWords = new Set(significantWords(proposal.target));
    const matched = [...counterpartWords].filter((word) => targetWords.has(word)).sort();
    // The target must touch what the counterpart actually wants — an
    // endorsement for embedded firmware says nothing to a desk hiring
    // designers, however strong.
    if (matched.length === 0 && counterpartWords.size > 0) continue;
    const weight = PROPOSAL_WEIGHTS[proposal.grade] ?? PROPOSAL_WEIGHTS.good;
    return {
      id: "graded_proposal",
      weight,
      detail: `Yente's read: ${proposal.grade} candidate for ${proposal.target}`,
      matched,
      quotes: [{ quote: proposal.quote, evidenceId: proposal.evidenceId }],
    };
  }
  return null;
}

/**
 * Propose matches over every observation in the graph.
 *
 * @param {object} input
 * @param {Array} input.observations  every claim (projections are per-subject;
 *                                    matching is inherently cross-subject)
 * @param {number} [input.threshold]
 */
/**
 * Introductions from what people DECLARED, not from what a model inferred.
 *
 * Two roles that answer each other are already a match; the only question left
 * is how good it is, which is what the documents answer. A pair with corroborating
 * evidence on both sides outranks a bare declaration — but a bare declaration
 * still beats anything mined from prose, because it cannot be a
 * misinterpretation of a sentence.
 */
function proposeFromRoles({ observations, vocabularies, proposals = new Map() }) {
  const rolesBySubject = new Map();
  for (const row of observations) {
    if (row?.predicate !== ROLE_PREDICATE) continue;
    if (row?.attributes?.retracted) continue;
    const held = rolesBySubject.get(row.subject) ?? [];
    if (!held.some((r) => r.object === row.object)) held.push(row);
    rolesBySubject.set(row.subject, held);
  }

  const out = [];
  for (const [seeker, seekerRoles] of rolesBySubject) {
    for (const [offerer, offererRoles] of rolesBySubject) {
      if (seeker === offerer) continue;

      for (const mine of seekerRoles) {
        // ONE introduction per pair, in the direction that reads correctly.
        // The asking side is the seeker; without this the same meeting appears
        // twice in the review queue, once from each end.
        if (!isSeekingRole(mine.object)) continue;

        const answering = offererRoles.find((theirs) => rolesComplement(mine.object, theirs.object));
        if (!answering) continue;

        // A declaration is worth more than any inferred pairing can reach:
        // 0.4 (complementary) + 0.3 (same subject) + 0.3 (specifics) tops out
        // at 1.0 for a perfect inferred match, and a declared one starts at
        // 0.7 before evidence is considered at all.
        const reasons = [{
          id: "declared_roles",
          weight: 0.7,
          detail: `${ROLE_LABELS[mine.object]} is answered by ${ROLE_LABELS[answering.object]}`,
        }];
        let score = 0.7;

        // The documents rank it. Same asymmetry as the inferred path: what the
        // OFFERER can evidence is what matters to the seeker.
        const shared = sharedVocabulary(
          vocabularies.for(seeker), vocabularies.for(offerer),
        );
        if (shared.length > 0) {
          const weight = Math.min(0.3, 0.06 * shared.length);
          score += weight;
          reasons.push({
            id: "document_corroboration",
            weight,
            detail: `both evidence ${shared.slice(0, 5).map((s) => s.word).join(", ")}`,
            matched: shared.map((s) => s.word),
            quotes: shared.slice(0, 5).map((s) => ({ quote: s.quote, evidenceId: s.evidenceId })),
          });
        }

        // Yente's own graded read of the seeker's documents, when its family
        // matches this pair and its target touches what the offerer evidences.
        // Ranking only — the declaration established the match; the proposal
        // says how warmly to write the introduction.
        const offererWords = new Set((vocabularies.for(offerer) ?? new Map()).keys());
        const endorsed = proposalSupport(
          proposals.get(seeker), PROPOSAL_FAMILY[mine.object], offererWords);
        if (endorsed) {
          score += endorsed.weight;
          reasons.push(endorsed);
        }

        out.push(Object.freeze({
          seeker,
          offerer,
          matchType: `${mine.object}_x_${answering.object}`,
          confidence: Number(Math.min(1, score).toFixed(3)),
          reasons: Object.freeze(reasons),
          conflicts: Object.freeze([]),
          evidence: Object.freeze([
            {
              subject: seeker, quote: mine.quote, evidenceId: mine.evidenceId,
              said: ROLE_LABELS[mine.object],
            },
            {
              subject: offerer, quote: answering.quote, evidenceId: answering.evidenceId,
              said: ROLE_LABELS[answering.object],
            },
          ]),
        }));
      }
    }
  }
  return out;
}

/** Words BOTH sides' documents can vouch for, with a quote from the offerer. */
function sharedVocabulary(seekerVocab, offererVocab) {
  if (!seekerVocab?.size || !offererVocab?.size) return [];
  const shared = [];
  for (const [word, entry] of offererVocab) {
    if (seekerVocab.has(word)) shared.push(entry);
  }
  return shared.sort((a, b) => a.word.localeCompare(b.word));
}

/** Which live ask each proposal kind answers. */
const ASK_FAMILY = Object.freeze({
  "intent:HIRING": "hire_for",
  "intent:INVESTING": "invest_in",
});

/** The grade IS the base confidence — good clears the default threshold, barely. */
const GRADE_CONFIDENCE = Object.freeze({ good: 0.55, strong: 0.65, exceptional: 0.75 });

function proposalAnswers({ observations, endorsements }) {
  const out = [];
  const asks = observations.filter((row) =>
    ASK_FAMILY[String(row?.predicate ?? "")] && !row?.attributes?.retracted);

  for (const ask of asks) {
    // The intake conversation is never an ask, on this arm like every other.
    if (isIntakeArtifact(ask.object)) continue;
    const family = ASK_FAMILY[ask.predicate];
    const askWords = new Set(significantWords(ask.object));
    if (askWords.size === 0) continue;

    for (const [candidate, graded] of endorsements) {
      if (candidate === ask.subject) continue;

      // The BEST overlapping proposal speaks for the candidate; two grades
      // for adjacent targets are one introduction, not two.
      let best = null;
      for (const proposal of graded) {
        if (proposal.kind !== family) continue;
        const matched = significantWords(proposal.target)
          .filter((word) => askWords.has(word));
        if (matched.length === 0) continue;
        const confidence = Math.min(1,
          (GRADE_CONFIDENCE[proposal.grade] ?? GRADE_CONFIDENCE.good)
          + Math.min(0.1, 0.05 * (matched.length - 1)));
        if (!best || confidence > best.confidence) {
          best = { proposal, matched: [...new Set(matched)], confidence };
        }
      }
      if (!best) continue;

      out.push(Object.freeze({
        seeker: ask.subject,
        offerer: candidate,
        matchType: `${ask.predicate.replace(/^intent:/, "").toLowerCase()}_x_${family}`,
        confidence: Number(best.confidence.toFixed(3)),
        reasons: Object.freeze([{
          id: "graded_candidate",
          weight: best.confidence,
          detail: `Yente graded them ${best.proposal.grade} for ${best.proposal.target}; `
            + `the ask is ${ask.object} — sharing ${best.matched.join(", ")}`,
          matched: best.matched,
        }]),
        conflicts: Object.freeze([]),
        // Both sides carry their own words: the ask as they typed it, and the
        // resume sentence the grade stands on. INV-5 applies to a match's
        // reason as much as to the claim underneath it.
        evidence: Object.freeze([
          { subject: ask.subject, quote: ask.quote, evidenceId: ask.evidenceId, said: ask.object },
          { subject: candidate, quote: best.proposal.quote,
            evidenceId: best.proposal.evidenceId, said: best.proposal.target },
        ]),
      }));
    }
  }
  return out;
}

export function proposeIntroductions({ observations, threshold = 0.5, limit = 50 }) {
  const intents = observations.filter((row) => String(row.predicate ?? "").startsWith("intent:"));

  // Built once for the whole pass, not per pair. Scoring is O(intents²) and
  // every pair needs both sides' documents; re-deriving a subject's vocabulary
  // inside that loop would compute the same answer once per partner.
  const vocabularies = indexDocumentVocabulary(observations);
  const endorsements = gradedProposals(observations);

  const proposals = [];

  // DECLARED ROLES FIRST, BECAUSE THEY ARE NOT INFERRED.
  //
  // Everything below this block reads intents a model mined out of email prose,
  // and every bad match we have shipped came from that: "both mention resume",
  // `capability: "resume"`, `OFFERING: "professional services and expertise"`.
  // A declared role is the person answering a direct question from a closed
  // list — no model, no quote to verify, no ambiguity about what they meant.
  //
  // So it scores higher than any inferred pairing can, and the documents are
  // used to RANK within it rather than to establish it. That is the correct
  // order of authority: the person says what they want, their résumé says what
  // they can do.
  proposals.push(...proposeFromRoles({ observations, vocabularies, proposals: endorsements }));

  // A GRADED CANDIDATE ANSWERS A LIVE ASK. Observed 2026-09-01: a hiring
  // email ("I'm hiring a rust backend engineer") sat unanswered next to a
  // person Yente itself had graded `hire_for: exceptional` for exactly those
  // roles — because the candidate's only intent rows were intake artifacts,
  // and a proposal could WARM a pair but never establish one. That was the
  // proposals feature failing at its own founding sentence: "best candidate
  // for job xyz." Now a live HIRING/INVESTING ask pairs directly with another
  // person's graded proposal when the targets share real words — evidence on
  // both sides (their ask, the resume quote the grade stands on), and the
  // grade sets how warmly the introduction opens.
  proposals.push(...proposalAnswers({ observations, endorsements }));

  for (const a of intents) {
    for (const b of intents) {
      // Never introduce somebody to themselves. Two intents on one subject are
      // a profile, not a match — and this is the check that stops a single
      // chatty sender generating a page of imaginary introductions.
      if (a.subject === b.subject) continue;

      const scored = scorePair(a, b, {
        seeker: vocabularies.for(a.subject),
        offerer: vocabularies.for(b.subject),
      }, endorsements.get(a.subject));
      if (!scored || scored.score < threshold) continue;

      proposals.push(Object.freeze({
        // Directional, and the ORDER is part of the identity: "Sarah needs what
        // David has" is a different introduction from the reverse, and the
        // sentence you would write is different too.
        seeker: a.subject,
        offerer: b.subject,
        matchType: `${a.predicate.replace(/^intent:/, "")}_x_${b.predicate.replace(/^intent:/, "")}`,
        confidence: Number(scored.score.toFixed(3)),
        reasons: Object.freeze(scored.reasons),
        conflicts: Object.freeze(scored.conflicts),
        // EVIDENCE, both sides, with the quote. §13: the user clicks "Why?" and
        // gets this. A match without both quotes is not shippable, so they are
        // part of the proposal rather than something fetched later.
        evidence: Object.freeze([
          { subject: a.subject, quote: a.quote, evidenceId: a.evidenceId, said: a.object },
          { subject: b.subject, quote: b.quote, evidenceId: b.evidenceId, said: b.object },
        ]),
      }));
    }
  }

  // Best first, and deduplicate the same pair arriving from several intent
  // combinations — one introduction per direction per pair.
  const seen = new Set();
  return proposals
    .sort((x, y) => y.confidence - x.confidence)
    .filter((p) => {
      const key = `${p.seeker}|${p.offerer}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/**
 * A one-line human explanation. Built from the reasons, never written freehand,
 * so what a person reads and what the scorer decided cannot drift apart.
 */
export function explainIntroduction(proposal) {
  const [seekerSide, offererSide] = proposal.evidence;
  const why = proposal.reasons.map((r) => r.detail).join("; ");
  return `${seekerSide.subject} said "${seekerSide.said}" and ${offererSide.subject} `
    + `said "${offererSide.said}" — ${why} (confidence ${proposal.confidence}).`;
}
