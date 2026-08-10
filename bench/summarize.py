#!/usr/bin/env python3
"""Print the bake-off comparison table from bench/results/*.json.

The column that decides anything is MISCLASS: a confidently wrong intent on a
clear message. OVERCONF is second: a confident actionable label on a message
that was genuinely ambiguous. Everything else is context.
"""
import glob
import json
import os
import sys

BASELINE = {
    "label": "4B (sandbox, 2 vCPU)",
    "well_formed": 23, "clear_correct": "14/16", "ambiguous_abstained": "4/7",
    "overconfident": 3, "misclassified": 0, "evidence_invented": 0,
    "wall_seconds": None, "resident_mb": 2400,
}


def rows(d):
    out = []
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        try:
            s = json.load(open(f)).get("summary", {})
        except Exception:
            continue
        s.setdefault("label", os.path.basename(f)[:-5])
        out.append(s)
    return out


def fmt(s):
    wall = s.get("wall_seconds")
    return (f"{str(s.get('label'))[:26]:28s} "
            f"{str(s.get('well_formed', '?')) + '/23':10s} "
            f"{str(s.get('clear_correct', '?')):9s} "
            f"{str(s.get('ambiguous_abstained', '?')):11s} "
            f"{str(s.get('overconfident', '?')):9s} "
            f"{str(s.get('misclassified', '?')):9s} "
            f"{str(s.get('evidence_invented', '?')):9s} "
            f"{(str(wall) + 's') if wall else '-':8s} "
            f"{str(s.get('resident_mb', '?')) + 'MB':9s}")


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "bench/results"
    rs = rows(d)
    if not rs:
        print(f"no results in {d}")
        return 1
    hdr = (f"{'model':28s} {'wellform':10s} {'clear':9s} {'abstained':11s} "
           f"{'OVERCONF':9s} {'MISCLASS':9s} {'invented':9s} {'wall':8s} {'RSS':9s}")
    print(hdr)
    print("-" * len(hdr))
    print(fmt(BASELINE))
    for s in rs:
        print(fmt(s))
    print()

    clean = [s for s in rs if s.get("misclassified") == 0]
    if clean:
        best = min(clean, key=lambda s: (s.get("overconfident", 99),
                                         -int(str(s.get("ambiguous_abstained", "0/7")).split("/")[0])))
        print(f"zero-misclassification models: {', '.join(s['label'] for s in clean)}")
        print(f"best of those: {best['label']} "
              f"(overconfident {best.get('overconfident')}, "
              f"abstained {best.get('ambiguous_abstained')})")
    else:
        print("NO model reached zero misclassifications. The 4B baseline did.")
    print("\nA model that misclassifies a clear message is disqualified regardless "
          "of speed:\nthe 2B read 'Declining' on a calendar invite as 'unsubscribe'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
