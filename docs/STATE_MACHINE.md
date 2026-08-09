# CCME — state machines

Written before any code, on purpose. If the states are wrong, the code is wrong.

Three machines run concurrently: **person**, **proposal**, **meeting**. They are
separate because a match existing must never imply a proposal, and a proposal
being sent must never imply a meeting.

---

## 1. Person

A person carries their population as a role, and can hold both roles at once — a
hedge fund partner is a member when hiring and a candidate when raising. Each
role runs its own instance of this machine.

```
                     ┌──────────┐
                     │   NEW    │  first seen: wrote in, or was CC'd
                     └────┬─────┘
                          │ triage assigns population
                          ▼
                  ┌────────────────┐
                  │  INTERVIEWING  │  multi-turn, 1–2 questions per message
                  └───┬────────┬───┘
         below        │        │  interview complete + above threshold
         threshold    │        │
                      ▼        ▼
             ┌──────────────┐  ┌──────────┐
             │  INCOMPLETE  │  │  ACTIVE  │  eligible for matching
             │ (told what's │  └────┬─────┘
             │  missing)    │       │
             └──────────────┘       │ unsubscribe
                                    ▼
                              ┌───────────┐
                              │  STOPPED  │  no outbound, ever, permanently
                              └───────────┘
```

`DELETED` is terminal from any state: content removed, tombstone retained.

**INCOMPLETE is not a failure state.** It is the honest outcome of a thin
interview, and the person is told plainly what is still needed. Guessing past it
would violate INV-3 downstream.

---

## 2. Proposal

One proposal occupies one of a member's 2–5 slots for its entire life.

```
        match scored, both directions fire, above threshold
                          │
                          │  slot available?  ──no──▶ QUEUED (not sent)
                          ▼
                   ┌─────────────┐
                   │  PROPOSED   │  member sees candidate + reason + evidence
                   └──┬───┬───┬──┘
        member passes │   │   │ member interested
                      │   │   │
       ┌──────────────┘   │   └──────────────┐
       ▼                  │                  ▼
  DECLINED_MEMBER         │          ┌────────────────┐
                          │          │ CANDIDATE_ASKED│  availability requested
             no response  │          └───┬────────┬───┘
             by N days    │   candidate  │        │ candidate confirms
                          ▼    passes    ▼        ▼
                      EXPIRED        DECLINED_  ┌──────────────┐
                   (one reminder     CANDIDATE  │ INVITE_SENT  │
                    at midpoint)                └──────┬───────┘
                                                       │
                                                       ▼
                                              (see meeting machine)
```

**Every terminal state reopens the slot**, whichever arrives first:
`DECLINED_MEMBER` · `DECLINED_CANDIDATE` · `EXPIRED` · and all meeting terminals.

### Rules

- **One reminder, at the midpoint of N.** Then expire. No third message.
- **A queued match is not a sent proposal.** Queued matches age out and are
  re-scored rather than sat on — a fit that was true a month ago may not be.
- **A pass is never re-proposed within the same cycle.** Re-suggesting a rejected
  candidate is the behavior that makes a desk feel like spam.
- **The reason ships with the proposal, not after.** The member decides using the
  same evidence CCME used.

---

## 3. Meeting

```
   INVITE_SENT  ──▶ Google Calendar event created, Meet link attached,
        │            both parties invited
        │
        ├── either declines ──────────▶ MEETING_DECLINED ──┐
        │                                                   │
        ├── reschedule requested ──▶ RESCHEDULING ──┐       │
        │                                  │        │       │
        │        ◀─────────────────────────┘        │       │
        │                                           │       │
        └── both accept ──▶ SCHEDULED ──────────────┘       │
                                 │                          │
                    ┌────────────┴────────────┐             │
                    ▼                         ▼             │
              MEETING_COMPLETED          NO_SHOW ───────────┤
                    │                                       │
                    ▼                                       ▼
                 OUTCOME RECORDED  ────────▶  slot reopens (all paths)
```

`RESCHEDULING` does **not** reopen the slot — the proposal is still live. Only
terminal states do.

**Outcomes are the feedback signal.** Accepted invites and completed meetings are
what tell the match engine it was right. They are recorded against the match, with
causal links back to both interviews, so quality can be measured over time rather
than asserted.

---

## 4. Triage — the entry point for every inbound message

One typed tool call per message, before any other logic (INV-1). It answers: who,
which population, what state, what intent.

| intent | condition | action |
|---|---|---|
| `new_inbound` | sender unknown | enroll, assign population, start interview |
| `interview_answer` | sender INTERVIEWING | advance interview |
| `proposal_interested` | member has live proposal | → CANDIDATE_ASKED |
| `proposal_pass` | member has live proposal | → DECLINED_MEMBER, reopen slot |
| `candidate_available` | candidate was asked | → INVITE_SENT |
| `invite_response` | invite outstanding | accept / decline / reschedule |
| `reschedule_request` | meeting scheduled | → RESCHEDULING |
| `unsubscribe` | any | → STOPPED (INV-5) |
| `delete_me` | any | → DELETED (INV-7) |
| `question_or_other` | any | answer if answerable, else escalate |
| `unknown` | anything else | **escalate — do not reply** |

### Why `unknown` does not answer

A confidently wrong reply from a matchmaking desk costs more than a slow one, and
a human glance at an ambiguous email costs near zero.

This mirrors a measured finding: in model testing the larger model's "failures"
were almost entirely abstentions rather than errors, and abstention proved the
more trustworthy behavior. Same principle, applied to the inbox.

---

## 5. CC handling

When a member CCs CCME on a thread with other participants:

1. Each other participant is enrolled as a **candidate** (`NEW`), with provenance
   recording the thread and the member who surfaced them.
2. CCME may email them to begin an interview — this is the intended mechanic.
3. Their enrollment is subject to every ordinary rule: unsubscribe, deletion, the
   confidence threshold, and the slot cap of whichever member they are matched to.
