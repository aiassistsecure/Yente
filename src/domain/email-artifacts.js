import {
  BLOCK_TAGS,
  createEmailArtifact,
  createPromptArtifact,
} from "../protocol/blocks.js";

function requirePair(match) {
  if (
    !Array.isArray(match?.memberIds) ||
    match.memberIds.length !== 2 ||
    match.memberIds[0] === match.memberIds[1]
  ) {
    throw new TypeError("A frozen match requires exactly two distinct members");
  }
  for (const field of ["reason", "discussionTopic"]) {
    if (typeof match[field] !== "string" || match[field].trim() === "") {
      throw new TypeError(`Frozen match ${field} must be non-empty text`);
    }
  }
}

function factIds(match) {
  if (
    !Array.isArray(match.factsUsed) ||
    match.factsUsed.length === 0 ||
    match.factsUsed.some((id) => typeof id !== "string" || id.trim() === "")
  ) {
    throw new TypeError("A frozen match requires evidenced fact IDs");
  }
  return [...new Set(match.factsUsed)].sort();
}

function requireDisclosure(match, memberId) {
  const disclosure = match.disclosures?.[memberId];
  if (!disclosure) throw new TypeError(`Missing match-safe disclosure for ${memberId}`);
  if (
    typeof disclosure.displayName !== "string" ||
    disclosure.displayName.trim() === "" ||
    typeof disclosure.summary !== "string" ||
    disclosure.summary.trim() === ""
  ) {
    throw new TypeError(`Invalid match-safe disclosure for ${memberId}`);
  }
  return disclosure;
}

function counterpartFor(match, recipientId) {
  requirePair(match);
  if (!match.memberIds.includes(recipientId)) {
    throw new TypeError("Recipient is not part of this match");
  }
  return match.memberIds.find((id) => id !== recipientId);
}

export function createPrivatePreviewPrompt({ match, policy, recipientId }) {
  const counterpartId = counterpartFor(match, recipientId);

  return createPromptArtifact([
    {
      tag: BLOCK_TAGS.TASK,
      content:
        "Write a private proposed-introduction preview. Use only supplied facts. " +
        "Explain why the match is useful and clearly offer INTRODUCE, PASS, CORRECT, and STOP.",
    },
    { tag: BLOCK_TAGS.PROFILE, json: requireDisclosure(match, counterpartId) },
    {
      tag: BLOCK_TAGS.MATCH,
      json: {
        id: match.id,
        recipientId,
        counterpartId,
        reason: match.reason,
        discussionTopic: match.discussionTopic,
        factsUsed: factIds(match),
        vetoDeadlineAt: match.vetoDeadlineAt,
      },
    },
    { tag: BLOCK_TAGS.POLICY, json: policy },
    {
      tag: BLOCK_TAGS.OUTPUT_CONTRACT,
      content: "Return exactly one META, one SUBJECT, and one EMAIL_TEXT block.",
    },
  ]);
}

export function createIntroductionPrompt({ match, policy }) {
  requirePair(match);
  return createPromptArtifact([
    {
      tag: BLOCK_TAGS.TASK,
      content:
        "Write one joint introduction email. Introduce both members, explain the " +
        "approved match, suggest a useful first topic, ask them to reply-all, " +
        "encourage one person to share a calendar link or times, and make Yente step away.",
    },
    {
      tag: BLOCK_TAGS.PROFILE,
      json: Object.fromEntries(
        match.memberIds.map((memberId) => [memberId, requireDisclosure(match, memberId)]),
      ),
    },
    {
      tag: BLOCK_TAGS.MATCH,
      json: {
        id: match.id,
        reason: match.reason,
        discussionTopic: match.discussionTopic,
        factsUsed: factIds(match),
      },
    },
    { tag: BLOCK_TAGS.POLICY, json: policy },
    {
      tag: BLOCK_TAGS.OUTPUT_CONTRACT,
      content: "Return exactly one META, one SUBJECT, and one EMAIL_TEXT block.",
    },
  ]);
}

export function createReferencePrivatePreview({ match, recipientId }) {
  const counterpartId = counterpartFor(match, recipientId);
  const recipient = requireDisclosure(match, recipientId);
  const counterpart = requireDisclosure(match, counterpartId);
  const deadline = new Date(match.vetoDeadlineAt);
  if (Number.isNaN(deadline.getTime())) {
    throw new TypeError("A private preview requires a valid veto deadline");
  }

  return createEmailArtifact({
    meta: {
      template: "private_match_preview",
      version: 1,
      match_id: match.id,
      recipient_id: recipientId,
      facts_used: factIds(match),
    },
    subject: "A potential introduction from Yente",
    text:
      `Hi ${recipient.displayName} — I found a potential introduction with ` +
      `${counterpart.displayName}.\n\n${counterpart.summary}\n\n` +
      `Why I matched you: ${match.reason}\n\n` +
      `A useful place to start may be: ${match.discussionTopic}\n\n` +
      `Reply INTRODUCE to approve, PASS to decline this match, CORRECT if a ` +
      `material fact is wrong, or STOP to halt all Yente introductions.\n\n` +
      `Unless either of you stops this match by ${deadline.toISOString()}, ` +
      `I will introduce you in one shared email.`,
  });
}

export function createReferenceIntroduction({ match }) {
  requirePair(match);
  const [firstId, secondId] = match.memberIds;
  const first = requireDisclosure(match, firstId);
  const second = requireDisclosure(match, secondId);

  return createEmailArtifact({
    meta: {
      template: "joint_introduction",
      version: 1,
      match_id: match.id,
      recipient_ids: [...match.memberIds],
      facts_used: factIds(match),
    },
    subject: `Yente introduction — ${first.displayName} x ${second.displayName}`,
    text:
      `Hi ${first.displayName} and ${second.displayName},\n\n` +
      `I am connecting you because ${match.reason}\n\n` +
      `${first.displayName}: ${first.summary}\n\n` +
      `${second.displayName}: ${second.summary}\n\n` +
      `A useful place to start may be ${match.discussionTopic}\n\n` +
      `Please reply-all to take it forward. If a conversation makes sense, one ` +
      `of you can share a calendar link or suggest a couple of times.\n\n` +
      `I will step out here and let you take it forward.\n\n— Yente`,
  });
}
