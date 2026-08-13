#!/usr/bin/env python3
"""OrganizationResearchService — Yente's view of "go understand this company".

Yente calls this. Yente does not call AiAS. Swapping or adding a provider
should touch provider_*.py and nothing else.

Two things this file does that the provider cannot:

1. PAGE DISCOVERY. AiAS accepts extract_links and ignores it, so there is no
   link graph to walk. We find internal pages from sitemap.xml when it exists
   and from a ranked list of conventional paths when it does not. This is
   deliberately a small fixed budget: the goal is to understand the business,
   not to archive the website.

2. GROUNDING. Every fact the model proposes is checked back against the page
   text it came from. A fact whose evidence is not in the source is marked
   INVENTED, stored, and never used. This is the same rule the triage grader
   applies to extracted attributes, and it exists because the failure it
   catches — a plausible sentence nobody wrote — is invisible without it.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

try:
    from .model import (Fact, Inference, Organization, Signal, Source,
                        domain_of, ground, norm_text)
    from .provider_aias import AiasClient, Result
except ImportError:  # running as a script
    from model import (Fact, Inference, Organization, Signal, Source,
                       domain_of, ground, norm_text)
    from provider_aias import AiasClient, Result


# Staged enrichment. Depth costs money and time, so it is bought explicitly.
LEVELS = {
    0: "discovery      — identity only, is this even a real company",
    1: "qualification  — homepage, enough to decide whether to go further",
    2: "match research — the pages that reveal offer and need",
    3: "introduction   — deep company + person research before outreach",
    4: "refresh        — targeted re-check when a relationship warrants it",
}

# Ranked by how much they reveal about offer/need per page fetched. Ordering is
# the whole trick: under a page budget, /pricing and /customers say far more
# about who a company serves than /blog does.
CANDIDATE_PATHS = [
    "/about", "/about-us", "/products", "/product", "/solutions", "/services",
    "/pricing", "/customers", "/partners", "/integrations", "/team",
    "/careers", "/jobs", "/portfolio", "/investors", "/case-studies",
    "/press", "/news", "/blog", "/contact",
]

PATH_HINTS = {
    "about": "identity", "product": "offer", "solutions": "offer",
    "services": "offer", "pricing": "model", "customers": "market",
    "partners": "ecosystem", "integrations": "ecosystem", "team": "people",
    "careers": "need", "jobs": "need", "portfolio": "offer",
    "investors": "identity", "case": "market", "press": "signal",
    "news": "signal", "blog": "signal", "contact": "identity",
}

# One tool, typed, with descriptions that carry the discipline. Free-text
# fields lose to enums at small model sizes; descriptions beat types again on
# top of that. Both findings are from the imagine TOOL_DESIGN work.
ORG_TOOL = {
    "type": "function",
    "function": {
        "name": "record_organization",
        "description": (
            "Record what this page says about the organization. Use ONLY what "
            "the page states. Copy evidence verbatim from the page — never "
            "paraphrase it, because the evidence is checked against the source "
            "and a rewritten span is discarded. If the page does not say "
            "something, leave that field empty; an empty field is correct and "
            "useful, a guess is not. Call this exactly once."),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string",
                         "description": "The company name as the page writes it. Empty if unclear."},
                "what_they_do": {"type": "string",
                                 "description": "One sentence, in the page's own terms."},
                "offers": {
                    "type": "array",
                    "description": "What this company could provide to another business.",
                    "items": {"type": "object", "properties": {
                        "category": {"type": "string", "enum": [
                            "capital", "technology", "services", "customers",
                            "distribution", "expertise", "audience",
                            "integrations", "talent", "facilities", "media",
                            "referrals", "none"]},
                        "detail": {"type": "string"},
                        "evidence": {"type": "string",
                                     "description": "Verbatim span from the page."}},
                        "required": ["category", "evidence"]}},
                "serves": {
                    "type": "array",
                    "description": "Customer types the page says they serve.",
                    "items": {"type": "object", "properties": {
                        "who": {"type": "string"},
                        "evidence": {"type": "string"}},
                        "required": ["who", "evidence"]}},
                "signals": {
                    "type": "array",
                    "description": "Timing signals: hiring, funding, launches, expansion.",
                    "items": {"type": "object", "properties": {
                        "kind": {"type": "string", "enum": [
                            "hiring", "funding", "launch", "expansion",
                            "leadership", "press", "none"]},
                        "summary": {"type": "string"},
                        "evidence": {"type": "string"}},
                        "required": ["kind", "evidence"]}},
                "people": {
                    "type": "array",
                    "description": "Named individuals with their stated role.",
                    "items": {"type": "object", "properties": {
                        "name": {"type": "string"},
                        "title": {"type": "string"},
                        "evidence": {"type": "string"}},
                        "required": ["name", "evidence"]}},
            },
            "required": ["what_they_do"],
        },
    },
}

SYS = ("You read one web page and record what it says about the organization "
       "by calling record_organization exactly once. You never invent. You "
       "copy evidence spans verbatim. You never reply in prose.")


@dataclass
class ResearchReport:
    """What happened, not just what was found. Failures are part of the result."""
    org: Organization
    pages_attempted: list[str]
    pages_fetched: list[str]
    pages_failed: list[tuple[str, str]]
    provider_notes: list[str]
    level: int
    elapsed_s: float

    def summary(self) -> dict[str, Any]:
        return {
            "domain": self.org.domain,
            "name": self.org.name,
            "level": self.level,
            "pages_fetched": len(self.pages_fetched),
            "pages_failed": len(self.pages_failed),
            "facts": len(self.org.believable_facts()),
            "facts_discarded_invented": len(self.org.facts) - len(self.org.believable_facts()),
            "signals": len(self.org.signals),
            "inferences": len(self.org.inferences),
            "coverage": self.org.coverage,
            "elapsed_s": round(self.elapsed_s, 1),
            "notes": self.provider_notes,
        }


class OrganizationResearchService:
    # AiAS rate-limits /v1/web/extract PER TARGET DOMAIN, and tightly: measured
    # 2026-08-10, a burst of six got one 200 and five RATE_LIMITED, while ~3s
    # spacing got two of three through. Focused crawling is therefore paced by
    # construction — an unpaced six-page crawl returns one page and looks like
    # a company with nothing on its website.
    DOMAIN_PACE_S = 4.0

    def __init__(self, client: AiasClient | None = None,
                 model: str | None = None,
                 fetch: Callable[[str], Result] | None = None,
                 pace_s: float | None = None):
        self.client = client or AiasClient()
        self.model = model
        self._fetch = fetch          # injectable, so tests need no network
        self.pace_s = self.DOMAIN_PACE_S if pace_s is None else pace_s
        self._last_hit: dict[str, float] = {}

    # ------------------------------------------------------- page discovery

    def _sitemap_paths(self, domain: str, limit: int = 60) -> list[str]:
        """Read sitemap.xml if the site publishes one. Best source of truth."""
        r = self._extract(f"https://{domain}/sitemap.xml", max_chars=20000)
        if not r.ok:
            return []
        text = (r.data or {}).get("content") or ""
        urls = re.findall(r"https?://[^\s<>\"']+", text)
        return urls[:limit]

    def _rank(self, urls: list[str], budget: int) -> list[str]:
        """Prefer pages whose path suggests offer, need or market."""
        scored: list[tuple[int, str]] = []
        for u in urls:
            path = re.sub(r"^https?://[^/]+", "", u).lower()
            if path.count("/") > 3 or len(path) > 80:
                continue          # deep archive pages rarely repay the fetch
            score = 0
            for hint, kind in PATH_HINTS.items():
                if hint in path:
                    score += {"offer": 5, "need": 4, "market": 4,
                              "model": 5, "identity": 3, "ecosystem": 3,
                              "people": 3, "signal": 1}.get(kind, 1)
            if score:
                scored.append((score, u))
        scored.sort(key=lambda x: (-x[0], len(x[1])))
        seen, out = set(), []
        for _, u in scored:
            if u not in seen:
                seen.add(u)
                out.append(u)
            if len(out) >= budget:
                break
        return out

    def discover_pages(self, domain: str, budget: int = 6) -> list[str]:
        """Which internal pages are worth fetching.

        AiAS ignores extract_links, so there is no link graph to crawl. Sitemap
        first because it is authoritative; conventional paths as the fallback,
        which costs a few 404s but needs no link discovery at all.
        """
        found = self._rank(self._sitemap_paths(domain), budget)
        if found:
            return found
        return [f"https://{domain}{p}" for p in CANDIDATE_PATHS[:budget]]

    # -------------------------------------------------------------- fetching

    def _extract(self, url: str, max_chars: int = 12000) -> Result:
        if self._fetch:
            return self._fetch(url)
        self._wait_for(domain_of(url))
        return self.client.extract(url, max_chars=max_chars)

    def _wait_for(self, domain: str) -> None:
        """Space requests to one domain. Cheaper than handling RATE_LIMITED."""
        if self.pace_s <= 0:
            return
        last = self._last_hit.get(domain)
        if last is not None:
            gap = self.pace_s - (time.time() - last)
            if gap > 0:
                time.sleep(gap)
        self._last_hit[domain] = time.time()

    # ------------------------------------------------------------ extraction

    def _read_page(self, org: Organization, page: dict[str, Any]) -> list[str]:
        """Turn one fetched page into grounded Facts and Signals."""
        notes: list[str] = []
        content = norm_text(page.get("content"))
        if len(content) < 120:
            return ["page too thin to read"]

        src = Source(provider="aias", kind="website", url=page.get("url"),
                     title=page.get("title"),
                     fetch_method=page.get("fetch_method"))
        haystack = " ".join([norm_text(page.get("title")),
                             norm_text(page.get("description")), content])

        kwargs = {"model": self.model} if self.model else {}
        r = self.client.tool_call(
            [{"role": "system", "content": SYS},
             {"role": "user", "content":
              f"URL: {page.get('url')}\nTitle: {page.get('title')}\n\n"
              f"--- page ---\n{content[:9000]}\n--- end ---\n\n"
              "Record what this page says about the organization."}],
            ORG_TOOL, **kwargs)
        if not r.ok:
            return [f"extraction failed on {page.get('url')}: {r.reason}"]

        a = r.data or {}
        if a.get("name") and not org.name:
            org.name = a["name"]

        def add(pred: str, value: str, evidence: str) -> None:
            g = ground(evidence, haystack)
            org.facts.append(Fact(subject=org.domain, predicate=pred,
                                  value=value, evidence=evidence, source=src,
                                  grounding=g,
                                  confidence=1.0 if g == "exact" else 0.6))

        if a.get("what_they_do"):
            add("describes_itself_as", a["what_they_do"], a["what_they_do"])
            if not org.description:
                org.description = a["what_they_do"]

        for o in a.get("offers") or []:
            if o.get("category") in (None, "none"):
                continue
            add(f"offers:{o['category']}", o.get("detail") or o["category"],
                o.get("evidence", ""))
            org.coverage["offer"] = True
        for s in a.get("serves") or []:
            add("serves", s.get("who", ""), s.get("evidence", ""))
            org.coverage["market"] = True
        for p in a.get("people") or []:
            add("person", f"{p.get('name','')} — {p.get('title','')}".strip(" —"),
                p.get("evidence", ""))
            org.coverage["people"] = True
        for sig in a.get("signals") or []:
            if sig.get("kind") in (None, "none"):
                continue
            g = ground(sig.get("evidence", ""), haystack)
            if g == "INVENTED":
                notes.append(f"discarded invented signal on {page.get('url')}")
                continue
            org.signals.append(Signal(
                subject=org.domain, kind=sig["kind"],
                summary=sig.get("summary") or sig["kind"],
                observed_at=time.time(), source=src))
            org.coverage["signal"] = True
        return notes

    # ---------------------------------------------------------------- public

    def research(self, identifier: str, level: int = 2,
                 page_budget: int = 6) -> ResearchReport:
        """Research one organization from a domain, URL or email address."""
        t0 = time.time()
        domain = domain_of(identifier)
        org = Organization(domain=domain, enrichment_level=level)
        attempted: list[str] = []
        fetched: list[str] = []
        failed: list[tuple[str, str]] = []
        notes: list[str] = []

        targets = [f"https://{domain}"]
        if level >= 2:
            targets += [u for u in self.discover_pages(domain, page_budget)
                        if u.rstrip("/") != f"https://{domain}"]

        for url in targets:
            attempted.append(url)
            r = self._extract(url)
            if not r.ok:
                failed.append((url, r.reason or "unknown"))
                if r.meta.get("transient"):
                    notes.append(f"transient provider failure on {url}: {r.reason}")
                continue
            fetched.append(url)
            org.pages_seen.append(url)
            notes.extend(self._read_page(org, r.data or {}))

        # An empty profile is a real outcome and must not read like a thin one.
        if not fetched:
            notes.append(
                "NO PAGES FETCHED — the provider could not reach this site. "
                "This is absence of data, not evidence of a small company.")
        org.enriched_at = time.time()
        org.coverage.setdefault("offer", False)
        org.coverage.setdefault("market", False)

        return ResearchReport(org=org, pages_attempted=attempted,
                              pages_fetched=fetched, pages_failed=failed,
                              provider_notes=notes, level=level,
                              elapsed_s=time.time() - t0)

    # ------------------------------------------------------------ inference

    def infer_needs(self, org: Organization) -> list[Inference]:
        """Conclude likely needs from facts. Kept apart from facts, always."""
        out: list[Inference] = []
        hiring = [s for s in org.fresh_signals() if s.kind == "hiring"]
        if hiring:
            out.append(Inference(
                subject=org.domain,
                claim="likely needs talent or the capability they are hiring for",
                supporting_fact_ids=[],
                confidence=0.6,
                rationale="; ".join(s.summary for s in hiring[:3]),
                model=self.model,
                review_after=time.time() + 30 * 86400))
        funding = [s for s in org.fresh_signals() if s.kind == "funding"]
        if funding:
            out.append(Inference(
                subject=org.domain,
                claim="recently funded — likely deploying capital, not raising",
                supporting_fact_ids=[],
                confidence=0.5,
                rationale="; ".join(s.summary for s in funding[:2]),
                model=self.model,
                review_after=time.time() + 60 * 86400))
        org.inferences.extend(out)
        return out


if __name__ == "__main__":
    import sys
    ident = sys.argv[1] if len(sys.argv) > 1 else "interchained.org"
    lvl = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    svc = OrganizationResearchService()
    rep = svc.research(ident, level=lvl)
    svc.infer_needs(rep.org)
    print(json.dumps(rep.summary(), indent=1))
    for f in rep.org.believable_facts():
        print(f"  {f.grounding:6s} {f.predicate:28s} {f.value[:70]}")
    for s in rep.org.signals:
        print(f"  signal {s.kind:12s} {s.summary[:70]}")
    for f in rep.pages_failed:
        print(f"  FAILED {f[0]}  {f[1][:90]}")
