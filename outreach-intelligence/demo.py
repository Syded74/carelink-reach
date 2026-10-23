"""Reproducible fictional demo: runs every scenario through the real forecaster and CP-SAT solver.

    .venv/bin/python demo.py            # prints the results and writes ../evidence/outreach-intelligence-demo.{json,md}
"""
from __future__ import annotations

import json
from pathlib import Path

from carelink_oi import data_adapter, forecast, planning, synthetic

EVIDENCE = Path(__file__).resolve().parent.parent / "evidence"


def main() -> None:
    dataset = data_adapter.parse(synthetic.hackathon_dataset())
    Path(__file__).with_name("data").joinpath("hackathon-villages.json").write_text(json.dumps(synthetic.hackathon_dataset(), indent=1))
    estimate = forecast.estimate(dataset)
    ml = forecast.ml_experiment(dataset)
    runs = []
    lines = ["# Outreach Intelligence — fictional demo results", "",
             f"Dataset `{dataset.dataset_id}` (synthetic, sha256 {dataset.sha256[:16]}…), as of {dataset.as_of}. "
             "Every number below was produced by running the code; nothing is hand-written.", "",
             "## Demand estimate", "", "| Community | Documented now | Estimate next week | Method | Back-test MAE | Weeks reported (12) |", "|---|---:|---:|---|---:|---:|"]
    for c in estimate["communities"]:
        lines.append(f"| {c['community']} | {c['current']['pending_followups']} | {c['estimate']} | {c['method']} | "
                     f"{c['validation']['mae'] if c['validation'] else '—'} | {round(c['data_coverage_12w'] * 100)}% |")
    lines += ["", f"ML experiment: {ml.get('conclusion', ml.get('reason'))}", "", "## Schedules", ""]
    for name in synthetic.SCENARIOS:
        resources = planning.hackathon_resources(name)
        plan = planning.build(dataset, resources)
        r, x = plan["result"], plan["explanation"]
        runs.append({"scenario": name, "label": resources["label"], "status": r["status"], "served": r.get("served"),
                     "trips": r.get("trips"), "explanation": x})
        lines += [f"### {resources['label']} — {r['status']}", "", x["summary"], ""]
        for t in r["trips"]:
            lines.append(f"- {t['worker_name']} ({t['vehicle']}): {' → '.join(t['route'])}; covers {t['served']}; "
                         f"travel {t['travel_minutes']} + visits {t['service_minutes']} = {t['total_minutes']} of {t['available_minutes']} min")
        lines += [f"- {t}" for t in x.get("communities", {}).values()]
        lines += [f"- Constraint: {t}" for t in x.get("binding", [])]
        lines += [f"- Infeasible: {t}" for t in x.get("reasons", [])]
        lines += [f"- What if {w['change']}: +{w['extra_items_served']} items" for w in x.get("what_if", []) or []]
        lines.append("")
    fair = planning.build(dataset, planning.hackathon_resources("baseline"),
                          {"min_coverage": {"enabled": True, "communities": ["village-c"], "min_followups": 1}})
    lines += ["### Baseline with the minimum-coverage policy for Village C", "", fair["explanation"]["summary"], ""]
    lines += [f"- {t['worker_name']}: {' → '.join(t['route'])}; covers {t['served']}" for t in fair["result"]["trips"]]
    EVIDENCE.mkdir(exist_ok=True)
    (EVIDENCE / "outreach-intelligence-demo.json").write_text(json.dumps({"estimate": estimate, "ml_experiment": ml, "runs": runs,
                                                                         "fairness_policy_run": fair["result"]}, indent=2))
    (EVIDENCE / "outreach-intelligence-demo.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
