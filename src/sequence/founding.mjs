/**
 * The founding-cohort sequence. One letter a week until launch week.
 *
 * The thing that makes a weekly cadence not-spam is that every letter either
 * ASKS FOR SOMETHING YENTE ACTUALLY NEEDS or GIVES SOMETHING BACK. Nothing here
 * exists to "stay top of mind". If a week has nothing to say to a particular
 * person, it does not write — see `when` on each step.
 *
 * It is therefore a paced conversation, not a drip campaign. The distinction is
 * load-bearing: a nurture sequence that talks while the recipient is waiting is
 * exactly the behaviour the product claims not to have. INV-3 says an empty slot
 * beats a weak fill; the same logic says a skipped week beats a filler email.
 *
 * Every step declares:
 *   id       stable key — the send ledger is idempotent on (address, id)
 *   week     which week after claiming the seat it becomes eligible
 *   theme    one word, so the sequence's shape is auditable at a glance
 *   when     predicate on the subscriber. Returning false SKIPS THE WEEK
 *            entirely rather than substituting filler.
 *   subject  / text  — text is a function of { sub, snap, seat }
 *
 * Plain text on purpose. Yente is a person writing to you, and the whole
 * proposition collapses the moment her letters look like marketing.
 */

import { COHORTS } from "../waitlist/capacity.js";

const SIG = "\n\n— Yente\n";
const FOOT = (inbox) =>
  `\n\nReply STOP and I will not write again. Reply DELETE and I remove your `
  + `record entirely — not hidden, removed.\nYou can always reach a person at ${inbox}.\n`;

const nf = (n) => Number(n || 0).toLocaleString("en-US");

/** Has this person actually sent evidence yet? */
const hasEvidence = (s) => Boolean(s.evidence_received_at);
const noEvidence = (s) => !s.evidence_received_at;
/** Has Yente already produced a read-back of what she understood? */
const hasProfile = (s) => Boolean(s.profile_summary);

export const STEPS = [
  {
    id: "w0-seat",
    week: 0,
    theme: "confirmation",
    when: () => true,
    subject: ({ seat }) => `Your founding seat — no. ${seat}`,
    text: ({ sub, seat, snap, inbox }) =>
`Thank you for writing.

You are founding member no. ${seat} in the ${sub.cohort === COHORTS.INVESTOR_EMPLOYER
  ? "investors, employers and acquirers" : "developers and founders"} cohort.
That seat is yours for life, and there is nothing to pay, now or later.

Here is what I need from you, and it is the only thing I will ask twice:
something that shows what you have actually done. A résumé, a portfolio, a
LinkedIn export, a deck, or three honest paragraphs. Whatever is easiest.

Reply to this email and attach it. I read it before I ask you anything else,
because the worst use of your time is answering questions a document already
answered.

${nf(snap.total.remaining)} of ${nf(snap.total.capacity)} founding seats remain.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w1-nudge-evidence",
    week: 1,
    theme: "request",
    when: noEvidence,
    subject: () => `One attachment and you are in`,
    text: ({ inbox }) =>
`I have your seat held, but I cannot introduce you to anyone yet — I do not know
what you have done.

It genuinely does not need to be polished. A LinkedIn PDF export takes about
thirty seconds: open your profile, More, Save to PDF. A portfolio link works.
So do three paragraphs written badly.

I would rather have something rough this week than something perfect in a
month, because until it arrives you are not in the matching pool.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w1-readback",
    week: 1,
    theme: "return",
    when: (s) => hasEvidence(s) && hasProfile(s),
    subject: () => `What I understood about you — correct me`,
    text: ({ sub, inbox }) =>
`I read what you sent. Here is what I took from it, in your words where I could:

${String(sub.profile_summary || "").trim()}

If any of that is wrong, reply and tell me. Nobody else has seen it, and I would
rather be corrected now than introduce you on a misunderstanding.

Everything above traces back to a line in what you sent me. If you ever want to
know why I believe something, ask and I will quote it.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w2-one-question",
    week: 2,
    theme: "interview",
    when: hasEvidence,
    subject: () => `One question your CV could not answer`,
    text: ({ sub, inbox }) =>
`Your documents told me what you have done. They cannot tell me what you want
next — that changes faster than any profile.

So, one question:

${sub.cohort === COHORTS.INVESTOR_EMPLOYER
  ? `What would make you reply to a cold introduction this month? Stage, sector,
check size, a role you are struggling to fill, or a thesis you are actively
trying to buy into. And just as usefully: what do you never want to see again?`
  : `What would a genuinely useful introduction look like for you right now? An
investor for a round you are opening, a technical cofounder, an operator who has
done the thing you are about to do — and what is the sticking point that makes
it hard to find them yourself?`}

A sentence is plenty. Precision beats length here.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w3-how-a-brief-reads",
    week: 3,
    theme: "expectation",
    when: () => true,
    subject: () => `What you will actually receive from me`,
    text: ({ inbox }) =>
`So that nothing I send you later is a surprise, this is the shape of a match
brief. You will get one of these before you ever get a name:

  Why now.      The thing that makes the timing real.
  Why you.      Which of your stated criteria this clears.
  Evidence.     A line from their own words, with a date.

Reply PASS and it ends there. No explanation needed, and the other person is
never told who declined or that anyone did.

Two things worth knowing while you wait. You will never hold more than five open
introductions at once — a new one appears only when an old one resolves. And I
am never paid for an introduction, so I have no reason to send you a weak one.

That is also why some weeks you will hear nothing from me. Silence means nothing
has cleared the bar, which is the system working rather than failing.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w4-network-state",
    week: 4,
    theme: "report",
    when: () => true,
    subject: ({ snap }) =>
      `The network, honestly: ${nf(snap.total.claimed)} in`,
    text: ({ snap, inbox }) =>
`A short, true report rather than a milestone announcement.

  Developers and founders:              ${nf(snap.cohorts[COHORTS.FOUNDER_DEVELOPER]?.claimed)} claimed
  Investors, employers and acquirers:   ${nf(snap.cohorts[COHORTS.INVESTOR_EMPLOYER]?.claimed)} claimed
  Founding seats left:                  ${nf(snap.total.remaining)}

Why this matters to you: a matchmaker is only as good as the density on the
other side of the table. I would rather tell you the real number than imply a
network I do not have — if the side you need is thin, the honest answer is that
you wait longer, and you should know that from me and not by inference.

If you know one person who belongs in the other cohort, forwarding this is worth
more to you than to me.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "w5-still-nothing",
    week: 5,
    theme: "request",
    when: noEvidence,
    subject: () => `Holding your seat, but I need one thing`,
    text: ({ seat, inbox }) =>
`Seat no. ${seat} is still yours — I am not going to quietly give it away.

But five weeks in, I still have nothing to match on. This is my last ask; after
this I will stop writing about it and simply keep the seat open until you are
ready.

Anything at all: a link, a PDF, a paragraph.${SIG}${FOOT(inbox)}`,
  },

  {
    id: "launch",
    week: null,               // fires only when the launch gate opens
    theme: "launch",
    when: () => true,
    subject: () => `Introductions start this week`,
    text: ({ seat, snap, inbox }) =>
`Matching opens this week, and you are in it as founding member no. ${seat}.

From here the rhythm changes. I stop writing on a schedule and start writing
only when I have something specific: a brief, a question I genuinely need
answered, or an introduction both sides have agreed to.

Nothing about the rules changes. At most five open introductions at a time. A
pass ends it, privately, with no explanation owed. No fee, ever.

${nf(snap.total.claimed)} people are in the network. Let me go find the ones who
should know each other.${SIG}${FOOT(inbox)}`,
  },
];

export const STEPS_BY_ID = Object.fromEntries(STEPS.map((s) => [s.id, s]));

/** The themes present, in order — a one-line audit of the sequence's shape. */
export function themeMap() {
  return STEPS.map((s) => `${s.week === null ? "gate" : "w" + s.week}:${s.theme}`);
}

/** Render one step for one subscriber. Returns null when the step should skip. */
export function render(step, ctx) {
  if (!step.when(ctx.sub)) return null;
  return {
    id: step.id,
    theme: step.theme,
    subject: step.subject(ctx),
    text: step.text(ctx),
  };
}
