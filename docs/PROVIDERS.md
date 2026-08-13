# Providers — the boundary, and what the platform can actually do

Yente dogfoods AiAssist Secure for web research. This document records where the
seam is, and — separately — what AiAS measurably does, which is not the same as
what its OpenAPI document advertises.

## The seam

```
  Yente domain          Organization, Person, Fact, Inference, Signal
        ▲                          src/research/model.py
        │  normalised intelligence only
  ┌─────┴──────────────────────────────────────────────┐
  │ OrganizationResearchService   src/research/service.py │
  │   page discovery · pacing · grounding · staging       │
  └─────┬──────────────────────────────────────────────┘
        │  Result(ok, data, reason, meta)
  ┌─────┴────────────────┐
  │ AiasClient           │  src/research/provider_aias.py
  │ the ONLY file that   │
  │ knows api.aiassist.net│
  └──────────────────────┘
```

Two rules make the seam real rather than decorative:

**A provider payload never reaches the domain.** `ExtractResponse` dies inside
`provider_aias.py`. Everything above it sees `Fact` and `Signal`.

**A provider failure is data, not an exception.** Every method returns
`Result(ok=False, reason=...)`. A research pipeline that raises on a flaky
provider abandons the organization half-read and leaves a profile that looks
thin rather than blocked. `ResearchReport` therefore carries `pages_failed`
and `provider_notes` alongside the findings — *what we could not see* is part
of the result.

## Measured capability — 2026-08-10

Run `python3 bench/probe_aias.py` to refresh this. It exists because AiAS's
failures are **partial and several are silent**, so "is it up" is the wrong
question.

| capability | state | detail |
|---|---|---|
| `/v1/web/extract` via `http` | **works** | the workhorse |
| tool calling | **works** | ~600–760 ms, correct calls, explicit model required |
| free intel sources | **works** | 18 sources, real data |
| `/v1/web/extract` via `browser` | **down** | `FETCH_FAILED: Browser capacity exceeded` |
| `/v1/search` | **down** | `'RedisOnNedb' object has no attribute 'zremrangebyrank'` |
| netrows sources | **empty** | returns `[]` with `sources_failed: []` |
| `extract_links: true` | **ignored** | accepted; no `links` field is ever returned |

### Things that cost real debugging time

**Cloudflare bans the default Python UA.** `Python-urllib/3.x` gets HTML
`error code: 1010` at the edge before the request reaches the app — a 403 that
looks exactly like an auth failure but is not. Send a browser `User-Agent`.
`curl` passes, which makes the difference easy to misread.

**`/api/*` and `/v1/*` have different auth.** `/v1/*` accepts
`Authorization: Bearer aai_...`. `/api/*` rejects every API-key header variant
(`Bearer`, `X-API-Key`, `x-api-key`, `X-AiAssist-Key`, raw) — it wants a user
session. **Yente uses `/v1` only**, which costs us
`/api/web-extraction/batch`; the single-page `/v1/web/extract` is its twin and
does work.

**Extraction is rate-limited per target domain, tightly.** A burst of six
requests to one domain returned one `200` and five `RATE_LIMITED`; ~3 s spacing
got two of three through. Focused crawling is paced by construction
(`DOMAIN_PACE_S = 4.0`). Unpaced, a six-page crawl returns one page and the
company looks like it has nothing on its website.

**The account's default model 400s.** Default provider is `anthropic` with
model `claude-fable-5`; fallback provider is `groq`. When the fallback fires it
**keeps the Anthropic model name**, so the request dies as
`Groq: The model claude-fable-5 does not exist`. Pin an explicit model until
that is fixed.

## Page discovery is ours

Because `extract_links` is ignored there is no link graph to walk, so
`service.py` does discovery itself: `sitemap.xml` first because it is
authoritative, then a ranked list of conventional paths. Ranking is the part
that matters under a page budget — `/pricing` and `/customers` say far more
about who a company serves than `/blog` does.

## Netrows

The four Netrows-backed sources (`linkedin_people`, `linkedin_jobs`, `twitter`,
`google_news`) are **already exposed through AiAS** as premium
`/v1/intelligence` sources. Yente does not need a second integration; it needs
those sources to return data.

They currently return `[]` with an empty `sources_failed`, which is the worst
available failure mode: **indistinguishable from a genuine "nothing matched."**
`AiasClient.scan()` therefore sets `meta.empty_unexplained` so a caller can tell
"we looked and found nothing" from "we could not look." Under INV-4 that
distinction is not optional — an introduction justified by absent evidence is
an introduction justified by a bug.

## Facts and inferences

The rule the schema enforces:

> **Fact** — something a source *said*. Has a URL, a verbatim span, a timestamp.
> **Inference** — something Yente *concluded*. Has the facts beneath it, a
> confidence, the model that concluded it, and a review date.

An inference is never promoted to a fact. Every proposed fact is re-checked
against the page text it came from and graded `exact` / `fuzzy` / `INVENTED`,
the same three-way call the triage grader applies to attributes. **`INVENTED`
rows are stored and never used** — keeping them measures drift; using them
would mean citing a sentence nobody wrote.

**Signals are a third thing** because they expire. "They are hiring three infra
engineers" is true on Tuesday and misleading in nine months, and a `Fact` has
no decay. Storing timing as a fact is how a matchmaker ends up giving a stale
reason for an introduction.

## First dogfood run

`sourcegraph.com`, level 2, 2026-08-10:

```
pages fetched 7   failed 0   elapsed 29.7s (dominated by pacing)
facts 21          invented 0            signals 1 (hiring)
coverage          offer ✓  market ✓  people ✓  signal ✓
```

It recovered the CEO and seven more named executives, five service lines, two
customer-type statements, and a hiring signal — with every claim carrying the
page it came from. Twenty of twenty-one spans graded `exact`, one `fuzzy`,
none invented.

**The correction worth recording:** on three samples (`stripe.com`,
`interchained.org`, `aiassist.net`) the browser path failed and I concluded
most company sites would need it. Eight of eight real B2B SaaS sites then
resolved over plain `http` — `plausible.io`, `basecamp.com`, `sourcegraph.com`,
`posthog.com`, `supabase.com`, `railway.app`, `fly.io`, `ycombinator.com`. The
browser outage is a real gap but a **narrower one than three samples suggested**.
