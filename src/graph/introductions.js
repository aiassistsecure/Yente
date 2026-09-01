import { createHash } from "node:crypto";
import { MATCH_STATES } from "../store/graph.js";
import {
  BLOCK_TAGS, composeBlocks, createEmailArtifact, textBlock,
} from "../protocol/blocks.js";
import { generateEmail } from "../llm/generate.js";
import { YENTE_SYSTEM_IDENTITY } from "../llm/identity.js";

function addressOf(subject) {
  const value = String(subject ?? "");
  if (!value.startsWith("person:")) return null;
  const address = value.slice("person:".length);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

function displayName(manager, subject, fallback) {
  return manager?.subject(subject)?.name || fallback;
}

export function introductionMessageId(matchId) {
  const short = createHash("sha256").update(String(matchId)).digest("hex").slice(0, 32);
  return `<yente-introduction-${short}@ccme.network>`;
}

export function composeGraphIntroduction({ match, manager }) {
  const seekerAddress = addressOf(match.seeker);
  const offererAddress = addressOf(match.offerer);
  if (!seekerAddress || !offererAddress) {
    throw new Error("confirmed introduction requires two email-keyed people");
  }
  const seekerName = displayName(manager, match.seeker, seekerAddress);
  const offererName = displayName(manager, match.offerer, offererAddress);
  const [seekerEvidence, offererEvidence] = match.evidence ?? [];
  const why = (match.reasons ?? []).map((reason) => reason.detail).filter(Boolean).join("; ");

  // The deterministic letter — and since a template nobody rewrites is the
  // one everyone receives, it is written the way a human introducer actually
  // writes: each side's OWN words as the reason, no scoring language, no
  // "cleared review", out of the room in five lines.
  return {
    to: [seekerAddress, offererAddress],
    subject: `Intro: ${seekerName} <> ${offererName}`,
    messageId: introductionMessageId(match.id ?? match._id),
    headers: {
      "X-Yente-Purpose": "joint_introduction",
      "X-Yente-Match": String(match.id ?? match._id),
    },
    text: [
      `${seekerName}, ${offererName} — you two should be talking.`,
      "",
      seekerEvidence?.said
        ? `${seekerName}, you told me: "${seekerEvidence.said}" — this is who I had in mind.`
        : `${seekerName}, this is the person I had in mind for what you're after.`,
      "",
      offererEvidence?.said
        ? `${offererName}, in your own words: "${offererEvidence.said}". That's exactly what ${seekerName} is looking for.`
        : `${offererName}, ${seekerName} is looking for exactly what you do.`,
      "",
      "You have each other now — just hit reply-all, say hello, and take it "
        + "from here. If a conversation makes sense, one of you can share a "
        + "calendar link or a couple of times. I'll get out of the way.",
      why ? `\nP.S. For the curious: ${why}.` : null,
      "",
      "— Yente",
      "yente@ccme.network",
    ].filter((line) => line !== null).join("\n"),
  };
}

/**
 * THE MODEL WRITES THE INTRODUCTION — Mark, 2026-09-01: "the introduction
 * email sucks make it sound more human and realistic ... let the model write
 * the email???"
 *
 * The voice seat composes the letter both people receive, from the match's
 * own evidence — each side's quoted words, the reasons, the names. It runs
 * through guardEmailDisclosure like every generated email: no address beyond
 * the two being introduced (and Yente's own), and two failed attempts fall
 * back to the deterministic human template above. Never silence, never a leak.
 */
export async function composeIntroductionWithVoice({ match, manager, emailClient }) {
  const base = composeGraphIntroduction({ match, manager });
  if (!emailClient) return { ...base, source: "template" };

  const seekerName = displayName(manager, match.seeker, base.to[0]);
  const offererName = displayName(manager, match.offerer, base.to[1]);
  const [seekerEvidence, offererEvidence] = match.evidence ?? [];
  const why = (match.reasons ?? []).map((reason) => reason.detail).filter(Boolean).join("; ");

  const prompt = composeBlocks(
    textBlock(BLOCK_TAGS.TASK, [
      "You made this match and it cleared review. Now write the ONE email both",
      "people receive together — the introduction itself. Write it like a",
      "well-connected human who knows them both would: warm, brief, specific.",
      `- Open to both of them by name: ${seekerName} and ${offererName}.`,
      "- The reason for the introduction is their OWN words (the MATCH block",
      "  below). Quote or closely paraphrase each side; never invent facts,",
      "  achievements, or enthusiasm they did not state.",
      "- No scoring language, no 'my review process', no bullet points.",
      "- Close by stepping out: tell them to reply-all and take it from here,",
      "  and that one of them can share a calendar link or a couple of times",
      "  if they want to meet.",
      "- NEVER include any email address in the body except your own signature,",
      "  and never mention anyone who is not one of these two people.",
      "- A few short paragraphs. Sign as Yente with yente@ccme.network.",
    ].join("\n")),
    textBlock(BLOCK_TAGS.MATCH, [
      `match_type: ${match.matchType}`,
      `seeker: ${seekerName}`,
      seekerEvidence?.said ? `seeker_said: "${seekerEvidence.said}"` : null,
      `offerer: ${offererName}`,
      offererEvidence?.said ? `offerer_said: "${offererEvidence.said}"` : null,
      why ? `why: ${why}` : null,
    ].filter(Boolean).join("\n")),
    textBlock(BLOCK_TAGS.OUTPUT_CONTRACT, [
      "Answer as exactly three sentinel blocks, in this order, with NOTHING",
      "outside a block. Each block opens with its tag between triple angle",
      "brackets on its own line and closes with END between triple angle",
      "brackets on its own line, exactly like the blocks in this prompt:",
      "",
      '  META        one JSON object, exactly {"template": "joint_introduction",',
      '              "facts_used": []}',
      "  SUBJECT     one line, at most 200 characters",
      "  EMAIL_TEXT  the letter itself, plain text",
    ].join("\n")),
  );

  const generated = await generateEmail({
    client: emailClient,
    prompt,
    system: YENTE_SYSTEM_IDENTITY,
    expect: {
      template: "joint_introduction",
      allowedFactIds: [],
      allowedAddresses: [...base.to, "yente@ccme.network"],
    },
    fallback: () => createEmailArtifact({
      meta: { template: "joint_introduction", facts_used: [] },
      subject: base.subject,
      text: base.text,
    }),
  });

  if (!generated.email) return { ...base, source: "template" };
  return {
    ...base,
    subject: generated.email.subject,
    text: generated.email.text,
    source: generated.source,
  };
}

/**
 * Deliver every confirmed graph match due now. The match row is the durable
 * outbox: claim before SMTP, mark after SMTP, and return failed sends to
 * CONFIRMED with a retry deadline.
 */
export async function drainConfirmedIntroductions({
  graph, manager, transport,
  // The voice seat. When present, the model writes each introduction (with
  // the human template as guard-checked fallback); when absent, the template.
  emailClient = null,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  if (!transport) return { claimed: 0, sent: 0, failed: 0 };
  const summary = { claimed: 0, sent: 0, failed: 0 };

  for (const candidate of graph.matches.confirmedReady(now())) {
    const matchId = candidate.id ?? candidate._id;
    const claimed = graph.matches.claimIntroduction(matchId, now());
    if (!claimed) continue;
    summary.claimed += 1;
    try {
      const { source, ...message } = await composeIntroductionWithVoice({
        match: { ...claimed, id: matchId }, manager, emailClient,
      });
      const delivered = await transport.send(message);
      graph.matches.markIntroduced(matchId, {
        at: now(), messageId: delivered.messageId ?? message.messageId,
      });
      summary.sent += 1;
      log("info", "graph_introduction_sent", {
        match: matchId,
        to: message.to.join(","),
        voice: source ?? "template",
        message_id: delivered.messageId ?? message.messageId,
      });
    } catch (error) {
      graph.matches.failIntroduction(matchId, { at: now(), error });
      summary.failed += 1;
      log("error", "graph_introduction_failed", {
        match: matchId,
        error: String(error?.message ?? error),
      });
    }
  }
  return summary;
}
