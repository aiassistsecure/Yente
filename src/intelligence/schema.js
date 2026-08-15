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
export const OBSERVATION_SCHEMA_VERSION = "obs_v1";

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
 * Relationship predicates. Also open, same reasoning.
 */
export const RELATIONSHIP_PREDICATES = Object.freeze([
  "works_at", "knows", "communicated_with", "introduced",
  "mentions", "associated_with",
]);

const ENTITY_KIND_SET = new Set(ENTITY_KINDS);
const INTENT_TYPE_SET = new Set(INTENT_TYPES);
const PREDICATE_SET = new Set(RELATIONSHIP_PREDICATES);

/** The five claim arrays. `confidence`/`evidenceRefs` are envelope metadata. */
export const CLAIM_GROUPS = Object.freeze([
  "entities", "intents", "relationships", "opportunities", "observations",
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
  const known = PREDICATE_SET.has(predicate);
  return Object.freeze({
    subjectRef: requireString(raw.subject_ref ?? raw.subjectRef, `${label}.subject_ref`, { max: 128 }),
    predicate: known ? predicate : "associated_with",
    rawPredicate: known ? null : String(raw.predicate ?? ""),
    objectRef: requireString(raw.object_ref ?? raw.objectRef, `${label}.object_ref`, { max: 128 }),
    ...normalizeEvidence(raw, label),
  });
}

function normalizeOpportunity(raw, index) {
  const label = `opportunities[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  return Object.freeze({
    subjectRef: requireString(raw.subject_ref ?? raw.subjectRef, `${label}.subject_ref`, { max: 128 }),
    summary: requireString(raw.summary, `${label}.summary`, { max: 1_000 }),
    ...normalizeEvidence(raw, label),
  });
}

function normalizeObservation(raw, index) {
  const label = `observations[${index}]`;
  if (!isPlainObject(raw)) throw new SchemaError("BAD_CLAIM", `${label} must be an object`);
  return Object.freeze({
    subjectRef: typeof raw.subject_ref === "string" && raw.subject_ref.trim()
      ? raw.subject_ref.trim() : null,
    text: requireString(raw.text, `${label}.text`, { max: 1_000 }),
    ...normalizeEvidence(raw, label),
  });
}

const NORMALIZERS = Object.freeze({
  entities: normalizeEntity,
  intents: normalizeIntent,
  relationships: normalizeRelationship,
  opportunities: normalizeOpportunity,
  observations: normalizeObservation,
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
 */
export function validateEnvelope(raw, { knownSourceIds = null } = {}) {
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
  const declaredRefs = new Set(envelope.entities.map((entity) => entity.ref));
  const REF_FIELDS = Object.freeze({
    intents: ["actorRef"],
    relationships: ["subjectRef", "objectRef"],
    opportunities: ["subjectRef"],
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
