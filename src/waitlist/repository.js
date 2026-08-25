import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { COLLECTIONS, openDatabase } from "../store/db.js";
import {
  COHORTS,
  COHORT_LIMIT,
  COUNTED_SUBSCRIBER_STATES,
  assertCohort,
  buildCapacitySnapshot,
} from "./capacity.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBSCRIBERS = COLLECTIONS.SUBSCRIBERS;
const SUBSCRIPTION_EVENTS = COLLECTIONS.SUBSCRIPTION_EVENTS;

export class CapacityFullError extends Error {
  constructor(cohort) {
    super(`The ${cohort} founding cohort is full`);
    this.name = "CapacityFullError";
    this.code = "COHORT_FULL";
    this.cohort = cohort;
  }
}

export class InvalidSubscriptionError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "InvalidSubscriptionError";
    this.code = "INVALID_SUBSCRIPTION";
    this.field = field;
  }
}

function cleanRecord(record) {
  if (!record) return null;
  const { _coll, ...clean } = record;
  return clean;
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new InvalidSubscriptionError("Enter a valid email address", "email");
  }
  return email;
}

function normalizeName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 120) {
    throw new InvalidSubscriptionError(
      "Name must be between 1 and 120 characters",
      "name",
    );
  }
  return name;
}

function normalizeIntent(value) {
  const intent = String(value ?? "").trim().replace(/\s+/g, " ");
  if (intent.length > 500) {
    throw new InvalidSubscriptionError(
      "Intent must be 500 characters or fewer",
      "intent",
    );
  }
  return intent;
}

function subscriberId(email) {
  return `sub_${createHash("sha256").update(email).digest("hex")}`;
}

function activeInCohort(records, cohort, exceptId = null) {
  return records.filter(
    (record) =>
      record._id !== exceptId &&
      record.cohort === cohort &&
      COUNTED_SUBSCRIBER_STATES.has(record.status),
  ).length;
}

export function openWaitlistRepository({ store = null, dataPath = null, clock = () => new Date() }) {
  if (!store && !dataPath) throw new TypeError("YENTE_WAITLIST_DATA_PATH is required");

  let sharedStore = store;
  if (!sharedStore) {
    const absolutePath = resolve(dataPath);
    mkdirSync(absolutePath, { recursive: true, mode: 0o700 });
    sharedStore = openDatabase(absolutePath);
  }

  sharedStore.createIndex(SUBSCRIBERS, "email", "eq");
  sharedStore.createIndex(SUBSCRIBERS, "cohort", "eq");
  sharedStore.createIndex(SUBSCRIBERS, "status", "eq");
  sharedStore.createIndex(SUBSCRIPTION_EVENTS, "subscriber_id", "eq");

  function allSubscribers() {
    return sharedStore.query(`FROM ${SUBSCRIBERS}`);
  }

  function getSubscriberById(id) {
    return sharedStore.get(SUBSCRIBERS, id);
  }

  function subscribe(input) {
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const intent = normalizeIntent(input.intent);
    const cohort = assertCohort(input.cohort);
    if (input.consent !== true) {
      throw new InvalidSubscriptionError(
        "Consent is required to join the founding network",
        "consent",
      );
    }

    const id = subscriberId(email);
    const existing = getSubscriberById(id);
    const records = allSubscribers();
    const destinationCount = activeInCohort(records, cohort, id);
    if (destinationCount >= COHORT_LIMIT) throw new CapacityFullError(cohort);

    const now = clock().toISOString();
    const eventId = `evt_${randomUUID()}`;
    const eventType = existing ? "WAITLIST_SUBSCRIPTION_UPDATED" : "WAITLIST_SUBSCRIBED";
    const event = sharedStore.put(SUBSCRIPTION_EVENTS, eventId, {
      schema_version: 1,
      event_type: eventType,
      subscriber_id: id,
      cohort,
      source: "public_landing_page",
      consent_version: "founding-network-v1",
      occurred_at: now,
    });

    const record = sharedStore.put(
      SUBSCRIBERS,
      id,
      {
        schema_version: 1,
        email,
        name,
        cohort,
        intent,
        status: "waiting",
        source: "public_landing_page",
        consent: true,
        consent_version: "founding-network-v1",
        inbound_established_at: existing?.inbound_established_at ?? now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        revision: (existing?.revision ?? 0) + 1,
        caused_by_event_id: eventId,
        caused_by_event_hash: event._hash,
      },
      { causedBy: [event] },
    );

    sharedStore.flush();

    return Object.freeze({
      created: !existing,
      subscriber: cleanRecord(record),
      event: cleanRecord(event),
      capacity: capacity(),
    });
  }

  function capacity() {
    const records = allSubscribers();
    const tip = sharedStore.tipCollection(SUBSCRIBERS);
    return buildCapacitySnapshot(records, {
      sequence: String(sharedStore.seq()),
      updatedAt: tip?.updated_at ?? null,
    });
  }

  function list({ cohort = null, status = null, search = "", offset = 0, limit = 100 } = {}) {
    if (cohort) assertCohort(cohort);
    const needle = String(search).trim().toLowerCase();
    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const safeLimit = Math.min(250, Math.max(1, Number.parseInt(limit, 10) || 100));

    const filtered = allSubscribers()
      .filter((record) => !cohort || record.cohort === cohort)
      .filter((record) => !status || record.status === status)
      .filter(
        (record) =>
          !needle ||
          [record.name, record.email, record.intent]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle)),
      )
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

    return Object.freeze({
      total: filtered.length,
      offset: safeOffset,
      limit: safeLimit,
      records: Object.freeze(
        filtered.slice(safeOffset, safeOffset + safeLimit).map(cleanRecord),
      ),
    });
  }

  function exportAll() {
    return allSubscribers()
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map(cleanRecord);
  }

  function health() {
    return Object.freeze({
      ok: sharedStore.verify(),
      head: sharedStore.head(),
      sequence: String(sharedStore.seq()),
      scan: sharedStore.scanStatus(),
      dataPath: sharedStore.path,
    });
  }

  function provenance(id) {
    // Provenance without collection identity is not provenance. `cleanRecord`
    // intentionally strips `_coll` from public subscriber payloads, but applying
    // it here erased which causal node was the subscriber and which was the
    // inbound event. Preserve the engine metadata on this diagnostic surface.
    return sharedStore.trace(SUBSCRIBERS, id).map((record) => Object.freeze({ ...record }));
  }

  return Object.freeze({
    subscribe,
    capacity,
    list,
    exportAll,
    health,
    provenance,
    cohorts: COHORTS,
  });
}
