/**
 * A realistic store for the console — real engine, real repositories, real
 * domain transitions. Nothing here fabricates a row directly; every record
 * arrives through the same functions the runtime uses, so the console preview
 * is rendering the actual system rather than a picture of one.
 */

import {
  OUTBOUND_PURPOSES,
  activate,
  beginIntake,
  beginInterview,
  beginSend,
  createMember,
  enqueueEmail,
  markFailed,
  markQualified,
  markSent,
  stopMember,
} from "../src/index.js";
import { openInMemory } from "../src/store/db.js";
import { createRepositories } from "../src/store/repositories.js";
import { outboxKeyFor } from "../src/store/keys.js";

const QUALIFICATION = { policyId: "employment", policyVersion: 3, qualified: true };

function activeMember(address, at) {
  let m = createMember({ memberId: `member_${address}`, address, inboundEstablishedAt: at, createdAt: at });
  m = beginIntake(m, at);
  m = beginInterview(m, at);
  m = markQualified(m, { qualification: QUALIFICATION, at });
  return activate(m, at);
}

export function seedConsoleStore({ now = new Date("2026-08-12T21:40:00.000Z") } = {}) {
  const store = openInMemory();
  const repos = createRepositories(store);
  const iso = (offsetMinutes) => new Date(now.getTime() - offsetMinutes * 60_000).toISOString();

  /* --- members, each traced to the inbound that permitted them --------- */
  const people = [
    ["dana.reyes@northwindlog.com", 2400],
    ["priya@cobaltsystems.io", 1900],
    ["tomas.herrera@andesretail.com", 1200],
    ["wren.okafor@meridianhealth.org", 700],
    ["kenji@sakura-interactive.jp", 480],
    ["devon.clarke@harborview.co", 300],
    ["lena@brandt.de", 180],
  ];
  const members = people.map(([address, mins]) => {
    const at = iso(mins);
    const inbound = repos.messages.recordInbound({
      rfcMessageId: `<${address.split("@")[0]}.${mins}@host>`,
      from: address,
      receivedAt: at,
    }).message;
    return repos.members.save(activeMember(address, at), { causedBy: [inbound] });
  });

  // Two members in earlier states, and one who stopped.
  const interviewing = createMember({
    memberId: "member_aisha",
    address: "aisha.bello@lagosdigital.com",
    inboundEstablishedAt: iso(90),
    createdAt: iso(90),
  });
  repos.members.save(beginInterview(beginIntake(interviewing, iso(90)), iso(88)));
  const needsProfile = createMember({
    memberId: "member_owen",
    address: "owen@fitzandco.com",
    inboundEstablishedAt: iso(45),
    createdAt: iso(45),
  });
  repos.members.save(beginIntake(needsProfile, iso(44)));
  repos.members.save(stopMember(activeMember("ruth.kaplan@sightline.io", iso(600)), iso(120), { reason: "unsubscribe" }));

  /* --- a completed introduction, with its full causal chain ------------ */
  const match = repos.matches.save(
    { matchId: "match_northwind_cobalt", state: "INTRODUCED" },
    {
      policyId: "employment",
      policyVersion: 3,
      memberIds: ["dana.reyes@northwindlog.com", "priya@cobaltsystems.io"],
      cycle: 1,
      causedBy: [members[0], members[1]],
    },
  );
  repos.introductions.save(
    { matchId: match._id, messageId: "<intro.northwind.cobalt@yente>", sentAt: iso(35) },
    { causedBy: [match] },
  );

  /* --- outbox in every state ------------------------------------------- */
  const job = (key, purpose, recipients, enqueuedAt) =>
    enqueueEmail({
      jobId: key,
      idempotencyKey: key,
      purpose,
      recipients,
      enqueuedAt,
      headers:
        purpose === OUTBOUND_PURPOSES.ENROLLMENT_INVITATION
          ? {
              "List-Unsubscribe": "<https://ccme.network/u/x>",
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : {},
      backoff: { baseMs: 60_000, maxMs: 3_600_000, maxAttempts: 4 },
    });

  // Delivered.
  for (const [key, purpose, to, mins] of [
    [outboxKeyFor.jointIntroduction(match._id), OUTBOUND_PURPOSES.JOINT_INTRODUCTION, ["dana.reyes@northwindlog.com", "priya@cobaltsystems.io"], 35],
    ["preview:dana", OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW, ["dana.reyes@northwindlog.com"], 2900],
    ["interview:tomas", OUTBOUND_PURPOSES.INTERVIEW_QUESTION, ["tomas.herrera@andesretail.com"], 240],
  ]) {
    const enqueued = job(key, purpose, to, iso(mins + 2));
    repos.outbox.enqueue(enqueued);
    repos.outbox.save(markSent(beginSend(enqueued, iso(mins + 1)), { messageId: `<${key}@yente>`, sentAt: iso(mins) }));
  }

  // Invitations sent today, against the cap.
  const invitees = [
    "sam.delacroix@northgatelabs.com",
    "ilya@balticfreight.lv",
    "nadia@vergemedia.tv",
  ];
  for (const [n, address] of invitees.entries()) {
    const key = outboxKeyFor.enrollmentInvitation(address);
    const enqueued = job(key, OUTBOUND_PURPOSES.ENROLLMENT_INVITATION, [address], iso(200 - n * 30));
    repos.outbox.enqueue(enqueued);
    repos.outbox.save(markSent(beginSend(enqueued, iso(199 - n * 30)), { messageId: `<inv${n}@yente>`, sentAt: iso(198 - n * 30) }));
  }

  // Pending.
  const pending = job("profile:wren", OUTBOUND_PURPOSES.PROFILE_REQUEST, ["wren.okafor@meridianhealth.org"], iso(4));
  repos.outbox.enqueue(pending);

  // In flight.
  const flying = job("interview:kenji", OUTBOUND_PURPOSES.INTERVIEW_QUESTION, ["kenji@sakura-interactive.jp"], iso(9));
  repos.outbox.enqueue(flying);
  repos.outbox.save(beginSend(flying, iso(8)));

  // Backing off after a soft failure.
  const retrying = job("interview:devon", OUTBOUND_PURPOSES.INTERVIEW_QUESTION, ["devon.clarke@harborview.co"], iso(20));
  repos.outbox.enqueue(retrying);
  repos.outbox.save(
    markFailed(beginSend(retrying, iso(18)), {
      at: iso(18),
      error: "421 4.7.0 too many connections from this IP",
      random: () => 0.8,
    }),
  );

  // Dead — a hard bounce, which must never be retried (§5.4, deliverability).
  const dead = job("clarify:lena", OUTBOUND_PURPOSES.CLARIFICATION, ["lena@brandt.de"], iso(700));
  repos.outbox.enqueue(dead);
  repos.outbox.save(
    markFailed(beginSend(dead, iso(699)), {
      at: iso(699),
      error: "550 5.1.1 recipient address rejected: user unknown",
      permanent: true,
    }),
  );

  /* --- one job awaiting a human — §11.6 -------------------------------- */
  repos.reviews.record({
    idempotencyKey: "preview:aisha",
    purpose: OUTBOUND_PURPOSES.PRIVATE_MATCH_PREVIEW,
    template: "private_match_preview",
    failures: [
      { attempt: 1, code: "UNKNOWN_FACT_ID", message: "META cites fact ids that were not supplied: fact_88" },
      { attempt: 2, code: "UNAUTHORISED_ADDRESS", message: "EMAIL_TEXT contains addresses that were not authorised" },
    ],
    recordedAt: iso(55),
  });

  return { store, repos, now };
}

export const SEED_HEALTH = Object.freeze({
  host: "hostbox.interchained.org",
  imap: "ok",
  smtp: "ok",
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  quota: "4.2 / 25 GB",
  lastSyncAt: new Date("2026-08-12T21:39:48.000Z").toISOString(),
});
