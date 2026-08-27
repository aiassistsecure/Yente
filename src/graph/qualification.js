/**
 * Whether a person is ready to be introduced to anyone.
 *
 * WHY THIS EXISTS — THE RÉSUMÉ MATCH
 *
 * Yente sent a real introduction whose stated reason was:
 *
 *   Interchained Core is looking for or offering: resume.
 *   founders@vibecode-101.com is looking for or offering: resume receipt confirmation.
 *   Why this matched: OFFERING is answered by SEEKING; both mention resume.
 *
 * Nothing in the scorer was broken. It was handed two "intents" manufactured
 * out of the INTAKE CONVERSATION — somebody sending a résumé, and Yente saying
 * she got it — and it did its job on them faithfully.
 *
 * Mark, on reading it: "Resume is a requirement to get your profile built, not
 * a criteria to match on directly."
 *
 * So the fix is not a cleverer scorer or a longer stop-list. Tightening words
 * would have produced the same bug next week as "both mentioned LinkedIn". Two
 * structural rules instead:
 *
 *   1. Artefacts of intake are not business intent. A résumé, a LinkedIn
 *      export, a receipt, an approval — these are how a profile gets BUILT.
 *      They are never the thing a person is seeking or offering.
 *
 *   2. Only a QUALIFIED person can be matched. Qualified means: they sent
 *      evidence, Yente read it, Yente showed them the profile she derived, and
 *      THEY approved it. Until then they are mid-onboarding, not a candidate.
 *
 * Rule 2 is the one that matters. In the email above, neither party was
 * qualified — both were mid-intake — so the introduction could not have
 * happened at all, whatever the scorer thought of the word "resume". It also
 * fixes the second thing wrong with that email, which nobody had to tell the
 * scorer about: it introduced Mark to Mark.
 *
 * WHY A STATE, AND WHY IT IS AN OBSERVATION
 *
 * The state lives where every other belief about a person lives: as an
 * append-only observation, projected to a current value. It is not a mutable
 * column, because "when did she become qualified, and on the strength of what"
 * is a question we will be asked, and a column cannot answer it. `TRACE` can.
 *
 * It also means qualification inherits the authority fold for free: a person's
 * own APPROVE carries USER_CORRECTION and outranks anything the pipeline
 * inferred, which is exactly the precedence a consent decision should have.
 */

/**
 * The lifecycle. Each state answers one question: what is Yente waiting for?
 */
export const PROFILE_STATES = Object.freeze({
  /** Heard from them. Nothing asked yet. */
  NEW: "new",
  /** Yente asked for a résumé or a LinkedIn export. */
  ASKED: "asked",
  /** Something arrived and parsed. Facts are being extracted. */
  RECEIVED: "received",
  /** Facts extracted and a bio composed, not yet shown to them. */
  DRAFTED: "drafted",
  /** The bio has been sent. Yente is waiting for them to approve or correct. */
  AWAITING_APPROVAL: "awaiting_approval",
  /** They approved it. THE ONLY STATE THAT CAN BE MATCHED. */
  QUALIFIED: "qualified",
  /** They said no. Never matched, never chased. */
  DECLINED: "declined",
});

export const PROFILE_STATE_PREDICATE = "profile_state";

/**
 * Which moves are legal.
 *
 * Stated as data rather than scattered through `if`s so the shape of the
 * lifecycle is readable in one place, and so an illegal transition is a caught
 * error rather than a state nobody expected.
 *
 * Two properties worth naming:
 *
 * - QUALIFIED is not terminal. A person can send a new résumé and go round
 *   again; their profile is a living thing, not a one-time form. It re-enters
 *   at RECEIVED, and — deliberately — they must approve the new bio too.
 * - DECLINED is not terminal either, because "no" today is not "no" forever
 *   and a person who writes back should be able to continue.
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  [PROFILE_STATES.NEW]: [PROFILE_STATES.ASKED, PROFILE_STATES.RECEIVED, PROFILE_STATES.DECLINED],
  [PROFILE_STATES.ASKED]: [PROFILE_STATES.RECEIVED, PROFILE_STATES.ASKED, PROFILE_STATES.DECLINED],
  [PROFILE_STATES.RECEIVED]: [PROFILE_STATES.DRAFTED, PROFILE_STATES.ASKED, PROFILE_STATES.DECLINED],
  [PROFILE_STATES.DRAFTED]: [PROFILE_STATES.AWAITING_APPROVAL, PROFILE_STATES.DECLINED],
  [PROFILE_STATES.AWAITING_APPROVAL]: [
    PROFILE_STATES.QUALIFIED, PROFILE_STATES.RECEIVED, PROFILE_STATES.DECLINED,
  ],
  [PROFILE_STATES.QUALIFIED]: [PROFILE_STATES.RECEIVED, PROFILE_STATES.DECLINED],
  [PROFILE_STATES.DECLINED]: [PROFILE_STATES.ASKED, PROFILE_STATES.RECEIVED],
});

export function isLegalTransition(from, to) {
  if (!from) return true;                       // first state, nothing to leave
  if (from === to) return true;                 // idempotent re-assertion
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The current state of one person, from their observations.
 *
 * Reads the LAST `profile_state` claim. The projection upstream has already
 * applied the authority fold, so a person's own approval has already won over
 * anything inferred by the time we get here.
 */
export function profileState(observations) {
  const states = (observations ?? [])
    .filter((row) => row?.predicate === PROFILE_STATE_PREDICATE)
    .sort((a, b) => String(a.observedAt ?? "").localeCompare(String(b.observedAt ?? "")));
  return states.length > 0 ? states[states.length - 1].object : PROFILE_STATES.NEW;
}

/** Only an approved profile is a candidate. */
export function isQualified(observations) {
  return profileState(observations) === PROFILE_STATES.QUALIFIED;
}

/**
 * The artefacts of intake. Supplying one is how a profile gets BUILT; it is
 * never what a person wants from another person.
 *
 * Deliberately narrow and deliberately a list. This is not a general-purpose
 * stop-list for uninteresting words — those belong in the scorer's overlap
 * function, and widening this one would silently stop matching people who
 * genuinely trade in documents (a CV-writing service SEEKING clients is a real
 * intent about résumés). What makes these different is that they name the
 * INTAKE TRANSACTION WITH YENTE, and Yente is not a party to any introduction.
 */
const INTAKE_ARTIFACTS = [
  "resume", "resumes", "résumé", "résumés", "cv", "curriculum vitae",
  "linkedin", "export", "exports", "url", "link", "links",
  "profile", "bio", "biography",
  "receipt", "confirmation", "acknowledgement", "acknowledgment",
  "approval", "introduction", "intro",
  "attachment", "document", "documents", "doc", "docs", "pdf", "docx",
  "file", "files", "email", "message", "reply", "portfolio", "deck",
];

const ARTIFACT_SET = new Set(INTAKE_ARTIFACTS);

/**
 * Is this intent object nothing but intake?
 *
 * True only when EVERY content word is an artefact word. "resume" and "resume
 * receipt confirmation" are intake; "resume review for senior engineers" is
 * not, because `review`, `senior` and `engineers` survive — that is a real
 * service somebody offers, and refusing it would be the over-correction.
 */
export function isIntakeArtifact(object) {
  const words = String(object ?? "")
    .toLowerCase()
    .split(/[^a-zà-ÿ]+/)
    .filter((word) => word.length > 1);

  if (words.length === 0) return false;

  const meaningful = words.filter((word) => !["the", "my", "your", "our", "and", "for", "of", "to", "an"].includes(word));
  if (meaningful.length === 0) return false;

  return meaningful.every((word) => ARTIFACT_SET.has(word));
}

/**
 * The reason string for a refusal, so a rejected match can say why it was
 * rejected rather than merely scoring low.
 */
export function intakeRefusal(object) {
  return `"${object}" names the intake process, not a business intent — a `
    + "résumé is how a profile gets built, not something one person seeks from "
    + "another";
}
