import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openInMemory } from "../src/store/db.js";
import { openWaitlistRepository } from "../src/waitlist/repository.js";
import { createYenteServer } from "../web/server.js";

let server;
let origin;

before(async () => {
  const repository = openWaitlistRepository({
    store: openInMemory(),
    clock: () => new Date("2026-08-13T20:00:00.000Z"),
  });
  server = createYenteServer({
    repository,
    adminUsername: "admin",
    adminPassword: "correct horse battery staple",
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("public landing page ships the mailto offer, and no form", async () => {
  const response = await fetch(`${origin}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Stop networking\./);
  assert.match(html, /Start getting introduced\./);

  // The offer is a prefilled mailto, not a submit button. Intake is a
  // conversation: a form makes someone answer the questions we guessed they
  // could answer, and throws away the first evidence about them.
  assert.match(html, /href="mailto:[^"]*\?subject=Founding%20seat/);
  assert.match(html, /Claim a seat by email/);

  // Graded in the other direction too, because the whole point is the absence.
  // Asserting only that the mailto is present would pass on a page that ALSO
  // shipped the old form.
  assert.doesNotMatch(html, /<form/,
    "the landing page must not ship a form");
  assert.doesNotMatch(html, /Claim my free founding spot/,
    "the old form CTA must be gone, not merely hidden");

  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("subscription writes NEDB and immediately updates public capacity", async () => {
  const subscribe = await fetch(`${origin}/api/founding-network/subscribers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Bob Builder",
      email: "bob@example.com",
      cohort: "founder_developer",
      intent: "An employer building developer infrastructure",
      consent: true,
    }),
  });
  assert.equal(subscribe.status, 201);

  const capacityResponse = await fetch(`${origin}/api/founding-network/capacity`);
  const capacity = await capacityResponse.json();
  assert.equal(capacity.cohorts.foundersDevelopers.joined, 1);
  assert.equal(capacity.cohorts.foundersDevelopers.remaining, 4_999);
  assert.equal(capacityResponse.headers.get("cache-control"), "no-store");
});

test("admin records and CSV fail closed without .env credentials", async () => {
  const denied = await fetch(`${origin}/api/admin/subscribers`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /Yente Admin/);

  const authorization = `Basic ${Buffer.from("admin:correct horse battery staple").toString("base64")}`;
  const recordsResponse = await fetch(`${origin}/api/admin/subscribers`, {
    headers: { Authorization: authorization },
  });
  const records = await recordsResponse.json();
  assert.equal(recordsResponse.status, 200);
  assert.equal(records.total, 1);
  assert.equal(records.records[0].email, "bob@example.com");

  const csvResponse = await fetch(`${origin}/api/admin/subscribers.csv`, {
    headers: { Authorization: authorization },
  });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get("content-disposition"), /yente-subscribers-/);
  assert.match(await csvResponse.text(), /bob@example\.com/);
});
