#!/usr/bin/env python3
"""imagine :: tool schema linter

Small models fail at tool calling far more often because of how a tool was
DESCRIBED than because of what the model is. We measured this on stock
Qwen3.5-0.8B with identical weights and identical questions, changing only the
schemas:

    free-text  {"db": "string", "nql": "string"}        2/7 usable calls
    typed      enums + typed slots                      5/7
    typed + good descriptions                           6/7

No training. Three of the five original failures were schema-design defects
wearing a model-capability costume.

The mechanism is concrete. In llama.cpp's grammar builder:

    schema_info.resolves_to_string(param_schema) ? arg_string : ...schema...
                                                   ^ = "any text until delim"

A "type": "string" parameter is constrained to ANY text, so a model asked for
NQL will happily emit SQL and the grammar cannot object. Non-string parameters
ARE json-schema constrained -- so an enum makes a wrong value literally
unrepresentable rather than something you detect afterwards.

This linter flags the patterns that cost us those calls.

Usage:
    python3 lint_tools.py tools.json [--strict]
"""
from __future__ import annotations

import argparse, json, re, sys

# Parameter names that almost always mean "the model must author a language".
DSL_NAMES = re.compile(
    r"^(nql|sql|query_string|expression|expr|code|script|filter|dsl|"
    r"jq|jsonpath|xpath|regex|pattern|selector|formula)$", re.I)

# Words that suggest an enum is hiding inside a free-text field.
ENUMY = re.compile(r"^(status|state|mode|kind|type|level|op|operator|order|"
                   r"sort|direction|format|unit|category|collection|table|"
                   r"database|db|action|method)$", re.I)

VAGUE = re.compile(r"^(the )?(value|input|arg|argument|param|parameter|data|"
                   r"string|name|thing)s?\.?$", re.I)


class Finding:
    def __init__(self, sev, tool, param, msg, fix):
        self.sev, self.tool, self.param, self.msg, self.fix = sev, tool, param, msg, fix

    def __str__(self):
        where = f"{self.tool}" + (f".{self.param}" if self.param else "")
        return f"  [{self.sev:5}] {where:34} {self.msg}\n           fix: {self.fix}"


def lint_tool(fn: dict) -> list[Finding]:
    out: list[Finding] = []
    name = fn.get("name", "<unnamed>")
    desc = (fn.get("description") or "").strip()
    params = (fn.get("parameters") or {}).get("properties") or {}
    required = set((fn.get("parameters") or {}).get("required") or [])

    if not desc:
        out.append(Finding("ERROR", name, None, "tool has no description",
                           "say what it does AND when to reach for it"))
    elif len(desc) < 40:
        out.append(Finding("WARN", name, None,
                           f"description is {len(desc)} chars, likely too thin",
                           "add when-to-use guidance; 'Run a shell command.' produced a "
                           "refusal until it said the model has real access"))

    if not params:
        out.append(Finding("WARN", name, None, "no parameters declared",
                           "if it truly takes none, ignore this"))

    for pname, p in params.items():
        ptype = p.get("type")
        pdesc = (p.get("description") or "").strip()
        has_enum = bool(p.get("enum"))

        if ptype == "string" and not has_enum:
            if DSL_NAMES.match(pname):
                out.append(Finding("ERROR", name, pname,
                                   "free-text parameter expects a query language",
                                   "decompose into typed slots (collection/field/op/value) "
                                   "and compose the language in your runtime; the model "
                                   "emitted SQL where NQL was required"))
            elif ENUMY.match(pname):
                out.append(Finding("WARN", name, pname,
                                   "name suggests a closed set but the type is free text",
                                   "add an enum so a wrong value is unrepresentable"))

        if not pdesc:
            out.append(Finding("WARN", name, pname, "parameter has no description",
                               "state the expected form, with an example"))
        elif VAGUE.match(pdesc):
            out.append(Finding("WARN", name, pname,
                               f"description is vague: {pdesc!r}",
                               "say what a valid value looks like"))

        if has_enum and pname not in required:
            if not any(str(v).lower() in ("none", "any", "all") for v in p["enum"]):
                out.append(Finding("INFO", name, pname,
                                   "optional enum has no explicit 'none' member",
                                   "add 'none' so the model can say 'not applicable' "
                                   "instead of picking a wrong value; ours chose "
                                   "aggregate=count when it wanted rows"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="JSON file: OpenAI-style tools array")
    ap.add_argument("--strict", action="store_true",
                    help="exit nonzero on WARN as well as ERROR")
    a = ap.parse_args()

    tools = json.load(open(a.path))
    if isinstance(tools, dict):
        tools = tools.get("tools", [])

    findings: list[Finding] = []
    for t in tools:
        findings.extend(lint_tool(t.get("function", t)))

    print(f"* {a.path}: {len(tools)} tools, {len(findings)} findings")
    for sev in ("ERROR", "WARN", "INFO"):
        rows = [f for f in findings if f.sev == sev]
        if rows:
            print(f"\n{sev} ({len(rows)})")
            for f in rows:
                print(f)

    n_err = sum(f.sev == "ERROR" for f in findings)
    n_warn = sum(f.sev == "WARN" for f in findings)
    print(f"\n  {n_err} error(s), {n_warn} warning(s)")
    if not findings:
        print("  clean — these schemas give a small model a fair chance")
    return 1 if (n_err or (a.strict and n_warn)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
