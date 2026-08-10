# Yente

**Founders meet investors. cc me.**

> *Yente is the matchmaker. `ccme@` is how you reach her.*

Yente connects **founders of digital products** — SaaS, devtools, AI infrastructure,
marketplaces — with **angels, VCs and funds.** It interviews both sides by email
and produces one thing: **a meeting on a calendar, with a Google Meet link, that
both parties accepted.**

Venture runs on warm introductions, which means it runs on who you already know.
Yente is a warm introduction for people without the network.

---

## No fee. Ever.

Yente takes **nothing** for an introduction. No success fee, no percentage, no
carry, no payment tied to a round closing. It gives no advice on terms, never
negotiates, and never touches money or securities. It books the meeting and gets
out of the way.

That is not modesty — it is the only reason the email is worth opening. An honest
broker is credible exactly when there is nothing in it for them.

**Monetization is pay-what-you-want, and the first 500 founders and 500 investors are free for life.**
A contribution supports the infrastructure and buys nothing: payment status is
invisible to the match engine, by invariant and by test. PWYW that changes nothing
is a tip. PWYW that changes outcomes is a price.

---

## Two to five. Never more.

You hold at most 2–5 live proposals at a time. A slot reopens only when something
actually resolves — a pass, a meeting, a decline, or a timeout.

This is the quality mechanism and the volume control at once. Nobody sends an
investor forty decks and calls it service, and a system that *cannot* flood you is
more trustworthy than one that promises not to.

**An empty slot beats a weak fill.** Under a cap of five every proposal is
expensive, so Yente leaves slots open rather than filling them with a maybe. This
came out of measurement: in model testing the larger model's apparent failures
were almost entirely *refusals to guess*, and under a throttle that is exactly the
behavior you want.

**Portfolio conflicts are exclusions.** An investor holding a competing company is
never proposed — something a warm intro from a friend does not protect you from.

---

## How people arrive

1. They email `ccme@` directly.
2. **They CC `ccme@` into a thread**, and Yente picks it up from there.

The address is the instruction. That second path is the one the name describes,
and it is how most people will arrive.

---

## Receipts

Built on [NEDB](https://github.com/Eth-Interchained/nedb), whose causal provenance
is native. `TRACE caused_by` on any booked meeting returns the whole chain — which
sentence, in whose email or document, extracted under which model weights, on what
date, caused two people to meet.

Extraction runs on our own hardware: a 1.28 GB open-weights model on our own
server. With no fee per introduction that is not a margin choice, it is the
difference between viable and not — and founders' unannounced raise plans should
not be routinely shipped to a third-party inference provider.

---

## Scope

**In:** founders of digital products ⇄ investors. Secondarily, founders ⇄
co-founders, technical partners and advisors.

**Out:** employment. Matching people to salaried roles is a different regulatory
regime, and partnership formation is not employment. If hiring is ever added it
is a separate decision with its own gates.

---

## Status

**Phase 0c — specification.** No runtime yet.

| document | what it settles |
|---|---|
| [`SPEC.md`](SPEC.md) | invariants, architecture, the slot ledger, monetization, D1–D9 gates |
| [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | person, proposal and meeting machines; triage table |
| [`docs/COLLECTIONS.md`](docs/COLLECTIONS.md) | the NEDB data model and the shape of a receipt |

Earlier revisions specified a consent-gated peer-to-peer B2B matchmaker (v0.1) and
a generic two-population desk spanning employers and influencers (v0.2). Both were
superseded. [SPEC §12](SPEC.md#12-what-changed-from-v02-and-why) records why.

---

## Licence

Code is BUSL-1.1 with a Change Date of 2030-08-09, converting to Apache-2.0.
Model weights are covered by their own upstream licences (Qwen3.5-2B is
apache-2.0) and are **not** relicensed by this repository.

---

Built by [Interchained LLC](https://interchained.org).
