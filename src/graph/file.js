/**
 * "What do you have on file for me?" — the member's own record, rendered for
 * its owner.
 *
 * Mark, 2026-09-02, holding the phone: Yente's answer was a column of raw
 * desk facts — `professional.display_name: Mark Allen Evans` six times over,
 * `intent.introductionTypes: hiring` twice, a stranger's alias in the middle.
 * System paths and duplicates are not a record anyone can read, let alone
 * correct.
 *
 * This is the one renderer for that letter. It is DATA, not prose — the voice
 * reproduces it faithfully and wraps it in her own words. Everything here is
 * about the recipient and nobody else: no counterpart names, no counterpart
 * addresses, match counts only.
 *
 *   On file: 14 claims from 2 documents and 5 messages · first read 12 Aug 2026 · last updated 2 Sep 2026
 *   Name: Mark Allen Evans (also seen as: Mark)
 *   Role: Co-founder · President
 *   Where: World Vapor Expo
 *   Works with: Rust · Node
 *   Contact: +1-844-…
 *   Yente's read (3): hire for: rust backend engineer (strong); …
 *   Looking for: hiring: rust backend engineer
 *   Matches: 2 under review · 1 awaiting your yes · 1 introduced
 */

import { MATCH_STATES } from "../store/graph.js";
import { profileCard, renderCard } from "./consent.js";

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function day(iso) {
  const at = new Date(String(iso ?? ""));
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Sources behind the claims, by kind. Evidence ids are `kind:hash`, so the
 * kind is legible even when the evidence row itself is gone.
 */
function sourceCounts(graph, evidenceIds) {
  let documents = 0;
  let messages = 0;
  for (const id of evidenceIds) {
    const row = graph.evidence?.get?.(id) ?? null;
    const kind = row?.kind ?? String(id).split(":")[0];
    if (kind === "message") messages += 1;
    else documents += 1;
  }
  return { documents, messages };
}

function matchCounts(graph, subject) {
  const counts = { review: 0, awaiting: 0, confirmed: 0, introduced: 0 };
  for (const m of graph.matches?.all?.() ?? []) {
    if (m.seeker !== subject && m.offerer !== subject) continue;
    if (m.state === MATCH_STATES.PROPOSED) counts.review += 1;
    else if (m.state === MATCH_STATES.AWAITING_PARTIES) counts.awaiting += 1;
    else if (m.state === MATCH_STATES.CONFIRMED || m.state === MATCH_STATES.INTRODUCTION_SENDING) counts.confirmed += 1;
    else if (m.state === MATCH_STATES.INTRODUCED) counts.introduced += 1;
  }
  return counts;
}

/**
 * The member's file as lines. Returns "" when nothing at all is on record —
 * the caller decides what "nothing" sounds like.
 */
export function renderFile(graph, subjectId) {
  const card = profileCard(graph, subjectId);
  const body = renderCard(card);
  if (!body && !card.name && card.claims === 0) return "";

  const lines = [];
  const { documents, messages } = sourceCounts(graph, card.evidenceIds);
  const sources = [
    documents ? plural(documents, "document") : null,
    messages ? plural(messages, "message") : null,
  ].filter(Boolean).join(" and ");
  const span = [
    day(card.firstSeen) ? `first read ${day(card.firstSeen)}` : null,
    day(card.lastSeen) && card.lastSeen !== card.firstSeen ? `last updated ${day(card.lastSeen)}` : null,
  ].filter(Boolean);
  lines.push(`  On file: ${[
    `${plural(card.claims, "claim")}${sources ? ` from ${sources}` : ""}`,
    ...span,
  ].join(" · ")}`);

  if (card.name) {
    const others = card.names.filter((n) => n !== card.name);
    lines.push(`  Name: ${card.name}${others.length ? ` (also seen as: ${others.join(" · ")})` : ""}`);
  }

  // The card body already dedupes per field; only the proposals line grows
  // a count so a member can see how much of the record is Yente's reading
  // rather than their own words.
  for (const line of body.split("\n").filter(Boolean)) {
    lines.push(line.startsWith("  Yente's read:")
      ? line.replace("  Yente's read:", `  Yente's read (${card.proposals.length}):`)
      : line);
  }

  const m = matchCounts(graph, card.subject);
  const parts = [
    m.review ? `${m.review} under review` : null,
    m.awaiting ? `${m.awaiting} awaiting your yes` : null,
    m.confirmed ? `${m.confirmed} being introduced` : null,
    m.introduced ? `${m.introduced} introduced` : null,
  ].filter(Boolean);
  lines.push(`  Matches: ${parts.length ? parts.join(" · ") : "none yet"}`);

  return lines.join("\n");
}
