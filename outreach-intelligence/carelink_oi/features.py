"""Forecast features and outputs for one exported CHT dataset (python -m carelink_oi.features <dataset.json> [--simulated]).

Prints, per community, the inputs the forecaster sees (pending items now, this week's recorded workload,
reported weeks) and what it predicts, so before-and-after snapshots of the feedback loop can be compared.
Read-only; never writes to CHT.
"""
from __future__ import annotations

import json
import sys

from . import data_adapter, forecast, synthetic


def features(raw: dict, simulated: bool = False) -> dict:
    dataset = data_adapter.parse(synthetic.with_demo_history(raw) if simulated else raw)
    estimate = forecast.estimate(dataset)
    this_week = max((r["period_start"] for r in raw["history"]), default=None)
    out = {"dataset": dataset.label, "as_of": dataset.as_of, "simulated_history": dataset.synthetic, "communities": {}}
    for c in estimate["communities"]:
        week = next((r for r in raw["history"] if r["community_id"] == c["community_id"] and r["period_start"] == this_week), {})
        out["communities"][c["community"]] = {
            "pending_now": (c["current"] or {}).get("pending_followups", 0),
            "requests_this_week": week.get("requests_created", 0), "visits_completed_this_week": week.get("visits_completed", 0),
            "this_week_reported": week.get("reported", False), "reported_weeks_of_12": round(c["data_coverage_12w"] * 12),
            "estimate_next_week": c["estimate"], "method": c["method"], "recent_mean": c["recent_mean"],
            "reporting_quality": c["reporting_quality"],
        }
    return out


if __name__ == "__main__":
    print(json.dumps(features(json.loads(open(sys.argv[1]).read()), "--simulated" in sys.argv[2:]), indent=2))
