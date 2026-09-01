# Yente

**Inbound-first professional introductions by email.**

> Email `yente@ccme.network`. Yente gathers enough professional evidence to
> understand who you are, interviews for what is missing, and only then considers
> an introduction.

Yente turns resume-shaped evidence into careful B2B introductions:

1. A person emails Yente.
2. Yente asks for a resume or equivalent professional information.
3. An LLM extracts evidenced facts and conducts the interview.
4. Deterministic policy qualifies people and scores potential matches.
5. Each party privately receives a match-safe preview and may approve, pass,
   correct the record, stop, or request deletion.
6. If neither party stops the process during the veto window, Yente sends one
   joint CCME introduction and steps out.

Yente does not cold-email strangers, schedule meetings, create calendar events,
or join calls. The introduced people choose whether and how to meet; the final
email simply asks them to reply-all and share a calendar link or a few times.

## Design boundary

The LLM may read evidence, extract candidate facts, choose interview questions,
and write natural email prose. It may not decide qualification, compute match
scores, advance workflow state, override consent, or send mail.

Those decisions live in deterministic code and produce inspectable reason codes.
Outbound mail is permitted only as a direct consequence of an inbound
relationship or an already-authorized match workflow.

## Sentinel Blocks from genesis

[`sentinel-blocks`](https://github.com/Eth-Interchained/sentinel-blocks) is the
protocol for every untrusted boundary: prompt inputs, model outputs, extracted
profile facts, match explanations, and generated email artifacts. The protocol
uses a closed block-tag registry and rejects unknown, missing, or duplicate
contract blocks before content can reach workflow logic.

Inside the deterministic core, data remains typed JavaScript objects so policy
cannot be hidden in prose.

## Current status

**Running desk.** Phase 1a shipped the deterministic genesis core — the v2
contract in [`SPEC_v2.md`](SPEC_v2.md), Sentinel Block protocol helpers,
evidenced qualification, deterministic match scoring with hard gates, the
private-preview / veto-window / joint-introduction state machine, and the
executable tests that pin all of it. Everything the genesis README said was
"not yet" built has since been built, and it runs in production as **one
process** (`node bin/yente.mjs`):

- **Mailbox adapter** — a single IMAP read path (imapflow, durable UID
  cursor, UIDVALIDITY handling) feeds an append-only, content-addressed
  **evidence ledger**; the desk consumes the ledger rather than racing for
  the inbox. Attachments are parsed in-process (PDF via unpdf, DOCX via
  mammoth).
- **LLM adapter, two seats** — `YENTE_MODEL_DOCUMENT` reads evidence
  (extraction, observation, span-verified grounding), `YENTE_MODEL_MESSAGE`
  is the voice: it composes conversational replies and writes the joint
  introduction itself. Every generated email passes a disclosure guard
  (closed template set, no un-authorised addresses, no raw source quotes)
  and degrades to a deterministic letter — never to silence. Local models
  over an OpenAI-style endpoint are first-class; see
  [`docs/PROVIDERS.md`](docs/PROVIDERS.md).
- **Understanding pipeline** — models answer in Sentinel observation
  envelopes, one JSON claim per line, each claim span-verified against the
  source before it can enter the graph. Partly-verified answers get a graded
  RESULTS round (accepted claims banked, rejections returned with parser
  reason codes) instead of a blind retry.
- **Supervisor lanes** — the main thread owns the stores and dispatches
  model work to worker-thread pools, sized per seat with
  `YENTE_INGEST_WORKERS` / `YENTE_VOICE_WORKERS` (0 keeps a seat
  in-process). A crashed lane costs one attempt of one task, never data.
- **Durable outbox** — every outbound letter is queued with an idempotency
  key and drained separately, so a crash between deciding and sending leaves
  a durable job, and reboots settle any owed replies exactly once.
- **Matching, always on** — the connect loop scores the graph continuously
  (intent × complementary intent, and graded candidates answering live
  hiring/investing asks), auto-qualifies members the graph can stand behind
  (`YENTE_AUTOQUALIFY=0` restores the operator-driven lifecycle), and queues
  introduction candidates for human review.
- **Operator manager** — a private web console with the full dossier per
  person (every claim with its quote and source, proposal grades, lifecycle
  controls, match review), plus a status tape that reports the standing
  match tally, per-tick extraction outcomes, and send failures.
- **Public résumé directory** — an identity-resolved, searchable directory
  of evidenced profiles at `/directory` on the landing page, built from pure
  store reads. No email addresses are ever rendered.

The earlier founder/investor design remains in [`SPEC.md`](SPEC.md) as
historical context; v2 is the active contract. Operational references live in
[`docs/`](docs/): collections, polling, providers, and the state machine.

## Public Founding Network

Yente includes a VPS-ready public landing page and waitlist slice:

- free founding membership for 5,000 founders/developers and 5,000
  investors/employers;
- a consented subscriber form persisted in an embedded, filesystem-backed NEDB
  v2 DAG;
- live public capacity counters polled every 10 seconds;
- idempotent subscription updates keyed by normalized email;
- a `.env`-protected subscriber desk at `/admin/`; and
- spreadsheet-safe CSV export.

The waitlist is an inbound request, not automatic qualification. A subscriber
still needs professional evidence, interview completion, deterministic
qualification, and activation before entering the match engine.

Configure from [`.env.example`](.env.example), then run:

```sh
set -a
source .env
set +a
npm start
```

`YENTE_WAITLIST_DATA_PATH` names the waitlist's dedicated embedded NEDB
directory. It must not reuse Yente's core database path.

See [`docs/VPS_DEPLOY.md`](docs/VPS_DEPLOY.md) for systemd, nginx, TLS, storage,
and operations.

## Run the core

Requires Node.js 24 or newer.

```sh
npm install
npm test
```

## Run Yente

One process, everything she is — desk, listener, understanding, matching, and
the web surfaces on one port (the operator manager on its own):

```sh
set -a; source .env; set +a
node bin/yente.mjs
```

The halves still run alone when you want them to: `bin/daemon.mjs` (desk
only), `bin/graph.mjs` (listener/graph only), plus `bin/inspect.mjs`,
`bin/extract-once.mjs`, and `bin/observe-once.mjs` for reading and replaying
without a running desk. Key environment:

```sh
YENTE_MODEL_DOCUMENT=…    # the model that reads evidence
YENTE_MODEL_MESSAGE=…     # the model that writes to people (defaults to document)
YENTE_INGEST_WORKERS=2    # document-seat worker lanes (0 = in-process)
YENTE_VOICE_WORKERS=1     # voice-seat worker lanes (0 = in-process)
YENTE_AUTOQUALIFY=1       # graph-driven qualification (0 = operator-driven)
```

See [`.env.example`](.env.example) for the full set.

## Licence

Code is BUSL-1.1 with a Change Date of 2030-08-09, converting to Apache-2.0.
Third-party packages and model weights retain their upstream licences.

Built by [Interchained LLC](https://interchained.org).
