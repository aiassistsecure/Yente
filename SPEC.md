# CCME — Specification v0.2

**Status:** draft, Phase 0b
**Owner:** Interchained LLC
**Supersedes:** v0.1 (consent-gated B2B matchmaker). See §12 for what changed and why.
**Written for external review.** Anyone should be able to read this and tell us we are wrong.

---

## 1. What CCME is

CCME is an AI matchmaking **desk** that runs out of an inbox.

It keeps a CRM of two populations, interviews both sides by email, and produces
one thing: **a meeting on a calendar, with a Google Meet link, that both parties
accepted.**

The name is the interface. You cc it. It explains itself.

### 1.1 The output is a booked meeting

Not a "match." Not an introduction email. A match is an internal artifact; a
booked meeting is a business outcome. It is countable, it is what a member would
pay for, and it produces a feedback signal — accepted invites and their outcomes
are the training data that improves matching over time.

### 1.2 What CCME is not

- Not a job board. Nobody browses a list.
- Not a bulk outreach tool. Volume is capped by construction (§5).
- Not a black box. Every proposal can print the evidence that caused it.

---

## 2. The two populations

**MEMBERS** are decision-makers with capital, hiring authority, budget, or reach:
employers, investors, hedge funds, marketing partners, social-media influencers.
They are interviewed to define their **ideal candidate**. They are the paying side.

**CANDIDATES** are the fit for those members. They are interviewed to define their
**ideal member**. They are the supply side.

Candidates arrive two ways, and both are first-class:

1. They email CCME directly.
2. **They are CC'd into a thread.** Being CC'd enrolls you as a candidate, and
   CCME will email you. This is the core mechanic, not a side effect — it is why
   the product is called CCME.

A person's population is a **property of the relationship, not the person.** A
hedge fund partner is a member when hiring and a candidate when raising. The
record carries both roles independently.

---

## 3. Hard invariants

A change that violates one of these is a defect regardless of how much it
improves any metric.

**INV-1 — Triage decides everything.**
No inbound message is acted upon until it has been classified by a typed triage
call that identifies the sender, their population, their pipeline state, and
their intent. There is no code path that replies before triage.

**INV-2 — The slot ledger is the volume control.**
A member holds between **2 and 5 live candidate proposals**, never more. A slot
reopens only on a terminal outcome or a timeout (§5.2). This cap is enforced in
the proposal function itself, not at its call sites.

**INV-3 — An empty slot beats a weak fill.**
Proposals below the confidence threshold are not sent. Leaving a slot open is an
acceptable, expected, and frequently correct outcome. Under a 2–5 cap every
proposal is expensive; precision dominates recall.

**INV-4 — Every claim is traceable.**
Any attribute CCME asserts about a person must trace to a span of text that
person supplied, in an interview answer or a document they sent. Untraceable
claims are flagged and excluded from matching.

**INV-5 — Stop means stop, everywhere.**
An unsubscribe halts all outbound to that address within one processing cycle,
across both populations, permanently, without requiring any further interaction.

**INV-6 — Protected attributes are never match features.**
Members include employers, so CCME performs employment-adjacent matching. Race,
sex, age, national origin, religion, disability, pregnancy, and veteran status —
and close proxies for them, including photographs, names-as-ethnicity signals,
and graduation years — are never extracted as match features, never stored as
match features, and never surfaced in a proposal reason. The taxonomy is
capability-and-intent only.

> *This is an engineering constraint with legal teeth, not a values statement.
> A matching system that can be shown to have used protected attributes is a
> liability to every employer member who used it.*

**INV-7 — Deletion is real.**
"Delete my data" removes content and stops processing. Provenance nodes may
retain a tombstone, never the content.

---

## 4. Architecture

```
  inbound mail ──▶ TRIAGE (typed tool call)
                       │  who / population / state / intent
        ┌──────────────┼───────────────────┐
        ▼              ▼                   ▼
   MEMBER flow    CANDIDATE flow     new or unrecognised
   interview      interview          ─▶ enroll as candidate, begin interview
        │              │
        └──────┬───────┘
               ▼
        MATCH ENGINE — member.ideal_candidate ⇄ candidate.ideal_member
               │  confidence-scored, both directions
               ▼
        SLOT GATE — 2–5 live per member (INV-2), threshold enforced (INV-3)
               │
               ▼
        PROPOSAL — sent to member with the reason and the evidence
               │  member interested?
               ▼
        INVITE — Google Calendar event + Meet link, sent to both
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
| Calendar | **Google Calendar API**, real Meet links | Decided; iCal-only was rejected |
| Tunnel | PORTAL-BRIDGE-V1 HMAC | Already built, replay-protected |
| Workspace (Phase 6) | Portal | Shares theme tokens with salon-platform |

### 4.2 Why extraction is self-hosted

Matching is superlinear in pool size and interviews are multi-turn, so metered
inference fails exactly when the product starts working. A 1.28 GB model on a VPS
we already pay for has no marginal cost per interview turn.

Secondary and equally real: CCME holds people's professional histories and their
stated ambitions. Those should not be routinely shipped to a third-party
inference provider.

---

## 5. Matching under scarcity

### 5.1 The join

The member states an ideal candidate. The candidate states an ideal member. A
proposal requires **both directions to fire** and both to clear the confidence
threshold.

Both sides draw from one shared controlled vocabulary. A shared enum makes
matching a deterministic join rather than a similarity guess, and makes every
proposal explainable in one sentence. **The taxonomy is the matching engine.**

### 5.2 The slot ledger

Each member has 2–5 live proposals. A slot is occupied from the moment a proposal
is sent until a terminal outcome.

A slot reopens on **whichever comes first**:

| terminal outcome | meaning |
|---|---|
| `declined_by_member` | member passed |
| `declined_by_candidate` | candidate passed |
| `meeting_completed` | the meeting happened |
| `meeting_declined` | invite declined by either party |
| `no_show` | invite accepted, meeting did not occur |
| `expired` | **timeout** — no response within N days |

`N` is configurable per member, defaulting to 7 days, with exactly one reminder
at the midpoint. A non-response is not pursued beyond that reminder.

### 5.3 Why the throttle is also the anti-spam architecture

Outbound volume is capped at the *demand* side by a rule that exists for quality
reasons anyway. A member with 5 live slots generates at most 5 candidate contacts.
Scarcity does the work that a consent wall would otherwise do, and it matches how
a competent human recruiter already behaves — nobody sends a hiring manager forty
résumés and calls it service.

---

## 6. Triage

One typed tool call per inbound message. Enum slots, no free-text authoring, an
explicit `unknown` member.

Triage answers four questions: **who is this**, **which population**, **what
pipeline state are they in**, **what do they want**.

| intent | routed to |
|---|---|
| `new_inbound` | enroll, choose population, begin interview |
| `interview_answer` | advance the interview |
| `proposal_interested` | move toward invite |
| `proposal_pass` | terminal outcome, reopen slot |
| `invite_response` | accept / decline / reschedule |
| `reschedule_request` | calendar flow |
| `unsubscribe` | INV-5 |
| `delete_me` | INV-7 |
| `question_or_other` | answer if answerable, escalate if not |
| `unknown` | escalate — do not guess |

`unknown` does not answer. A confidently wrong reply from a matchmaking desk
costs more than a slow one, and the cost of a human glancing at an ambiguous
message is near zero.

---

## 7. Interviews

Both populations are interviewed by email, multi-turn, one or two questions per
message. An attached profile (LinkedIn "Save to PDF") **pre-fills** the interview
rather than replacing it — extraction supplies the history, the interview supplies
the intent.

This is the structural fix for a measured problem: `need_category` came back
`none` in **35 of 40** extractions, because a profile records what someone did and
never what they want (§9.2). Both sides of this join are now *stated*, never
inferred.

An interview that ends below the confidence threshold does not enter matching.
The person is told plainly what is still missing.

---

## 8. Calendar and meetings

Google Calendar API, real Meet links, invites sent to both parties.

- The event is created only after the member expresses interest **and** the
  candidate confirms availability.
- Accept, decline, reschedule and no-show all resolve to terminal outcomes that
  reopen the slot (§5.2).
- Outcomes are recorded against the match, and become the feedback signal for
  matching quality over time.

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

### 9.1 Abstention is a feature under a throttle

All 17 of the 4B's misses were `offer_category: "none"` — abstentions, not errors.
Shown `Company: Tesla / Title: Production control Team Lead`, it declined to infer
what Tesla sells because the excerpt does not say.

Under v0.1 scoring that looked like losing. **Under INV-3 it is precisely the
desired behavior.** The 4B remains a live candidate for the proposal-confidence
step even though 2B is chosen for extraction throughput. Open question in §13.

### 9.2 Two findings that shaped the design

- A profile encodes capability, never intent — hence interviews (§7).
- Description length has an optimum at small scale: a 2,269-character parameter
  description scored *worse* (36%) on the 0.8B than a 700-character one (52%).
  More guidance is not monotonically better.

### 9.3 Honest limits

n = 5 profiles, four of them supply-chain professionals. Labels were written by
the implementer, not a domain expert, and several "misses" are debatable — Edelman
was labelled `accounting_finance` where the model said `consulting_strategy`, and
Edelman is a communications consultancy. This is a signal, not a benchmark.

---

## 10. Definition of done — gates

A gate is met only when demonstrated by a command anyone can run, producing
output anyone can check. "It looked right" is not a gate.

### D1 — Triage
- [ ] Every intent enum is exercised by a fixture email.
- [ ] Ambiguous fixtures produce `unknown` and escalate rather than guess.
- [ ] Triage asserts arguments, not just the tool name.
- [ ] No reply path exists that bypasses triage.

### D2 — CRM and populations
- [ ] A CC'd participant is enrolled as a candidate with correct provenance.
- [ ] One person can hold member and candidate roles simultaneously without collision.
- [ ] Interview state survives restart and out-of-order replies.

### D3 — The slot ledger
- [ ] A member never holds more than 5 live proposals; asserted in the proposal function.
- [ ] Each terminal outcome reopens exactly one slot.
- [ ] Timeout fires at N days with exactly one reminder at the midpoint.
- [ ] A concurrency test cannot drive live proposals above the cap.

### D4 — Precision
- [ ] Sub-threshold matches are not proposed; the slot stays open.
- [ ] A run over the test corpus reports proposals made vs slots left open.
- [ ] The threshold is configurable and its effect is measured, not assumed.

### D5 — Fairness
- [ ] No protected attribute or close proxy appears in any match feature.
- [ ] A linter over the taxonomy and extraction schema fails CI on violation.
- [ ] Proposal reasons are generated only from capability and intent spans.

### D6 — Calendar
- [ ] Events carry working Meet links and reach both parties.
- [ ] Accept, decline, reschedule and no-show each resolve correctly.
- [ ] A declined invite reopens the slot without further messaging.

### D7 — Deliverability
- [ ] SPF, DKIM and DMARC pass a third-party inbox placement test.
- [ ] Sending domain is warmed and volume ramped before live use.
- [ ] Bounces and complaints feed a suppression list automatically.
- [ ] Every outbound carries a working unsubscribe and a postal address.
- [ ] One config flag halts all outbound.

### D8 — Receipts and data rights
- [ ] `TRACE caused_by` on any meeting returns the full chain to both interviews.
- [ ] Proposal reasons are generated once from stored spans, never re-generated at read time.
- [ ] `unsubscribe` and `delete_me` are honoured within one cycle and confirmed once.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Domain blacklisted — CCME now emails people who did not write in first | **Existential** | D7 in full before first live send; warm, ramp, suppress |
| Weak candidates burn a member's trust | **Existential** | INV-3, D4; an empty slot is acceptable |
| Employment-matching legal exposure | High | INV-6, D5, enforced by a CI linter |
| Cold start — no candidate supply | High | CC mechanic is the supply loop; every member thread seeds candidates |
| Interview abandonment mid-flow | Medium | Short turns, resumable state, one reminder |
| Taxonomy too coarse for real industries | Medium | Known hole and known seam; expand from real intake |

---

## 12. What changed from v0.1, and why

v0.1 was a consent-gated peer-to-peer B2B matchmaker: only people who wrote in
could be enrolled, matches were symmetric offer↔need, and introductions were
double-opt-in emails.

Three problems, two of them found by measurement:

1. **The employee finding was a dead end.** Three of five real test profiles were
   employees, and under a business-to-business-only design a Tesla production
   control lead has "a job, not an offer." The two-population model **inverts
   this into the supply side** — that person is a strong candidate, and the
   corpus already collected is candidate supply.
2. **Consent-gating starved the graph.** Requiring everyone to write in first made
   cold start nearly unsolvable. The CC mechanic solves supply directly.
3. **The output was too weak to charge for.** An introduction email is not a
   business outcome. A booked meeting is.

The volume protection that consent-gating provided is preserved — relocated to
the slot throttle (§5.3), where it derives from quality rather than from a wall.

---

## 13. Open questions

1. Sending domain and address.
2. Pricing and which side pays — presumed members, unconfirmed.
3. Whether the 4B should serve the proposal-confidence step while 2B serves
   extraction (§9.1).
4. Default timeout `N` — 7 days assumed, unvalidated.
5. Whether a candidate may hold their own slot cap across multiple members.
6. Whether members can veto a candidate permanently or only for one cycle.
