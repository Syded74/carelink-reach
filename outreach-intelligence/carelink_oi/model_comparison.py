"""Rolling-origin comparison of forecasting models against the operational baseline.

Candidates: StatsForecast intermittent-demand models (Croston classic / optimized / SBA, TSB,
ADIDA, IMAPA) and simple baselines; MLForecast models as an experiment when history allows.
Every model is scored on the same one-week-ahead windows as carelink_oi.forecast's baseline.

Missing vs zero: a week that never reached the server is MISSING. For model input it is filled
with the mean of earlier reported weeks only (never zero, never a later value), and it is never
scored. A reported week with no work items is a true zero and is scored like any other week.

Decision rule (declared before looking at results): the operational baseline is replaced only if
a candidate's pooled MAE is at least 10% lower AND it is not more than 10% worse for any single
community, including the poorly reported one. Otherwise the baseline stays.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import forecast
from .data_adapter import Dataset

WINDOWS = 26
IMPROVEMENT = 0.10
COMMUNITY_TOLERANCE = 0.10
FREQ = "W-MON"


def long_frame(dataset: Dataset) -> pd.DataFrame:
    rows = []
    for cid, s in forecast.series(dataset).items():
        seen = []
        for period, value in zip(s.periods, s.values):
            imputed = value is None
            if imputed and not seen:
                continue  # No earlier observation exists; never invent a leading zero.
            y = float(np.mean(seen)) if imputed else float(value)
            rows.append({"unique_id": cid, "ds": pd.Timestamp(period), "y": y, "reported": not imputed})
            if not imputed:
                seen.append(value)
    return pd.DataFrame(rows)


def intermittency(df: pd.DataFrame) -> dict:
    """Share of reported weeks with zero work items, and average gap between non-zero weeks (ADI)."""
    out = {}
    for cid, g in df[df.reported].groupby("unique_id"):
        nonzero = int((g.y > 0).sum())
        out[cid] = {"zero_share": round(float((g.y == 0).mean()), 3), "adi": round(len(g) / nonzero, 2) if nonzero else None,
                    "reported_weeks": int(len(g))}
    return out


def _stats_models():
    from statsforecast.models import (ADIDA, IMAPA, TSB, CrostonClassic, CrostonOptimized, CrostonSBA, HistoricAverage,
                                      Naive, SeasonalNaive, SimpleExponentialSmoothing, WindowAverage)
    return [CrostonClassic(), CrostonOptimized(), CrostonSBA(), TSB(alpha_d=0.2, alpha_p=0.2), ADIDA(), IMAPA(),
            Naive(), WindowAverage(window_size=4), SeasonalNaive(season_length=52), HistoricAverage(),
            SimpleExponentialSmoothing(alpha=0.3)]


def _score(cv: pd.DataFrame, df: pd.DataFrame, models: list[str]) -> pd.DataFrame:
    """Keep only windows whose target week was actually reported (missing weeks are never scored)."""
    reported = df[["unique_id", "ds", "reported"]]
    cv = cv.merge(reported, on=["unique_id", "ds"], how="left")
    return cv[cv.reported.fillna(False)].drop(columns=["reported"])


def _metrics(err: np.ndarray) -> dict:
    return {"n": int(len(err)), "mae": round(float(np.mean(np.abs(err))), 3), "rmse": round(float(np.sqrt(np.mean(err ** 2))), 3),
            "bias": round(float(np.mean(err)), 3)}


def compare(dataset: Dataset, windows: int = WINDOWS, with_ml: bool = True) -> dict:
    from statsforecast import StatsForecast

    df = long_frame(dataset)
    if df.empty or df.groupby("unique_id").size().min() < windows + 8:
        return {"status": "not_run", "reason": f"Needs at least {windows + 8} weeks per community for {windows} rolling windows."}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sf = StatsForecast(models=_stats_models(), freq=FREQ, n_jobs=1)
        cv = sf.cross_validation(df=df[["unique_id", "ds", "y"]], h=1, n_windows=windows, step_size=1)
    cv = cv.reset_index() if "unique_id" not in cv.columns else cv
    models = [c for c in cv.columns if c not in ("unique_id", "ds", "cutoff", "y")]

    # The operational baseline, computed on exactly the same windows from reported weeks only.
    all_series = forecast.series(dataset)
    # Freeze baseline selection on the initial training period, before ANY scored target.
    # Selecting the baseline using the full series would leak evaluation outcomes.
    cutoff = cv["cutoff"].min().date().isoformat()
    training = {}
    for cid, values in all_series.items():
        n = sum(period <= cutoff for period in values.periods)
        training[cid] = forecast.Series(cid, values.periods[:n], values.values[:n], values.rows[:n])
    baseline_method = forecast.select_method(training)[0] or "mean_4"
    base = []
    for _, r in cv.iterrows():
        s = all_series[r.unique_id]
        t = s.periods.index(r.ds.date().isoformat())
        base.append(forecast.predict(baseline_method, s.values[:t]))
    cv["operational_baseline"] = base
    models = ["operational_baseline", *models]

    ml = mlforecast_experiment(df, windows) if with_ml else {"status": "not_run", "reason": "disabled"}
    if ml.get("cv") is not None:
        cv = cv.merge(ml.pop("cv"), on=["unique_id", "ds"], how="left")
        models += ml["models"]

    scored = _score(cv, df, models)
    median = float(scored.y.median())
    table = {}
    for m in models:
        ok = scored[m].notna()
        err = (scored.loc[ok, m] - scored.loc[ok, "y"]).to_numpy()
        per = {cid: _metrics((g[m] - g.y).to_numpy())["mae"] for cid, g in scored[ok].groupby("unique_id")}
        table[m] = {**_metrics(err), "by_community": per,
                    "low_demand_mae": _metrics((scored.loc[ok & (scored.y <= median), m] - scored.loc[ok & (scored.y <= median), "y"]).to_numpy())["mae"],
                    "high_demand_mae": _metrics((scored.loc[ok & (scored.y > median), m] - scored.loc[ok & (scored.y > median), "y"]).to_numpy())["mae"],
                    "family": "operational" if m == "operational_baseline" else ("mlforecast (experimental)" if m in ml.get("models", []) else "statsforecast")}
    decision = decide(table)
    zero = max(v["zero_share"] for v in intermittency(df).values())
    decision["intermittency_note"] = (
        f"Demand here is not intermittent (at most {zero:.0%} of reported weeks are zero), so Croston-family models "
        "are outside their intended use; their gains come from heavier smoothing." if zero < 0.3 else
        f"Demand is intermittent (up to {zero:.0%} zero weeks): Croston/TSB models are appropriate candidates.")
    return {"status": "compared", "baseline_method": baseline_method, "baseline_selected_through": cutoff, "windows": windows, "scored_weeks": int(len(scored)), "intermittency": intermittency(df),
            "table": table, "ranking": sorted(table, key=lambda m: table[m]["mae"]), "decision": decision, "mlforecast": ml,
            "missing_weeks_imputed_for_input_only": int((~df.reported).sum()), "synthetic_data": dataset.synthetic}


def decide(table: dict) -> dict:
    base = table["operational_baseline"]
    if base["mae"] <= 0:
        return {"operational_model": "operational_baseline", "changed": False, "reason": "The baseline has zero back-test error; no relative improvement is possible."}
    best, reason = None, None
    for m, v in sorted(table.items(), key=lambda kv: kv[1]["mae"]):
        if m == "operational_baseline" or "experimental" in v["family"]:
            continue
        pooled_gain = 1 - v["mae"] / base["mae"]
        if set(v["by_community"]) != set(base["by_community"]):
            continue
        worst = max((v["by_community"][c] / base["by_community"][c] - 1 if base["by_community"][c] > 0 else
                     (0.0 if v["by_community"][c] == 0 else float("inf"))) for c in base["by_community"])
        if pooled_gain >= IMPROVEMENT and worst <= COMMUNITY_TOLERANCE:
            best = m
            reason = f"{m} lowers pooled MAE by {pooled_gain:.0%} and is at most {worst:.0%} worse for any community."
            break
    if best is None:
        leader = min((m for m in table if m != "operational_baseline" and "experimental" not in table[m]["family"]), key=lambda m: table[m]["mae"])
        gain = 1 - table[leader]["mae"] / base["mae"]
        reason = (f"No candidate met the rule (≥{IMPROVEMENT:.0%} lower pooled MAE and ≤{COMMUNITY_TOLERANCE:.0%} worse for every community). "
                  f"Best StatsForecast model: {leader}, MAE {table[leader]['mae']} vs {base['mae']} ({gain:.0%} lower overall; "
                  f"high-demand weeks {table[leader].get('high_demand_mae', '—')} vs {base.get('high_demand_mae', '—')}).")
    return {"operational_model": best or "operational_baseline", "changed": best is not None, "reason": reason}


def mlforecast_experiment(df: pd.DataFrame, windows: int) -> dict:
    # Count only observations available before the first rolling test window.
    training = df[df.groupby("unique_id").cumcount() < df.groupby("unique_id")["ds"].transform("size") - windows]
    observed = training[training.reported].groupby("unique_id").size()
    if len(observed) != df.unique_id.nunique() or observed.min() < 52:
        return {"status": "not_run", "reason": "MLForecast needs at least 52 reported training weeks per community before the first test window.", "models": []}
    from mlforecast import MLForecast
    from mlforecast.lag_transforms import RollingMean
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.linear_model import PoissonRegressor

    data = df[["unique_id", "ds", "y"]].copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        mlf = MLForecast(models={"mlf_poisson": PoissonRegressor(alpha=1.0, max_iter=1000),
                                 "mlf_random_forest": RandomForestRegressor(n_estimators=200, min_samples_leaf=3, random_state=0)},
                         freq=FREQ, lags=[1, 2, 4], lag_transforms={1: [RollingMean(window_size=4)]}, date_features=["week"])
        cv = mlf.cross_validation(df=data, h=1, n_windows=windows, step_size=1, refit=True)
    return {"status": "experimental", "models": ["mlf_poisson", "mlf_random_forest"],
            "features": ["lags 1, 2, 4", "rolling mean of last 4 (shifted 1)", "ISO week"],
            "excluded_inputs": ["danger signs", "clinical measurements", "any person-level data"],
            "cv": cv[["unique_id", "ds", "mlf_poisson", "mlf_random_forest"]]}
