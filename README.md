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

**Phase 1a — deterministic genesis core.** The repository now contains:

- the v2 product and runtime contract in [`SPEC_v2.md`](SPEC_v2.md);
- Sentinel Block protocol helpers and strict email artifact validation;
- evidenced qualification checks;
- bidirectional deterministic match scoring with hard gates;
- private-preview, veto-window, and joint-introduction state transitions;
- reference prompt and email artifacts; and
- executable tests covering policy, protocol, and workflow invariants.

It does **not** yet contain the production mailbox adapter, attachment parsers,
LLM adapter, durable mailbox workflow repositories/outbox, or a running worker. The earlier
founder/investor design remains in [`SPEC.md`](SPEC.md) as historical context; v2
is the active contract.

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

## Licence

Code is BUSL-1.1 with a Change Date of 2030-08-09, converting to Apache-2.0.
Third-party packages and model weights retain their upstream licences.

Built by [Interchained LLC](https://interchained.org).
