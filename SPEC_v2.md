# Yente — Production Specification v2

*Parse professional evidence. Interview for intent. Match deterministically. Make the introduction. Step away.*

**Status:** active draft; implementation contract
**Canonical address:** `yente@ccme.network`
**Owner:** Interchained LLC
**Supersedes:** `SPEC.md` v0.3 for product behavior. The original specification and benchmark remain historical research.

---

## 1. Product definition

Yente is an inbound-first B2B introduction desk that operates through email.

People email Yente with a resume or whatever professional material best explains
who they are. Yente parses the supplied material, interviews them for whatever is
still missing, and builds an evidence-backed professional profile. When two
qualified members satisfy a deterministic matching policy, Yente privately
prepares each person for the proposed introduction. Unless either person vetoes
the match, Yente creates one useful shared email thread and steps away.

Yente does **not** schedule the conversation, create a video meeting, join a
meeting, negotiate on either person's behalf, or remain socially present in the
relationship it introduced.

### 1.1 The product sentence

> Email Yente what best explains who you are and what you are looking for. She
> will ask for anything missing and introduce you when there is a credible fit.

### 1.2 The core loop

```text
INBOUND
  -> PROFILE INTAKE
  -> INTERVIEW
  -> QUALIFIED
  -> DETERMINISTIC MATCH
  -> PRIVATE PREVIEWS
  -> VETO WINDOW
  -> CCME INTRODUCTION
  -> HANDOFF
```

### 1.3 The CCME wedge

The CCME wedge is the final handoff:

1. Yente sends one new email to both matched members.
2. The email introduces each person using a match-safe profile.
3. It explains the deterministic reason for the match.
4. It suggests a useful first conversation.
5. It asks them to reply-all and, if they want to meet, share a calendar link or
   propose times.
6. Yente explicitly steps away.

The output is a relevant, evidence-backed introduction in a useful shared email
thread. A booked meeting is not required for Yente to have completed its job.

---

## 2. Scope

### 2.1 In scope for the initial runtime

- Inbound email at `yente@ccme.network`.
- Threading and idempotent ingest.
- Resume-shaped professional profile construction.
- PDF, DOCX, plain-text, and email-body sources.
- LLM-assisted extraction with source evidence.
- LLM-led, multi-turn email interviews.
- Deterministic qualification.
- Deterministic member-to-opportunity matching.
- Employers as the first concrete opportunity type.
- Private match previews and veto processing.
- One joint CCME introduction email.
- Global stop, match-specific pass, corrections, and deletion requests.
- Provenance from an introduction back to profile facts and inbound sources.

### 2.2 Designed to extend later

The data model may later support introductions such as founder/investor,
operator/CEO, advisor/company, vendor/buyer, and strategic partners. These are not
implemented by weakening the first matching policy. Each new match type receives
its own explicit qualification and compatibility policy.

### 2.3 Explicitly out of scope

- Cold outbound email.
- Purchased contact lists.
- Calendar availability negotiation.
- Google Calendar, Google Meet, Zoom, or other meeting APIs.
- Yente joining or observing a meeting.
- Automated participation in the shared introduction thread.
- Web dashboard or member portal.
- Social-media automation.
- Public-web enrichment in the first runtime.
- Payments, subscriptions, or success fees.
- Vector databases or embedding-based matching.
- Redis, Kafka, RabbitMQ, or a separate job-queue service.
- Multi-agent orchestration.

These omissions are product boundaries, not unfinished integrations.

---

## 3. Vocabulary

**Member**
A person who has established an inbound relationship with Yente.

**Source**
An inbound email, resume, profile, deck, website supplied by the member, or an
interview answer.

**Profile fact**
A typed claim supported by evidence from a source. Examples include a role,
capability, industry, seniority level, geography, offer, need, or constraint.

**Resume-shaped profile**
The normalized professional profile Yente builds regardless of whether the member
sent a conventional full resume. A partial resume, LinkedIn export, bio,
portfolio, deck, email description, and interview answers can all contribute.

**Opportunity**
A typed need offered by an employer or other qualified member. The first runtime
implements employer opportunities.

**Qualification policy**
Deterministic requirements for a member or opportunity to become matchable.

**Match policy**
Deterministic hard gates, weights, and thresholds for one match type.

**Match-safe profile**
The minimal professional summary that may be disclosed to a proposed counterpart.
It never includes the raw resume, private source documents, protected fields, or
facts outside the allowed disclosure policy.

**Private preview**
A separate email to each side explaining the proposed match before contact details
are placed together in a shared thread.

**Veto**
A member's decision to stop one proposed match before introduction.

**Stop**
A global decision to receive no further Yente outbound email.

**Introduction**
The shared CCME email that completes Yente's workflow for a match.

---

## 4. Hard invariants

A change violating an invariant is a defect even if it improves a metric.

### INV-1 — Every recipient came inbound first

Yente sends no message to an address until that address has emailed Yente or has
replied to a Yente thread. Public availability of a business address does not
authorize outreach.

Private previews and introductions are delayed consequences of the member's
inbound request. Every outbound record must trace to that inbound relationship.

**The CC case.** A member may copy Yente on a thread that includes other people.
Those people did not write in, but they are participants on a thread Yente was
deliberately placed into by someone who chose to put them in the room. That
establishes a *thread relationship*, and a thread relationship authorizes
exactly one message: an `enrollment_invitation` under §5.4. It authorizes
nothing else — no profile, no matching, no preview, no introduction, and no
second message. The address becomes a member only by replying.

This is a narrow, enumerated exception and it is the only one. An address
obtained from a signature block, a forwarded thread Yente was not copied on, a
public directory, or any other source has no relationship and receives nothing.

### INV-2 — Triage precedes action

Every inbound message is deduplicated, associated with a thread and member, and
triaged before it can change workflow state or produce outbound email.

### INV-3 — Professional history and present intent are different

A resume establishes what a person has done. The inbound message and interview
establish what they want now. Yente never treats professional history as proof of
current intent.

### INV-4 — The LLM never decides the match

The LLM may extract typed facts, identify missing information, draft interview
questions, and write explanations from approved facts. Only deterministic code
may qualify members, calculate compatibility, create a proposed match, open or
close a veto window, or authorize a joint introduction.

### INV-5 — Every disclosed claim is evidenced

Every profile fact and every sentence in a match explanation must cite stored
evidence. Unsupported LLM output is rejected, not stored as truth.

### INV-6 — Raw sources remain private

Yente never sends one member another member's raw resume, attachment, private
email, or complete internal profile. Only a match-safe projection may be used in
a private preview or introduction.

### INV-7 — Either member can veto

Both members receive private previews before the CCME wedge. `PASS`, `STOP`, a
blocking correction, or deletion from either side prevents the joint
introduction. One side cannot override the other.

### INV-8 — Silence advances only inside a disclosed veto window

During intake, members are told that proposed matches receive a private preview
and will proceed after a defined period unless declined. Silence outside that
specific, pending preview state authorizes nothing.

### INV-9 — Stop means stop

`STOP`, `unsubscribe`, or an equivalent unambiguous request suppresses all future
outbound to the address before any other action. A match-specific `PASS` does not
globally stop the member.

### INV-10 — One pair, one introduction per match cycle

Retries, duplicate inbound messages, concurrent workers, and process restarts
must not create duplicate previews or introductions.

### INV-11 — Yente steps away

After the CCME introduction, Yente does not schedule, join, remind, mediate, or
automatically participate. A later direct request to Yente is a new inbound event.

### INV-12 — Cheap and operable beats impressive

The first runtime uses one process, one database, one mailbox, and local
inference. A new infrastructure dependency requires evidence that the existing
design cannot meet a demonstrated requirement.

### INV-13 — Sentinel Blocks at every boundary

Sentinel Blocks is a genesis dependency and Yente's canonical interchange
protocol. Prompt context, source material, extraction results, interview plans,
match explanations, private previews, introduction drafts, and inspectable test
artifacts are represented as named sentinel blocks.

The blocks carry information across boundaries; validated typed objects remain
the authority inside deterministic domain functions and NEDB.

---

## 5. Inbound and outbound policy

### 5.1 Allowed outbound classes

Only the following outbound purposes exist in the initial runtime:

| purpose | cause |
|---|---|
| `profile_request` | the member emailed without enough professional evidence |
| `interview_question` | a required profile or intent field is missing |
| `clarification` | supplied facts conflict or cannot be grounded |
| `private_match_preview` | deterministic match cleared all gates |
| `joint_introduction` | veto window cleared for both members |
| `stop_confirmation` | member requested global stop |
| `deletion_confirmation` | member requested deletion |
| `enrollment_invitation` | a member CC'd Yente on a thread including this address (§5.4) |

There are no newsletters, promotional sequences, cold introductions, or generic
"checking in" messages.

The list is closed. A purpose absent from this table cannot be enqueued, which
is what makes the previous sentence a property of the runtime rather than a
statement of intent.

### 5.2 First inbound behavior

The first inbound always begins intake.

If professional material is attached, Yente parses it before replying and asks
only for missing information. If no useful material is present, Yente asks for a
resume, LinkedIn export, portfolio, professional bio, deck, or a concise written
summary.

Example:

> Hi Alice — I can help with introductions. Please send whatever best explains
> your professional background: a resume, LinkedIn export, portfolio, deck, or a
> short summary. Also tell me whether you are primarily looking for employers,
> CEOs, investors, partners, or advisors.

### 5.3 Attachment boundary

The first runtime accepts:

- PDF containing extractable text.
- DOCX.
- UTF-8 plain text.
- Email body text.

The runtime does not execute macros, scripts, embedded files, or external
resources. Password-protected documents, images requiring OCR, unsupported file
types, and files over the configured size limit are rejected with a plain request
for an alternate format.

### 5.4 The enrollment invitation

The product is named after this mechanic. A member CCs `yente@ccme.network` on a
thread, and the other participants on that thread receive one invitation to
enroll. It is the acquisition loop, and it is the only outbound class addressed
to someone who has not written in.

Both of those facts point the same direction: it carries the most upside and all
of the domain risk, so it is the most tightly constrained message in the system.

**Trigger.** A member in good standing CC'd Yente on a thread on which the
address appears as a participant. The inviting member must exist, be non-stopped
and non-deleted. Yente being CC'd by a non-member triggers nothing.

**Exactly once per address, for the lifetime of the system.** The idempotency key
is the normalized address, not the thread and not the pair. A person surfaced on
six threads by four members receives one invitation, ever. A person who ignored
an invitation two years ago is not invited again.

**It discloses nothing.** No counterpart facts, no match, no profile content, no
attachment text, no quotation of the thread. It may name the member who CC'd
Yente, because that member chose to put the address in the room, and it may
state in general terms what Yente does. Nothing else about anyone.

**Silence is a no.** An ignored invitation never enrolls anybody and never
produces a second message. This is explicitly *not* an INV-8 veto window: no
deadline advances anything, because nothing was disclosed to be vetoed. The
absence of a reply is the end of the interaction.

**Enrollment happens on reply.** The address becomes a member by writing back,
at which point ordinary intake begins under §5.2 and INV-1 is satisfied in the
ordinary way.

**STOP is checked first.** Suppression is evaluated before the invitation is
composed, per INV-9. A previously stopped address is never invited, and an
unsubscribe in response is permanent.

**`List-Unsubscribe` is mandatory on this class.** Both the header (RFC 8058,
with `List-Unsubscribe-Post`) and a plain-language line in the body. Every other
class goes to a member who asked to be there; this one does not, and a
one-click, machine-readable opt-out is what separates an invitation from the
thing we said we would never build.

**Volume is capped.** Invitations are rate-limited per sending domain per day
independently of all other outbound, and the cap is configuration (§16). A
matchmaker whose invitations land in spam has no pool to match.

**Care is the requirement, not a nicety.** This email is written to be worth
opening: it names the person who thought of them, says plainly what Yente would
do for them, and offers one clear yes and one clear no. It is generated inside a
§11 output contract like every other class — the model fills approved slots and
does not author the message.

---

## 6. Profile construction and qualification

### 6.1 Profile dimensions

The normalized profile contains typed, independently evidenced fields:

```json
{
  "identity": {
    "display_name": "Bob Example",
    "primary_email": "bob@example.com"
  },
  "professional": {
    "roles": [],
    "industries": [],
    "capabilities": [],
    "seniority": null,
    "years_experience": null,
    "geographies": []
  },
  "intent": {
    "offers": [],
    "seeks": [],
    "introduction_types": [],
    "constraints": []
  },
  "readiness": {
    "evidence_complete": false,
    "intent_complete": false,
    "qualified": false
  }
}
```

Each value references one or more stored evidence IDs. The normalized profile is
a materialized view; evidence records remain the source of truth.

### 6.2 LLM extraction contract

The extraction model returns proposed facts with:

- field name;
- controlled value;
- source ID;
- exact evidence span;
- confidence;
- whether the value was explicit or inferred.

The runtime verifies that the span occurs in the referenced source. Inferred facts
may inform the next interview question but cannot satisfy qualification or appear
in a disclosed profile until the member confirms them.

### 6.3 Interview contract

The interview is conversational and written on the fly, but the interview plan is
deterministic:

1. Compute missing required fields for the active qualification policy.
2. Select at most two highest-priority missing fields.
3. Supply the LLM only approved context and the required questions.
4. Generate one natural email.
5. Validate the response contract before enqueueing it.

Yente does not ask for information already established by evidence unless it is
conflicting, stale, or ambiguous.

### 6.4 Qualification

Qualification is a pure function of the active policy and evidenced profile. The
LLM does not emit `qualified=true`.

The initial employer-match policy requires, at minimum:

- professional role or capability;
- at least one evidenced experience signal;
- current introduction type;
- current objective;
- applicable geography or remote preference;
- no global stop or deletion state.

Opportunity-side qualification requires a real inbound member, an evidenced need,
the kind of counterpart sought, applicable constraints, and an active state.

---

## 7. Deterministic matching

### 7.1 Matching inputs

The match engine reads only:

- evidenced profile facts;
- member-confirmed intent;
- opportunity requirements;
- configured hard exclusions;
- the versioned match policy;
- prior match decisions for the pair.

It does not read payment status, prose generated by the LLM, model confidence
alone, or private fields outside the policy.

### 7.2 Hard gates

A proposed match is impossible unless:

1. Both addresses have established inbound relationships.
2. Both members are active and qualified for the match type.
3. Neither member is stopped or deleted.
4. Both members are open to the counterpart category.
5. Every required hard constraint passes.
6. The pair has not already been introduced in the same cycle.
7. Neither member previously vetoed the pair in the same cycle.
8. Both directional scores meet their thresholds.

### 7.3 Bidirectional score

Every match policy defines two independently visible scores:

```text
member_fit      = how well the opportunity satisfies the member's stated need
opportunity_fit = how well the member satisfies the opportunity's requirements
```

Both must pass. A high score in one direction cannot compensate for failure in the
other. Each score is an integer sum of versioned rule contributions, and the match
record stores the complete breakdown.

The first implementation uses controlled values and explicit weights. It does not
use embeddings or model-generated similarity scores.

### 7.4 Stable explanation

Once a match is proposed, the runtime freezes:

- the policy version;
- both score breakdowns;
- the evidence IDs used;
- the match-safe projection for each side;
- a concise reason derived from those facts.

The LLM may turn that frozen material into natural prose, but it cannot add a new
reason or disclose a new fact.

---

## 8. Private preview and veto

### 8.1 Preview creation

Creating a match atomically creates two private preview jobs: one for each member.
They share one `match_id` but contain side-specific, match-safe context.

Each preview states:

- who Yente proposes to introduce;
- what that person or organization does;
- why the match cleared both directions;
- a useful first topic;
- the veto deadline;
- the available controls.

### 8.2 Controls

| member response | effect |
|---|---|
| `INTRODUCE` or clear approval | marks that side approved |
| `PASS` or clear match-specific decline | vetoes this match only |
| `CORRECT` or a blocking factual correction | pauses the match and returns the affected profile to intake |
| `STOP` or unsubscribe equivalent | globally stops the member and vetoes all pending matches |
| deletion request | deletes content under the deletion policy and vetoes all pending matches |

Ambiguous replies are escalated or clarified. They never advance the match.

### 8.3 Timing

The veto period is configuration, recorded on every match. The initial default is
48 hours.

- Two affirmative approvals may advance immediately.
- One approval and one silence wait until the deadline.
- Two silent members advance at the deadline.
- Any veto or blocking state prevents introduction.
- No reminder is sent in the initial runtime.

The deadline worker is idempotent. Re-running it cannot create a second
introduction.

---

## 9. Joint introduction and handoff

### 9.1 Introduction email contract

The joint email is a new thread sent from `yente@ccme.network` to both members. It
contains:

1. Both display names.
2. One match-safe summary per person.
3. The concise, evidenced reason for the introduction.
4. A suggested first discussion topic.
5. A request to reply-all.
6. A suggestion that one person share a calendar link or propose times if they
   want to meet.
7. A statement that Yente is stepping away.

Example shape:

> **Subject:** Yente introduction — Alice x Bob
>
> Hi Alice and Bob,
>
> I am connecting you because [evidence-backed reason].
>
> **Alice:** [match-safe summary].
> **Bob:** [match-safe summary].
>
> A useful place to start may be [approved discussion topic]. If a conversation
> makes sense, reply-all and one of you can share a calendar link or suggest a
> couple of times.
>
> I will step out here and let you take it forward.
>
> — Yente

### 9.2 After sending

The introduction transitions to `INTRODUCED` only after the outbox records a
successful SMTP handoff. The exact RFC `Message-ID` is stored.

Reply-all messages may return to Yente because she originated the thread. They are
ingested for threading and stop/delete handling, but Yente sends no automatic
response unless a participant directly asks Yente to do something within scope.

There is no automated follow-up in the initial runtime.

---

## 10. State machines

### 10.1 Member

```text
NEW
 -> NEEDS_PROFILE
 -> INTERVIEWING
 -> QUALIFIED
 -> ACTIVE

Any nonterminal state -> STOPPED
Any state -> DELETED
```

`NEEDS_PROFILE` and `INTERVIEWING` may alternate as new match types require new
information. Qualification is scoped to a policy; it is not a permanent judgment
about the person.

### 10.2 Match

```text
PROPOSED
 -> PREVIEWS_QUEUED
 -> VETO_WINDOW
 -> READY_TO_INTRODUCE
 -> INTRODUCTION_QUEUED
 -> INTRODUCED
```

Terminal alternatives:

- `VETOED`
- `INVALIDATED_BY_CORRECTION`
- `CANCELLED_BY_STOP`
- `CANCELLED_BY_DELETION`
- `DELIVERY_FAILED`

### 10.3 Outbox

```text
PENDING -> SENDING -> SENT
                  \-> RETRY_WAIT -> SENDING
                  \-> DEAD
```

Outbox retries use bounded exponential backoff with jitter. An idempotency key is
unique per intended email, not per send attempt.

---

## 11. Sentinel Blocks and the LLM

### 11.1 Foundation

Yente depends on `sentinel-blocks` from the first executable slice. An adapter
calls a local OpenAI-compatible inference endpoint and converts model output into
validated commands or email content.

Sentinel Blocks is used for both model input and model output. Templates are
contracts containing approved block placeholders and required content; the LLM
supplies natural language inside that contract.

The deterministic core never accepts raw model prose. Boundary code extracts and
validates blocks first, then calls domain functions with ordinary typed objects.
NEDB stores those validated objects, their original block artifact, and the causal
link between them.

### 11.2 Prompt-context contract

Every model request is assembled from explicit blocks. A resume-extraction prompt,
for example, receives:

```text
<<<TASK>>>
Extract evidenced professional facts from this source.
<<<END>>>

<<<SOURCE source_123>>>
...verbatim extracted resume text...
<<<END>>>

<<<CONTROLLED_VOCABULARY>>>
{"capabilities":[...],"industries":[...]}
<<<END>>>

<<<OUTPUT_CONTRACT>>>
Return exactly one PROFILE_FACTS block.
<<<END>>>
```

Interview generation, private previews, and introductions follow the same shape:
task, approved facts, policy, required content, forbidden content, and output
contract each receive their own block. Context is never concatenated into one
ambiguous prose blob.

### 11.3 Email-generation response

```text
<<<META>>>
{"template":"private_match_preview","facts_used":["fact_1","fact_9"]}
<<<END>>>

<<<SUBJECT>>>
A potential introduction from Yente
<<<END>>>

<<<EMAIL_TEXT>>>
Hi Alice — I found someone whose background...
<<<END>>>
```

The runtime requires exactly one `META`, `SUBJECT`, and `EMAIL_TEXT` block. It
rejects unknown fact IDs, forbidden disclosures, empty blocks, additional
recipients, or subject/body content outside configured limits.

### 11.4 Profile-extraction response

```text
<<<PROFILE_FACTS>>>
{
  "facts": [
    {
      "field": "professional.capabilities",
      "value": "infrastructure_operations",
      "source_id": "source_123",
      "evidence": "Led infrastructure operations for...",
      "confidence": "certain",
      "explicit": true
    }
  ]
}
<<<END>>>
```

Sentinel extraction is not validation. JSON schema, controlled vocabulary,
evidence grounding, and state authorization remain runtime responsibilities.

### 11.5 Canonical block tags

The initial registry is closed and versioned:

| tag | content |
|---|---|
| `TASK` | one bounded instruction |
| `SOURCE <id>` | verbatim source text |
| `PROFILE` | validated match-safe profile JSON |
| `PROFILE_FACTS` | proposed evidenced fact JSON |
| `MISSING_FIELDS` | deterministic interview requirements |
| `INTERVIEW_PLAN` | validated question plan JSON |
| `MATCH` | frozen match and score breakdown JSON |
| `POLICY` | relevant policy JSON |
| `META` | template, version, and fact IDs used |
| `SUBJECT` | email subject text |
| `EMAIL_TEXT` | plain-text email body |
| `OUTPUT_CONTRACT` | required response blocks |

Unknown tags are rejected at command boundaries unless the active protocol
version explicitly permits them.

### 11.6 Failure behavior

- Invalid blocks are never sent.
- Extraction may retry once with the validation error.
- Email generation may retry once.
- If the second attempt fails, the job becomes reviewable or uses a deterministic
  fallback template where one exists.
- The runtime never fabricates a profile fact or silently substitutes mock data.

---

## 12. Storage

NEDB is the sole application database. The following are logical collections;
exact physical partitioning may change without changing their contracts.

| collection | purpose |
|---|---|
| `messages` | inbound and outbound email envelope, thread, and delivery metadata |
| `members` | identity, lifecycle state, and global suppression state |
| `sources` | attachment/email metadata and extracted text references |
| `profile_facts` | typed value, evidence span, source, confirmation state |
| `profile_views` | rebuildable normalized member profiles |
| `opportunities` | evidenced employer or counterpart needs |
| `match_policies` | immutable, versioned hard gates, weights, and thresholds |
| `matches` | pair, policy version, score breakdown, frozen disclosure projections |
| `preview_decisions` | per-member preview delivery and decision state |
| `introductions` | joint email state and RFC Message-ID |
| `outbox` | durable outbound jobs, retries, and idempotency keys |

Every derived record carries causal links to its inputs. A completed introduction
must trace to the match policy, both profiles, their evidence, and the inbound
relationships that permitted outbound.

### 12.1 Required uniqueness

- Inbound RFC `Message-ID`.
- Member primary normalized email.
- Source content hash within a member.
- Match idempotency key: policy version + ordered member pair + match cycle.
- Private preview idempotency key: match + recipient.
- Introduction idempotency key: match.
- Enrollment invitation idempotency key: normalized address, system-wide and for
  the lifetime of the system (§5.4).
- Outbox idempotency key.

---

## 13. Minimal runtime architecture

One long-running Node.js 24 process contains:

```text
mail adapter
  -> Sentinel Blocks protocol
  -> ingest/triage
  -> source extraction
  -> profile/interview service
  -> deterministic qualification and matching
  -> preview/veto workflow
  -> introduction service
  -> durable outbox
```

External services are limited to:

- the existing mailbox over IMAP/SMTP;
- the existing NEDB daemon;
- the existing local OpenAI-compatible model endpoint.

The domain core uses Node's standard library, the `sentinel-blocks` protocol
package, and Node's built-in test runner. Protocol adapters may add a small number
of focused dependencies only when their slice is implemented.

---

## 14. Definition of done

### D1 — Inbound intake

- [ ] A duplicate RFC `Message-ID` changes state exactly once.
- [ ] A first inbound creates the member and begins intake.
- [ ] A supported attachment is extracted and causally linked.
- [ ] No-document inbound produces one useful request for professional material.
- [ ] Unsupported or unsafe attachments are rejected without execution.

### D1a — Enrollment invitation

- [ ] A CC'd address receives exactly one invitation, ever, across every thread
      and every inviting member.
- [ ] A previously stopped or deleted address receives none.
- [ ] A CC from a non-member triggers none.
- [ ] The invitation discloses no counterpart facts, profile content, or thread
      text.
- [ ] Ignoring an invitation produces no second message and enrolls nobody.
- [ ] The invitation carries a `List-Unsubscribe` header and a body opt-out.
- [ ] Replying begins ordinary intake under §5.2.

### D2 — Profile and interview

- [ ] Extracted facts cite exact spans in stored sources.
- [ ] An invented or ungrounded span is rejected.
- [ ] Explicit facts pre-fill the interview.
- [ ] Inferred facts become questions, not qualification facts.
- [ ] The interview asks no more than two targeted questions per email.
- [ ] Qualification is decided by code under a versioned policy.

### D3 — Deterministic matching

- [ ] The same inputs and policy version always return the same score breakdown.
- [ ] Both directional thresholds must pass.
- [ ] A hard constraint cannot be outweighed by soft points.
- [ ] An LLM completion cannot create or approve a match.
- [ ] A previously vetoed pair is not recreated in the same cycle.

### D4 — Private previews

- [ ] Both members receive separate, match-safe previews.
- [ ] The raw resume and private source text are never disclosed.
- [ ] `PASS` vetoes one match only.
- [ ] `STOP` suppresses all pending and future outbound.
- [ ] A blocking correction pauses and invalidates the current match.
- [ ] Ambiguous replies cannot advance the workflow.

### D5 — Veto window

- [ ] Two approvals may advance immediately.
- [ ] Silence advances only after the recorded deadline.
- [ ] Either member's veto prevents introduction.
- [ ] Concurrent deadline workers create at most one introduction job.

### D6 — CCME introduction

- [ ] One email is addressed to both matched members.
- [ ] It includes only approved match-safe facts and the frozen match reason.
- [ ] It asks them to reply-all and encourages a meeting without scheduling it.
- [ ] The successful RFC `Message-ID` is recorded.
- [ ] Yente performs no automatic follow-up or meeting action.

### D7 — Reliability and rights

- [ ] Every outbound class traces to an inbound relationship.
- [ ] Outbox retries cannot duplicate a delivered email.
- [ ] Restarting during any state transition is safe.
- [ ] Stop is enforced before any lower-priority intent.
- [ ] Deletion removes content according to the deletion policy.
- [ ] One configuration flag halts all outbound sending.

### D8 — End-to-end acceptance

Given:

- Bob emails Yente with professional material and completes the interview.
- An employer member has previously emailed Yente with an evidenced need.
- Both qualify under the same active match policy.

Then:

1. The deterministic engine produces a bidirectional match with a score breakdown.
2. Bob and the employer receive separate private previews.
3. Neither vetoes before the deadline.
4. Exactly one shared introduction email is sent to both.
5. The introduction encourages them to reply-all and arrange a meeting themselves.
6. Yente records the handoff and does nothing further without new inbound.

---

## 15. Build order

1. Sentinel Blocks protocol registry, codecs, and contract tests.
2. Pure domain types and state transitions expressed through that protocol.
3. Deterministic qualification and matching.
4. Preview decisions, veto deadline, and introduction authorization.
5. Durable NEDB repositories and outbox.
6. Streaming LLM adapter and email-generation contracts.
7. Resume/source extraction.
8. IMAP ingest and SMTP delivery.
9. End-to-end fixtures against a local model and test mailbox.

Each step must be demonstrable before the next integration is allowed to obscure
it.

---

## 16. Configuration decisions still open

These values are configuration, not architecture:

1. Final veto-window duration; v2 assumes 48 hours.
2. Maximum accepted attachment size.
3. Initial controlled vocabulary for employer matching.
4. Initial score weights and bidirectional thresholds.
5. Whether two explicit approvals introduce immediately or still wait a short
   courtesy interval.
6. Daily cap on enrollment invitations per sending domain (§5.4).

Everything else in this specification is the v2 product boundary.
