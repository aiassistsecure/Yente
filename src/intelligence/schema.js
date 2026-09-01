/**
 * The observation envelope — what Muse is allowed to say, and how we check it.
 *
 * "Muse proposes beliefs. Yente owns truth." That sentence only means something
 * if there is a gate, and this file is the gate's first half: the SHAPE check.
 * The second half is semantic (does the quoted evidence exist in the source),
 * and it lives in extract/spans.js, which already does exactly that job for
 * profile facts and needs no changes to do it for observations.
 *
 * TWO STAGES, DELIBERATELY SEPARATE
 *
 *   validateEnvelope()  — is this the right shape, with the right types and
 *                         internally consistent references?
 *   verifyObservations() — is each claim's quoted evidence actually present in
 *                         the stored source text?
 *
 * Keeping them apart matters because they fail differently and deserve
 * different responses. A malformed envelope is worth one retry carrying the
 * error, because models fix shape when told. A claim whose evidence cannot be
 * found is not a retryable error at all — it is the model inventing, and the
 * correct response is to drop that claim and keep the rest.
 *
 * WHERE THIS DEPARTS FROM THE BRIEF, AND WHY
 *
 * The brief's conceptual JSON puts `confidence` and `evidence_refs` at the
 * ENVELOPE level:
 *
 *   { entities: [], intents: [], ..., confidence: {}, evidence_refs: [] }
 *
 * Envelope-level evidence cannot be verified per claim. If ten intents share
 * one `evidence_refs` array, a single real quote launders the other nine — and
 * "every inferred graph fact should be traceable back to its evidence" becomes
 * unenforceable precisely where it matters most. So evidence and confidence are
 * required PER CLAIM here. `evidenceRefs` still appears on the envelope, but it
 * is DERIVED from the claims and cross-checked against them rather than
 * accepted from the model: a source id the model cites in the envelope but
 * quotes in no claim is a discrepancy worth reporting, not a fact.
 *
 * SCHEMA VERSION IS PROVENANCE, NOT DECORATION
 *
 * Every observation records the schema version that produced it, so the
 * reprocessing the brief asks for — re-analyse everything from
 * (muse-local:latest, obs_v1) under (muse-local:latest, obs_v2) without
 * re-ingesting the mailbox — is a query rather than a migration.
 */

/**
 * Bump this when the envelope's SHAPE or the prompt's meaning changes in a way
 * that makes old and new observations non-comparable. It is part of the
 * inference cache key, so a bump invalidates cached inferences by construction
 * instead of by remembering to clear something.
 */
export const OBSERVATION_SCHEMA_VERSION = "obs_v2";

export class SchemaError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
    this.meta = meta;
  }
}

/**
 * Entity kinds. Closed, because these decide which graph collection a claim
 * lands in — an unrecognised kind has nowhere to go, and silently coercing it
 * is how a person becomes an organisation.
 */
export const ENTITY_KINDS = Object.freeze(["PERSON", "ORGANIZATION"]);

/**
 * Intent types, from §15 of the redesign brief.
 *
 * OPEN by design (§6: "do not treat this as a rigid final ontology"). An
 * unrecognised type is preserved as `UNKNOWN` with the model's raw string kept
 * in `rawType`, and counted — so a type we should support shows up as a number
 * in the logs rather than as silence. That is the lesson from the vocabulary
 * drift that dropped all sixteen of a real member's verified facts: the
 * dangerous failure is not rejection, it is discarding without a count.
 */
export const INTENT_TYPES = Object.freeze([
  "SEEKING", "OFFERING", "DISCUSSING", "CONSIDERING", "INTRODUCING",
  "HIRING", "SELLING", "BUYING", "INVESTING", "FUNDRAISING",
  "PARTNERING", "REFERRING",
]);

/**
 * Relationship predicates. CLOSED — see normalizeRelationship for why this
 * changed, and what it cost while it was open.
 */
export const RELATIONSHIP_PREDICATES = Object.freeze([
  "works_at", "knows", "communicated_with", "introduced",
]);

/**
 * What a message can DISCLOSE about somebody.
 *
 * A closed vocabulary, and the same one profile extraction already uses
 * (`domain/profile-schema.js`), so a fact mined from a résumé by the desk and a
 * fact observed from an email by the graph land under the same name instead of
 * being two vocabularies that drift.
 *
 * This is the array that replaced `opportunities` and `observations`. Those two
 * asked the model to speculate ("a concrete business possibility the sources
 * support") and then to keep going ("anything else worth remembering that the
 * shapes above do not fit") — an instruction to produce until it runs out of
 * text, which is exactly what it did. A disclosure has a FIELD and a VALUE, so
 * there is a shape to fill and a point at which the source has nothing left to
 * say.
 */
export const DISCLOSURE_FIELDS = Object.freeze([
  "role", "capability", "industry", "employer", "geography",
  "seniority", "credential", "availability", "stage", "budget",
  // A way to reach them that they OFFERED — a phone number, a handle. Added
  // 2026-09-01 after the live desk rejected "+1-844-VAPE-B2B" twice per pass
  // (UNKNOWN_DISCLOSURE_FIELD): the writer kept handing over contact routes
  // and the schema kept refusing to remember them. Renders everywhere,
  // including the public directory — this is B2B, and a business line the
  // writer volunteered is a business line (Mark, 2026-09-01).
  "contact",
]);

/**
 * What a proposal may propose someone FOR, and how well they fit.
 *
 * A proposal is Yente's graded read of a résumé: "strong candidate for
 * backend engineering roles", "good candidate for investment in their
 * venture". Two kinds, mirroring the two declared-role pairs the desk
 * actually brokers: hire_for answers HIRING <-> SEEKING_EMPLOYMENT, and
 * invest_in answers SEEKING_FUNDING <-> FUNDING_STARTUPS.
 *
 * THE GRADES ONLY GO UP. The floor of the scale is "good": there is no
 * "weak", no "poor", no numeric score that can be low, and the normalizer
 * below copies no field in which a weakness could ride. This is positivity
 * enforced the way this schema enforces everything — by making the negative
 * UNREPRESENTABLE rather than discouraged. Determining what is wrong with a
 * résumé is expensive, slow, and none of the desk's business; judging the
 * cover is one pass. A person a résumé does not support proposing is simply
 * not proposed, and that absence costs nothing and defames nobody.
 */
export const PROPOSAL_KINDS = Object.freeze(["hire_for", "invest_in"]);
export const PROPOSAL_GRADES = Object.freeze(["good", "strong", "exceptional"]);

const ENTITY_KIND_SET = new Set(ENTITY_KINDS);
const INTENT_TYPE_SET = new Set(INTENT_TYPES);
const PREDICATE_SET = new Set(RELATIONSHIP_PREDICATES);
const DISCLOSURE_FIELD_SET = new Set(DISCLOSURE_FIELDS);
const PROPOSAL_KIND_SET = new Set(PROPOSAL_KINDS);
const PROPOSAL_GRADE_SET = new Set(PROPOSAL_GRADES);

/** The claim arrays. `confidence`/`evidenceRefs` are envelope metadata. */
export const CLAIM_GROUPS = Object.freeze([
  "entities", "intents", "relationships", "disclosures", "proposals",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, label, { max = 2_000 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaError("FIELD_MISSING", `${label} must be non-empty text`);
  }
  if (value.length > max) {
    throw new SchemaError("FIELD_TOO_LONG",
      `${label} exceeds ${max} characters (${value.length})`);
  }
  return value.trim();
}

/**
 * Confidence is a number in [0,1]. A missing confidence is NOT defaulted to
 * something confident — an unstated confidence becomes 0.5, because inventing
 * certainty on the model's behalf is the same class of error as inventing
 * evidence.
 */
function normalizeConfidence(value, label) {
  if (value === undefined || value === null) return 0.5;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new SchemaError("BAD_CONFIDENCE", `${label} confidence must be a number`);
  }
  return Math.min(1, Math.max(0, n));
}

/**
 * Every claim carries the same evidence triple, whatever kind of claim it is.
 * One shape means one verifier and one place for the rule to be wrong.
 */
function normalizeEvidence(claim, label) {
  return {
    sourceId: requireString(claim.source_id ?? claim.sourceId, `${label}.source_id`, { max: 256 }),
    evidence: requireString(claim.evidence, `${label}.evidence`, { max: 4_000 }),
    explicit: claim.explicit === true,
    confidence: normalizeConfidence(claim.confidence, label),
  };
}

function normalizeEntity(raw, index) {
  const label = `entities[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  const kind = String(raw.kind ?? "").trim().toUpperCase();
  if (!ENTITY_KIND_SET.has(kind)) {
    // Closed vocabulary: an unknown kind has no collection to land in.
    throw new SchemaError("UNKNOWN_ENTITY_KIND",
      `${label}.kind must be one of ${ENTITY_KINDS.join(", ")}, got ${raw.kind ?? "(missing)"}`,
      { kind: raw.kind });
  }
  return Object.freeze({
    ref: requireString(raw.ref, `${label}.ref`, { max: 128 }),
    kind,
    name: requireString(raw.name, `${label}.name`, { max: 512 }),
    emailAddress: typeof raw.email_address === "string" && raw.email_address.includes("@")
      ? raw.email_address.trim().toLowerCase()
      : null,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null,
    ...normalizeEvidence(raw, label),
  });
}

function openVocabulary(rawValue, allowed, fallback) {
  const value = String(rawValue ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (allowed.has(value)) return { value, rawValue: null };
  return { value: fallback, rawValue: String(rawValue ?? "") };
}

function normalizeIntent(raw, index) {
  const label = `intents[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  const { value: type, rawValue: rawType } = openVocabulary(raw.type, INTENT_TYPE_SET, "UNKNOWN");
  return Object.freeze({
    actorRef: requireString(raw.actor_ref ?? raw.actorRef, `${label}.actor_ref`, { max: 128 }),
    type,
    rawType,
    object: requireString(raw.object, `${label}.object`, { max: 512 }),
    attributes: isPlainObject(raw.attributes) ? Object.freeze({ ...raw.attributes }) : Object.freeze({}),
    ...normalizeEvidence(raw, label),
  });
}

function normalizeRelationship(raw, index) {
  const label = `relationships[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  const predicate = String(raw.predicate ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

  // CLOSED, like entity kinds — and this used to be open, which was the bug.
  //
  // An unrecognised predicate was silently rewritten to `associated_with` and
  // stored as a real edge, so a relationship the model invented could never
  // fail validation; it just arrived wearing a vaguer name. That is how the
  // graph filled with connections nobody could trace to a claim anyone made.
  //
  // Rejecting is not the same as discarding: the rejection is counted and
  // reported with the offending predicate, so a vocabulary that is genuinely
  // too narrow shows up as a pattern in the rejections rather than as silent
  // mush in the graph.
  //
  // `mentions` and `associated_with` went with it. They are facts about text,
  // not about people: always true, never meaningful, and the two the fallback
  // funnelled everything into.
  if (!PREDICATE_SET.has(predicate)) {
    throw new SchemaError("UNKNOWN_PREDICATE",
      `${label}.predicate must be one of ${RELATIONSHIP_PREDICATES.join(", ")}, `
      + `got ${raw.predicate ?? "(missing)"}`,
      { predicate: raw.predicate });
  }

  return Object.freeze({
    subjectRef: requireString(raw.subject_ref ?? raw.subjectRef, `${label}.subject_ref`, { max: 128 }),
    predicate,
    objectRef: requireString(raw.object_ref ?? raw.objectRef, `${label}.object_ref`, { max: 128 }),
    ...normalizeEvidence(raw, label),
  });
}

/**
 * What this message revealed about somebody: a typed field and its value.
 *
 * Replaces `opportunities` (speculation) and `observations` (a catch-all whose
 * own description invited the model to keep producing). A disclosure has to
 * name a field from a closed list, so there is a shape to fill and a point at
 * which the source has nothing left to disclose.
 */
function normalizeDisclosure(raw, index) {
  const label = `disclosures[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  const field = String(raw.field ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!DISCLOSURE_FIELD_SET.has(field)) {
    throw new SchemaError("UNKNOWN_DISCLOSURE_FIELD",
      `${label}.field must be one of ${DISCLOSURE_FIELDS.join(", ")}, got ${raw.field ?? "(missing)"}`,
      { field: raw.field });
  }
  return Object.freeze({
    subjectRef: requireString(raw.subject_ref ?? raw.subjectRef, `${label}.subject_ref`, { max: 128 }),
    field,
    value: requireString(raw.value, `${label}.value`, { max: 512 }),
    ...normalizeEvidence(raw, label),
  });
}

function normalizeProposal(raw, index) {
  const label = `proposals[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  const kind = String(raw.kind ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!PROPOSAL_KIND_SET.has(kind)) {
    throw new SchemaError("UNKNOWN_PROPOSAL_KIND",
      `${label}.kind must be one of ${PROPOSAL_KINDS.join(", ")}, got ${raw.kind ?? "(missing)"}`,
      { kind: raw.kind });
  }
  const grade = String(raw.grade ?? "").trim().toLowerCase();
  if (!PROPOSAL_GRADE_SET.has(grade)) {
    throw new SchemaError("UNKNOWN_PROPOSAL_GRADE",
      `${label}.grade must be one of ${PROPOSAL_GRADES.join(", ")} — the scale has no `
      + `bottom below "good", by design — got ${raw.grade ?? "(missing)"}`,
      { grade: raw.grade });
  }
  // ONLY these fields survive. A model that volunteers "weaknesses",
  // "concerns", "risks" or a score finds them dropped here by construction:
  // the object is built from named fields, never spread from the input.
  return Object.freeze({
    subjectRef: requireString(raw.subject_ref ?? raw.subjectRef, `${label}.subject_ref`, { max: 128 }),
    kind,
    target: requireString(raw.target, `${label}.target`, { max: 512 }),
    grade,
    ...normalizeEvidence(raw, label),
  });
}

const NORMALIZERS = Object.freeze({
  entities: normalizeEntity,
  intents: normalizeIntent,
  relationships: normalizeRelationship,
  disclosures: normalizeDisclosure,
  proposals: normalizeProposal,
});

/**
 * Stage one: is this the right shape?
 *
 * Returns `{ envelope, rejected, discrepancies }`. A claim that fails its own
 * normalisation is REJECTED individually and counted rather than failing the
 * whole envelope — one malformed intent should not discard nine good entities.
 * The exception is a structurally wrong envelope (not an object, a claim group
 * that is not an array), which is a shape failure worth one retry.
 *
 * @param {object} raw            parsed JSON from the model's block
 * @param {object} [options]
 * @param {Set<string>} [options.knownSourceIds]  source ids that actually exist
 * @param {Iterable<string>} [options.providedRefs]  refs the CALLER declared —
 *        identities Yente established deterministically (the message sender,
 *        keyed by their email address) and handed to the model as given. A
 *        claim referencing a provided ref is not dangling: the entity exists
 *        because the transport says so, not because the model asserted it.
 */
export function validateEnvelope(raw, { knownSourceIds = null, providedRefs = null } = {}) {
  if (!isPlainObject(raw)) {
    throw new SchemaError("BAD_ENVELOPE", "Observation envelope must be a JSON object");
  }

  const envelope = {};
  const rejected = [];

  for (const group of CLAIM_GROUPS) {
    const value = raw[group];
    if (value === undefined || value === null) {
      envelope[group] = Object.freeze([]);
      continue;
    }
    if (!Array.isArray(value)) {
      throw new SchemaError("BAD_ENVELOPE", `${group} must be an array when present`);
    }
    const kept = [];
    value.forEach((claim, index) => {
      try {
        kept.push(NORMALIZERS[group](claim, index));
      } catch (error) {
        rejected.push({
          group,
          index,
          code: error instanceof SchemaError ? error.code : "BAD_CLAIM",
          message: String(error?.message ?? error),
        });
      }
    });
    envelope[group] = Object.freeze(kept);
  }

  // Referential integrity. An intent whose actor names no declared entity
  // cannot be attached to anybody, so it is not a usable claim — and this is
  // the check that catches a model inventing a reference rather than a quote.
  //
  // Provided refs count as declared. The sender of a message EXISTS — the
  // MIME parser proved it before the model ever ran — and requiring the model
  // to re-assert that existence (with a name it may not have) was how every
  // bare-address email produced zero claims by construction: name missing →
  // entity rejected → every fact about the sender cascaded out with it.
  // Identity comes from transport; the model only attaches facts to it.
  const declaredRefs = new Set(envelope.entities.map((entity) => entity.ref));
  for (const ref of providedRefs ?? []) declaredRefs.add(ref);
  const REF_FIELDS = Object.freeze({
    intents: ["actorRef"],
    relationships: ["subjectRef", "objectRef"],
    disclosures: ["subjectRef"],
    proposals: ["subjectRef"],
  });

  for (const [group, fields] of Object.entries(REF_FIELDS)) {
    const kept = envelope[group].filter((claim, index) => {
      const dangling = fields.filter((field) => !declaredRefs.has(claim[field]));
      if (dangling.length === 0) return true;
      rejected.push({
        group,
        index,
        code: "DANGLING_REF",
        message: `references undeclared entity: ${dangling.map((f) => `${f}=${claim[f]}`).join(", ")}`,
      });
      return false;
    });
    envelope[group] = Object.freeze(kept);
  }

  // `evidenceRefs` is derived from surviving claims, never trusted from the
  // model. A source the model cited but quoted nowhere is a discrepancy.
  const citedInClaims = new Set();
  for (const group of CLAIM_GROUPS) {
    for (const claim of envelope[group]) citedInClaims.add(claim.sourceId);
  }

  const discrepancies = [];
  const claimedRefs = Array.isArray(raw.evidence_refs) ? raw.evidence_refs.map(String) : [];
  for (const ref of claimedRefs) {
    if (!citedInClaims.has(ref)) {
      discrepancies.push({
        code: "CITED_BUT_UNQUOTED",
        message: `evidence_refs names ${ref}, but no surviving claim quotes it`,
      });
    }
  }
  if (knownSourceIds) {
    for (const ref of citedInClaims) {
      if (!knownSourceIds.has(ref)) {
        discrepancies.push({
          code: "UNKNOWN_SOURCE",
          message: `a claim cites source ${ref}, which was never sent to the model`,
        });
      }
    }
  }

  envelope.evidenceRefs = Object.freeze([...citedInClaims].sort());
  envelope.schemaVersion = OBSERVATION_SCHEMA_VERSION;

  return {
    envelope: Object.freeze(envelope),
    rejected: Object.freeze(rejected),
    discrepancies: Object.freeze(discrepancies),
  };
}

/** Total claims across every group — the number worth logging per inference. */
export function claimCount(envelope) {
  return CLAIM_GROUPS.reduce((total, group) => total + (envelope?.[group]?.length ?? 0), 0);
}

/**
 * Flatten to a uniform list for the span verifier, which cares only about
 * `{ sourceId, evidence }` and should not learn the claim taxonomy.
 */
export function claimsForVerification(envelope) {
  const out = [];
  for (const group of CLAIM_GROUPS) {
    envelope[group].forEach((claim, index) => {
      out.push({ group, index, claim });
    });
  }
  return out;
}
