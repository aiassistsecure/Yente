import { createHash } from "node:crypto";
import { MATCH_STATES } from "../store/graph.js";

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

  return {
    to: [seekerAddress, offererAddress],
    subject: `Introduction: ${seekerName} ↔ ${offererName}`,
    messageId: introductionMessageId(match.id ?? match._id),
    headers: {
      "X-Yente-Purpose": "joint_introduction",
      "X-Yente-Match": String(match.id ?? match._id),
    },
    text: [
      `Hi ${seekerName} and ${offererName},`,
      "",
      "This is the introduction that cleared Yente’s review.",
      "",
      seekerEvidence?.said
        ? `${seekerName} is looking for or offering: ${seekerEvidence.said}.`
        : null,
      offererEvidence?.said
        ? `${offererName} is looking for or offering: ${offererEvidence.said}.`
        : null,
      why ? `Why this matched: ${why}.` : null,
      "",
      "You both have the context now, so I’m stepping out. Reply directly to each other from here.",
      "",
      "— Yente",
      "yente@ccme.network",
    ].filter((line) => line !== null).join("\n"),
  };
}

/**
 * Deliver every confirmed graph match due now. The match row is the durable
 * outbox: claim before SMTP, mark after SMTP, and return failed sends to
 * CONFIRMED with a retry deadline.
 */
export async function drainConfirmedIntroductions({
  graph, manager, transport,
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
      const message = composeGraphIntroduction({ match: { ...claimed, id: matchId }, manager });
      const delivered = await transport.send(message);
      graph.matches.markIntroduced(matchId, {
        at: now(), messageId: delivered.messageId ?? message.messageId,
      });
      summary.sent += 1;
      log("info", "graph_introduction_sent", {
        match: matchId,
        to: message.to.join(","),
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
