import assert from "node:assert/strict";
import test from "node:test";
import { openInMemory } from "../src/store/db.js";
import {
  COHORTS,
  COHORT_LIMIT,
  buildCapacitySnapshot,
} from "../src/waitlist/capacity.js";
import {
  InvalidSubscriptionError,
  openWaitlistRepository,
} from "../src/waitlist/repository.js";
import { subscribersToCsv } from "../src/waitlist/csv.js";

function input(overrides = {}) {
  return {
    name: "Alice Example",
    email: "Alice@Example.com",
    cohort: COHORTS.FOUNDER_DEVELOPER,
    intent: "A seed investor",
    consent: true,
    ...overrides,
  };
}

test("capacity keeps the two 5,000-seat cohorts independent", () => {
  const founders = Array.from({ length: COHORT_LIMIT }, (_, index) => ({
    _id: `f${index}`,
    cohort: COHORTS.FOUNDER_DEVELOPER,
    status: "waiting",
  }));
  const snapshot = buildCapacitySnapshot([
    ...founders,
    { _id: "i1", cohort: COHORTS.INVESTOR_EMPLOYER, status: "active" },
    { _id: "stopped", cohort: COHORTS.INVESTOR_EMPLOYER, status: "stopped" },
  ]);

  assert.equal(snapshot.cohorts.foundersDevelopers.joined, 5_000);
  assert.equal(snapshot.cohorts.foundersDevelopers.full, true);
  assert.equal(snapshot.cohorts.investorsEmployers.joined, 1);
  assert.equal(snapshot.cohorts.investorsEmployers.remaining, 4_999);
});

test("embedded NEDB stores idempotent subscriber records and DAG-linked inbound events", () => {
  let tick = 0;
  const repository = openWaitlistRepository({
    store: openInMemory(),
    clock: () => new Date(1_786_651_200_000 + tick++ * 1_000),
  });

  const first = repository.subscribe(input());
  const updated = repository.subscribe(
    input({ intent: "A seed investor who understands regulated infrastructure" }),
  );

  assert.equal(first.created, true);
  assert.equal(updated.created, false);
  assert.equal(updated.subscriber.email, "alice@example.com");
  assert.equal(updated.subscriber.revision, 2);
  assert.match(updated.subscriber.caused_by_event_id, /^evt_/);
  assert.match(updated.subscriber.caused_by_event_hash, /^[a-f0-9]{64}$/);
  assert.equal(repository.capacity().total.joined, 1);
  assert.equal(repository.list().records.length, 1);
  assert.equal(repository.health().ok, true);
  assert.deepEqual(
    repository.provenance(updated.subscriber._id).map((record) => record._coll),
    ["subscribers", "subscription_events"],
  );
});

test("an explicit re-subscription can move one address between cohorts without double counting", () => {
  const repository = openWaitlistRepository({ store: openInMemory() });
  repository.subscribe(input());
  repository.subscribe(input({ cohort: COHORTS.INVESTOR_EMPLOYER }));
  const capacity = repository.capacity();

  assert.equal(capacity.cohorts.foundersDevelopers.joined, 0);
  assert.equal(capacity.cohorts.investorsEmployers.joined, 1);
  assert.equal(capacity.total.joined, 1);
});

test("subscriber validation requires explicit consent and valid fields", () => {
  const repository = openWaitlistRepository({ store: openInMemory() });
  assert.throws(
    () => repository.subscribe(input({ consent: false })),
    (error) => error instanceof InvalidSubscriptionError && error.field === "consent",
  );
  assert.throws(
    () => repository.subscribe(input({ email: "not-an-email" })),
    (error) => error instanceof InvalidSubscriptionError && error.field === "email",
  );
});

test("CSV export quotes cells and neutralizes spreadsheet formulas", () => {
  const csv = subscribersToCsv([
    {
      _id: "sub_1",
      name: "=HYPERLINK(\"https://bad.example\")",
      email: "alice@example.com",
      cohort: COHORTS.FOUNDER_DEVELOPER,
      intent: "Builder, operator",
      status: "waiting",
    },
  ]);

  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example""\)"/);
  assert.match(csv, /"Builder, operator"/);
  assert.ok(csv.endsWith("\r\n"));
});
