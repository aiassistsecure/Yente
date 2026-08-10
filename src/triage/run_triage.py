#!/usr/bin/env python3
"""Run the triage tool over fixture emails and grade it in BOTH directions.

Two failure modes matter and they pull against each other:

  MISCLASSIFIED  - a clear message got the wrong intent
  OVERCONFIDENT  - an ambiguous message got a confident, actionable intent.
                   This is the dangerous one: Yente would act on a message it
                   misread. Graded as a pass only if the model either answered
                   'unknown' or marked itself 'unsure'.
  OVERCAUTIOUS   - a clear message was punted to 'unknown'/'unsure'. Not
                   dangerous, but a desk that escalates everything is useless,
                   so it is measured rather than ignored.

A check that only tests the true-positive direction is one people learn to
ignore.
"""
import argparse
import json
import re
import sys
import urllib.request

SYS = (
    "You triage inbound email for Yente, a service that introduces startup "
    "founders to investors. You always answer by calling the triage_email tool "
    "exactly once. You never reply in prose."
)

ACTIONABLE = {
    "new_inbound", "interview_answer", "proposal_interested", "proposal_pass",
    "availability_reply", "invite_response", "reschedule_request",
    "unsubscribe", "delete_me",
}


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower())).strip()


def grounded(evidence, body, subject):
    e, hay = norm(evidence), norm(subject + " " + body)
    if not e:
        return "EMPTY"
    if e in hay:
        return "exact"
    toks = [t for t in e.split() if len(t) > 2]
    if toks and sum(1 for t in toks if t in hay) / len(toks) >= 0.8:
        return "fuzzy"
    return "INVENTED"


def verdict(kind, expect, intent, conf, clarity=None):
    """Grade one triage result. Pure function so it can be tested directly.

    Abstention is a CODE decision, not a model one: anything other than
    clarity == 'one_clear_intent' routes to a human regardless of the label the
    model attached. The model reports a signal; the router enforces the rule.
    """
    abstained = (intent == "unknown") or (conf == "unsure") or (
        clarity is not None and clarity != "one_clear_intent")
    if kind == "clear":
        # Escalation wins over the label: if the router will punt this to a
        # human, the desk did not act on it, whatever the model called it.
        if abstained:
            return "OVERCAUTIOUS"
        return "PASS" if intent in (expect or []) else "MISCLASSIFIED"
    # ambiguous: abstaining is the correct answer
    if abstained:
        return "PASS"
    return "OVERCONFIDENT" if intent in ACTIONABLE else "PASS"


def call(url, tools, case, timeout=600):
    user = (
        f"What Yente knows about the sender: {case['context']}\n\n"
        f"--- message ---\n"
        f"Subject: {case['subject']}\n\n{case['body']}\n--- end ---\n\n"
        f"Triage this message."
    )
    body = {
        "messages": [{"role": "system", "content": SYS},
                     {"role": "user", "content": user}],
        "tools": tools, "tool_choice": "auto",
        "temperature": 0.0, "max_tokens": 400,
    }
    req = urllib.request.Request(
        f"{url}/v1/chat/completions", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--tools", default="src/triage/schema.json")
    ap.add_argument("--cases", default="tests/fixtures/triage_cases.json")
    ap.add_argument("--out", default="triage_results.json")
    ap.add_argument("--label", default="model")
    a = ap.parse_args()

    tools = json.load(open(a.tools))
    cases = json.load(open(a.cases))
    props = tools[0]["function"]["parameters"]["properties"]
    enums = {k: set(v["enum"]) for k, v in props.items() if "enum" in v}
    required = tools[0]["function"]["parameters"]["required"]

    rows = []
    for c in cases:
        rec = {"id": c["id"], "kind": c["kind"]}
        try:
            msg = call(a.url, tools, c)["choices"][0]["message"]
            tcs = msg.get("tool_calls") or []
            if not tcs:
                rec.update(verdict="NO_TOOL_CALL", prose=(msg.get("content") or "")[:160])
                rows.append(rec); print(f"  {c['id']:28s} NO_TOOL_CALL"); continue
            args = json.loads(tcs[0]["function"]["arguments"])
            rec["args"] = args

            problems = []
            if tcs[0]["function"]["name"] != "triage_email":
                problems.append("wrong_tool")
            for k in required:
                if k not in args:
                    problems.append(f"missing:{k}")
            for k, allowed in enums.items():
                if k in args and args[k] not in allowed:
                    problems.append(f"bad_enum:{k}={args[k]!r}")
            rec["well_formed"] = not problems
            rec["problems"] = problems

            intent = args.get("intent")
            conf = args.get("confidence")
            rec["grounding"] = grounded(args.get("evidence"), c["body"], c["subject"])

            clarity = args.get("clarity")
            rec["clarity"] = clarity
            rec["verdict"] = verdict(c["kind"], c.get("expect"), intent, conf, clarity)

            print(f"  {c['id']:32s} {rec['verdict']:14s} {str(clarity):22s} "
                  f"{str(intent):20s} {str(conf):8s} ground={rec['grounding']:8s} {';'.join(problems)}")
        except Exception as ex:
            rec.update(verdict="EXCEPTION", error=str(ex)[:200])
            print(f"  {c['id']:28s} EXCEPTION {str(ex)[:100]}")
        rows.append(rec)

    n = len(rows)
    wf = sum(1 for r in rows if r.get("well_formed"))
    clear = [r for r in rows if r["kind"] == "clear"]
    amb = [r for r in rows if r["kind"] == "ambiguous"]
    cp = sum(1 for r in clear if r["verdict"] == "PASS")
    ap_ = sum(1 for r in amb if r["verdict"] == "PASS")
    oc = sum(1 for r in rows if r["verdict"] == "OVERCONFIDENT")
    ocaut = sum(1 for r in rows if r["verdict"] == "OVERCAUTIOUS")
    mis = sum(1 for r in rows if r["verdict"] == "MISCLASSIFIED")
    inv = sum(1 for r in rows if r.get("grounding") == "INVENTED")

    summary = {"label": a.label, "cases": n, "well_formed": wf,
               "clear_correct": f"{cp}/{len(clear)}", "ambiguous_abstained": f"{ap_}/{len(amb)}",
               "overconfident": oc, "overcautious": ocaut, "misclassified": mis,
               "evidence_invented": inv}
    json.dump({"summary": summary, "rows": rows}, open(a.out, "w"), indent=1)

    print(f"\n  {a.label}")
    print(f"    well-formed calls      {wf}/{n}")
    print(f"    clear correct          {cp}/{len(clear)}")
    print(f"    ambiguous abstained    {ap_}/{len(amb)}   <-- the safety number")
    print(f"    OVERCONFIDENT          {oc}   <-- acted on a message it misread")
    print(f"    overcautious           {ocaut}")
    print(f"    misclassified          {mis}")
    print(f"    evidence invented      {inv}")
    return 0 if (oc == 0 and wf == n) else 1


if __name__ == "__main__":
    sys.exit(main())
