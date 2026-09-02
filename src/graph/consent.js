/**
 * Both parties say yes — Mark, 2026-09-01: "when we find a match we email
 * both parties separately and send them the other users profile cards
 * linkedin resume etc and wait for their approval email, make the LLM read
 * that and decide."
 *
 * The graph arm used to send the joint introduction the moment the operator
 * confirmed. Now confirmation opens a CONSENT ROUND instead: each party gets
 * their own letter carrying the OTHER side's evidenced profile card — name,
 * roles, employers, capabilities, geography, credentials, contact routes,
 * Yente's graded read — everything the résumé and their own mail put on the
 * record. The introduction goes out only when BOTH reply yes.
 *
 * WHO DECIDES WHAT (the design boundary, unchanged):
 *   - Control words stay deterministic and binding: INTRODUCE approves,
 *     PASS declines, STOP declines and suppresses — matched by rule, first.
 *   - Free text ("sure, connect us" / "not this quarter") is read by the
 *     DOCUMENT model under a closed contract: a single CONSENT block,
 *     {"decision": approve|decline|unclear, "quote": …}, where the quote
 *     must be a verbatim substring of the reply — a verdict the reply
 *     cannot be shown to contain is not a verdict, it is "unclear".
 *   - "unclear" changes NOTHING. Silence and small talk leave the match
 *     waiting; only a legible yes or no moves it.
 *
 * The card deliberately includes contact routes and credential URLs — this
 * is B2B and the values are things the person volunteered onto their own
 * record. The counterpart's EMAIL ADDRESS is still withheld: until both say
 * yes, reaching each other goes through Yente.
 */

import { createHash } from "node:crypto";

import { MATCH_STATES } from "../store/graph.js";
import { resolveObservations } from "./identity.js";
import { BLOCK_TAGS, composeBlocks, extractArtifact, textBlock, parseJsonBlock, namedTextBlock } from "../protocol/blocks.js";
import { YENTE_SYSTEM_IDENTITY } from "../llm/identity.js";

const CARD_FIELDS = Object.freeze([
  ["role", "Role"],
  ["employer", "Employer"],
  ["industry", "Industry"],
  ["capability", "Capabilities"],
  ["geography", "Location"],
  ["seniority", "Seniority"],
  ["credential", "Credentials"],
  ["availability", "Availability"],
  ["stage", "Stage"],
  ["budget", "Budget"],
  ["contact", "Contact"],
]);

export function addressOf(subject) {
  const value = String(subject ?? "");
  if (!value.startsWith("person:")) return null;
  const address = value.slice("person:".length);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address.toLowerCase() : null;
}

/**
 * The evidenced profile card for one subject — the "resume etc" of the
 * directive, rebuilt from verified observations rather than forwarded raw
 * (INV-6: source documents stay on the desk; their VERIFIED content is what
 * travels). Email addresses are never card lines.
 */
export function profileCard(graph, subjectId) {
  const rows = resolveObservations(graph.observations.all())
    .filter((row) => !row?.attributes?.retracted && row.subject === subjectId);

  const card = { name: null, fields: new Map(), intents: [], proposals: [] };
  let nameSeenAt = "";
  for (const row of rows) {
    const predicate = String(row.predicate ?? "");
    const value = String(row.object ?? "").trim();
    if (!value) continue;
    if (predicate === "is_person") {
      if (String(row.observedAt ?? "") >= nameSeenAt) {
        card.name = value;
        nameSeenAt = String(row.observedAt ?? "");
      }
    } else if (CARD_FIELDS.some(([field]) => field === predicate)) {
      const held = card.fields.get(predicate) ?? [];
      if (!held.some((v) => v.toLowerCase() === value.toLowerCase())) held.push(value);
      card.fields.set(predicate, held);
    } else if (predicate.startsWith("intent:")) {
      card.intents.push(`${predicate.slice("intent:".length)}: ${value}`);
    } else if (predicate.startsWith("proposal:")) {
      const grade = row.attributes?.grade ? ` (${row.attributes.grade})` : "";
      card.proposals.push(`${predicate.slice("proposal:".length).replace(/_/g, " ")}: ${value}${grade}`);
    }
  }
  return card;
}

export function renderCard(card) {
  const lines = [];
  for (const [field, label] of CARD_FIELDS) {
    const values = card.fields.get(field);
    if (values?.length) lines.push(`  ${label}: ${values.join(" · ")}`);
  }
  if (card.proposals.length) lines.push(`  Yente's read: ${card.proposals.join("; ")}`);
  if (card.intents.length) lines.push(`  Looking for: ${card.intents.join("; ")}`);
  return lines.join("\n");
}

export function partyPreviewMessageId(matchId, address) {
  const short = createHash("sha256").update(`${matchId}|${address}`).digest("hex").slice(0, 32);
  return `<yente-party-preview-${short}@ccme.network>`;
}

/**
 * One party's letter: the other side's card, and the ask. Deterministic —
 * the card is data and must be complete; prose flourishes are not worth a
 * disclosure surface here.
 */
export function composePartyPreview({ match, graph, manager, recipientSubject, counterpartSubject }) {
  const to = addressOf(recipientSubject);
  if (!to) throw new Error("a party preview requires an email-keyed person");
  const matchId = match.id ?? match._id;

  const recipientName = manager?.subject(recipientSubject)?.name
    || profileCard(graph, recipientSubject).name || to;
  const counterCard = profileCard(graph, counterpartSubject);
  const counterName = manager?.subject(counterpartSubject)?.name
    || counterCard.name || "someone in the network";

  const [seekerEvidence, offererEvidence] = match.evidence ?? [];
  const theirSaid = recipientSubject === match.seeker
    ? seekerEvidence?.said : offererEvidence?.said;
  const otherSaid = recipientSubject === match.seeker
    ? offererEvidence?.said : seekerEvidence?.said;

  const cardLines = renderCard(counterCard);
  return {
    to: [to],
    subject: `Shall I introduce you to ${counterName}?`,
    messageId: partyPreviewMessageId(matchId, to),
    headers: {
      "X-Yente-Purpose": "party_preview",
      "X-Yente-Match": String(matchId),
    },
    text: [
      `Hi ${recipientName},`,
      "",
      theirSaid
        ? `You told me: "${theirSaid}" — I think I have your match.`
        : "I think I have a match for you.",
      "",
      `Here is ${counterName}, exactly as their record supports:`,
      "",
      cardLines || "  (their profile is on file with Yente)",
      ...(otherSaid ? ["", `In their own words: "${otherSaid}"`] : []),
      "",
      "If you want the introduction, just reply and tell me — YES or",
      "INTRODUCE works, or say it your own way. PASS declines this one",
      "match; STOP ends all Yente mail. I only make the introduction when",
      "BOTH of you say yes, and until then your addresses stay with me.",
      "",
      "— Yente",
      "yente@ccme.network",
    ].join("\n"),
  };
}

/* --- reading the answer ------------------------------------------------- */

const APPROVE_WORDS = /\b(INTRODUCE|YES)\b/;
const DECLINE_WORDS = /\b(PASS|STOP|UNSUBSCRIBE)\b/;

/**
 * Read one reply and decide. Control words first, by rule — being wrong
 * about a PASS is unrecoverable. Anything else goes to the document model
 * under the CONSENT contract; a quote the reply cannot be shown to contain
 * demotes the verdict to "unclear", and "unclear" moves nothing.
 */
export async function interpretConsent({ client, text, counterpartName }) {
  const reply = String(text ?? "").trim();
  if (!reply) return { decision: "unclear", quote: null, via: "empty" };

  const head = reply.slice(0, 200).toUpperCase();
  if (DECLINE_WORDS.test(head)) return { decision: "decline", quote: null, via: "rule" };
  if (APPROVE_WORDS.test(head)) return { decision: "approve", quote: null, via: "rule" };
  if (!client) return { decision: "unclear", quote: null, via: "no_model" };

  const prompt = composeBlocks(
    textBlock(BLOCK_TAGS.TASK, [
      "You offered to introduce this person to " + String(counterpartName ?? "a match") + ",",
      "and asked them to reply if they want it. The SOURCE block is their",
      "reply. Decide what they answered:",
      '  approve  they want the introduction made',
      '  decline  they do not want THIS introduction',
      '  unclear  anything else — a question, small talk, conditions you',
      "           cannot verify, or no legible answer",
      "Copy the exact words that carry the answer into \"quote\" — a verbatim",
      "substring of the reply. When in doubt, unclear: a wrong yes costs two",
      "people an unwanted email; unclear costs nothing.",
    ].join("\n")),
    namedTextBlock(BLOCK_TAGS.SOURCE, "their_reply", reply.slice(0, 4000)),
    textBlock(BLOCK_TAGS.OUTPUT_CONTRACT, [
      "Answer as exactly one CONSENT sentinel block: the tag between triple",
      "angle brackets on its own line, one JSON object",
      '{"decision": "approve" | "decline" | "unclear", "quote": "..."} on the',
      "next line, then END between triple angle brackets on its own line.",
    ].join("\n")),
  );

  let completion;
  try {
    completion = await client.complete({ prompt, system: YENTE_SYSTEM_IDENTITY });
  } catch {
    return { decision: "unclear", quote: null, via: "model_error" };
  }
  let verdict;
  try {
    verdict = parseJsonBlock(extractArtifact(completion.text), BLOCK_TAGS.CONSENT);
  } catch {
    return { decision: "unclear", quote: null, via: "malformed" };
  }
  const decision = String(verdict?.decision ?? "").toLowerCase();
  if (decision !== "approve" && decision !== "decline") {
    return { decision: "unclear", quote: null, via: "model" };
  }
  // Grounding: the verdict must be able to point at the words that carry it.
  const quote = String(verdict?.quote ?? "").trim();
  const normalize = (v) => v.toLowerCase().replace(/\s+/g, " ").trim();
  if (!quote || !normalize(reply).includes(normalize(quote))) {
    return { decision: "unclear", quote: null, via: "ungrounded" };
  }
  return { decision, quote, via: "model" };
}

/* --- the drain ----------------------------------------------------------- */

/**
 * Drive every AWAITING_PARTIES match: send the two preview letters that have
 * not gone out yet (per-side, so a crash between sends costs one resend of
 * one side at most), then read any new replies from either party and record
 * legible decisions. State transitions live in the repository: a decline
 * rejects the match, the second approval confirms it — and the existing
 * confirmed-introduction drain sends the joint letter on the same pass.
 */
/**
 * One drain at a time. Two entrants — the manager's confirm hook and the
 * connect tick — used to overlap inside transport.send()'s await window
 * and each mail the same letter. The claim below makes that impossible per
 * letter; this latch makes it impossible per drain, so the two never even
 * interleave their reads.
 */
let drainInFlight = null;

export async function drainPartyConsent(deps) {
  if (drainInFlight) return drainInFlight;
  drainInFlight = drainPartyConsentOnce(deps).finally(() => { drainInFlight = null; });
  return drainInFlight;
}

async function drainPartyConsentOnce({
  graph, manager, transport, consentClient = null,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  if (!transport) return { previews: 0, decisions: 0 };
  const summary = { previews: 0, decisions: 0 };

  for (const held of graph.matches.byState(MATCH_STATES.AWAITING_PARTIES)) {
    const matchId = held.id ?? held._id;
    const sides = [
      { subject: held.seeker, other: held.offerer },
      { subject: held.offerer, other: held.seeker },
    ];

    for (const side of sides) {
      const address = addressOf(side.subject);
      if (!address) continue;
      const preview = held.previews?.[address] ?? null;
      const sentAt = preview?.sentAt ?? null;

      if (!sentAt) {
        // Claim FIRST — synchronously, before any await — so a concurrent
        // entrant finds the slot taken. A claim without a send is released
        // on failure; a claim that is somehow stranded (process died between
        // claim and send) is retried by the stranded sweep below.
        if (preview?.claimedAt) continue; // another pass holds it right now
        if (!graph.matches.claimPartyPreview(matchId, { address, at: now() })) continue;
        try {
          const message = composePartyPreview({
            match: { ...held, id: matchId }, graph, manager,
            recipientSubject: side.subject, counterpartSubject: side.other,
          });
          await transport.send(message);
          graph.matches.markPartyPreviewSent(matchId, { address, at: now() });
          summary.previews += 1;
          log("info", "party_preview_sent", { match: matchId, to: address });
        } catch (error) {
          graph.matches.releasePartyPreview(matchId, { address });
          log("error", "party_preview_failed", {
            match: matchId, to: address, error: String(error?.message ?? error).slice(0, 200),
          });
        }
        continue; // a reply cannot predate the letter
      }

      if (held.partyDecisions?.[address]) continue;

      // Replies live in the evidence ledger the LISTEN loop already keeps.
      const replies = graph.evidence.all().filter((row) =>
        row.kind === "message"
        && String(row.meta?.from ?? "").toLowerCase().includes(address)
        && String(row.receivedAt ?? "") > String(sentAt)
        && !(held.consentSeen ?? []).includes(row.id));

      for (const reply of replies) {
        graph.matches.noteConsentEvidence(matchId, reply.id);
        const counterpartName = manager?.subject(side.other)?.name ?? null;
        const verdict = await interpretConsent({
          client: consentClient, text: reply.text, counterpartName,
        });
        log("info", "party_reply_read", {
          match: matchId, from: address, decision: verdict.decision, via: verdict.via,
        });
        if (verdict.decision === "unclear") continue;
        graph.matches.recordPartyDecision(matchId, {
          address, decision: verdict.decision, quote: verdict.quote,
          evidenceId: reply.id, at: now(),
        });
        summary.decisions += 1;
        break; // one legible answer per side is the answer
      }
    }
  }
  return summary;
}
