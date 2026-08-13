/**
 * The uniqueness keys of SPEC v2 §12.1.
 *
 * THE DESIGN DECISION, stated once: **the document id IS the uniqueness key.**
 *
 * NEDB stores one row per (collection, id) and a second put to the same id is a
 * new version of that row, not a second row. So deriving the id from the unique
 * tuple makes uniqueness a property of addressing rather than something a
 * constraint has to catch afterwards. There is no unique index to declare, no
 * "does this exist yet" read to forget, and no window between the check and the
 * insert for a second worker to slip through.
 *
 * The alternative — a random id plus a lookup before insert — is a
 * check-then-act race in any system, and D5's "concurrent deadline workers
 * create at most one introduction job" is exactly the requirement that race
 * would violate. Addressing removes the race instead of narrowing it.
 *
 * Every function here is pure and total: same inputs, same key, no I/O.
 */

import { createHash } from "node:crypto";
import { normalizeAddress } from "../domain/member.js";

/**
 * BLAKE2b-256, matching the engine's own hash family so provenance values and
 * derived ids read as one vocabulary rather than two.
 */
export function digest(input) {
  return createHash("blake2b512").update(input).digest("hex").slice(0, 64);
}

/**
 * A key segment that is safe to embed in an id.
 *
 * Message-IDs and addresses carry `<`, `>`, `@`, `/` and whitespace. Rather than
 * inventing an escaping scheme whose corner cases become a source of collisions,
 * anything outside a conservative set is hashed. Readable when it can be,
 * unambiguous always.
 */
function segment(value) {
  const s = String(value).trim();
  return /^[A-Za-z0-9._@+-]{1,120}$/.test(s) ? s : digest(s);
}

/* --- 1. Inbound RFC Message-ID --------------------------------------- */

/**
 * Angle brackets are transport syntax, not identity: `<abc@host>` and `abc@host`
 * are the same message. Folding them here is what makes INV-2's "deduplicated"
 * true for a sender that omits them.
 */
export function messageKey(rfcMessageId) {
  const raw = String(rfcMessageId).trim().replace(/^<|>$/g, "");
  if (raw === "") throw new TypeError("An inbound message requires an RFC Message-ID");
  return segment(raw);
}

/* --- 2. Member primary normalized email ------------------------------ */

export function memberKey(address) {
  return segment(normalizeAddress(address));
}

/* --- 3. Source content hash within a member -------------------------- */

/**
 * Scoped to the member on purpose. Two people may legitimately send the same
 * public deck, and those are two sources with two provenance chains. Deduping
 * globally would attribute one person's evidence to another.
 */
export function sourceKey(memberId, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  return `${segment(memberId)}:${digest(bytes)}`;
}

/* --- 4. Match: policy version + ordered member pair + match cycle ----- */

/**
 * The pair is SORTED before hashing, so (alice, bob) and (bob, alice) are one
 * match rather than two. §7.3 scores both directions inside a single match;
 * an unordered pair would let the same two people be proposed twice, once from
 * each side, with neither instance able to see the other's veto.
 */
export function matchKey({ policyId, policyVersion, memberIds, cycle }) {
  if (!Array.isArray(memberIds) || memberIds.length !== 2) {
    throw new TypeError("A match key requires exactly two member ids");
  }
  const [a, b] = [...memberIds].map(segment).sort();
  if (a === b) throw new TypeError("A match key requires two distinct members");
  if (policyVersion === undefined || policyVersion === null) {
    throw new TypeError("A match key requires a policy version");
  }
  if (cycle === undefined || cycle === null) throw new TypeError("A match key requires a cycle");
  return `${segment(policyId)}:v${policyVersion}:${a}~${b}:c${cycle}`;
}

/* --- 5. Private preview: match + recipient ---------------------------- */

export function previewKey(matchId, recipientMemberId) {
  return `${segment(matchId)}:${segment(recipientMemberId)}`;
}

/* --- 6. Introduction: match ------------------------------------------ */

/**
 * The match alone. One pair, one introduction per cycle — INV-10 — so there is
 * nothing else the key could contain without weakening it.
 */
export function introductionKey(matchId) {
  return segment(matchId);
}

/* --- 7. Enrollment invitation: normalized address, lifetime ----------- */

/**
 * §5.4. Deliberately not the thread and not the inviting member: an address
 * surfaced on six threads by four members must receive one invitation, ever.
 */
export function invitationKey(address) {
  return `enrollment_invitation:${normalizeAddress(address)}`;
}

/* --- 8. Outbox idempotency key ---------------------------------------- */

/**
 * Unique per *intended email*, never per attempt. Retries reuse the key, which
 * is the only reason a resend after a crash is recognisable as the same message
 * rather than a second one.
 */
export function outboxKey(idempotencyKey) {
  const raw = String(idempotencyKey ?? "").trim();
  if (raw === "") throw new TypeError("An outbox job requires an idempotency key");
  return segment(raw);
}

/** Compose the outbox key for each purpose that has a canonical shape. */
export const outboxKeyFor = Object.freeze({
  privateMatchPreview: (matchId, recipientMemberId) =>
    outboxKey(`private_match_preview:${previewKey(matchId, recipientMemberId)}`),
  jointIntroduction: (matchId) => outboxKey(`joint_introduction:${introductionKey(matchId)}`),
  enrollmentInvitation: (address) => outboxKey(invitationKey(address)),
});
