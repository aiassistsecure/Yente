/**
 * Where a claim came from — and why matching has been ignoring most of it.
 *
 * THE GAP THIS CLOSES
 *
 * `proposeIntroductions` filters observations down to `intent:` predicates and
 * scores those against each other. Every other claim in the graph is invisible
 * to it. That means a résumé we parsed, a portfolio we fetched, and eight years
 * of a person's work history contribute exactly nothing to whether they get
 * introduced — the only thing that counts is a sentence they typed in an email.
 *
 * Which is backwards. The email is the least considered thing a person sends;
 * the résumé is the most. "I do some engineering work" and a CV listing six
 * years of React are the same intent with wildly different evidence behind
 * them, and the scorer could not tell them apart.
 *
 * WHAT DOCUMENTS DO *NOT* GET TO DO
 *
 * They do not create intents. That rule was paid for — the résumé match came
 * from treating intake artefacts as business intent, and the fix was structural
 * (`qualification.js`). A CV states capability, not desire: "knows Rust" is not
 * "wants a Rust job", and a scorer that reads it as one will introduce a happily
 * employed person to a recruiter on the strength of a skills list.
 *
 * So documents SUBSTANTIATE. An intent still has to be stated by the person, in
 * their own words, with a quote. What the document changes is how much that
 * stated intent is worth, and whether the specifics behind it are real:
 *
 *   stated  "looking for a React contractor"       ← the intent, always from a person
 *   backed  résumé lists React, 6 years            ← the evidence it is true
 *
 * WHY THE KIND IS READ FROM THE ID
 *
 * Evidence is content-addressed as `${kind}:${contentHash}`, so an observation's
 * `evidenceId` ALREADY carries its provenance — `attachment:eea45f00…` announces
 * itself. Looking the row up to ask its kind would introduce a second source of
 * truth for a fact the first one already states, and two sources of truth is how
 * the concurrency log came to print a number the code was not using.
 *
 * A claim with no evidence id is not missing provenance; it is the operator's.
 * Corrections are made by a person at a keyboard and there is no document to
 * point at, so they are named OPERATOR rather than treated as an absence.
 */

/** Where a claim came from. Matches the `kind` used when evidence is recorded. */
export const SOURCE_KINDS = Object.freeze({
  /** The body of an email somebody sent. */
  MESSAGE: "message",
  /** A file they attached — a résumé, a deck, a case study. */
  ATTACHMENT: "attachment",
  /** A URL they shared that we fetched — a portfolio, a personal site. */
  LINK: "link",
  /** A structured record from a data vendor, keyed to a profile URL. */
  VENDOR: "vendor",
  /** A person ruled on it. No document, and none needed. */
  OPERATOR: "operator",
});

/**
 * The kinds that constitute a DOCUMENT — something the person authored or
 * published, rather than typed into an email to us.
 *
 * This is the set whose facts substantiate an intent. A message does not
 * substantiate itself: "I know React because I said I know React" is not
 * corroboration, it is the same claim counted twice, and a scorer that counted
 * it twice would rank the most talkative sender highest.
 */
export const DOCUMENT_KINDS = Object.freeze(new Set([
  SOURCE_KINDS.ATTACHMENT,
  SOURCE_KINDS.LINK,
  SOURCE_KINDS.VENDOR,
]));

/**
 * What kind of source produced this claim.
 * @param {string|null|undefined} evidenceId
 */
export function sourceKindOf(evidenceId) {
  if (!evidenceId) return SOURCE_KINDS.OPERATOR;
  const kind = String(evidenceId).split(":")[0];
  return Object.values(SOURCE_KINDS).includes(kind) ? kind : SOURCE_KINDS.MESSAGE;
}

/** Did this claim come from something the person authored, not just said? */
export function isDocumentClaim(observation) {
  return DOCUMENT_KINDS.has(sourceKindOf(observation?.evidenceId));
}

/**
 * Split a person's claims by where they came from.
 *
 * This is the answer to "which of this belongs where" on the profile page: not
 * one undifferentiated list of everything Yente believes, but the same claims
 * organised by what produced them, so a reviewer can see at a glance that a
 * title came from a CV and a budget came from an email.
 */
export function groupBySource(observations) {
  const groups = {
    [SOURCE_KINDS.MESSAGE]: [],
    [SOURCE_KINDS.ATTACHMENT]: [],
    [SOURCE_KINDS.LINK]: [],
    [SOURCE_KINDS.VENDOR]: [],
    [SOURCE_KINDS.OPERATOR]: [],
  };
  for (const row of observations ?? []) {
    groups[sourceKindOf(row?.evidenceId)].push(row);
  }
  return groups;
}

/**
 * The substantiating facts for one person: everything they can be shown to be,
 * as opposed to everything they said they want.
 *
 * Intents are excluded even when a document produced one, because the whole
 * point of the split is that capability corroborates desire. Folding an intent
 * into its own corroboration would let a single claim score twice.
 */
export function documentFacts(observations) {
  return (observations ?? []).filter((row) =>
    isDocumentClaim(row)
    && !String(row?.predicate ?? "").startsWith("intent:")
    && !row?.attributes?.retracted);
}

/**
 * Every word a person's documents can vouch for, lowercased, with the claim
 * that carries each one so a match can quote its source.
 *
 * A Map rather than a Set because the quote is the deliverable. "David's CV
 * lists React" is a sentence an introduction can contain; "the vocabularies
 * overlapped" is not, and an introduction that cannot say why it happened is
 * the one the recipient does not trust.
 *
 * @returns {Map<string, {word: string, quote: string|null, evidenceId: string|null, predicate: string}>}
 */
export function documentVocabulary(observations) {
  const vocabulary = new Map();

  for (const row of documentFacts(observations)) {
    const values = [row.object, ...Object.values(row.attributes ?? {})]
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value) => typeof value === "string" || typeof value === "number");

    for (const value of values) {
      for (const word of significantWords(String(value))) {
        // First one wins: the earliest claim carrying a word is the one that
        // established it, and re-pointing the quote at a later duplicate would
        // cite the echo rather than the source.
        if (!vocabulary.has(word)) {
          vocabulary.set(word, {
            word,
            quote: row.quote ?? null,
            evidenceId: row.evidenceId ?? null,
            predicate: row.predicate,
          });
        }
      }
    }
  }
  return vocabulary;
}

/**
 * Words worth matching on.
 *
 * The stop-list is short by design and NOT the intake-artifact list — these are
 * words that carry no information anywhere, whereas `qualification.js` refuses
 * words that are specifically about the intake transaction. Two different jobs;
 * merging them would mean a widening for one silently changed the other.
 */
const NOISE = new Set([
  // two-letter English that a length filter used to remove for us
  "of", "an", "at", "in", "on", "to", "is", "be", "we", "my", "it", "or", "as",
  "if", "so", "up", "by", "do", "no", "us", "me", "he", "am",
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "our",
  "your", "their", "his", "her", "its", "have", "has", "had", "will", "would",
  "can", "could", "should", "about", "into", "over", "under", "more", "most",
  "some", "any", "all", "who", "whom", "which", "what", "when", "where", "how",
  "work", "working", "worked", "role", "roles", "job", "jobs", "team", "teams",
  "company", "companies", "years", "year", "experience", "skills", "skill",
]);

/**
 * Words worth matching on.
 *
 * TWO THINGS THIS GETS RIGHT THAT THE OBVIOUS VERSION DOES NOT
 *
 * 1. `#` and `+` are kept, and only sentence periods are stripped. The first
 *    version trimmed trailing punctuation and then required three characters,
 *    which turned "C#" into "c" and threw it away — so a C# developer could
 *    never be corroborated on C#. "C++", "F#" and ".NET" failed the same way.
 *
 * 2. Two-letter tokens survive, because "Go" is a language and "R" is a
 *    language and a network of engineers matches on exactly those. The stop
 *    words a length filter used to remove are now named in NOISE instead,
 *    which is the honest place for them — the old rule was not "short words
 *    are noise", it was "short words are usually noise", and it silently cost
 *    us the exceptions.
 *
 * The false-positive risk of keeping "go" is small here and worth naming: this
 * reads CLAIM objects and attributes the model already typed — `skill: "Go"` —
 * not raw document prose. A verb in a sentence never reaches this function.
 */
export function significantWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ+#.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length >= 2 && !NOISE.has(word));
}

/**
 * A per-subject index of substantiating vocabulary, built once for a whole
 * scoring pass.
 *
 * Matching is O(intents²) and each pair needs both sides' documents. Rebuilding
 * a subject's vocabulary inside that loop would re-derive the same answer once
 * per pair — on a graph with a few hundred intents that is the difference
 * between a tick and a stall.
 */
export function indexDocumentVocabulary(observations) {
  const bySubject = new Map();
  for (const row of observations ?? []) {
    const list = bySubject.get(row.subject) ?? [];
    list.push(row);
    bySubject.set(row.subject, list);
  }

  const index = new Map();
  for (const [subject, rows] of bySubject) {
    index.set(subject, documentVocabulary(rows));
  }
  return {
    /** @returns {Map<string, object>} never null, so callers need no guard */
    for(subject) {
      return index.get(subject) ?? new Map();
    },
    size: index.size,
  };
}
