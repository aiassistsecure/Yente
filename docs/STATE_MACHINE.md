# CCME — email state machine

Written before any code, on purpose. If the states are wrong, the code is wrong.

---

## Person states

```
                    ┌──────────┐
                    │  UNKNOWN │   never written in; not in the graph
                    └────┬─────┘
                         │ sends mail to CCME
                         ▼
                  ┌──────────────┐
                  │  QUALIFYING  │   asked: business or individual?
                  └──┬────────┬──┘
        "individual" │        │ "business"
                     ▼        ▼
              ┌───────────┐  ┌──────────────┐
              │ DECLINED  │  │ AWAITING_DOC │  asked for LinkedIn PDF
              │ (honest   │  └──────┬───────┘
              │  note)    │         │ attachment received
              └───────────┘         ▼
                             ┌──────────────┐
                             │  EXTRACTED   │  offers stored w/ evidence
                             └──────┬───────┘
                                    │ reply: OFFER card + the one need question
                                    ▼
                            ┌────────────────┐
                            │ AWAITING_NEED  │
                            └───────┬────────┘
                                    │ need parsed
                                    ▼
                              ┌───────────┐
                              │  MATCHABLE│  in the graph, eligible
                              └─────┬─────┘
                                    │ unsubscribe / delete_me
                                    ▼
                              ┌───────────┐
                              │  DORMANT  │  no outbound, retained
                              └───────────┘
```

`DELETED` is terminal from any state: content removed, tombstone retained.

---

## Introduction states

A match is a node. An intro is a separate node with its own lifecycle, because a
match existing must never imply an intro happening.

```
   MATCH_FOUND
        │  ask side A: "want an intro to <B, described by evidence>?"
        ▼
   A_ASKED ──── A says no ──▶ CLOSED_DECLINED  (never re-ask this pair)
        │
        │ A says yes
        ▼
   B_ASKED ──── B says no ──▶ CLOSED_DECLINED  (A is told nothing about B's answer)
        │
        │ B says yes
        ▼
   INTRO_SENT   one thread, both parties, reason included
        │
        ▼
     CLOSED
```

### Rules

- **One reminder, then stop.** A non-answer is a no. No third message.
- **B learns nothing until A has said yes.** B is not told that A declined, and
  A is not told that B declined — only that it did not work out.
- **A declined pair is never re-proposed.** Repeatedly re-suggesting the same
  person is the behavior that makes matchmakers feel like spam.
- **The reason ships with the ask, not after.** The recipient decides using the
  same evidence CCME used.

---

## Triage — the entry point for every inbound message

One typed tool call per message. Enum slots, no free-text authoring, an explicit
`unknown` member with an escalation path.

| intent | trigger | action |
|---|---|---|
| `signup_with_attachment` | new sender, PDF attached | qualify → extract |
| `signup_no_attachment` | new sender, no PDF | reply asking for the export, with instructions |
| `qualify_reply` | sender in QUALIFYING | route to DECLINED or AWAITING_DOC |
| `need_reply` | sender in AWAITING_NEED | parse need → MATCHABLE |
| `intro_yes` | sender has an open ask | advance intro state |
| `intro_no` | sender has an open ask | CLOSED_DECLINED |
| `unsubscribe` | any | DORMANT, confirm once |
| `delete_me` | any | DELETED, confirm once |
| `unknown` | anything else | **human queue — do not reply** |

### Why `unknown` does not answer

A wrong-but-confident reply from a matchmaker is worse than a slow one. The cost
of a human glancing at an ambiguous email is near zero; the cost of telling
someone we understood them when we did not is the whole relationship.

This mirrors a measured finding from the extraction work: the larger model's
"failures" were nearly all abstentions rather than errors, and abstention was the
more trustworthy behavior. Same principle, applied to the inbox.

---

## Third parties (INV-2)

If a message has CCME in CC and other humans in To/CC:

1. CCME may act for **the sender**, who addressed it deliberately.
2. Every other participant is a third party. They are **not** enrolled,
   **not** extracted, **not** matched, and **not** emailed.
3. Whether CCME replies in-thread at all — where third parties would read it —
   is an open question in SPEC §10.2. Default until decided: **reply directly to
   the sender only**, never to the thread.
