# CCME — Specification v0.3

**Status:** draft, Phase 0c
**Owner:** Interchained LLC
**Supersedes:** v0.2 (generic two-population matchmaker). Scope narrowed to founders and capital. See §12.
**Written for external review.** Anyone should be able to read this and tell us we are wrong.

---

## 1. What CCME is

CCME is an AI matchmaking **desk** that runs out of an inbox.

It connects **founders of digital products** — SaaS, devtools, AI infrastructure,
marketplaces — with **investors: angels, VCs and funds.** It interviews both sides
by email and produces one thing: **a meeting on a calendar, with a Google Meet
link, that both parties accepted.**

The goal is networking. CCME takes no fee for an introduction, gives no advice on
terms, does not negotiate, and never touches money or securities. It books the
meeting and gets out of the way.

The name is the interface. You cc it. It explains itself.

### 1.1 Why it exists

Venture runs on warm introductions, which means it runs on who you already know.
CCME is a warm introduction for people without the network — and, on the other
side, a filter for investors whose scarce resource is attention, not capital.

### 1.2 The output is a booked meeting

Not a "match." A match is an internal artifact; a booked meeting is an outcome.
It is countable, it is the only thing either side actually wanted, and it produces
the feedback signal that improves matching over time.

### 1.3 Inbound-first

CCME is a triage desk before it is anything else. The dominant flow is a message
arriving and being answered: someone writes in, someone replies to an interview
question, someone accepts an invite. Proposals are the only genuinely unprompted
messages CCME sends, and they are capped at 2–5 per person (§5.2).

This matters beyond architecture — an inbound-driven reply pattern is the
healthiest sending behaviour a mail server can have, which is why deliverability
is a normal engineering requirement here rather than a crisis (§11).

### 1.4 What CCME is not

- **Not a placement agent, broker, or finder.** No fee is charged for an
  introduction and no payment is ever tied to a round closing (§6).
- **Not fundraising advice.** No opinion on valuation, terms, or strategy.
- **Not a job board.** Employment matching is out of scope (§2.3).
- Not a bulk outreach tool. Volume is capped by construction (§5).
- Not a black box. Every proposal prints the evidence that caused it.

---

## 2. Who is in it

### 2.1 The two sides

**FOUNDERS** build digital products and are raising or preparing to raise. They
are interviewed to establish stage, category, traction, raise size, and the kind
of investor they want.

**INVESTORS** are angels, VCs, and funds. They are interviewed to establish
thesis: check size, stage, sector, geography, lead-or-follow, and portfolio
conflicts.

A role is a **property of the relationship, not the person.** An angel who is also
building a product holds both roles independently.

### 2.2 How people arrive

1. They email CCME directly.
2. **They are CC'd into a thread.** Being CC'd enrolls you, and CCME will email
   you to begin an interview. This is the core mechanic, not a side effect — it is
   why the product is called CCME.

### 2.3 Secondary: adjacent builders

A founder may also be matched with **co-founders, technical partners, and
advisors** — equity partnerships, to grow the team around the product.

**Employment is explicitly out of scope.** Co-founder and advisor matching is
partnership formation; matching people to salaried roles is employment and pulls
in an entire regulatory regime (EEOC guidance, automated-employment-decision audit
laws) that CCME is not built to satisfy. If hiring is ever added it is a separate
decision with its own gates, not a widening of this one.

---

## 3. Hard invariants

A change violating one of these is a defect regardless of how much it improves any
metric.

**INV-1 — Triage decides everything.**
No inbound message is acted upon until a typed triage call has identified the
sender, their role, their pipeline state, and their intent. No code path replies
before triage.

**INV-2 — The slot ledger is the volume control.**
A recipient holds between **2 and 5 live proposals**, never more. A slot reopens
only on a terminal outcome or a timeout (§5.2). Enforced inside the proposal
function, under a lock, not at its call sites.

**INV-3 — An empty slot beats a weak fill.**
Sub-threshold proposals are not sent. Leaving a slot open is an acceptable,
expected, and frequently correct outcome. Under a cap of five, every proposal is
expensive; precision dominates recall.

**INV-4 — Every claim is traceable.**
Any attribute CCME asserts must trace to a span of text that person supplied, in
an interview answer or a document they sent. Untraceable claims are flagged and
excluded from matching.

**INV-5 — Stop means stop, everywhere.**
An unsubscribe halts all outbound to that address within one processing cycle,
across both roles, permanently, without requiring further interaction.

**INV-6 — Never compensated for an introduction.**
CCME charges no fee for a match, an introduction, or a meeting, and takes no
success fee, percentage, carry, warrants, or any payment contingent on a round
closing. Contributions are voluntary and decoupled from outcomes (§6).

> *Transaction-based compensation is the trigger that turns an introducer into an
> unregistered broker under Exchange Act §15(a). Removing compensation removes the
> question. This is a structural decision, cheap to hold now and expensive to
> unwind later.*

**INV-7 — Money never affects matching.**
Payment status changes nothing: not match quality, not priority, not slot count,
not speed, not ordering. A paying user and a free user receive identical treatment
from the match engine, and no code path reads payment status during matching.

> *Two reasons, both load-bearing. It keeps voluntary support from becoming a fee
> for access. And it protects the only sentence that makes the desk credible: we
> have no incentive to push you at anyone.*

**INV-8 — Sensitive attributes are never match features.**
Race, sex, age, national origin, religion, disability, pregnancy, and veteran
status — and close proxies including photographs, name-as-ethnicity signals, and
graduation years — are never extracted, never stored as match features, and never
surfaced in a proposal reason. The taxonomy is capability, traction, and intent
only. Enforced by a CI linter (D5).

**INV-9 — Deletion is real.**
"Delete my data" removes content and stops processing. Provenance nodes may retain
a tombstone, never the content.

---

## 4. Architecture

```
  inbound mail ──▶ TRIAGE (typed tool call)
                       │  who / role / state / intent
        ┌──────────────┼───────────────────┐
        ▼              ▼                   ▼
   FOUNDER flow   INVESTOR flow      new or unrecognised
   interview      interview          ─▶ enroll, assign role, interview
        │              │
        └──────┬───────┘
               ▼
        MATCH ENGINE — founder profile ⇄ investor thesis
               │  both directions, confidence-scored, conflicts excluded
               ▼
        SLOT GATE — 2–5 live per recipient (INV-2), threshold enforced (INV-3)
               │
               ▼
        PROPOSAL — sent with the reason and the evidence
               │
               ▼
        INVITE — Google Calendar event + Meet link, both parties
               │
               ▼
        OUTCOME — accepted / declined / expired / no-show → slot reopens
```

### 4.1 Components

| Component | Choice | Why |
|---|---|---|
| Mail transport | Mail-in-a-Box, Contabo VPS | Already running and owned |
| Extraction + interview parsing | Qwen3.5-2B Q4_K_M, apache-2.0, llama.cpp | Measured best of three (§9) |
| Store | nedbd (NEDB) | Causal provenance is native |
| Calendar | **Google Calendar API**, real Meet links | Decided |
| Tunnel | PORTAL-BRIDGE-V1 HMAC | Already built, replay-protected |
| Workspace (Phase 6) | Portal | Shares theme tokens with salon-platform |

### 4.2 Self-hosted inference is now a requirement, not a preference

With no fee per introduction, metered inference is not a margin question — it is
the difference between viable and not. A 1.28 GB model on a VPS we already own
makes the marginal cost of a match approximately electricity.

Note the coupling: an API-based version would have to charge, and charging for
introductions drags §15(a) back in. **The architecture and the business model are
the same decision.**

Secondary and equally real: CCME holds founders' unannounced raise plans and
traction numbers. Those should not be routinely shipped to a third-party
inference provider.

---

## 5. Matching under scarcity

### 5.1 The join

Founders state what they are building and what they want. Investors state their
thesis. A proposal requires **both directions to fire** and both to clear the
confidence threshold.

Both sides draw from one shared controlled vocabulary:

| founder | investor |
|---|---|
| stage — pre-seed / seed / series A | stage focus |
| category — devtools, AI infra, fintech, marketplace, vertical SaaS, consumer | sector thesis |
| traction band — pre-revenue / <10k MRR / 10–100k / 100k+ | traction floor |
| raise size | check size |
| geography | geography |
| business model | lead or follow |

This vocabulary is not invented — it is the language both sides already write in.
Investors publish theses in exactly these terms and founders pitch in exactly
these terms, which is precisely why extraction should perform better here than on
a generic taxonomy (§9.2).

**Conflicts are exclusions, not penalties.** An investor holding a competing
portfolio company is never proposed. This is a feature a warm intro from a friend
does not give you.

### 5.2 The slot ledger

A slot is occupied from the moment a proposal is sent until a terminal outcome.

Reopens on **whichever comes first**:

| terminal outcome | meaning |
|---|---|
| `declined_by_recipient` | passed on the proposal |
| `declined_by_subject` | the other side passed |
| `meeting_completed` | it happened |
| `meeting_declined` | invite declined by either party |
| `no_show` | accepted, did not occur |
| `expired` | **timeout** — no response within N days |

`N` defaults to 7 days, configurable per person, with exactly one reminder at the
midpoint. A non-response is not pursued beyond that reminder.

### 5.3 The throttle is also the anti-spam architecture

Outbound volume is capped at the receiving side by a rule that exists for quality
reasons anyway. Nobody sends an investor forty decks and calls it service, and a
system that *cannot* flood you is more trustworthy than one that promises not to.

---

## 6. Monetization

**Pay what you want. The first 500 founders and the first 500 investors are free
for life.**

- **Founding 1,000 — 500 founders and 500 investors** — free permanently, badged.
  The two counters are tracked separately and both are public. Splitting them per
  side is deliberate: it keeps the marketplace balanced during cold start instead
  of filling 1,000 seats with whichever side arrives fastest.
- **After that: PWYW**, including zero. A suggested amount is shown; any amount,
  or none, is accepted.
- **Never contingent.** No success fee, no percentage, no carry, nothing tied to a
  round closing (INV-6).
- **Never load-bearing.** Payment status is invisible to the match engine (INV-7).

A contribution supports the infrastructure. It buys nothing, and that is the
point — it is what allows CCME to tell an investor, truthfully, that it has no
stake in whether they take the meeting.

---

## 7. Triage

One typed tool call per inbound message, before any other logic (INV-1). Enum
slots, no free-text authoring, an explicit `unknown`.

| intent | routed to |
|---|---|
| `new_inbound` | enroll, assign role, begin interview |
| `interview_answer` | advance the interview |
| `proposal_interested` | move toward invite |
| `proposal_pass` | terminal outcome, reopen slot |
| `availability_reply` | calendar flow |
| `invite_response` | accept / decline / reschedule |
| `unsubscribe` | INV-5 |
| `delete_me` | INV-9 |
| `question_or_other` | answer if answerable, escalate if not |
| `unknown` | **escalate — do not guess** |

`unknown` does not answer. A confidently wrong reply from a matchmaking desk costs
more than a slow one; a human glance at an ambiguous message costs near zero.

---

## 8. Interviews

Both sides are interviewed by email, multi-turn, one or two questions per message.
An attached document — a LinkedIn export, a deck, a fund's thesis page — **pre-fills**
the interview rather than replacing it. Extraction supplies the history; the
interview supplies the intent.

This is the structural fix for a measured problem: intent came back `none` in
**35 of 40** extractions, because documents record what someone did and never what
they want (§9.2). Both sides of this join are *stated*, never inferred.

An interview ending below the confidence threshold does not enter matching, and
the person is told plainly what is still missing.

---

## 9. Model selection — the measurement behind the choice

Five real LinkedIn PDF exports, 34 chunks, 33 scoreable. One excluded: a donut
shop, for which the taxonomy had no valid category — a taxonomy defect, not a
model error, excluded rather than scored as a miss.

| model | size | s/chunk | well-formed calls | evidence exact | category correct |
|---|---|---|---|---|---|
| imagine 0.8B v0.2.0 | 529 MB | 6.6 | 34/34 | 31/34 | 17/33 — 52% |
| **Qwen3.5-2B** | **1.28 GB** | **12.4** | **34/34** | **33/34** | **27/33 — 82%** |
| Qwen3.5-4B | 2.74 GB | 30.8 | 34/34 | 27/34 | 16/33 — 48% |

**All three produced 34/34 well-formed tool calls.** The mechanics are not in
question at any size.

**The model is settled: Qwen3.5-2B.** The table above is the record of why, not an
open comparison.

### 9.1 One principle carried forward from the testing

Larger-model "failures" in that run were overwhelmingly *abstentions* rather than
wrong answers — shown a chunk that did not state what a company sells, it declined
to guess. That behaviour is the right one under a throttle, and it is why INV-3
exists: an empty slot beats a weak fill. The principle is kept; the model choice
is 2B and is not revisited here.

### 9.2 Why these numbers should improve under the narrowed scope

The 82% was measured against a **generic 20-category B2B taxonomy** whose members
did not map cleanly to language in the documents — `consulting_strategy` became an
attractor precisely because it was vague. The investment vocabulary (§5.1) is one
both sides already write in. **The measurement must be repeated against the new
taxonomy before 82% is quoted for this product.**

### 9.3 Honest limits

n = 5 profiles, four supply-chain professionals, none of them founders or
investors. Labels were written by the implementer, not a domain expert. This is a
signal about the pipeline, not a benchmark for this product.

---

## 10. Definition of done — gates

A gate is met only when demonstrated by a command anyone can run, producing output
anyone can check. "It looked right" is not a gate.

### D1 — Triage
- [ ] Every intent enum is exercised by a fixture email.
- [ ] Ambiguous fixtures produce `unknown` and escalate rather than guess.
- [ ] Triage asserts arguments, not just the tool name.
- [ ] No reply path bypasses triage.

### D2 — CRM and roles
- [ ] A CC'd participant is enrolled with correct provenance.
- [ ] One person can hold founder and investor roles without collision.
- [ ] Interview state survives restart and out-of-order replies.

### D3 — The slot ledger
- [ ] No recipient ever holds more than 5 live proposals; asserted in the function.
- [ ] Each terminal outcome reopens exactly one slot.
- [ ] Timeout fires at N days with exactly one reminder at the midpoint.
- [ ] A concurrency test cannot drive live proposals above the cap.

### D4 — Precision
- [ ] Sub-threshold matches are not proposed; the slot stays open.
- [ ] A corpus run reports proposals made vs slots deliberately left open.
- [ ] Portfolio conflicts are excluded, with a fixture proving it.

### D5 — Fairness and taxonomy hygiene
- [ ] No sensitive attribute or proxy appears in any match feature.
- [ ] A CI linter fails on violation in the taxonomy or extraction schema.
- [ ] Proposal reasons draw only from capability, traction, and intent spans.

### D6 — Money is inert
- [ ] No code path reads payment status during matching (asserted by test).
- [ ] Founding-1000 status affects badges only, never ordering.
- [ ] A paying and a non-paying fixture user receive identical match output.

### D7 — Calendar
- [ ] Events carry working Meet links and reach both parties.
- [ ] Accept, decline, reschedule and no-show each resolve correctly.
- [ ] A declined invite reopens the slot without further messaging.

### D8 — Deliverability
- [ ] SPF, DKIM and DMARC pass a third-party inbox placement test.
- [ ] Sending domain verified against the operator's existing mailbox before live use.
- [ ] Bounces and complaints feed a suppression list automatically.
- [ ] Every outbound carries a working unsubscribe and a postal address.
- [ ] One config flag halts all outbound.

### D9 — Receipts and data rights
- [ ] `TRACE caused_by` on any meeting returns the chain to both interviews.
- [ ] Proposal reasons are generated once from stored spans, never at read time.
- [ ] `unsubscribe` and `delete_me` honoured within one cycle, confirmed once.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Sender reputation damage | High | Flow is inbound-first: most outbound is a reply to someone who just wrote in, which is the healthiest sending pattern available. Mailbox and DNS are already provisioned. D8 still gates the first live send. |
| Weak proposals burn an investor's trust | **Existential** | INV-3, D4; an empty slot is acceptable |
| Being treated as an unregistered broker | High | INV-6; no fee, no contingent payment, no advice |
| Leaking an unannounced raise to the wrong party | High | Conflict exclusion, self-hosted inference, no third-party model calls |
| Cold start — no supply on either side | High | CC mechanic; Founding 1,000 scarcity |
| Taxonomy untested on this domain | Medium | §9.2 — re-measure before quoting any number |

---

## 12. What changed from v0.2, and why

v0.2 was a generic two-population matchmaker spanning employers, investors, hedge
funds, marketing partners and influencers, with members as the paying side.

- **Scope narrowed to founders and capital.** A generic taxonomy produced a
  measured attractor problem; a domain vocabulary both sides already speak should
  not (§9.2).
- **Employment removed.** It was the single largest regulatory surface, and it was
  secondary to the actual goal. Co-founder and advisor matching stays because
  partnership is not employment (§2.3).
- **No fees at all.** v0.2 assumed members paid. Charging for introductions to
  investors is the fact pattern that creates broker-dealer exposure; removing
  compensation removes the question (INV-6).
- **PWYW plus Founding 1,000** replaces subscriptions, with payment made inert by
  INV-7 so that voluntary support cannot become a fee for access.

---

## 13. Open questions

1. Default slot cap within 2–5. Assumed 3.
2. Default timeout `N` — 7 days assumed, unvalidated.
3. Does a founder's raise status need an explicit confidentiality mode?

**Settled:** model is Qwen3.5-2B · mailbox and DNS are provisioned by the operator ·
Founding seats are 500 per side, 1,000 total.
