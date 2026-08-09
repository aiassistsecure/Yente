# CCME

**An email-first B2B matchmaker. You cc it; it explains itself.**

Send CCME your LinkedIn profile export. It reads it, tells you what it
understood, and asks you one question: what do you need from another business?

When someone else's answer matches what you do — and what you need matches what
they do — CCME asks you both, separately, whether you want an introduction. Two
yeses and it opens a single thread with both of you, including the reason.

One no, or one silence, and nothing happens.

---

## Three things that make it different

**Nothing enters the graph that a person did not send in.**
No scraping. No purchased lists. No cold profiles waiting to be matched. You are
in the graph because you emailed in, and for no other reason. This is enforced as
a schema constraint, not promised in a policy.

**It runs on our own hardware.**
Extraction uses a 1.28 GB open-weights model on our own server. Matching is
superlinear in pool size, so metered inference fails exactly when the product
starts working. It also means your professional history is not routinely shipped
to a third-party inference provider.

**Every introduction can print its receipt.**
Built on [NEDB](https://github.com/Eth-Interchained/nedb), whose causal
provenance is native. `TRACE caused_by` on any introduction returns the whole
chain — which sentence, in whose profile, extracted by which model version, on
what date, caused two people to meet.

---

## Status

**Phase 0 — specification.** No runtime yet.

| document | what it settles |
|---|---|
| [`SPEC.md`](SPEC.md) | invariants, architecture, model selection, gated definition of done |
| [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | every state a person or an introduction can be in |
| [`docs/COLLECTIONS.md`](docs/COLLECTIONS.md) | the NEDB data model and the shape of a receipt |

---

## The invariant worth reading first

> Being CC'd does not enroll anyone.
>
> If Alice emails Bob and CCs CCME, CCME may act **for Alice**, who addressed it.
> Bob did not opt in. Bob is never added to the graph, never extracted, never
> matched, and never emailed.

The product's name invites a mechanic that would otherwise quietly pull
non-consenting people into the dataset. Naming that invariant up front is cheaper
than discovering it later. Full list in [SPEC §2](SPEC.md#2-hard-invariants).

---

## Licence

Code is BUSL-1.1 with a Change Date of 2030-08-09, converting to Apache-2.0.
Model weights are covered by their own upstream licences (Qwen3.5-2B is
apache-2.0) and are **not** relicensed by this repository.

---

Built by [Interchained LLC](https://interchained.org).
