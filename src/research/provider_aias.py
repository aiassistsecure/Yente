#!/usr/bin/env python3
"""AiAS adapter — the only file in Yente that knows api.aiassist.net exists.

Everything here is written against what the platform *measurably does* on
2026-08-10, not what its OpenAPI document advertises. Where those disagree the
measurement wins, and the disagreement is recorded in the comment so that when
AiAS is fixed we can delete the workaround instead of rediscovering why it was
there.

Measured on 2026-08-10 against api.aiassist.net (see bench/probe_aias.py):

  /v1/*                accepts `Authorization: Bearer aai_...`
  /api/*               rejects every API-key header variant; wants a user
                       session. Yente therefore uses the /v1 surface ONLY,
                       which costs us /api/web-extraction/batch.
  Cloudflare           bans the default Python-urllib User-Agent with error
                       1010 before the request reaches the app. Send a browser
                       UA or every call 403s with an HTML body.
  /v1/search           returns success:false —
                       "'RedisOnNedb' object has no attribute 'zremrangebyrank'"
  /v1/web/extract      works when it resolves via fetch_method "http".
                       Escalates to "browser" for JS-heavy or CDN-fronted
                       sites and then fails FETCH_FAILED "Browser capacity
                       exceeded" — which is most real company websites.
  extract_links:true   accepted and silently ignored; no links field is ever
                       returned. Page discovery is therefore ours to do.
  intelligence/scan    free sources return data; the four netrows-backed
                       premium sources return [] with sources_failed:[] —
                       silently empty rather than erroring.
  chat/completions     tool calling works with an EXPLICIT model. The account
                       default (anthropic/claude-fable-5) fails because the
                       groq fallback keeps the anthropic model name.

Every method returns a normalised result and never raises for a provider-side
failure: callers get `ok=False` plus a reason. A research pipeline that throws
on a flaky provider stops mid-organization and leaves half a profile behind.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

DEFAULT_BASE = "https://api.aiassist.net"

# Cloudflare 1010 bans Python-urllib's signature at the edge. This is not
# politeness theatre, it is the difference between 200 and an HTML 403.
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# The account default (claude-fable-5) 400s when the groq fallback fires,
# because the fallback does not remap the model name. Pin an explicit model
# until that is fixed upstream.
DEFAULT_MODEL = "llama-3.3-70b-versatile"

NETROWS_SOURCES = ("google_news", "linkedin_jobs", "linkedin_people", "twitter")


@dataclass
class Result:
    """Uniform provider return. `ok` is about Yente's needs, not HTTP."""
    ok: bool
    data: Any = None
    reason: str | None = None
    status: int | None = None
    latency_ms: int = 0
    meta: dict[str, Any] = field(default_factory=dict)


class AiasClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 timeout: int = 90):
        self.key = api_key or os.environ.get("AIASSIST_API_KEY", "")
        self.base = (base_url or os.environ.get("AIASSIST_BASE_URL")
                     or DEFAULT_BASE).rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------- transport

    def _call(self, method: str, path: str, body: dict | None = None,
              timeout: int | None = None) -> Result:
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
        }
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}{path}", data=data,
                                     method=method, headers=headers)
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                ms = int((time.time() - t0) * 1000)
                return Result(True, json.load(r), status=r.status, latency_ms=ms)
        except urllib.error.HTTPError as e:
            ms = int((time.time() - t0) * 1000)
            raw = e.read().decode(errors="replace")[:300]
            hint = ""
            if e.code == 403 and "1010" in raw:
                hint = " (Cloudflare UA ban — send a browser User-Agent)"
            elif e.code == 401 and path.startswith("/api/"):
                hint = " (/api/* needs a user session, not an API key)"
            return Result(False, reason=f"http {e.code}: {raw}{hint}",
                          status=e.code, latency_ms=ms)
        except Exception as e:  # network, timeout, malformed JSON
            ms = int((time.time() - t0) * 1000)
            return Result(False, reason=f"{type(e).__name__}: {e}"[:250],
                          latency_ms=ms)

    # ---------------------------------------------------------------- search

    def search(self, query: str, max_results: int = 5,
               depth: str = "basic") -> Result:
        """Web search. Currently DOWN in production (RedisOnNedb shim)."""
        r = self._call("POST", "/v1/search", {
            "query": query, "search_depth": depth, "max_results": max_results})
        if not r.ok:
            return r
        d = r.data or {}
        if not d.get("success"):
            # A 200 carrying success:false is still a failure for Yente. Say so
            # rather than returning an empty list that reads like "no results".
            return Result(False, reason=f"search failed: {d.get('error')}",
                          status=r.status, latency_ms=r.latency_ms)
        out = [{"title": x.get("title"), "url": x.get("url"),
                "content": x.get("content") or ""}
               for x in (d.get("results") or [])]
        return Result(True, out, status=r.status, latency_ms=r.latency_ms,
                      meta={"quality_tier": d.get("quality_tier")})

    # --------------------------------------------------------------- extract

    def extract(self, url: str, max_chars: int = 12000,
                use_browser: bool | None = None) -> Result:
        """Fetch and clean one page.

        Note we do NOT pass extract_links: the flag is accepted and ignored, so
        sending it would imply a capability we do not have. Page discovery
        lives in service.py instead.
        """
        body: dict[str, Any] = {"url": url, "max_content_length": max_chars}
        if use_browser is not None:
            body["use_browser"] = use_browser
        r = self._call("POST", "/v1/web/extract", body)
        if not r.ok:
            return r
        d = r.data or {}
        if not d.get("success"):
            code = d.get("error_code")
            msg = d.get("error_message") or ""
            reason = f"{code}: {msg}"
            # Distinguish "this page is unreachable" from "the platform's
            # browser pool is full". They call for different responses: the
            # first is final, the second is worth retrying later.
            transient = "capacity" in msg.lower() or code == "FETCH_FAILED"
            return Result(False, reason=reason, status=r.status,
                          latency_ms=r.latency_ms,
                          meta={"transient": transient,
                                "fetch_method": d.get("fetch_method")})
        return Result(True, {
            "url": d.get("url") or url,
            "title": d.get("title"),
            "description": d.get("description"),
            "content": d.get("content") or "",
            "domain": d.get("domain"),
            "fetch_method": d.get("fetch_method"),
            "cached": d.get("cached"),
            "extracted_at": d.get("extracted_at"),
        }, status=r.status, latency_ms=r.latency_ms)

    # ---------------------------------------------------------- intelligence

    def sources(self) -> Result:
        r = self._call("GET", "/v1/intelligence/sources")
        if not r.ok:
            return r
        srcs = ((r.data or {}).get("data") or {}).get("sources") or []
        return Result(True, srcs, status=r.status, latency_ms=r.latency_ms)

    def scan(self, sources: list[str], keywords: list[str] | None = None,
             query: str | None = None, limit: int = 25,
             category: str = "recent") -> Result:
        """Signal scan across social/news sources.

        The netrows-backed sources currently return an empty list with an empty
        sources_failed, which is indistinguishable from a genuine "nothing
        matched". We surface that ambiguity in meta rather than letting an
        empty result silently look like a finding of absence.
        """
        body: dict[str, Any] = {"sources": sources, "limit": limit,
                                "category": category}
        if keywords:
            body["keywords"] = keywords
        if query:
            body["query"] = query
        r = self._call("POST", "/v1/intelligence/scan", body)
        if not r.ok:
            return r
        data = (r.data or {}).get("data") or {}
        results = data.get("results") or []
        used_premium = [s for s in sources if s in NETROWS_SOURCES]
        return Result(True, results, status=r.status, latency_ms=r.latency_ms,
                      meta={
                          "sources_failed": data.get("sources_failed") or [],
                          "premium_requested": used_premium,
                          # True when we cannot tell absence from unavailability
                          "empty_unexplained": (not results and used_premium
                                                and not data.get("sources_failed")),
                      })

    # -------------------------------------------------------------- language

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             model: str = DEFAULT_MODEL, temperature: float = 0.0,
             max_tokens: int = 800) -> Result:
        body: dict[str, Any] = {"messages": messages, "model": model,
                                "temperature": temperature,
                                "max_tokens": max_tokens}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        r = self._call("POST", "/v1/chat/completions", body, timeout=120)
        if not r.ok:
            return r
        choices = (r.data or {}).get("choices") or []
        if not choices:
            return Result(False, reason="no choices returned",
                          status=r.status, latency_ms=r.latency_ms)
        msg = choices[0].get("message") or {}
        return Result(True, msg, status=r.status, latency_ms=r.latency_ms,
                      meta={"model": (r.data or {}).get("model"),
                            "usage": (r.data or {}).get("usage")})

    def tool_call(self, messages: list[dict], tool: dict,
                  model: str = DEFAULT_MODEL) -> Result:
        """Chat that must answer with one call to `tool`. Returns parsed args."""
        r = self.chat(messages, tools=[tool], model=model)
        if not r.ok:
            return r
        calls = (r.data or {}).get("tool_calls") or []
        if not calls:
            return Result(False, reason="model answered in prose, not a tool call",
                          latency_ms=r.latency_ms,
                          meta={"content": (r.data or {}).get("content")})
        try:
            args = json.loads(calls[0]["function"]["arguments"])
        except Exception as e:
            return Result(False, reason=f"unparseable tool arguments: {e}",
                          latency_ms=r.latency_ms)
        return Result(True, args, latency_ms=r.latency_ms, meta=r.meta)


# --------------------------------------------------------------- capability


CAPABILITIES = ("search", "extract_http", "extract_browser", "scan_free",
                "scan_netrows", "tools")


def probe(client: AiasClient) -> dict[str, Any]:
    """Measure what AiAS can do right now. Cheap enough to run before a batch.

    Yente calls this rather than assuming, because the platform's failures are
    partial and silent: extract works for some sites and not others, and the
    premium sources return [] instead of an error. A pipeline that assumes
    capability produces a confidently thin profile, which is the worst outcome
    of all — it looks like research and is not.
    """
    caps: dict[str, Any] = {"checked_at": time.time()}

    r = client.search("test query", max_results=1)
    caps["search"] = {"ok": r.ok, "reason": r.reason, "ms": r.latency_ms}

    r = client.extract("https://example.com", max_chars=500)
    caps["extract_http"] = {"ok": r.ok, "reason": r.reason, "ms": r.latency_ms,
                            "method": (r.data or {}).get("fetch_method") if r.ok else None}

    r = client.extract("https://stripe.com", max_chars=500)
    caps["extract_browser"] = {"ok": r.ok, "reason": r.reason, "ms": r.latency_ms,
                               "transient": r.meta.get("transient")}

    r = client.scan(["hackernews"], keywords=["developer tools"], limit=2)
    caps["scan_free"] = {"ok": r.ok and bool(r.data), "n": len(r.data or []),
                         "reason": r.reason, "ms": r.latency_ms}

    r = client.scan(["linkedin_people"], keywords=["partner"], limit=2)
    caps["scan_netrows"] = {"ok": r.ok and bool(r.data), "n": len(r.data or []),
                            "empty_unexplained": r.meta.get("empty_unexplained"),
                            "reason": r.reason, "ms": r.latency_ms}

    r = client.tool_call(
        [{"role": "user", "content": "The company is Acme Ventures."}],
        {"type": "function", "function": {
            "name": "record", "description": "Record the organization name.",
            "parameters": {"type": "object",
                           "properties": {"name": {"type": "string"}},
                           "required": ["name"]}}})
    caps["tools"] = {"ok": r.ok, "got": r.data if r.ok else None,
                     "reason": r.reason, "ms": r.latency_ms}

    caps["usable_for_research"] = bool(
        caps["extract_http"]["ok"] and caps["tools"]["ok"])
    return caps
