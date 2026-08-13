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

/* -------------------------------------------------------------------------
 * The enrollment invitation — SPEC v2 §5.4
 *
 * The one message that goes to somebody who did not write in. It is both the
 * acquisition loop and the whole domain risk, and §5.4 leaves almost nothing to
 * write with: no thread content, no counterpart, no profile, nothing about the
 * recipient at all. Four slots, and one of them is optional.
 *
 * That constraint is the brief rather than an obstacle. With no information to
 * flatter anyone with, the only thing the email can offer is candour, so the
 * copy spends its length on what Yente will NOT do. Three of those promises are
 * enforced elsewhere in this codebase, which is what makes them safe to make:
 *
 *   "it is the only time you will hear from me" -> invitationKey is the address,
 *                                                  once for the lifetime (§5.4)
 *   "I have not read the thread"                -> no thread content reaches
 *                                                  this template, and the
 *                                                  disclosure guard rejects it
 *   "there is no follow-up"                     -> invitationFollowUp() returns
 *                                                  null and exists to be empty
 *
 * The subject names the member who copied Yente in and states the plain fact. A
 * stranger's first question is "why is this in my inbox", and answering it in
 * the subject line is worth more than any cleverness available here.
 *
 * DELIBERATELY OMITTED: the thread's subject line. It is the single most useful
 * piece of context available and it is thread content, so it stays out. Named
 * here because it is the obvious thing a future edit will want to add back.
 * ---------------------------------------------------------------------- */

const INVITATION_TEMPLATE = "enrollment_invitation";

const INVITATION_FORBIDDEN = Object.freeze([
  "any content from the thread, including its subject line",
  "any fact about the recipient, their employer, or their work",
  "any other person's name, profile, or summary",
  "any claim that a match, opportunity, or introduction already exists",
  "any email address other than the supplied reply address",
  "any deadline, or any suggestion that silence means yes",
]);

function requireInvitationSlots({ invitedName, invitingName, replyAddress, unsubscribeUrl }) {
  for (const [field, value] of Object.entries({ invitingName, replyAddress, unsubscribeUrl })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`An enrollment invitation requires ${field}`);
    }
  }
  if (invitedName !== undefined && invitedName !== null && typeof invitedName !== "string") {
    throw new TypeError("invitedName must be text when supplied");
  }
  return {
    invitedName:
      typeof invitedName === "string" && invitedName.trim() !== "" ? invitedName.trim() : null,
    invitingName: invitingName.trim(),
    replyAddress: replyAddress.trim(),
    unsubscribeUrl: unsubscribeUrl.trim(),
  };
}

/**
 * The §11 prompt. Four approved slots and an explicit list of what may not
 * appear — the forbidden list is longer than the permitted one, which is the
 * right proportion for the only class addressed to a stranger.
 */
export function createEnrollmentInvitationPrompt({
  invitedName,
  invitingName,
  replyAddress,
  unsubscribeUrl,
}) {
  const slots = requireInvitationSlots({ invitedName, invitingName, replyAddress, unsubscribeUrl });

  return createPromptArtifact([
    {
      tag: BLOCK_TAGS.TASK,
      content:
        "Write one short plain-text email inviting this person to enrol with Yente. " +
        "They did not write in: a member copied Yente on an email thread they are on, " +
        "and this is the only message they will ever receive unless they reply. " +
        "Lead with why it is in their inbox. Be warm, plain and brief. " +
        "State clearly that Yente has not read the thread and knows nothing about them. " +
        "Give one clear way to say yes, replying with whatever explains their work, and " +
        "one clear way to say no, ignoring it or unsubscribing. Promise no follow-up. " +
        "Do not sell, do not flatter, do not use marketing language, and do not invent " +
        "any fact about the recipient or anyone else.",
    },
    { tag: BLOCK_TAGS.POLICY, json: { approvedSlots: slots, forbidden: INVITATION_FORBIDDEN } },
    {
      tag: BLOCK_TAGS.OUTPUT_CONTRACT,
      content: "Return exactly one META, one SUBJECT, and one EMAIL_TEXT block.",
    },
  ]);
}

/**
 * The deterministic invitation.
 *
 * This is what §11.6 falls back to when the model fails twice, and also the
 * reference the model is measured against. It is written to be good enough to
 * send as-is: a fallback nobody would be happy to send is a fallback that turns
 * a model outage into a product outage.
 */
export function createReferenceEnrollmentInvitation({
  invitedName,
  invitingName,
  replyAddress,
  unsubscribeUrl,
  threadId,
  invitedByMemberId,
}) {
  const slots = requireInvitationSlots({ invitedName, invitingName, replyAddress, unsubscribeUrl });
  const greeting = slots.invitedName ? `Hi ${slots.invitedName},` : "Hi,";

  return createEmailArtifact({
    meta: {
      template: INVITATION_TEMPLATE,
      version: 1,
      thread_id: threadId ?? null,
      invited_by: invitedByMemberId ?? null,
      facts_used: [],
    },
    subject: `${slots.invitingName} copied me on a thread with you`,
    text:
      `${greeting}\n\n` +
      `${slots.invitingName} copied me on an email thread you are both on. That is the ` +
      `only reason you are hearing from me, and it is the only time you will unless you ` +
      `write back.\n\n` +
      `I am Yente. I make professional introductions over email \u2014 one person to one ` +
      `person, when there is a real reason for it. No app, no feed, no profile to fill ` +
      `in. You send me whatever already explains your work: a resume, a LinkedIn export, ` +
      `a portfolio, or a few sentences. You tell me what you are looking for. When ` +
      `someone genuinely fits, I write to each of you privately first, and if either of ` +
      `you would rather not, nothing happens.\n\n` +
      `Good introductions usually come from who you already know. I am a way to get one ` +
      `when you don't.\n\n` +
      `To be plain about what I have: nothing. I have not read the thread, I do not have ` +
      `your resume, and I know nothing about you beyond the fact that ` +
      `${slots.invitingName} put us in the same room.\n\n` +
      `If you would like in, reply to this email with whatever best explains what you do.\n\n` +
      `If not, ignore this. There is no follow-up and no second message. You can also ` +
      `unsubscribe and I will drop your address entirely: ${slots.unsubscribeUrl}\n\n` +
      `— Yente\n${slots.replyAddress}`,
  });
}

/** What the disclosure guard is given for this class. */
export function enrollmentInvitationExpectation({ replyAddress, unsubscribeAddress }) {
  return {
    template: INVITATION_TEMPLATE,
    allowedFactIds: [],
    allowedAddresses: [replyAddress, unsubscribeAddress].filter(Boolean),
    forbiddenSubstrings: [],
  };
}
