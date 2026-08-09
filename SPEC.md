# CCME — Specification v0.1

**Status:** draft, Phase 0
**Owner:** Interchained LLC
**Written for external review.** Anyone should be able to read this and tell us we are wrong.

---

## 1. What CCME is

CCME is a B2B matchmaker that lives in an inbox.

A person emails it their LinkedIn profile export. CCME reads it, tells them what it understood, asks them one question about what they need, and then — only when two people have each said yes — introduces them to each other in a single email thread.

The name is the interface. You cc it. It explains itself.

### 1.1 What CCME is not

- Not a scraper. Nothing enters the graph that a person did not personally send in.
- Not an outreach tool. It will not contact anyone who has not written to it first.
- Not a job board. Individuals looking for employment are out of scope for v0.1 (see §4.3).
- Not a black box. Every introduction can print the evidence that caused it.

---

## 2. Hard invariants

These are not guidelines. A change that violates one of these is a defect, regardless of how much it improves any metric.

**INV-1 — Consent by construction.**
A person exists in the match graph if and only if that person sent an email to CCME from their own address. There is no other write path into the `people` collection.

**INV-2 — CC does not confer membership.**
Being CC'd on a thread does not enroll anyone. If Alice emails Bob and CCs CCME, CCME may act *on Alice's behalf*, because Alice addressed it. Bob is a third party who did not opt in. Bob is never added to the graph, never extracted, never matched, and never emailed by CCME as a result of that thread.

> *Rationale: the product's name invites a mechanic that would otherwise smuggle non-consenting people into the dataset. Naming the invariant is cheaper than discovering it later.*

**INV-3 — No unsolicited outbound.**
Every outbound message is either (a) a direct reply to a message that person sent, or (b) an introduction that person explicitly said yes to. There is no third category.

**INV-4 — Two yeses or no intro.**
An introduction is sent only after both parties have independently affirmed. A single non-response is a no. Silence is never consent.

**INV-5 — Every claim is traceable.**
Any capability CCME attributes to a person must be traceable to a span of text that person supplied. Untraceable claims are flagged and excluded from matching.

**INV-6 — Deletion is real.**
"Delete my data" removes the person from the graph and stops all processing. Provenance nodes may retain a tombstone, never the content.

---

## 3. Architecture

```
  inbound mail ──▶ triage (typed tool call) ──▶ state machine ──▶ outbound mail
                          │                          │
                          ▼                          ▼
                    human queue                    NEDB
                    (unknown intent)        (causal graph, receipts)
                                                     ▲
                                                     │
                       extraction service (Qwen3.5-2B, self-hosted)
```

### 3.1 Components

| Component | Choice | Why |
|---|---|---|
| Mail transport | Mail-in-a-Box, Contabo VPS | Already running and owned |
| Extraction model | Qwen3.5-2B Q4_K_M, apache-2.0, on llama.cpp | Measured best of three candidates (§6) |
| Store | nedbd (NEDB) | Causal provenance is native, not bolted on |
| Tunnel | PORTAL-BRIDGE-V1 HMAC | Already built, golden vectors, replay-protected |
| Workspace (Phase 5) | Portal | Shares theme tokens with salon-platform |

### 3.2 Why extraction is self-hosted

Matching is superlinear in pool size. If every comparison and every intake is a metered API call, unit economics fail exactly when the product starts working. A 1.28 GB model on a VPS we already pay for has no marginal cost per match.

Secondary reason, equally real: a matchmaker holds people's professional histories. Those should not be shipped to a third-party inference provider as a matter of routine.

---

## 4. The data model

### 4.1 The match unit — OFFER ↔ NEED

Every participant is reduced to two things:

- **OFFER** — what their organization can do for another business
- **NEED** — what their organization wants from another business

A match is `A.offer` against `B.need` **and** `B.offer` against `A.need`. Both directions must fire. One direction is a lead, not a match, and v0.1 does not act on leads.

Both are drawn from **one shared controlled vocabulary**. This is deliberate: a shared enum makes matching a deterministic join rather than a vector-similarity guess, and it makes every match explainable in one sentence. The taxonomy *is* the matching engine.

### 4.2 OFFER comes from the document. NEED does not.

Measured across 40 extractions on 5 real profiles: `need_category` was `none` **35 times**.

This is correct behavior, not a model failure. A LinkedIn profile records what someone *did*. It does not record what they *want*. Nobody writes "seeking a fractional CFO" in their work history.

Therefore the need is **asked**, in CCME's first reply, as a single question. A stated need also carries a timestamp and live intent, which is worth more for matching than anything inferred from a résumé.

### 4.3 The qualifying gate

In testing, three of five real profiles belonged to **employees**, not businesses — a material handler at Tesla, a logistics manager at Zoox, a production control manager at Base Power.

An employee has a job, not an offer. Extracting `manufacturing_supply` from a Tesla material handler's profile is technically correct and commercially meaningless; Tesla will not take a meeting because someone matched their material handler.

CCME asks, before anything enters the graph, whether the person is here **on behalf of a business** or **as an individual**. Only the former enters the match graph. Individuals receive an honest note that CCME is not built for them yet.

### 4.4 Collections

See `docs/COLLECTIONS.md`. Summary:

`people` · `offers` · `needs` · `matches` · `intros` · `messages` · `extraction_runs`

Every node cites its causes via `caused_by`, so `TRACE caused_by` on an intro yields: intro → match → both offers and needs → both extraction runs → both inbound emails.

> Engine note, learned the hard way: the identity field is `_id`, not `id`, and `caused_by` goes at the **top level** of a put, not inside `doc`. A `caused_by` placed inside `doc` is stored as ordinary user data and creates no causal edge.

---

## 5. The email state machine

Full diagram in `docs/STATE_MACHINE.md`.

Triage is a **typed tool call**, not free-text classification. One tool, enum slots, an explicit `unknown` member. Intents:

`signup_with_attachment` · `signup_no_attachment` · `need_reply` · `intro_yes` · `intro_no` · `unsubscribe` · `delete_me` · `unknown`

`unknown` routes to a human queue. It does not guess. A matchmaker that confidently replies to a message it misread destroys the trust the entire product runs on, and the cost of a human glancing at an ambiguous email is approximately zero.

---

## 6. Model selection — the measurement behind the choice

Five real LinkedIn PDF exports, 34 chunks, 33 scoreable. One unit excluded: a donut shop, for which the taxonomy had no valid category — a defect in the taxonomy, not a model error, and excluded rather than scored as a miss.

| model | size | s/chunk | well-formed calls | evidence exact | category correct |
|---|---|---|---|---|---|
| imagine 0.8B v0.2.0 | 529 MB | 6.6 | 34/34 | 31/34 | 17/33 — 52% |
| **Qwen3.5-2B** | **1.28 GB** | **12.4** | **34/34** | **33/34** | **27/33 — 82%** |
| Qwen3.5-4B | 2.74 GB | 30.8 | 34/34 | 27/34 | 16/33 — 48% |

**All three produced 34/34 well-formed tool calls.** The mechanics are not in question at any size.

Two findings worth carrying forward:

1. **The 4B did not fail — it abstained.** All 17 of its misses were `offer_category: "none"`. Shown `Company: Tesla / Title: Production control Team Lead`, it declined to infer what Tesla sells, because the excerpt does not say. That is arguably the correct behavior for a product that promises receipts, and the scoring rubric punished it. The likely fix is context, not capacity: the profile headline and top-skills block are present in the PDF and the chunker currently discards them. This is an open question, not a settled one.

2. **Description length has an optimum at small scale.** A 2,269-character parameter description covering all 20 categories scored *worse* on the 0.8B (36%) than a 700-character one covering 8 (52%). More guidance is not monotonically better.

### 6.1 Honest limits of this measurement

- n = 5 profiles. Four are supply-chain professionals. This is a signal, not a benchmark.
- Ground-truth labels were written by the implementer, not a domain expert. Several "misses" are debatable — Edelman was labelled `accounting_finance` and the model said `consulting_strategy`; Edelman is a communications consultancy, so the model may be right.
- The taxonomy has a known hole (no food/hospitality) and a known fuzzy seam (manufacturing vs logistics), both scored generously on purpose.

---

## 7. Definition of done — gates

A gate is met only when it is demonstrated by a command anyone can run, producing output anyone can check. "It looked right" is not a gate.

### D1 — Consent invariants are enforced in code
- [ ] There is exactly one write path into `people`, and it requires a verified inbound sender address.
- [ ] A test CCs CCME on a thread with a synthetic third party; the third party appears nowhere in the graph and receives nothing.
- [ ] A test attempts to send to an address with no inbound history; the send is refused.

### D2 — Extraction is grounded
- [ ] Every stored capability carries an evidence span.
- [ ] The grounding grader passes its own fixtures in both directions (known-good passes, known-bad fails).
- [ ] Claims graded `INVENTED` never reach the match graph.

### D3 — Triage is honest
- [ ] Every intent enum is exercised by a fixture email.
- [ ] Ambiguous fixtures produce `unknown` and land in the human queue, not a guess.
- [ ] Triage asserts arguments, not just the tool name.

### D4 — Two-yes introductions
- [ ] No intro is emitted with fewer than two recorded affirmations.
- [ ] Silence from either side produces no intro and no follow-up beyond a single reminder.

### D5 — Receipts
- [ ] `TRACE caused_by` on any intro returns the full chain to both source emails.
- [ ] The plain-English reason shown to users is generated from stored evidence spans, never re-generated by a model at read time.

### D6 — Deliverability
- [ ] SPF, DKIM and DMARC pass on a real third-party inbox placement test.
- [ ] Outbound is rate-limited per address and globally capped.
- [ ] A single config flag halts all outbound sending.

### D7 — Data rights
- [ ] `unsubscribe` stops all outbound within one processing cycle.
- [ ] `delete_me` removes content and leaves only a tombstone.
- [ ] Every outbound message states how to do both.

---

## 8. Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| Intro emails land in spam | **Kills the product** | D6 before any real send; test placement, do not assume |
| Cold start — pool too small to match | **Kills the product** | Shareable OFFER card as the acquisition loop |
| Taxonomy too coarse for real industries | High | Known hole + known seam; expand from real intake, not imagination |
| A wrong match damages someone's reputation | High | Two-yes gate; show the reason before asking |
| Model misreads a thin profile | Medium | Abstain rather than guess; ask the human |

---

## 9. Out of scope for v0.1

Payments · public directory · profile editing UI · social channels · Netrows enrichment · any outbound to a person who has not written in first.

---

## 10. Open questions

1. Sending domain and address for the agent.
2. Does CCME reply to a CC'd thread at all, or only to direct mail? INV-2 governs membership; it does not settle whether CCME should speak in a thread where a third party can read it.
3. Whether the 4B's abstention is preferable to the 2B's inference once headline context is supplied (§6, finding 1).
4. Whether individuals get a waiting list or a flat "not yet".
