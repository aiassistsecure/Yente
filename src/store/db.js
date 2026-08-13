/**
 * The store — NEDB, embedded.
 *
 * Not a daemon. §13 describes "the existing NEDB daemon" as an external
 * service; embedding the engine in the runtime process satisfies the same
 * section's intent more directly, and INV-12's "one process, one database"
 * literally. There is no port to bind, no HTTP hop, and nothing to start before
 * the runtime starts.
 *
 * Three properties of the embedded engine shape everything below, all three
 * confirmed against the running engine rather than assumed:
 *
 * 1. **The napi calls are synchronous.** JavaScript is single-threaded, so a
 *    read-modify-write inside one non-async function cannot interleave with
 *    another. The check-then-act race that forces optimistic concurrency on a
 *    networked store does not exist here — provided the sequence never awaits
 *    in the middle, which is why every repository write below is sync.
 *
 * 2. **`caused_by` is a plain field.** A document written with a `caused_by`
 *    array of hashes is traversable by `TRACE caused_by`. A field named
 *    `_caused_by` is NOT — it is stored as ordinary data and the trace stops.
 *    (Verified: TRACE on a `caused_by` doc returned the ancestor; on a
 *    `_caused_by` doc it returned only the node itself. This is the reverse of
 *    the HTTP daemon's shape, where the engine normalises a top-level field
 *    into `_caused_by` on the way in.)
 *
 * 3. **A durable directory is exclusively locked.** A second `open` of the same
 *    path is refused — deliberately, to prevent a split-brain where one engine
 *    cannot see the other's writes. So the process holds exactly one handle,
 *    and `openDatabase` enforces that rather than letting a second call
 *    discover it as a runtime error.
 */

import { NedbCore } from "nedb-engine";

/** The logical collections of SPEC v2 §12. */
export const COLLECTIONS = Object.freeze({
  MESSAGES: "messages",
  MEMBERS: "members",
  SOURCES: "sources",
  PROFILE_FACTS: "profile_facts",
  PROFILE_VIEWS: "profile_views",
  OPPORTUNITIES: "opportunities",
  MATCH_POLICIES: "match_policies",
  MATCHES: "matches",
  PREVIEW_DECISIONS: "preview_decisions",
  INTRODUCTIONS: "introductions",
  OUTBOX: "outbox",
});

let openHandle = null;

/**
 * Open the durable database. One engine per process, by construction.
 *
 * Opening the same path twice returns the SAME store rather than a second
 * handle. That is not a convenience — the addon exposes no `close`, so the
 * exclusive directory lock is held until the process exits, and any API that
 * implied otherwise would be lying. Idempotence is the honest shape: a caller
 * that asks for the database it already has, gets it.
 *
 * A different path while one is open is a real error, because that genuinely
 * cannot be satisfied.
 *
 * @param {string} path
 * @returns {Store}
 */
export function openDatabase(path) {
  if (openHandle) {
    if (openHandle.path === path) return openHandle;
    throw new Error(
      `A database is already open in this process (${openHandle.path}); cannot also open ${path}. ` +
        "The engine takes an exclusive lock on its data directory and the addon exposes no close, " +
        "so a second directory would need a second process.",
    );
  }
  const store = new Store(NedbCore.open(path), path);
  openHandle = store;
  return store;
}

/**
 * An in-memory database. Zero disk I/O, same engine, same semantics — which is
 * what makes it worth testing against rather than a fake.
 */
export function openInMemory() {
  return new Store(new NedbCore(), ":memory:");
}

/**
 * Flush everything to disk. Call before exit.
 *
 * Deliberately NOT named or shaped like a release. An earlier version cleared
 * the module handle here, which made `openDatabase` willing to try again — and
 * the retry failed inside the engine with a lock error naming the caller's own
 * pid, because the addon has no `close` and the flock outlives any bookkeeping
 * we keep on this side.
 *
 * Clearing a handle you cannot actually release is worse than not clearing it:
 * the guard that would have said "already open, here it is" is gone, and what
 * replaces it is a lower-level error that reads like an external process is at
 * fault.
 */
export function closeDatabase(store) {
  if (store?.path !== ":memory:") store?.flush();
}

export class Store {
  /** @param {NedbCore} core @param {string} path */
  constructor(core, path) {
    this.core = core;
    this.path = path;
  }

  /**
   * Write a document.
   *
   * `causedBy` takes hashes of the documents this one was derived from and is
   * written as the plain `caused_by` field, because that is the field
   * `TRACE caused_by` reads. §12: "Every derived record carries causal links to
   * its inputs." A completed introduction must trace back to the policy, both
   * profiles, their evidence, and the inbound relationships that permitted
   * outbound — and that chain only exists if every write along it supplies one.
   *
   * @returns {object} the stored document, including `_hash`, `_seq`, `_id`
   */
  put(collection, id, document, { causedBy = [] } = {}) {
    if (!id) throw new TypeError(`A ${collection} document requires an id`);
    const hashes = normalizeCausedBy(causedBy);
    const payload = hashes.length > 0 ? { ...document, caused_by: hashes } : { ...document };
    return JSON.parse(this.core.put(collection, String(id), JSON.stringify(payload)));
  }

  /** @returns {object|null} */
  get(collection, id) {
    const raw = this.core.get(collection, String(id));
    return raw === null ? null : JSON.parse(raw);
  }

  /** The document as it stood at `seq` — §12's rebuildable history. */
  getAsOf(collection, id, seq) {
    const raw = this.core.getAsOf(collection, String(id), BigInt(seq));
    return raw === null ? null : JSON.parse(raw);
  }

  /** @returns {object[]} */
  query(nql) {
    return this.core.query(nql).map((row) => JSON.parse(row));
  }

  /** Ancestry of a document, nearest first, via the causal edges. */
  trace(collection, id) {
    return this.query(`FROM ${collection} WHERE _id = ${quote(id)} TRACE caused_by`);
  }

  delete(collection, id) {
    this.core.delete(collection, String(id));
  }

  /** Tamper-evidence over the whole store. */
  verify() {
    return this.core.verify();
  }

  head() {
    return this.core.head();
  }

  seq() {
    return Number(this.core.seq());
  }

  flush() {
    this.core.flush();
  }
}

/**
 * Quote a value for NQL.
 *
 * Small and load-bearing: ids derived in keys.js are conservative, but member
 * ids and addresses reach queries from email, and an unescaped quote would
 * either break the parse or change which rows come back. Rejecting control
 * characters outright is cheaper than reasoning about what the parser does with
 * them.
 */
export function quote(value) {
  const s = String(value);
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new TypeError("Control characters are not permitted in a query value");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeCausedBy(causedBy) {
  const list = Array.isArray(causedBy) ? causedBy : [causedBy];
  return list
    .filter((entry) => entry !== undefined && entry !== null && entry !== "")
    .map((entry) => (typeof entry === "string" ? entry : entry._hash))
    .filter((hash) => {
      if (typeof hash !== "string" || hash === "") {
        throw new TypeError("caused_by takes document hashes or stored documents");
      }
      return true;
    });
}
