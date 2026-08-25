import { COHORTS } from "./capacity.js";

const ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * A founding seat claimed through the inbox, without asking Muse to decide.
 *
 * The landing page already encodes the cohort in each mailto subject. A resume,
 * CV or portfolio is the builder/founder acquisition path. Investor/employer/
 * acquirer language wins first so a backer attaching a document is not filed on
 * the builder side by accident.
 */
export function cohortFromInbound({ subject = "", attachmentCount = 0, attachments = [] } = {}) {
  const filenames = (attachments ?? []).map((item) => item?.filename ?? "").join(" ");
  const text = `${subject} ${filenames}`.toLowerCase();

  if (/\b(investor|employer|acquirer|backer)\b/.test(text)) {
    return COHORTS.INVESTOR_EMPLOYER;
  }
  if (/\b(developer|founder|builder|resume|résumé|cv|portfolio)\b/.test(text)) {
    return COHORTS.FOUNDER_DEVELOPER;
  }
  if (Number(attachmentCount) > 0 || (attachments ?? []).length > 0) {
    return COHORTS.FOUNDER_DEVELOPER;
  }
  return null;
}

/** Extract one canonical mailbox from either a bare address or Name <address>. */
export function addressFromInbound(value) {
  return String(value ?? "").match(ADDRESS)?.[0]?.toLowerCase() ?? null;
}

/**
 * Claim at most one seat for one sender. Returns null when the message does not
 * declare enough to choose a side; ambiguity never spends a scarce seat.
 */
export function claimSeatFromInbound({ repository, message }) {
  if (!repository || !message) return null;
  const email = addressFromInbound(message.from ?? message.meta?.from);
  const cohort = cohortFromInbound({
    subject: message.subject ?? message.meta?.subject,
    attachmentCount: message.attachmentCount ?? message.meta?.attachmentCount,
    attachments: message.attachments,
  });
  if (!email || !cohort) return null;
  return repository.claimInbound({ email, cohort });
}
