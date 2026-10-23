import copy
import json

import pytest

from carelink_oi import data_adapter, forecast, synthetic


def tiny(history, current=None, **extra):
    return data_adapter.parse({"dataset_id": "t", "as_of": "2026-10-21", "synthetic": True,
                               "communities": [{"id": "c1", "name": "C1", "barrier_level": "high"}],
                               "history": history, "current": current or [], **extra})


def week(i):
    import datetime as dt
    return (dt.date(2026, 1, 5) + dt.timedelta(weeks=i)).isoformat()


def row(i, n, reported=True):
    return {"community_id": "c1", "period_start": week(i), "reported": reported, "requests_created": n if reported else 0}


def test_aggregation_counts_only_workload_fields():
    r = {"requests_created": 2, "followups_due": 3, "missed_appointments": 1, "referrals_open": 1, "visits_completed": 9, "transport_barriers": 4}
    assert data_adapter.workload(r) == 7, "visits and barriers are context, not workload"


def test_duplicate_period_rows_are_not_double_counted():
    d = tiny([row(0, 5), row(0, 5), row(1, 3)])
    assert d.duplicates_removed == 1
    assert [r["requests_created"] for r in d.history] == [5, 3]


def test_engine_inputs_reject_personal_fields():
    with pytest.raises(data_adapter.DatasetError):
        tiny([{**row(0, 1), "patient_name": "x"}])
    with pytest.raises(data_adapter.DatasetError):
        data_adapter.parse({"dataset_id": "t", "as_of": "2026-10-21", "communities": [{"id": "c1", "name": "C1", "phone": "0"}], "history": []})
    with pytest.raises(data_adapter.DatasetError):
        tiny([{**row(0, 1), "requests_created": -1}])


def test_missing_periods_are_missing_not_zero():
    d = tiny([row(0, 4), row(2, 6)])  # week 1 never reached the server
    s = forecast.series(d)["c1"]
    assert s.values == [4, None, 6]
    assert forecast.predict("mean_4", s.values) == 5.0
    unreported = tiny([row(0, 4), row(1, 0, reported=False), row(2, 6)])
    assert forecast.series(unreported)["c1"].values == [4, None, 6]


def test_rolling_baselines_are_exact():
    v = [2, 4, 6, 8, 10]
    assert forecast.predict("last_value", v) == 10
    assert forecast.predict("mean_4", v) == 7.0
    level = 2.0
    for x in v[1:]:
        level = 0.3 * x + 0.7 * level
    assert forecast.predict("ewma_0.3", v) == pytest.approx(level)
    assert forecast.predict("seasonal_naive_52", v) is None
    assert forecast.predict("seasonal_naive_52", list(range(60))) == 8.0


def test_no_future_data_leakage_in_backtest():
    s = forecast.series(tiny([row(i, 5 + (i % 3)) for i in range(30)]))["c1"]
    before = forecast.backtest(s, "mean_4")
    poisoned = copy.deepcopy(s)
    t = len(s.values) - 5  # change only the last 5 weeks
    poisoned.values = s.values[:t] + [999] * 5
    after = forecast.backtest(poisoned, "mean_4")
    assert [g for g, _ in after[: len(before) - 5]] == [g for g, _ in before[: len(before) - 5]]
    assert all(a == 999 for _, a in after[-5:])
    assert [g for g, _ in after[-5:]][0] == [g for g, _ in before[-5:]][0], "the first poisoned week is predicted from clean history"


def test_insufficient_history_is_labelled_not_forecast():
    e = forecast.estimate(tiny([row(0, 3), row(1, 5)], [{"community_id": "c1", "as_of": "2026-10-21", "pending_followups": 4}]))
    c = e["communities"][0]
    assert c["method"] == "insufficient_history" and c["validation"] is None
    assert any("too little history" in w for w in c["warnings"])
    assert "not validated" in c["validation_status"] or "synthetic" in c["validation_status"]


def test_explanations_carry_required_fields_and_no_invented_certainty():
    e = forecast.estimate(data_adapter.parse(synthetic.hackathon_dataset()))
    for c in e["communities"]:
        for key in ["forecast_period", "estimate", "input_period", "method", "model_version", "validation_status", "warnings", "explanation", "contributors_last_4_weeks"]:
            assert key in c
        assert "simulated past weeks" in c["explanation"]
    text = json.dumps(e).lower()
    assert "confidence" not in text and "interval" not in text and "probability" not in text
    village_c = next(c for c in e["communities"] if c["community_id"] == "village-c")
    assert any("not low need" in w for w in village_c["warnings"]), "low reporting is flagged, not read as low need"


def test_ml_experiment_is_reproducible_time_split_and_never_claims_more_than_shown():
    d = data_adapter.parse(synthetic.hackathon_dataset())
    a, b = forecast.ml_experiment(d), forecast.ml_experiment(d)
    assert a == b
    assert a["status"] == "experimental" and a["train_weeks"].split(" to ")[1] < a["test_weeks"].split(" to ")[0]
    assert "danger signs" in a["excluded_inputs"]
    assert ("not lower" in a["conclusion"]) == (a["ml"]["mae"] >= a["baseline_metrics"]["mae"])
    assert "keeps using the transparent baseline" in a["conclusion"]


def test_ml_does_not_run_on_short_history():
    assert forecast.ml_experiment(tiny([row(i, 3) for i in range(10)]))["status"] == "not_run"


def test_synthetic_dataset_is_deterministic():
    assert synthetic.hackathon_dataset() == synthetic.hackathon_dataset()
