/**
 * A shared URL becomes evidence — netrows for LinkedIn, AiAS for the web.
 *
 * The properties that matter, in order of what they cost when wrong:
 *   1. A refused link never reaches a fetcher (the SSRF guard holds here too)
 *   2. A re-sent URL never spends a second credit (idempotent BEFORE fetch)
 *   3. A missing key reports itself skipped — never an error per tick
 *   4. Vendor fields land DETERMINISTIC; page prose lands as a normal job
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories } from "../src/store/graph.js";
import { enrichLink } from "../src/graph/enrich.js";

const harness = () => createGraphRepositories(openInMemory());

const jsonResponse = (body, ok = true, status = 200) => async () => ({
  ok, status, json: async () => body,
});

test("a private address is refused before any credential is spent", async () => {
  let fetched = 0;
  const result = await enrichLink({
    url: "http://169.254.169.254/latest/meta-data/",
    subject: "person:a@x.test",
    graph: harness(),
    env: { NETROWS_API_KEY: "k", AIASSIST_API_KEY: "k" },
    fetchImpl: async () => { fetched += 1; throw new Error("must not be called"); },
  });
  assert.equal(result.outcome, "refused");
  assert.equal(fetched, 0, "the guard runs before the fetcher, always");
});

test("a missing key is a skip with a reason, not an error", async () => {
  const result = await enrichLink({
    url: "https://www.linkedin.com/in/someone",
    subject: "person:a@x.test",
    graph: harness(),
    env: {},   // no keys on this box yet
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  assert.equal(result.outcome, "skipped");
  assert.match(result.skipped, /NETROWS_API_KEY/,
    "the reason names the exact key the operator must set");
});

test("a LinkedIn profile becomes DETERMINISTIC typed facts", async () => {
  const graph = harness();
  const result = await enrichLink({
    url: "https://www.linkedin.com/in/globalvapor",
    subject: "person:mark@x.test",
    graph,
    env: { NETROWS_API_KEY: "k" },
    fetchImpl: jsonResponse({
      data: {
        fullName: "Mark E.",
        headline: "Founder & Systems Architect",
        location: "Winter Park, FL",
        positions: [{ title: "Founder", companyName: "Interchained LLC" }],
        skills: ["Rust", "Solidity"],
      },
    }),
  });

  assert.equal(result.outcome, "enriched");
  assert.ok(result.claims >= 5);

  const rows = graph.observations.all();
  const capability = rows.find((r) => r.predicate === "capability" && r.object === "Rust");
  assert.ok(capability, "vendor skills land as typed capabilities");
  assert.equal(capability.confidence, 1);
  assert.equal(capability.evidenceId, result.evidenceId);
  assert.ok(rows.some((r) => r.predicate === "employer" && r.object === "Interchained LLC"));
  assert.ok(rows.some((r) => r.predicate === "profile_url"),
    "the URL itself is a fact — discovery cards cite it");

  const evidence = graph.evidence.get(result.evidenceId);
  assert.ok(evidence, "the raw vendor payload is immutable evidence");
  assert.equal(evidence.kind, "vendor");
});

test("re-sending the same profile URL is a lookup, not a second credit", async () => {
  const graph = harness();
  let fetches = 0;
  const fetchImpl = async (...args) => {
    fetches += 1;
    return jsonResponse({ data: { fullName: "Mark E." } })(...args);
  };
  const env = { NETROWS_API_KEY: "k" };
  const subject = "person:mark@x.test";
  const url = "https://www.linkedin.com/in/globalvapor";

  const first = await enrichLink({ url, subject, graph, env, fetchImpl });
  const second = await enrichLink({ url, subject, graph, env, fetchImpl });

  assert.equal(first.outcome, "enriched");
  assert.equal(second.outcome, "already_enriched");
  assert.equal(fetches, 1, "1 credit per profile URL, ever");
});

test("a portfolio becomes link evidence and a NORMAL intelligence job", async () => {
  const graph = harness();
  const result = await enrichLink({
    url: "https://marks.dev/work",
    subject: "person:mark@x.test",
    graph,
    env: { AIASSIST_API_KEY: "k" },
    fetchImpl: jsonResponse({
      success: true,
      content: "Kubernetes migrations for three fintechs. Rust since 2019.",
      title: "Mark — Work",
      fetch_method: "browser",
      cached: false,
    }),
  });

  assert.equal(result.outcome, "queued");
  const evidence = graph.evidence.get(result.evidenceId);
  assert.equal(evidence.kind, "link");
  assert.match(evidence.text, /Kubernetes/, "verbatim page text is the evidence");
  assert.equal(evidence.meta.fetchMethod, "browser",
    "HOW it was obtained is part of the evidence");

  const job = graph.jobs.counts();
  assert.equal(job.READY, 1,
    "prose goes through the model pipeline like any document — no new trust path");
});

test("a failed extraction is an outcome with a reason, never a throw", async () => {
  const result = await enrichLink({
    url: "https://dead.example/cv",
    subject: "person:a@x.test",
    graph: harness(),
    env: { AIASSIST_API_KEY: "k" },
    fetchImpl: jsonResponse({ success: false, error_message: "fetch timed out" }),
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.skipped, "fetch timed out");
});
