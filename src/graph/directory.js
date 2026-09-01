/**
 * The résumé directory — Yente's pretty-printed read of every résumé, as a
 * public surface. Mark's directive, 2026-08-31: "add resume directory — not
 * the file but our pretty printed version of it, deduped of course, on the
 * ccme.network lp. searchable, graph based, pure nedb lookups."
 *
 * Nothing here renders a document. A card is assembled from VERIFIED claims —
 * every one traced to a verbatim span of a document the person themselves
 * sent — read straight out of the NEDB-backed graph, identity-resolved and
 * with retractions honoured. Dedupe is not a feature bolted on here: it IS
 * the graph's identity resolution, so one person is one card however many
 * addresses their résumé arrived under.
 *
 * PUBLIC-SURFACE RULE: no addresses. Subject ids are email addresses by
 * design, and they belong on the operator's manager pages — a public card
 * carries a name, the verified facts, and an opaque key. There is a test
 * that greps the serialized directory for "@" and fails if one appears.
 *
 * Search parity: the same significantWords tokenizer as matching and the
 * manager's graph search, for the same reason those two share it — what the
 * directory finds and what matching sees must not drift apart.
 */

import { resolveObservations } from "./identity.js";
import { significantWords, sourceKindOf } from "./provenance.js";
import { digest } from "../store/keys.js";

/** Disclosure predicates, in the order a card presents them. */
const DISCLOSURE_FIELDS = Object.freeze([
  "role", "employer", "industry", "capability", "geography",
  "seniority", "credential", "availability", "stage", "budget",
]);

const GRADE_RANK = Object.freeze({ exceptional: 3, strong: 2, good: 1 });

/** Case-insensitive dedupe that keeps the first spelling seen. */
function addValue(list, value) {
  const text = String(value ?? "").trim();
  if (!text) return;
  const key = text.toLowerCase();
  if (!list.some((held) => held.toLowerCase() === key)) list.push(text);
}

function emptyCard(subject) {
  return {
    subject,
    name: null,
    nameSeenAt: "",
    organization: false,
    fromResume: false,
    fields: Object.fromEntries(DISCLOSURE_FIELDS.map((field) => [field, []])),
    intents: [],
    proposals: [],
    claims: 0,
    lastSeen: null,
  };
}

/** Everything searchable about a card, as one string. */
function cardText(card) {
  return [
    card.name,
    ...DISCLOSURE_FIELDS.flatMap((field) => card.fields[field]),
    ...card.intents.map((intent) => `${intent.type} ${intent.object}`),
    ...card.proposals.map((p) => `${p.kind} ${p.grade} ${p.target}`),
  ].join(" ");
}

/**
 * Build the directory: one card per resolved person whose words include a
 * document they sent. Pure reads — graph.observations.all() is the single
 * NEDB sweep, and everything else is assembly.
 *
 * @param {{graph: object}} deps
 * @param {{query?: string|null, limit?: number}} [options]
 */
export function buildDirectory({ graph }, { query = null, limit = 200 } = {}) {
  const resolved = resolveObservations(graph.observations.all())
    .filter((row) => !row?.attributes?.retracted);

  const people = new Map();
  for (const row of resolved) {
    const held = people.get(row.subject) ?? emptyCard(row.subject);
    held.claims += 1;
    if (!held.lastSeen || String(row.observedAt) > String(held.lastSeen)) {
      held.lastSeen = row.observedAt ?? null;
    }
    if (sourceKindOf(row.evidenceId) === "attachment") held.fromResume = true;

    const predicate = String(row.predicate ?? "");
    if (predicate === "is_person") {
      // The LATEST stated name wins — people fix their own headers.
      if (String(row.observedAt ?? "") >= held.nameSeenAt) {
        held.name = String(row.object ?? "").trim() || held.name;
        held.nameSeenAt = String(row.observedAt ?? "");
      }
    } else if (predicate === "is_organization") {
      held.organization = true;
    } else if (DISCLOSURE_FIELDS.includes(predicate)) {
      addValue(held.fields[predicate], row.object);
    } else if (predicate.startsWith("intent:")) {
      const type = predicate.slice("intent:".length);
      const object = String(row.object ?? "").trim();
      if (object && !held.intents.some((held2) =>
        held2.type === type && held2.object.toLowerCase() === object.toLowerCase())) {
        held.intents.push({ type, object });
      }
    } else if (predicate.startsWith("proposal:")) {
      const kind = predicate.slice("proposal:".length);
      const target = String(row.object ?? "").trim();
      const grade = String(row.attributes?.grade ?? "").toLowerCase() || null;
      if (target && !held.proposals.some((held2) =>
        held2.kind === kind && held2.target.toLowerCase() === target.toLowerCase())) {
        held.proposals.push({ kind, target, grade });
      }
    }
    people.set(row.subject, held);
  }

  // A directory member is a NAMED PERSON whose claims include a document
  // they sent. Organizations are graph subjects, not résumés; a person known
  // only from message prose has not put a résumé on the desk yet.
  let cards = [...people.values()]
    .filter((card) => !card.organization && card.name && card.fromResume);

  const words = new Set(significantWords(String(query ?? "")));
  if (words.size > 0) {
    // EVERY query word must appear — "rust miami" means both, which is what
    // somebody narrowing a directory expects. Same tokenizer as matching.
    cards = cards.filter((card) => {
      const haystack = new Set(significantWords(cardText(card)));
      for (const word of words) if (!haystack.has(word)) return false;
      return true;
    });
  }

  cards.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));

  return cards.slice(0, Math.max(0, limit)).map((card) => Object.freeze({
    // Opaque and stable; never the subject id, which is an address.
    key: digest(card.subject).slice(0, 12),
    name: card.name,
    headline: [card.fields.role[0], card.fields.employer[0]]
      .filter(Boolean).join(" · ") || null,
    ...Object.fromEntries(DISCLOSURE_FIELDS.map((field) => {
      const plural = field === "capability" ? "capabilities"
        : field === "geography" ? "geographies"
        : field === "industry" ? "industries"
        : `${field}s`;
      return [plural, Object.freeze([...card.fields[field]])];
    })),
    intents: Object.freeze(card.intents.map((intent) => Object.freeze({ ...intent }))),
    proposals: Object.freeze(
      [...card.proposals]
        .sort((a, b) => (GRADE_RANK[b.grade] ?? 0) - (GRADE_RANK[a.grade] ?? 0))
        .map((proposal) => Object.freeze({ ...proposal })),
    ),
    claims: card.claims,
    lastSeen: card.lastSeen,
  }));
}
