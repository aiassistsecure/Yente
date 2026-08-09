# CCME

**An AI matchmaking desk that runs out of an inbox. You cc it; it explains itself.**

CCME keeps a CRM of two populations, interviews both sides by email, and produces
one thing: **a meeting on a calendar, with a Google Meet link, that both parties
accepted.**

Not a match. Not an introduction email. A booked meeting — because that is the
thing that is actually worth something, and the thing you can count.

---

## How it works

**Members** are decision-makers: employers, investors, hedge funds, marketing
partners, influencers. CCME interviews them to learn their ideal candidate.

**Candidates** are the fit for those members. CCME interviews them to learn their
ideal member.

When both sides fire — their ideal matches yours, yours matches theirs — CCME
proposes, gets interest from both, and books the meeting.

Candidates arrive two ways: they write in, or **you cc CCME on a thread and it
picks them up from there.** That is the mechanic the name is describing.

---

## Three design decisions worth arguing with

**Two to five. Never more.**
A member holds at most 2–5 live candidates at a time. Slots reopen only when
something actually resolves — a pass, a meeting, a decline, or a timeout.

This is the quality mechanism and the volume control at once. Nobody sends a
hiring manager forty résumés and calls it service, and a system that *can't*
flood you is more trustworthy than one that promises not to.

**An empty slot beats a weak fill.**
Under a cap of five, every proposal is expensive. CCME leaves slots open rather
than filling them with a maybe. This came out of measurement: in model testing,
the larger model's apparent failures were almost entirely *refusals to guess*, and
under a throttle that is the behavior you want.

**Capability and intent only.**
Members include employers, so this is employment-adjacent matching. Protected
attributes and their proxies are never extracted, never stored as match features,
and never appear in a proposal's reason. That is enforced by a linter in CI, not
by good intentions.

---

## Receipts

Built on [NEDB](https://github.com/Eth-Interchained/nedb), whose causal provenance
is native. `TRACE caused_by` on any booked meeting returns the whole chain — which
sentence, in whose email or document, extracted under which model weights, on what
date, caused two people to meet.

Extraction runs on our own hardware: a 1.28 GB open-weights model on our own
server. Matching is superlinear in pool size, so metered inference fails exactly
when the product starts working — and people's professional histories should not
be routinely shipped to a third-party inference provider.

---

## Status

**Phase 0b — specification.** No runtime yet.

| document | what it settles |
|---|---|
| [`SPEC.md`](SPEC.md) | invariants, architecture, the slot ledger, model measurement, D1–D8 gates |
| [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | person, proposal and meeting machines; triage table |
| [`docs/COLLECTIONS.md`](docs/COLLECTIONS.md) | the NEDB data model and the shape of a receipt |

v0.1 specified a consent-gated peer-to-peer B2B matchmaker. It was superseded
after real-profile testing showed most people are not businesses — they are
candidates. [SPEC §12](SPEC.md#12-what-changed-from-v01-and-why) records what
changed and why.

---

## Licence

Code is BUSL-1.1 with a Change Date of 2030-08-09, converting to Apache-2.0.
Model weights are covered by their own upstream licences (Qwen3.5-2B is
apache-2.0) and are **not** relicensed by this repository.

---

Built by [Interchained LLC](https://interchained.org).
