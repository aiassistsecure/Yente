/**
 * Telling somebody that interesting people exist, without introducing them.
 *
 * The tests that matter here are the negative ones. This output is handed to a
 * model that writes prose, which is the least controllable surface in the
 * system — so the guarantee cannot be "the model was told not to share the
 * address". It has to be that the address is not in the object.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CARD_KEYS, searchMatches } from "../src/graph/discovery.js";

const claim = (subject, predicate, object, evidenceId = "message:m1", extra = {}) => ({
  subject, predicate, object, evidenceId, quote: `…${object}…`,
  observedAt: "2026-08-27T12:00:00Z", ...extra,
});

/** Everyone matchable unless named otherwise. */
function harness(rows, { unqualified = [] } = {}) {
  return {
    graph: { observations: { all: () => rows } },
    manager: { isMatchable: (id) => !unqualified.includes(id) },
  };
}

const JIM = claim("p:jim", "intent:SEEKING", "a web3 engineer");
const MARK = [
  claim("p:mark", "is_person", "Mark E."),
  claim("p:mark", "intent:OFFERING", "building in AI and web3"),
  claim("p:mark", "linkedin", "linkedin.com/in/globalvapor"),
  claim("p:mark", "capability", "Solidity", "attachment:cv1"),
];

/* --- the boundary ------------------------------------------------------- */

test("a card cannot carry an email address, because the field does not exist", () => {
  // THE LOAD-BEARING TEST. An instruction can be talked out of; an absent field
  // cannot. The model composing the reply never receives the one thing it would
  // need to introduce anybody.
  const [card] = searchMatches({ ...harness([JIM, ...MARK]), subject: "p:jim" });
  assert.deepEqual(Object.keys(card).sort(), [...CARD_KEYS].sort());
  const serialised = JSON.stringify(card);
  assert.doesNotMatch(serialised, /@/, "no address may survive into the reply layer");
});

test("raw document text never reaches the card", () => {
  // A résumé holds a phone number, a home address and a salary history. Typed
  // disclosures are how to serve "parts from their résumé" safely: the part
  // worth quoting arrives without the parts that are not.
  const rows = [JIM, ...MARK, claim("p:mark", "capability", "Rust", "attachment:cv1", {
    quote: "Rust — mobile 555-0148, 14 Elm Street, previously at Acme on $180k",
  })];
  const [card] = searchMatches({ ...harness(rows), subject: "p:jim" });
  const serialised = JSON.stringify(card);
  assert.doesNotMatch(serialised, /555-0148|Elm Street|180k/,
    "the quote is evidence for the graph, not content for an email");
  assert.ok(card.facts.some((f) => f.value === "Rust"), "but the typed fact is shown");
});

test("only a person who approved their own profile can be mentioned", () => {
  // Mentioning somebody is a disclosure even when no addresses change hands, so
  // it is gated by the same approval that gates an introduction.
  const result = searchMatches({
    ...harness([JIM, ...MARK], { unqualified: ["p:mark"] }),
    subject: "p:jim",
  });
  assert.equal(result, false, "mid-intake is not a candidate to be described");
});

test("the asker is never a result for themselves", () => {
  // The résumé match introduced Mark to Mark. That must be impossible here too.
  const rows = [JIM, claim("p:jim", "intent:OFFERING", "web3 consulting"),
    claim("p:jim", "is_person", "Jim Ko")];
  assert.equal(searchMatches({ ...harness(rows), subject: "p:jim" }), false);
});

/* --- false, not an empty array ------------------------------------------ */

test("nobody is FALSE, so a caller cannot render an enthusiastic empty list", () => {
  assert.equal(searchMatches({ ...harness([JIM]), subject: "p:jim" }), false);
});

test("an asker with no stated interest gets false rather than everybody", () => {
  // Without something to match on, "persons of interest" would be a directory
  // dump of the whole network to whoever wrote in last.
  const rows = [claim("p:new", "is_person", "New Person"), ...MARK];
  assert.equal(searchMatches({ ...harness(rows), subject: "p:new" }), false);
});

test("an intake artefact is not an interest", () => {
  // "resume" must not be the thing two people have in common. Again.
  const rows = [claim("p:jim", "intent:SEEKING", "resume"), ...MARK,
    claim("p:mark", "intent:OFFERING", "resume")];
  assert.equal(searchMatches({ ...harness(rows), subject: "p:jim" }), false);
});

/* --- the card is worth reading ------------------------------------------ */

test("the card carries what Mark's example needs, and says why", () => {
  // "Mark E. linkedin.com/in/globalvapor building in AI and Web3 matches your
  // interest in Web3" — every piece of that sentence comes from the card.
  const [card] = searchMatches({ ...harness([JIM, ...MARK]), subject: "p:jim" });
  assert.equal(card.name, "Mark E.");
  assert.deepEqual(card.links, ["linkedin.com/in/globalvapor"]);
  assert.ok(card.intents.some((i) => i.object === "building in AI and web3"));
  assert.ok(card.overlap.includes("web3"));
  assert.match(card.because, /matches your interest in .*web3/);
});

test("a document can be the reason somebody is surfaced", () => {
  // Their stated intent says "engineering help" and shares nothing. Their CV
  // says Solidity. That is the case where a portfolio earns its keep.
  const rows = [
    claim("p:jim", "intent:SEEKING", "a solidity contractor"),
    claim("p:dana", "is_person", "Dana Reed"),
    claim("p:dana", "intent:OFFERING", "engineering help", "message:m2"),
    claim("p:dana", "capability", "Solidity", "link:portfolio1"),
  ];
  const [card] = searchMatches({ ...harness(rows), subject: "p:jim" });
  assert.equal(card.name, "Dana Reed");
  assert.ok(card.overlap.includes("solidity"));
});

test("the strongest overlap comes first and the list is bounded", () => {
  const rows = [
    claim("p:jim", "intent:SEEKING", "web3 solidity audits"),
    claim("p:a", "is_person", "A"), claim("p:a", "intent:OFFERING", "web3"),
    claim("p:b", "is_person", "B"), claim("p:b", "intent:OFFERING", "web3 solidity audits"),
    claim("p:c", "is_person", "C"), claim("p:c", "intent:OFFERING", "solidity"),
  ];
  const found = searchMatches({ ...harness(rows), subject: "p:jim", limit: 2 });
  assert.equal(found.length, 2, "a reply naming everybody is a directory dump");
  assert.equal(found[0].name, "B", "best overlap first");
});

test("a free-text query can bias the search without a stated intent matching", () => {
  const rows = [JIM, ...MARK];
  const [card] = searchMatches({ ...harness(rows), subject: "p:jim", query: "solidity" });
  assert.ok(card.overlap.includes("solidity"),
    "the model can ask on the person's behalf when they said it in prose");
});
