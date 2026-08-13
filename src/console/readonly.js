/**
 * The read-only view — SPEC v2 §17.1.
 *
 * The console cannot write. Not "does not": cannot. It is handed this facade
 * and never the repositories, so there is no method on the object it holds that
 * could advance a match, resolve a review, or send an email.
 *
 * This is INV-4's argument applied to the operator rather than the model. A
 * surface that cannot act cannot be tricked into acting, and a leaked console
 * URL leaks visibility rather than control — the correct trade for a system
 * whose entire product is not emailing people without permission.
 *
 * Everything returned is deep-frozen, so a renderer cannot accidentally mutate
 * a row and write it back through some other path.
 */

import { COLLECTIONS } from "../store/db.js";
import { OUTBOX_STATES } from "../domain/outbox.js";
import { MEMBER_STATES } from "../domain/member.js";
import { introductionKey } from "../store/keys.js";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const frozen = (rows) => deepFreeze(rows);

/**
 * @param {import("../store/db.js").Store} store
 * @param {object} [options]
 * @param {object} [options.health] deliverability probe results, when available
 * @param {number} [options.invitationDailyCap] §5.4's cap, for the gauge
 */
export function createConsoleView(store, { health = null, invitationDailyCap = null } = {}) {
  const count = (collection, where = "") =>
    store.query(`FROM ${collection}${where ? ` WHERE ${where}` : ""}`).length;

  const view = {
    /* --- deliverability (§5.4, and trapdoor #1) ------------------------ */
    deliverability() {
      const invitations = store.query(
        `FROM ${COLLECTIONS.OUTBOX} WHERE purpose = "enrollment_invitation"`,
      );
      const sentToday = invitations.filter(
        (job) => job.state === OUTBOX_STATES.SENT && isToday(job.sentAt),
      ).length;
      return deepFreeze({
        // Absent rather than invented. A dash on the console is honest; a green
        // tick for a probe that never ran is how an operator learns to ignore
        // the panel.
        health,
        invitations: {
          sentToday,
          cap: invitationDailyCap,
          lifetimeAddresses: new Set(invitations.flatMap((job) => job.recipients)).size,
        },
      });
    },

    /* --- outbox (§10.3) ------------------------------------------------ */
    outbox() {
      const byState = Object.fromEntries(
        Object.values(OUTBOX_STATES).map((state) => [
          state,
          count(COLLECTIONS.OUTBOX, `state = "${state}"`),
        ]),
      );
      const dead = store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = "DEAD"`);
      const waiting = store
        .query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = "RETRY_WAIT"`)
        .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt));
      const sending = store.query(`FROM ${COLLECTIONS.OUTBOX} WHERE state = "SENDING"`);
      return deepFreeze({ byState, dead, waiting, sending, total: count(COLLECTIONS.OUTBOX) });
    },

    /* --- review (§11.6) ------------------------------------------------ */
    reviews() {
      return frozen(store.query(`FROM ${COLLECTIONS.GENERATION_FAILURES} WHERE state = "OPEN"`));
    },

    /* --- receipts (§12) ------------------------------------------------ */
    introductions() {
      return frozen(store.query(`FROM ${COLLECTIONS.INTRODUCTIONS}`));
    },

    /**
     * The causal chain behind one introduction. §12's closing requirement, and
     * the only place it is visible to a person rather than to a test.
     */
    receipt(matchId) {
      return frozen(store.trace(COLLECTIONS.INTRODUCTIONS, introductionKey(matchId)));
    },

    /* --- population ---------------------------------------------------- */
    members() {
      return deepFreeze(
        Object.fromEntries(
          Object.values(MEMBER_STATES).map((state) => [
            state,
            count(COLLECTIONS.MEMBERS, `state = "${state}"`),
          ]),
        ),
      );
    },

    /* --- engine -------------------------------------------------------- */
    engine() {
      return deepFreeze({
        seq: store.seq(),
        head: store.head(),
        verified: store.verify(),
        path: store.path,
        messages: count(COLLECTIONS.MESSAGES),
        matches: count(COLLECTIONS.MATCHES),
      });
    },
  };

  return Object.freeze(view);
}

function isToday(iso, now = new Date()) {
  if (!iso) return false;
  return String(iso).slice(0, 10) === now.toISOString().slice(0, 10);
}
