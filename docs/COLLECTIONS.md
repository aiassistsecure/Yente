# Yente — NEDB collections

Database: `yente` on nedbd.

Engine notes that cost real debugging time elsewhere, recorded so they are not
rediscovered:

- The identity field is **`_id`**, not `id`. `WHERE id = "..."` matches nothing and
  returns zero rows, which reads like a broken query rather than a typo.
- **`caused_by` goes at the top level of a put**, not inside `doc`. Placed inside
  `doc` it is stored as ordinary user data and creates **no causal edge**.
- **`caused_by` must be HASH STRINGS on the v2 DAG engine, not seqs.** Verified
  against a live nedbd 2.8.2: passing the integer `seq` from a put response
  silently creates **no edge** — `_caused_by` comes back `None` and
  `TRACE caused_by` returns only the starting row, which reads exactly like
  "TRACE is broken." Read the parent's `_hash` and pass that instead.
  Note the shipped Python client types the argument `caused_by: List[int]`,
  which is the **v1** signature; it will accept ints and quietly do nothing.
- The `seq` in a put response is a **global** counter; the `_seq` on a stored
  row is per-collection. They are different numbers and are easy to confuse.

Proven working shape, end to end:

```python
from nedb.client import NedbClient
c = NedbClient("http://127.0.0.1:7070", db="yente")

c.put("messages", "m1", {...})
h = c.get_doc("messages", "m1")["_hash"]          # the parent's hash
c.put("roles", "r1", {...}, caused_by=[h])        # top level, hash string

c.query('FROM interviews WHERE _id = "i1" TRACE caused_by')
# -> [interviews i1, roles r1, messages m1]
```

---

## `messages`
Every inbound and outbound email. The audit spine.

| field | type | notes |
|---|---|---|
| `direction` | enum | `inbound` \| `outbound` |
| `address` | string | counterparty, lowercased |
| `message_id` / `in_reply_to` | string | RFC 5322 threading |
| `subject` | string | |
| `body_text` | string | plain text; HTML stripped on ingest |
| `has_attachment` | bool | |
| `cc_addresses` | array | drives CC enrollment (SPEC §2.2) |
| `triage_intent` | enum | null for outbound |
| `triage_confidence` | number | |

`caused_by`: for outbound, the inbound message that prompted it.

---

## `people`
One record per human. **Roles are separate from the person** — the same person can
be a founder in one relationship and an investor in another.

| field | type | notes |
|---|---|---|
| `address` | string | primary key in practice |
| `display_name` | string | |
| `org_name` | string | |
| `stopped_at` | date | INV-5; blocks all outbound when set |
| `deleted_at` | date | INV-9 |
| `founding_seat_no` | number | 1–5,000 **within a cohort**; founding membership entitlement; **never read during matching** |
| `contribution_state` | enum | `none` \| `contributing`; **never read during matching (INV-7)** |

`caused_by`: the message that first surfaced them.

---

## `subscribers`

The public Founding Network waitlist. A subscriber is an explicit inbound
request, but does not become matchable until the ordinary evidence, interview,
qualification, and activation gates are complete.

| field | type | notes |
|---|---|---|
| `_id` | string | `sub_` + SHA-256 of normalized email; retries are idempotent without exposing the address in the key |
| `email` / `name` | string | normalized contact and display name |
| `cohort` | enum | `founder_developer` \| `investor_employer` |
| `intent` | string | optional user-stated introduction goal |
| `status` | enum | `waiting` \| `qualified` \| `active` \| `stopped` \| `deleted` |
| `consent` / `consent_version` | bool/string | exact consent contract accepted at submission |
| `inbound_established_at` | date | establishes INV-1 for this address |
| `created_at` / `updated_at` | date | first request and latest revision |
| `revision` | number | increments when the same address updates its request |
| `caused_by_event_id` / `caused_by_event_hash` | string | receipt for the inbound event stored in the same Merkle DAG |

Only `waiting`, `qualified`, and `active` records consume one of the 5,000
places in their cohort. Matching never reads founding order, seat count, or
pricing entitlement.

---

## `subscription_events`

Inbound receipts for the public form. Each event records the event type,
subscriber id, cohort, source, consent version, and occurrence time. Every
subscriber version stores the event hash in NEDB's native `caused_by` field, so
`TRACE caused_by` walks from the current subscriber projection to the inbound
request that produced it. Document versions and events are persisted in the
same embedded NEDB v2 content-addressed DAG.

---

## `roles`
A person's participation as a founder, an investor, or a builder. One person may
hold several.

| field | type | notes |
|---|---|---|
| `person_address` | string | |
| `role` | enum | `founder` \| `investor` \| `builder` |
| `state` | enum | see STATE_MACHINE.md §1 |
| `investor_kind` | enum | `angel` \| `vc` \| `fund` \| `other` — null for founders |
| `sourced_by` | string | for CC-enrolled people, who surfaced them |
| `slot_cap` | number | 2–5, default 3 |
| `timeout_days` | number | default 7 |

`caused_by`: the message that created the role.

---

## `interviews`
The stated side of the join. Both sides are interviewed (SPEC §8).

| field | type | notes |
|---|---|---|
| `role_id` | string | |
| `state` | enum | `open` \| `complete` \| `incomplete` |
| `turns` | array | question/answer pairs, each citing a message |
| `ideal_profile` | object | the typed result — founder profile, or investor thesis |
| `confidence` | number | below threshold ⇒ `incomplete`, excluded from matching |

`caused_by`: every inbound message that contributed an answer.

---

## `attributes`
Extracted capability, traction and intent. **Never sensitive attributes** (INV-8).

| field | type | notes |
|---|---|---|
| `role_id` | string | |
| `kind` | enum | `capability` \| `intent` |
| `category` | enum | the shared vocabulary |
| `evidence` | string | span copied from source |
| `grounding` | enum | `exact` \| `fuzzy` \| `INVENTED` |
| `source` | enum | `document` \| `interview` |

**Rows graded `INVENTED` are stored and never matched.** Keeping them measures
drift over time; matching them would mean lying to someone.

**No sensitive attribute or proxy is ever written here.** A CI linter enforces it
against both the taxonomy and the extraction schema (D5).

`caused_by`: the extraction run or the interview turn.

---

## `matches`
Computed, scored, both directions required.

| field | type | notes |
|---|---|---|
| `recipient_role_id` / `subject_role_id` | string | who receives the proposal, who it is about |
| `score` | number | |
| `above_threshold` | bool | false ⇒ never proposed (INV-3) |
| `reason` | string | plain English, built from stored evidence spans |
| `scored_at` | date | queued matches age out and are re-scored |

`caused_by`: both interviews and the contributing attributes.

The `reason` is generated **once, at match time, from stored spans** — never
re-generated by a model at read time. Two people must never see different
explanations for the same meeting.

---

## `proposals`
Occupies a slot for its entire life. Separate from `matches` because a match
existing must never imply a proposal.

| field | type | notes |
|---|---|---|
| `match_id` | string | |
| `recipient_role_id` | string | the slot owner |
| `state` | enum | see STATE_MACHINE.md §2 |
| `proposed_at` | date | slot occupied from here |
| `reminded_at` | date | at most one, at midpoint of N |
| `terminal_state` | enum | which outcome reopened the slot |
| `closed_at` | date | slot released |

`caused_by`: the match, plus the messages carrying each party's answer.

### The slot query
Live proposals for a person are those with `closed_at` unset. The cap (INV-2) is
asserted inside the proposal function against this query, under a lock, so a
concurrency race cannot exceed it (D3).

---

## `meetings`

| field | type | notes |
|---|---|---|
| `proposal_id` | string | |
| `gcal_event_id` | string | Google Calendar event |
| `meet_url` | string | |
| `scheduled_for` | date | |
| `state` | enum | see STATE_MACHINE.md §3 |
| `outcome_note` | string | optional, from either party |

`caused_by`: the proposal, plus both acceptance messages.

---

## `extraction_runs`
Provenance for the model itself.

| field | type | notes |
|---|---|---|
| `model` | string | e.g. `Qwen3.5-2B-Q4_K_M` |
| `model_sha256` | string | the actual file hash |
| `schema_version` | string | |
| `chunk_count` / `well_formed` / `invented_count` | number | |

Recording the model hash means *"why did Yente think that in March?"* is
answerable with `AS OF`, including which weights were running.

---

## The receipt

```
TRACE caused_by starting at a meeting:

  meeting ─▶ proposal ─▶ match ─┬▶ recipient interview ─▶ inbound messages
                                ├▶ the other interview  ─▶ inbound messages
                                └▶ attributes ─▶ extraction_run ─▶ the PDF they sent
```

Every booked meeting resolves to the literal sentences, in whose email or
document, on what date, under which model weights, that caused two people to
meet.
