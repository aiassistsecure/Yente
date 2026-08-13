/**
 * The materialised profile — §6.1, §6.2, INV-3.
 *
 * `qualify()` used to take a profile from its caller, which meant the D8 test
 * supplied by hand the very thing the runtime was supposed to derive. These
 * pin the derivation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory, COLLECTIONS } from "../src/store/db.js";
import { buildProfileView, saveProfileView } from "../src/store/profile-view.js";
import { evaluateQualification } from "../src/domain/qualification.js";
import { memberQualificationPolicy } from "../test-support/fixtures.js";

const MEMBER = "bob@example.com";

function storeWithFacts(facts) {
  const store = openInMemory();
  // Ids derived from the fact, not from insertion order. Indexing by position
  // would make the same fact hash differently depending on when it arrived,
  // which is exactly the non-determinism the last test is trying to rule out.
  for (const fact of facts) {
    store.put(COLLECTIONS.PROFILE_FACTS, `${MEMBER}:${fact.field}:${fact.value}`, { memberId: MEMBER, ...fact });
  }
  return store;
}

const explicit = (field, value) => ({ field, value, explicit: true, sourceId: "src_1", evidence: "…" });

test("the view is built from stored facts, not handed in", () => {
  const store = storeWithFacts([
    explicit("professional.roles", "technical_operator"),
    explicit("professional.capabilities", "infrastructure_operations"),
    explicit("professional.capabilities", "scaling_teams"),
    explicit("professional.industries", "b2b_saas"),
    explicit("professional.geographies", "us_remote"),
    explicit("intent.seeks", "operating_role"),
    explicit("intent.introductionTypes", "employer"),
  ]);

  const view = buildProfileView(store, MEMBER);
  assert.deepEqual(view.professional.capabilities, ["infrastructure_operations", "scaling_teams"]);
  assert.deepEqual(view.intent.seeks, ["operating_role"]);
  assert.deepEqual(view.professional.roles, ["technical_operator"]);
});

test("an inferred fact never reaches the view — INV-3", () => {
  // Grounding proves the words are in the document. It does not prove the
  // document means what the model concluded, so an inferred fact is a question
  // until the member confirms it.
  const store = storeWithFacts([
    explicit("professional.roles", "technical_operator"),
    { field: "professional.seniority", value: "principal", explicit: false, sourceId: "src_1", evidence: "…" },
  ]);

  const view = buildProfileView(store, MEMBER);
  assert.equal(view.professional.seniority, null);
  assert.equal(view.evidenceByField["professional.seniority"], undefined);
});

test("a member-confirmed inferred fact does reach it", () => {
  const store = storeWithFacts([
    { field: "professional.seniority", value: "principal", explicit: false, confirmed: true, sourceId: "src_1", evidence: "…" },
  ]);
  assert.equal(buildProfileView(store, MEMBER).professional.seniority, "principal");
  assert.equal(buildProfileView(store, MEMBER, { includeConfirmed: false }).professional.seniority, null);
});

test("a field can never be present without evidence", () => {
  // evaluateQualification checks value AND evidence separately. A view that
  // could satisfy one and not the other makes the second check theatre.
  const store = storeWithFacts([explicit("professional.roles", "technical_operator")]);
  const view = buildProfileView(store, MEMBER);

  for (const [group, values] of Object.entries({ professional: view.professional, intent: view.intent })) {
    for (const [key, value] of Object.entries(values)) {
      const populated = Array.isArray(value) ? value.length > 0 : value !== null;
      if (populated) assert.ok(view.evidenceByField[`${group}.${key}`]?.length > 0, `${group}.${key} has no evidence`);
    }
  }
});

test("the view is deterministic, so §7.1 survives a rebuild", () => {
  // Rebuilding from the SAME store must produce a byte-identical view, or
  // "same inputs, same score breakdown" quietly stops being true the moment a
  // profile is rematerialised.
  const store = storeWithFacts([
    explicit("professional.capabilities", "scaling_teams"),
    explicit("professional.capabilities", "infrastructure_operations"),
    explicit("professional.industries", "b2b_saas"),
  ]);
  assert.deepEqual(buildProfileView(store, MEMBER), buildProfileView(store, MEMBER));

  // And the evidence lists are sorted, not merely equal by luck.
  for (const list of Object.values(buildProfileView(store, MEMBER).evidenceByField)) {
    assert.deepEqual(list, [...list].sort());
  }
});

test("values are order-independent, but evidence hashes are per-database", () => {
  // ENGINE PROPERTY, measured rather than assumed: a node's `_hash` is
  // chain-dependent, not purely content-derived. The same fact written into two
  // different databases — or into one database in a different order — hashes
  // differently, because the hash covers the node's position in the chain.
  //
  // So the VALUES a view derives are order-independent, and the evidence ids
  // are only comparable within one store. Anything that compares hashes across
  // databases (replication, a re-import, a fixture asserting a literal hash)
  // is asserting something the engine never promised.
  const facts = [
    explicit("professional.capabilities", "scaling_teams"),
    explicit("professional.capabilities", "infrastructure_operations"),
    explicit("professional.industries", "b2b_saas"),
  ];
  const forward = buildProfileView(storeWithFacts(facts), MEMBER);
  const reverse = buildProfileView(storeWithFacts([...facts].reverse()), MEMBER);

  assert.deepEqual(forward.professional, reverse.professional, "values must not depend on write order");
  assert.deepEqual(forward.intent, reverse.intent);
  assert.deepEqual(Object.keys(forward.evidenceByField).sort(), Object.keys(reverse.evidenceByField).sort());
  assert.notDeepEqual(
    forward.evidenceByField["professional.industries"],
    reverse.evidenceByField["professional.industries"],
    "hashes are per-database; if this ever passes, the engine changed",
  );
});

test("a materialised view qualifies under the real policy", () => {
  const store = storeWithFacts([
    explicit("professional.roles", "technical_operator"),
    explicit("professional.capabilities", "infrastructure_operations"),
    explicit("professional.industries", "b2b_saas"),
    explicit("professional.geographies", "us_remote"),
    explicit("intent.seeks", "operating_role"),
    explicit("intent.introductionTypes", "employer"),
  ]);

  const view = buildProfileView(store, MEMBER);
  const result = evaluateQualification(
    { ...view, id: MEMBER, state: "INTERVIEWING", inboundEstablishedAt: "2026-08-12T12:00:00.000Z" },
    memberQualificationPolicy,
  );
  assert.equal(result.qualified, true, JSON.stringify(result));
});

test("an incomplete view reports exactly what is missing", () => {
  const store = storeWithFacts([explicit("professional.roles", "technical_operator")]);
  const result = evaluateQualification(
    { ...buildProfileView(store, MEMBER), id: MEMBER, state: "INTERVIEWING", inboundEstablishedAt: "2026-08-12T12:00:00.000Z" },
    memberQualificationPolicy,
  );
  assert.equal(result.qualified, false);
  assert.ok(result.missingFields.includes("intent.seeks"));
  assert.ok(result.missingFields.includes("professional.geographies"));
});

test("the persisted view cites the facts it was built from", () => {
  // §12 calls profile_views rebuildable. That is only true if the view carries
  // provenance — otherwise dropping the collection loses the link, not just
  // the cache.
  const store = storeWithFacts([explicit("professional.roles", "technical_operator")]);
  const saved = saveProfileView(store, MEMBER);
  assert.equal(saved.memberId, MEMBER);
  assert.equal(saved.factCount, 1);
  assert.equal(saved.caused_by.length, 1);
  assert.deepEqual(store.trace(COLLECTIONS.PROFILE_VIEWS, MEMBER).map((n) => n._coll), [
    "profile_views",
    "profile_facts",
  ]);
});
