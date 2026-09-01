/**
 * The whole dossier — Mark, 2026-09-01: "manager doesn't show all the claims
 * and evidence and everything about the person or org being displayed."
 *
 * manager.subject() always computed the full dossier — disclosures, proposals,
 * per-document claims, substantiated vocabulary, history with retractions.
 * The RENDERER dropped most of it on the floor: a résumé's fifteen
 * capabilities, every proposal grade, and the entire history were held and
 * never shown. These tests pin the page to the data: if subject() knows it,
 * /subject renders it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { openInMemory } from "../src/store/db.js";
import { createGraphRepositories, AUTHORITY } from "../src/store/graph.js";
import { createGraphManager } from "../src/graph/manager.js";
import { renderProfile } from "../web/manager.js";

const T0 = "2026-08-30T12:00:00.000Z";

function seeded() {
  const store = openInMemory();
  const graph = createGraphRepositories(store);

  graph.evidence.record({
    kind: "message", contentHash: "m1", text: "Resume attached.",
    receivedAt: T0, meta: { subject: "Intro from Dana", from: "dana@example.com" },
  });
  graph.evidence.record({
    kind: "attachment", contentHash: "a1", text: "DANA ITO — Platform Engineer. Rust, Kubernetes.",
    receivedAt: T0, meta: { filename: "dana-resume.pdf", messageEvidenceId: "message:m1" },
  });

  const claim = (predicate, object, extra = {}) => graph.observations.append({
    subject: "person:dana@example.com", predicate, object,
    evidenceId: extra.evidenceId ?? "attachment:a1",
    quote: extra.quote ?? String(object),
    authority: extra.authority ?? AUTHORITY.MODEL_VERIFIED,
    confidence: 0.9, observedAt: extra.observedAt ?? T0, model: "GLM-4-32B",
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  });

  claim("is_person", "Dana Ito");
  claim("role", "Platform Engineer");
  claim("employer", "Acme Corp");
  claim("capability", "Rust");
  claim("capability", "Kubernetes");
  claim("geography", "Miami, FL");
  claim("credential", "CKA");
  claim("intent:SEEKING", "a Rust backend role", { evidenceId: "message:m1" });
  claim("proposal:hire_for", "Rust backend engineering roles",
    { attributes: { grade: "exceptional" }, quote: "Rust, Kubernetes." });
  claim("capability", "recruiting", { attributes: { retracted: true } });

  return createGraphManager({ graph, actor: "test" });
}

test("the dossier renders EVERY disclosure, grouped by field, with quotes", () => {
  const html = renderProfile({ profile: seeded().subject("person:dana@example.com") });

  assert.match(html, /What we can evidence \(\d+\)/);
  for (const field of ["role", "employer", "capability", "geography", "credential"]) {
    assert.ok(html.includes(`<b>${field}</b>`), `field section: ${field}`);
  }
  for (const value of ["Platform Engineer", "Acme Corp", "Rust", "Kubernetes", "Miami, FL", "CKA"]) {
    assert.ok(html.includes(value), `disclosed value shown: ${value}`);
  }
  const evidenceSection = html.split("What we can evidence")[1].split("<h2>")[0];
  assert.ok(!evidenceSection.includes("recruiting"),
    "a retracted claim is not among the live disclosures");
});

test("proposals render with their grade — Yente's read is on the page", () => {
  const html = renderProfile({ profile: seeded().subject("person:dana@example.com") });
  assert.match(html, /Yente's read/);
  assert.match(html, /hire for/);
  assert.match(html, /Rust backend engineering roles/);
  assert.match(html, /class="grade">exceptional/);
});

test("each evidence row lists the claims IT produced", () => {
  const html = renderProfile({ profile: seeded().subject("person:dana@example.com") });
  assert.match(html, /\d+ claims? from this attachment/);
  assert.match(html, /\d+ claims? from this message/);
});

test("history shows everything, retractions included, struck not hidden", () => {
  const html = renderProfile({ profile: seeded().subject("person:dana@example.com") });
  assert.match(html, /<h2>History<\/h2>/);
  assert.match(html, /observations, newest first/);
  assert.ok(/class="gone"[\s\S]{0,200}recruiting/.test(html),
    "the retracted claim is visible in history, marked as gone");
});

test("the substantiated vocabulary is rendered as search links", () => {
  const html = renderProfile({ profile: seeded().subject("person:dana@example.com") });
  assert.match(html, /Their documents can vouch for/);
  assert.match(html, /href="\/search\?q=rust"/i);
});
