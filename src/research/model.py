#!/usr/bin/env python3
"""Yente's own intelligence types.

The whole point of this module is that a provider payload never reaches Yente's
domain. AiAS returns an ExtractResponse; Netrows returns something else again;
both get normalised into Fact / Signal / Inference here, and everything
downstream reasons over these.

The distinction that matters most:

    Fact       something a source SAID, with a URL and a timestamp.
    Inference  something Yente CONCLUDED, with the facts that led there.

Collapsing those two is how a research system starts lying. "Acme invests in
developer infrastructure" (their thesis page says so) and "Acme is a good match
for us" (we decided) are different kinds of claim and must never be stored in
the same shape. INV-4 requires every claim be traceable to a sentence someone
actually wrote; an inference is traceable only to the facts beneath it, and
saying so is the honest thing to record.
"""
from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field, asdict
from typing import Any

# ---------------------------------------------------------------- provenance


@dataclass
class Source:
    """Where a claim came from. Enough to re-check it by hand."""
    provider: str            # "aias" | "netrows" | "email" | "operator"
    kind: str                # "website" | "search" | "social" | "message"
    url: str | None = None
    title: str | None = None
    fetched_at: float = field(default_factory=time.time)
    fetch_method: str | None = None   # "http" | "browser" | "api"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Fact:
    """A claim a source made, with the span that supports it.

    `grounding` reuses the triage grader's vocabulary deliberately: the same
    three-way call (exact / fuzzy / INVENTED) that decides whether an extracted
    attribute may be matched also decides whether a researched fact may be
    believed. One vocabulary, one bar.
    """
    subject: str             # org domain or person address this is about
    predicate: str           # "describes_itself_as", "sells", "serves", ...
    value: str
    evidence: str            # verbatim span from the source
    source: Source
    grounding: str = "exact"          # exact | fuzzy | INVENTED
    confidence: float = 1.0

    @property
    def id(self) -> str:
        raw = f"{self.subject}|{self.predicate}|{self.value}|{self.source.url}"
        return "f_" + hashlib.sha256(raw.encode()).hexdigest()[:16]

    def believable(self) -> bool:
        """INVENTED facts are stored and never used. Same rule as attributes."""
        return self.grounding != "INVENTED"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["_id"] = self.id
        d["believable"] = self.believable()
        return d


@dataclass
class Inference:
    """Something Yente concluded. Never promoted to a Fact, ever."""
    subject: str
    claim: str
    supporting_fact_ids: list[str]
    confidence: float
    rationale: str
    model: str | None = None         # which weights concluded it
    created_at: float = field(default_factory=time.time)
    review_after: float | None = None

    @property
    def id(self) -> str:
        raw = f"{self.subject}|{self.claim}|{sorted(self.supporting_fact_ids)}"
        return "i_" + hashlib.sha256(raw.encode()).hexdigest()[:16]

    def stale(self, now: float | None = None) -> bool:
        if self.review_after is None:
            return False
        return (now or time.time()) > self.review_after

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["_id"] = self.id
        return d


@dataclass
class Signal:
    """A timing observation. Separate from Fact because signals expire.

    "They are hiring three infra engineers" is true on Tuesday and meaningless
    in nine months. Storing it as a Fact means Yente eventually cites a stale
    reason for an introduction, which is worse than citing none.
    """
    subject: str
    kind: str                # hiring | funding | launch | expansion | leadership | press
    summary: str
    observed_at: float
    source: Source
    decays_after_days: int = 90

    @property
    def id(self) -> str:
        raw = f"{self.subject}|{self.kind}|{self.summary}"
        return "s_" + hashlib.sha256(raw.encode()).hexdigest()[:16]

    def fresh(self, now: float | None = None) -> bool:
        age = ((now or time.time()) - self.observed_at) / 86400.0
        return age <= self.decays_after_days

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["_id"] = self.id
        d["fresh"] = self.fresh()
        return d


# ------------------------------------------------------------------ entities


@dataclass
class Organization:
    """What Yente knows about a company. Facts and inferences stay apart."""
    domain: str
    name: str | None = None
    aliases: list[str] = field(default_factory=list)
    description: str | None = None
    facts: list[Fact] = field(default_factory=list)
    inferences: list[Inference] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)
    pages_seen: list[str] = field(default_factory=list)
    enrichment_level: int = 0        # see service.LEVELS
    enriched_at: float | None = None
    coverage: dict[str, bool] = field(default_factory=dict)

    def believable_facts(self) -> list[Fact]:
        return [f for f in self.facts if f.believable()]

    def by_predicate(self, predicate: str) -> list[Fact]:
        return [f for f in self.believable_facts() if f.predicate == predicate]

    def fresh_signals(self) -> list[Signal]:
        return [s for s in self.signals if s.fresh()]

    def to_dict(self) -> dict[str, Any]:
        return {
            "_id": self.domain, "domain": self.domain, "name": self.name,
            "aliases": self.aliases, "description": self.description,
            "facts": [f.to_dict() for f in self.facts],
            "inferences": [i.to_dict() for i in self.inferences],
            "signals": [s.to_dict() for s in self.signals],
            "pages_seen": self.pages_seen,
            "enrichment_level": self.enrichment_level,
            "enriched_at": self.enriched_at,
            "coverage": self.coverage,
        }


@dataclass
class Person:
    """A human at or around an organization.

    Deliberately thin. Yente already has `people` and `roles` collections for
    anyone who has emailed her; this is the *researched* half, and it stays
    separate so that a person Yente has actually spoken to is never confused
    with a person she merely read about.
    """
    key: str                 # email if known, else "org_domain#slug"
    display_name: str | None = None
    org_domain: str | None = None
    title: str | None = None
    profile_urls: list[str] = field(default_factory=list)
    facts: list[Fact] = field(default_factory=list)
    inferences: list[Inference] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)
    researched_only: bool = True     # False once they have emailed Yente

    def to_dict(self) -> dict[str, Any]:
        return {
            "_id": self.key, "display_name": self.display_name,
            "org_domain": self.org_domain, "title": self.title,
            "profile_urls": self.profile_urls,
            "facts": [f.to_dict() for f in self.facts],
            "inferences": [i.to_dict() for i in self.inferences],
            "signals": [s.to_dict() for s in self.signals],
            "researched_only": self.researched_only,
        }


# ------------------------------------------------------------------- helpers

_WS = re.compile(r"\s+")


def norm_text(s: str | None) -> str:
    return _WS.sub(" ", (s or "")).strip()


def ground(evidence: str, haystack: str) -> str:
    """Is this span actually in the source? Same three-way call as triage."""
    e = _WS.sub(" ", re.sub(r"[^a-z0-9 ]+", " ", (evidence or "").lower())).strip()
    h = _WS.sub(" ", re.sub(r"[^a-z0-9 ]+", " ", (haystack or "").lower())).strip()
    if not e:
        return "EMPTY"
    if e in h:
        return "exact"
    toks = [t for t in e.split() if len(t) > 2]
    if toks and sum(1 for t in toks if t in h) / len(toks) >= 0.8:
        return "fuzzy"
    return "INVENTED"


def domain_of(value: str) -> str:
    """Accept a URL, a bare domain or an email address; return the domain."""
    v = (value or "").strip().lower()
    if "@" in v and "://" not in v:
        v = v.rsplit("@", 1)[-1]
    v = re.sub(r"^[a-z]+://", "", v)
    v = v.split("/")[0].split("?")[0]
    return v[4:] if v.startswith("www.") else v
