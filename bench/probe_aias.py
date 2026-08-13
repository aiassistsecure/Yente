#!/usr/bin/env python3
"""Measure what AiAS can actually do for Yente right now.

Run this before trusting a research batch, and after any AiAS deploy. The
platform's failures are partial and several of them are silent, so "is it up"
is not a useful question — the useful question is which of the six things
Yente needs are working this minute.

    AIASSIST_API_KEY=... python3 bench/probe_aias.py [--json]
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from research.provider_aias import AiasClient, probe  # noqa: E402

NEEDED = {
    "search": "find an org Yente was given only a name for",
    "extract_http": "read a page (simple sites)",
    "extract_browser": "read a page (JS/CDN sites — most company sites)",
    "scan_free": "timing signals from free sources",
    "scan_netrows": "people and company enrichment (linkedin_people, twitter)",
    "tools": "structured extraction via tool calling",
}


def main():
    c = AiasClient()
    if not c.key:
        print("no AIASSIST_API_KEY — run via RunWithCredentials")
        return 2
    caps = probe(c)
    if "--json" in sys.argv:
        print(json.dumps(caps, indent=1))
        return 0

    print(f"AiAS capability probe — {c.base}")
    print("=" * 74)
    for k, why in NEEDED.items():
        r = caps[k]
        mark = "OK  " if r.get("ok") else "DOWN"
        print(f"  {mark} {k:17s} {why}")
        if not r.get("ok"):
            print(f"       reason: {str(r.get('reason'))[:110]}")
        if r.get("empty_unexplained"):
            print("       returned [] with no failure — cannot tell "
                  "'no results' from 'not subscribed'")
    print("=" * 74)
    ok = caps["usable_for_research"]
    print(f"  usable for organization research: {'YES' if ok else 'NO'}")
    if ok and not caps["extract_browser"]["ok"]:
        print("  DEGRADED — only sites servable over plain http can be read.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
