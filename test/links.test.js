/**
 * Routing a link somebody emailed us.
 *
 * Two things are being guarded here, and only one of them is about features.
 *
 * The feature: a LinkedIn profile has a structured answer available from a data
 * vendor, and a portfolio does not. Sending both down the same "fetch the HTML
 * and ask a model about it" path would throw away fields we could have had for
 * one credit and no inference.
 *
 * The other thing: the gateway does the fetching, so the gateway's network
 * position — inside, with an IP — is what a stranger is really reaching when
 * they email us a link. Every refusal below is a URL that would have made Yente
 * the confused deputy, and they are tested first because they are the ones that
 * matter if this module is ever wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { LINK_KINDS, classifyLink, linksIn, rankLinks } from "../src/extract/links.js";

/* --- the refusals ------------------------------------------------------- */

test("cloud metadata endpoints are never fetched", () => {
  // The classic SSRF payload. We hold a credential and sit on a network; a
  // stranger emailing this link must not be able to spend either.
  const link = classifyLink("http://169.254.169.254/latest/meta-data/iam/");
  assert.equal(link.kind, LINK_KINDS.REFUSED);
  assert.match(link.reason, /not a public address/);
});

test("loopback and private ranges are never fetched", () => {
  for (const url of [
    "http://localhost:6379/",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "http://172.16.0.9/",
    "http://[::1]:8080/",
    "http://redis.internal/",
    "http://gateway.local/",
  ]) {
    assert.equal(classifyLink(url).kind, LINK_KINDS.REFUSED, `${url} must be refused`);
  }
});

test("a public host in the 172 range that is NOT private is allowed", () => {
  // 172.16-31 is private; 172.15 and 172.32 are ordinary internet. A regex that
  // matched all of 172. would quietly refuse real sites.
  assert.equal(classifyLink("https://172.15.0.1/").kind, LINK_KINDS.WEB_PAGE);
  assert.equal(classifyLink("https://172.32.0.1/").kind, LINK_KINDS.WEB_PAGE);
});

test("only http and https are fetched", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://files.example.com/cv.pdf",
    "data:text/html,<script>alert(1)</script>",
    "gopher://example.com/",
  ]) {
    assert.equal(classifyLink(url).kind, LINK_KINDS.REFUSED, `${url} must be refused`);
  }
});

test("a link carrying credentials is not followed", () => {
  const link = classifyLink("https://user:secret@example.com/profile");
  assert.equal(link.kind, LINK_KINDS.REFUSED);
  assert.match(link.reason, /credentials/);
});

test("garbage is refused with something quotable back to the sender", () => {
  for (const value of ["", "   ", null, undefined, "not a url", "http://"]) {
    const link = classifyLink(value);
    assert.equal(link.kind, LINK_KINDS.REFUSED);
    assert.ok(link.reason?.length > 0, "a refusal must be explainable to the person");
  }
});

/* --- the routing -------------------------------------------------------- */

test("a LinkedIn member profile routes to the structured vendor path", () => {
  const link = classifyLink("https://www.linkedin.com/in/williamhgates/");
  assert.equal(link.kind, LINK_KINDS.PERSON_PROFILE);
  assert.equal(link.slug, "williamhgates");
});

test("regional LinkedIn subdomains are the same site", () => {
  for (const url of [
    "https://uk.linkedin.com/in/someone",
    "https://linkedin.com/in/someone",
    "https://www.linkedin.com/in/someone?trk=nav",
  ]) {
    assert.equal(classifyLink(url).kind, LINK_KINDS.PERSON_PROFILE, url);
  }
});

test("a LinkedIn company or school page is structured too, but not a person", () => {
  assert.equal(classifyLink("https://www.linkedin.com/company/interchained").kind,
    LINK_KINDS.COMPANY_PROFILE);
  assert.equal(classifyLink("https://www.linkedin.com/school/mit").kind,
    LINK_KINDS.COMPANY_PROFILE);
});

test("a LinkedIn URL that is not a profile is just a web page", () => {
  // /feed and /jobs have no vendor record to look up. Sending them to
  // people-profile would spend a credit to be told nothing.
  for (const url of [
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/jobs/view/123456",
    "https://www.linkedin.com/",
  ]) {
    const kind = classifyLink(url).kind;
    assert.notEqual(kind, LINK_KINDS.PERSON_PROFILE, url);
    assert.notEqual(kind, LINK_KINDS.COMPANY_PROFILE, url);
  }
});

test("a substring match is not a LinkedIn profile", () => {
  // The bug this exists for: `.includes("linkedin.com/in/")` would call a blog
  // post a member profile and spend a credit looking up a slug that is prose.
  const link = classifyLink("https://example.com/blog/linkedin.com/in/tips");
  assert.equal(link.kind, LINK_KINDS.WEB_PAGE);
  assert.equal(link.host, "example.com");
});

test("a portfolio is a web page, which is an attachment that arrived over HTTP", () => {
  const link = classifyLink("https://marks.dev/work?ref=email");
  assert.equal(link.kind, LINK_KINDS.WEB_PAGE);
  assert.equal(link.host, "marks.dev");
  assert.match(link.url, /ref=email/, "the query string is part of the page identity");
});

test("a portfolio on a non-standard port is allowed", () => {
  // Refusing :8080 on a public host would refuse real personal sites. The host
  // check is what protects us, not the port.
  assert.equal(classifyLink("https://marks.dev:8443/cv").kind, LINK_KINDS.WEB_PAGE);
});

/* --- finding links in an email ------------------------------------------ */

test("links are pulled out of prose without their punctuation", () => {
  const found = linksIn(
    "Here's my LinkedIn: https://www.linkedin.com/in/mark, and my site (https://marks.dev). "
    + "Older stuff at www.oldsite.example/portfolio.",
  );
  assert.ok(found.includes("https://www.linkedin.com/in/mark"),
    "a trailing comma is not part of the URL");
  assert.ok(found.includes("https://marks.dev"),
    "a closing bracket is not part of the URL");
  assert.ok(found.includes("https://www.oldsite.example/portfolio"),
    "a bare www host is a link a person meant to send");
});

test("the same link twice is one link", () => {
  const found = linksIn("https://marks.dev and again https://marks.dev");
  assert.equal(found.length, 1, "a duplicate must not cost a second credit");
});

test("a message with no links yields none", () => {
  for (const value of ["just some text", "", null, undefined]) {
    assert.deepEqual(linksIn(value), []);
  }
});

/* --- ordering ----------------------------------------------------------- */

test("the structured link is used before the prose one", () => {
  // Someone who sends both has handed us cheap facts and expensive text. Taking
  // the facts first means the model is enriching a profile rather than being the
  // only thing that produced it.
  const ranked = rankLinks([
    "https://marks.dev/portfolio",
    "https://www.linkedin.com/in/mark",
  ]);
  assert.equal(ranked[0].kind, LINK_KINDS.PERSON_PROFILE);
  assert.equal(ranked[1].kind, LINK_KINDS.WEB_PAGE);
});

test("refused links are dropped from the work list, not carried as errors", () => {
  const ranked = rankLinks([
    "http://169.254.169.254/",
    "https://marks.dev",
    "file:///etc/passwd",
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].host, "marks.dev");
});
