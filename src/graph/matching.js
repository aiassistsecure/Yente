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
function scorePair(seeker, offerer) {
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

  // A pair that only shares a predicate shape and nothing else is the "both
  // mentioned AI" case. Recorded as a conflict so the reason survives into the
  // output instead of being silently filtered — a match we refuse is worth
  // showing to whoever is calibrating the threshold.
  if (objectOverlap.length === 0 && attrOverlap.length === 0) {
    conflicts.push({
      id: "no_shared_specifics",
      detail: "the intents complement in shape but share no subject or attribute",
    });
  }

  return { score: Math.min(1, score), reasons, conflicts };
}

/**
 * Propose matches over every observation in the graph.
 *
 * @param {object} input
 * @param {Array} input.observations  every claim (projections are per-subject;
 *                                    matching is inherently cross-subject)
 * @param {number} [input.threshold]
 */
export function proposeIntroductions({ observations, threshold = 0.5, limit = 50 }) {
  const intents = observations.filter((row) => String(row.predicate ?? "").startsWith("intent:"));

  const proposals = [];
  for (const a of intents) {
    for (const b of intents) {
      // Never introduce somebody to themselves. Two intents on one subject are
      // a profile, not a match — and this is the check that stops a single
      // chatty sender generating a page of imaginary introductions.
      if (a.subject === b.subject) continue;

      const scored = scorePair(a, b);
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
