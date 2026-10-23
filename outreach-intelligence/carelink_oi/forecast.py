"""Community outreach-demand estimation.

Target: next week's routine outreach workload per community (new requests + follow-ups due +
recorded missed appointments + open referrals). This is a count of operational work items. It is
not a clinical risk, an urgency, or a prediction about any person. Danger signs are not inputs.

Stage A (used for estimates): transparent baselines chosen by back-testing.
Stage B (experimental only): Poisson regression, compared with the best baseline on a time-based
held-out split. It never drives the planner in this prototype.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

import numpy as np

from . import FORECAST_VERSION
from .data_adapter import Dataset, workload

MIN_HISTORY = 8          # observed weeks needed before any back-tested baseline is used
BACKTEST_WEEKS = 26
ML_MIN_WEEKS = 52        # per community, before the ML experiment runs at all
COVERAGE_WINDOW = 12
METHODS = ["last_value", "mean_4", "ewma_0.3", "seasonal_naive_52"]
METHOD_TEXT = {
    "last_value": "the most recent reported week",
    "mean_4": "the average of the last 4 reported weeks",
    "ewma_0.3": "an exponentially weighted average of reported weeks (recent weeks count more)",
    "seasonal_naive_52": "the same week one year earlier",
    "insufficient_history": "the average of the few weeks available",
}


@dataclass
class Series:
    community_id: str
    periods: list[str]           # every week from first to last, including unreported weeks
    values: list[int | None]     # None = the week never reached the server (missing, not zero)
    rows: list[dict | None]


def series(dataset: Dataset) -> dict[str, Series]:
    out = {}
    for c in dataset.communities:
        rows = {r["period_start"]: r for r in dataset.history if r["community_id"] == c["id"]}
        if not rows:
            out[c["id"]] = Series(c["id"], [], [], [])
            continue
        start, end = dt.date.fromisoformat(min(rows)), dt.date.fromisoformat(max(rows))
        periods = [(start + dt.timedelta(weeks=i)).isoformat() for i in range((end - start).days // 7 + 1)]
        picked = [rows.get(p) for p in periods]
        out[c["id"]] = Series(c["id"], periods, [workload(r) if r and r.get("reported", True) else None for r in picked], picked)
    return out


def _observed(values: list[int | None]) -> list[int]:
    return [v for v in values if v is not None]


def predict(method: str, past: list[int | None]) -> float | None:
    """Forecast for the period right after `past`, using `past` only (no future data)."""
    seen = _observed(past)
    if not seen:
        return None
    if method == "last_value":
        return float(seen[-1])
    if method == "mean_4":
        return float(np.mean(seen[-4:]))
    if method == "ewma_0.3":
        level = float(seen[0])
        for v in seen[1:]:
            level = 0.3 * v + 0.7 * level
        return level
    if method == "seasonal_naive_52":
        return float(past[-52]) if len(past) >= 52 and past[-52] is not None else None
    raise ValueError(method)


def backtest(s: Series, method: str, weeks: int = BACKTEST_WEEKS) -> list[tuple[float, int]]:
    pairs = []
    for t in range(max(1, len(s.values) - weeks), len(s.values)):
        actual = s.values[t]
        if actual is None or len(_observed(s.values[:t])) < MIN_HISTORY:
            continue
        guess = predict(method, s.values[:t])
        if guess is not None:
            pairs.append((guess, actual))
    return pairs


def metrics(pairs: list[tuple[float, int]]) -> dict | None:
    if not pairs:
        return None
    err = np.array([g - a for g, a in pairs])
    return {"n": len(pairs), "mae": round(float(np.mean(np.abs(err))), 2),
            "rmse": round(float(math.sqrt(np.mean(err ** 2))), 2), "bias": round(float(np.mean(err)), 2)}


def coverage(s: Series, window: int = COVERAGE_WINDOW) -> float:
    recent = s.values[-window:]
    return round(sum(v is not None for v in recent) / window, 2) if recent else 0.0


def select_method(all_series: dict[str, Series]) -> tuple[str | None, dict]:
    """One baseline for the whole dataset: the lowest pooled back-test MAE."""
    table = {}
    for m in METHODS:
        pairs = [p for s in all_series.values() for p in backtest(s, m)]
        table[m] = metrics(pairs)
    usable = {m: v for m, v in table.items() if v and v["n"] >= 10}
    return (min(usable, key=lambda m: (usable[m]["mae"], METHODS.index(m))) if usable else None), table


def estimate(dataset: Dataset) -> dict:
    all_series = series(dataset)
    method, table = select_method(all_series)
    next_week = (dt.date.fromisoformat(dataset.as_of) - dt.timedelta(days=dt.date.fromisoformat(dataset.as_of).weekday()) + dt.timedelta(weeks=1)).isoformat()
    out = []
    for c in dataset.communities:
        s = all_series[c["id"]]
        seen = _observed(s.values)
        warnings = ["Volunteer reporting coverage is unknown: no expected-reporter roster or reporting denominator is configured. Weekly data availability is not volunteer participation."]
        cov = coverage(s)
        if dataset.synthetic:
            warnings.append("Includes simulated past weeks: not real reporting from this community.")
        if cov < 0.75:
            warnings.append(f"Only {round(cov * 100)}% of the last {COVERAGE_WINDOW} weeks reached the server. "
                            "Low reporting can mean poor access, not low need.")
        used = method
        if len(seen) < MIN_HISTORY or method is None:
            used = "insufficient_history"
            value = round(float(np.mean(seen)), 1) if seen else None
            warnings.append(f"Only {len(seen)} reported week(s): too little history for a tested forecast. "
                            "Treat this as a description of recent weeks, not a prediction.")
        else:
            value = predict(method, s.values)
            if value is None:
                used, value = "mean_4", predict("mean_4", s.values)
            value = round(value, 1)
        own = metrics(backtest(s, used)) if used != "insufficient_history" else None
        recent_rows = [r for r in s.rows[-4:] if r and r.get("reported", True)]
        totals = {k: sum(r[k] for r in recent_rows) for k in ["requests_created", "followups_due", "missed_appointments", "referrals_open", "transport_barriers"]}
        recent_mean = round(float(np.mean(seen[-4:])), 1) if seen else None
        out.append({
            "community_id": c["id"], "community": c["name"], "barrier_level": c["barrier_level"],
            "forecast_period": f"week of {next_week}", "estimate": value, "unit": "routine outreach work items per week",
            "method": used, "model_version": FORECAST_VERSION, "validation": own,
            "validation_status": "back-tested on simulated history (not validated on real data)" if dataset.synthetic
            else ("back-tested" if own else "not validated: insufficient history"),
            "input_period": f"{s.periods[0]} to {s.periods[-1]}" if s.periods else "none",
            "reported_weeks": len(seen), "data_coverage_12w": cov,
            "volunteer_reporting_coverage": None,
            "reporting_quality": {"missing_weeks": sum(v is None for v in s.values), "reported_zero_weeks": sum(v == 0 for v in s.values if v is not None),
                                  "coverage_period_end": s.periods[-1] if s.periods else None, "volunteer_denominator_available": False}, "recent_weeks": [v for v in s.values[-4:]],
            "recent_mean": recent_mean, "contributors_last_4_weeks": totals,
            "current": dataset.current.get(c["id"]), "warnings": warnings,
        })
        out[-1]["explanation"] = explain(out[-1])
    return {"dataset_id": dataset.dataset_id, "as_of": dataset.as_of, "method": method, "method_comparison": table,
            "model_version": FORECAST_VERSION, "communities": out}


def explain(e: dict) -> str:
    parts = []
    cur = e.get("current") or {}
    if cur:
        parts.append(f"{e['community']} has {cur['pending_followups']} documented routine follow-up item(s) pending now")
    contributors = e["contributors_last_4_weeks"]
    top = sorted(((v, k) for k, v in contributors.items() if k != "transport_barriers" and v), reverse=True)[:2]
    if top:
        labels = {"requests_created": "new help requests", "followups_due": "follow-ups falling due",
                  "missed_appointments": "recorded missed appointments", "referrals_open": "open referrals"}
        parts.append("in the last 4 reported weeks, workload came mostly from " + " and ".join(f"{labels[k]} ({v})" for v, k in top))
    n = contributors.get("transport_barriers")
    if n:
        parts.append(f"{n} transport {'difficulty was' if n == 1 else 'difficulties were'} reported in those weeks")
    text = "; ".join(parts) + "." if parts else f"{e['community']} has no recent reported workload."
    if e["estimate"] is None:
        return text + " No estimate: no reported weeks."
    text += f" Estimated {e['estimate']} work items for the {e['forecast_period']}, based on {METHOD_TEXT[e['method']]}"
    if e["validation"]:
        text += f"; in back-testing this was typically off by about {e['validation']['mae']} items"
    return text + ". " + " ".join(e["warnings"])


# ---- Stage B: experimental machine learning --------------------------------------------------

def _features(s: Series, t: int, barrier: float) -> list[float]:
    past = s.values[:t]
    seen = _observed(past)
    mean_all = float(np.mean(seen)) if seen else 0.0
    lag = lambda k: past[-k] if len(past) >= k and past[-k] is not None else mean_all
    week = dt.date.fromisoformat(s.periods[t]).isocalendar().week
    rows = [r for r in s.rows[max(0, t - 4):t] if r and r.get("reported", True)]
    barriers = float(np.mean([r["transport_barriers"] for r in rows])) if rows else 0.0
    missing = sum(v is None for v in past[-4:]) / 4 if past else 1.0
    return [lag(1), lag(2), predict("mean_4", past) or mean_all, math.sin(2 * math.pi * week / 52),
            math.cos(2 * math.pi * week / 52), barriers, missing, barrier]


def ml_experiment(dataset: Dataset, test_weeks: int = BACKTEST_WEEKS) -> dict:
    """Poisson regression vs the best baseline on the same held-out weeks (time-based split)."""
    from sklearn.linear_model import PoissonRegressor

    all_series = series(dataset)
    longest = max((len(s.values) for s in all_series.values()), default=0)
    if min((len(_observed(s.values)) for s in all_series.values()), default=0) < ML_MIN_WEEKS:
        return {"status": "not_run", "reason": f"Needs at least {ML_MIN_WEEKS} reported weeks per community; "
                "the available history is too short for a fair train/test split."}
    split = longest - test_weeks
    bar = {c["id"]: {"high": 1.0, "low": 0.0}.get(c["barrier_level"], 0.5) for c in dataset.communities}
    X_tr, y_tr, test = [], [], []
    for cid, s in all_series.items():
        for t in range(MIN_HISTORY, len(s.values)):
            if s.values[t] is None:
                continue
            if t < split:
                X_tr.append(_features(s, t, bar[cid])); y_tr.append(s.values[t])
            else:
                test.append((cid, t, s.values[t]))
    model = PoissonRegressor(alpha=1.0, max_iter=1000).fit(np.array(X_tr), np.array(y_tr))
    baseline, _ = select_method({k: Series(v.community_id, v.periods[:split], v.values[:split], v.rows[:split]) for k, v in all_series.items()})
    ml_pairs, base_pairs, by_comm = [], [], {}
    for cid, t, actual in test:
        s = all_series[cid]
        ml_guess = float(model.predict(np.array([_features(s, t, bar[cid])]))[0])
        base_guess = predict(baseline, s.values[:t]) or predict("mean_4", s.values[:t])
        ml_pairs.append((ml_guess, actual)); base_pairs.append((base_guess, actual))
        by_comm.setdefault(cid, {"ml": [], "baseline": []})
        by_comm[cid]["ml"].append((ml_guess, actual)); by_comm[cid]["baseline"].append((base_guess, actual))
    median = float(np.median([a for _, a in ml_pairs]))
    low = [i for i, (_, a) in enumerate(ml_pairs) if a <= median]
    high = [i for i, (_, a) in enumerate(ml_pairs) if a > median]
    pick = lambda pairs, idx: metrics([pairs[i] for i in idx])
    result = {
        "status": "experimental", "model": "PoissonRegressor(alpha=1.0)", "features": [
            "lag 1 week", "lag 2 weeks", "mean of last 4 reported weeks", "season (sin)", "season (cos)",
            "transport barriers, last 4 weeks", "share of last 4 weeks unreported", "community barrier level"],
        "excluded_inputs": ["danger signs", "clinical measurements", "any person-level data"],
        "train_weeks": f"{all_series[next(iter(all_series))].periods[MIN_HISTORY]} to {all_series[next(iter(all_series))].periods[split - 1]}",
        "test_weeks": f"{all_series[next(iter(all_series))].periods[split]} to {all_series[next(iter(all_series))].periods[-1]}",
        "baseline": baseline, "ml": metrics(ml_pairs), "baseline_metrics": metrics(base_pairs),
        "by_community": {cid: {"ml": metrics(v["ml"]), "baseline": metrics(v["baseline"])} for cid, v in by_comm.items()},
        "low_demand_weeks": {"ml": pick(ml_pairs, low), "baseline": pick(base_pairs, low)},
        "high_demand_weeks": {"ml": pick(ml_pairs, high), "baseline": pick(base_pairs, high)},
        "synthetic_data": dataset.synthetic,
    }
    better = result["ml"]["mae"] < result["baseline_metrics"]["mae"]
    result["conclusion"] = (
        f"On held-out weeks the Poisson model's MAE is {result['ml']['mae']} vs {result['baseline_metrics']['mae']} for the "
        f"{baseline} baseline ({'lower' if better else 'not lower'}; this baseline was chosen on the training weeks only, "
        "so it can differ from the one used for the live estimates). "
        + ("Simulated history shows the pipeline works, not that the model is better for real communities. "
           if dataset.synthetic else "")
        + "The planner keeps using the transparent baseline; the model stays experimental.")
    return result
