/**
 * Identity resolution — and the discipline of refusing to guess.
 *
 * "Email addresses are identifiers, but people are the entity." So
 * sarah@acme.com and sarah.chen@gmail.com may be one person, and Yente has to be
 * able to say so — while never merging on a hunch.
 *
 * THE ASYMMETRY THAT DECIDES EVERY RULE BELOW
 *
 * A missed merge is a smaller mistake than a wrong one. Two nodes for one person
 * looks untidy and is fixed by one click. Merging two people conflates their
 * intents, their employers and their correspondence — and then proposes an
 * introduction based on a claim the person never made. That is unrecoverable in
 * the way that matters: somebody acts on it.
 *
 * So: DETERMINISTIC EVIDENCE ONLY. Name similarity never merges. "Sarah Chen"
 * matching "Sarah Chen" is the single most tempting signal here and it is worth
 * nothing — it is three different people across three mailboxes, and the graph
 * has no way to tell which.
 *
 * WHAT DOES COUNT
 *
 *   1. A user correction. Highest authority, and the only arm that can be wrong
 *      in a way we accept, because a person asserting it IS the ground truth.
 *   2. The same address. Trivially, but it is the reason addresses key subjects
 *      in the first place.
 *   3. A signature block that states another address, IN A MESSAGE FROM ONE OF
 *      THEM. That last clause is load-bearing: a third party listing two
 *      addresses proves nothing about whether they are the same person.
 *
 * And what deliberately does not: shared employer, similar names, adjacent
 * timestamps, writing style. Each is suggestive and none is proof.
 *
 * MERGES ARE A VIEW, NOT A REWRITE
 *
 * Nothing here mutates an observation. `resolve` computes canonical subjects on
 * read from `same_as` / `not_same_as` claims, so a merge is reversible by
 * appending its opposite and the history of having thought otherwise survives.
 * A destructive merge would have to be undone by reconstructing deleted state,
 * which is not a thing you can do.
 */

/** Addresses are case-insensitive in the part that matters, and Gmail dots are noise. */
export function normalizeAddress(address) {
  const raw = String(address ?? "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at === -1) return raw;

  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  // Gmail ignores dots and everything after a +. Treating alice.smith@gmail.com
  // and alicesmith@gmail.com as different people is a merge we would miss for a
  // reason that is purely cosmetic — and this one is deterministic, documented
  // provider behaviour rather than a guess about humans.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  return `${local}@${domain}`;
}

export function subjectForAddress(address) {
  return `person:${normalizeAddress(address)}`;
}

/**
 * Normalize a subject id, whatever shape it arrived in.
 *
 * Applied on every comparison rather than trusting what is stored, because rows
 * written before normalization existed — or by a caller that built the id
 * inline — would otherwise never match a freshly-computed one. That exact drift
 * cost a debugging round here: the queue wrote `person:s.chen@gmail.com` while
 * identity resolution looked for `person:schen@gmail.com`, and the merge simply
 * never appeared. Silent disagreement between two functions that both look
 * right is the failure mode this whole file is arranged against.
 */
export function canonicalizeSubject(subject) {
  const s = String(subject ?? "");
  return s.startsWith("person:") ? subjectForAddress(s.slice("person:".length)) : s;
}

/**
 * Addresses that appear in text, keeping BOTH forms.
 *
 * The normalized form is identity; the raw form is what a human will recognise
 * on the page. Returning only the normalized one meant the quote lookup searched
 * for "schen" in a line reading "s.chen@gmail.com" and found nothing — so the
 * merge candidate rendered with no evidence, which is the one thing that makes it
 * judgeable.
 */
export function addressesIn(text) {
  const found = String(text ?? "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  const byNormalized = new Map();
  for (const raw of found) {
    const normalized = normalizeAddress(raw);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, { raw, normalized });
  }
  return [...byNormalized.values()];
}

/**
 * Build the union-find over asserted identity.
 *
 * `same_as` unions; `not_same_as` blocks. A block beats a union regardless of
 * which arrived first, because the two claims are not symmetric in cost — see
 * the asymmetry note above. A person who has said "these are different people"
 * has told us something we cannot infer, and no amount of later evidence should
 * quietly overrule it.
 */
export function buildIdentityIndex(observations) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };

  const blocked = new Set();
  const pairKey = (a, b) => [a, b].sort().join("|");

  // Canonicalized on read, so a claim written with an un-normalized id still
  // participates. See canonicalizeSubject.
  for (const row of observations) {
    if (row.predicate === "not_same_as" && row.object) {
      blocked.add(pairKey(canonicalizeSubject(row.subject), canonicalizeSubject(row.object)));
    }
  }

  const unions = [];
  for (const row of observations) {
    if (row.predicate !== "same_as" || !row.object) continue;
    const a = canonicalizeSubject(row.subject);
    const b = canonicalizeSubject(row.object);
    if (blocked.has(pairKey(a, b))) continue;
    unions.push([a, b]);
  }

  for (const [a, b] of unions) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) continue;
    // Canonical root is the lexicographically smaller id: stable across runs,
    // which matters because the canonical subject appears in URLs and in match
    // records. A root that moved between restarts would break both.
    const [keep, drop] = [rootA, rootB].sort();
    parent.set(drop, keep);
  }

  return {
    canonical(subject) { return find(canonicalizeSubject(subject)); },
    blockedPairs: blocked,
    /** Every id that folds into one canonical subject, including itself. */
    aliasesOf(subject) {
      const root = find(canonicalizeSubject(subject));
      const out = new Set([root]);
      for (const key of parent.keys()) if (find(key) === root) out.add(key);
      return [...out].sort();
    },
  };
}

/**
 * Collapse observations onto canonical subjects.
 *
 * Returns NEW rows rather than editing stored ones — the merge is a lens over
 * immutable claims. `originalSubject` is carried so a profile can show that a
 * claim arrived under an alias, which is the difference between a merge you can
 * audit and one you have to trust.
 */
export function resolveObservations(observations) {
  const index = buildIdentityIndex(observations);
  return observations.map((row) => {
    const canonical = index.canonical(row.subject);
    if (canonical === row.subject) return row;
    return { ...row, subject: canonical, originalSubject: row.subject };
  });
}

/**
 * Deterministic merge candidates, from evidence we actually hold.
 *
 * The only automatic arm: a message FROM one address whose body states another,
 * where both are already subjects in the graph. That is a signature block, and
 * it is the one case where a person has effectively told us themselves.
 *
 * Returned as CANDIDATES, never applied. Even this arm is proposed to a human,
 * because "same domain, mentioned in the body" is exactly how a shared inbox or
 * a forwarded introduction would look — and the cost of being wrong is not
 * symmetric with the cost of asking.
 */
export function proposeIdentityMerges({ observations, evidenceById, existingSubjects }) {
  const index = buildIdentityIndex(observations);
  // Normalize BOTH sides before comparing. A caller passing subjects straight
  // out of the store is the normal case, and if those were written before
  // normalization existed they will not match a freshly-normalized id.
  const known = new Set([...existingSubjects].map(canonicalizeSubject));
  const seen = new Set();
  const candidates = [];

  for (const [evidenceId, evidence] of Object.entries(evidenceById ?? {})) {
    const from = evidence?.meta?.from;
    if (!from || !evidence.text) continue;

    const sender = subjectForAddress(from);
    if (!known.has(sender)) continue;

    for (const { raw, normalized: address } of addressesIn(evidence.text)) {
      const other = subjectForAddress(address);
      if (other === sender || !known.has(other)) continue;

      // Already merged, or already ruled out by a person.
      if (index.canonical(other) === index.canonical(sender)) continue;
      if (index.blockedPairs.has([sender, other].sort().join("|"))) continue;

      const key = [sender, other].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      // The quote, so the human decision is made against the actual sentence
      // rather than against our summary of it.
      // Search for the address AS WRITTEN. The normalized form may not appear
      // anywhere in the text — gmail dots are stripped for identity and kept in
      // the sentence a person actually reads.
      const line = String(evidence.text)
        .split(/\r?\n/)
        .find((l) => l.toLowerCase().includes(raw.toLowerCase())) ?? null;

      candidates.push({
        subjectA: sender,
        subjectB: other,
        reason: "a message from one address states the other — likely a signature block",
        evidenceId,
        quote: line ? line.trim().slice(0, 200) : null,
        // Named for what it is. A shared inbox and a forwarded introduction look
        // identical to this rule, which is why it proposes rather than merges.
        caution: "a shared inbox or a forwarded introduction looks the same to this rule",
      });
    }
  }

  return candidates;
}
