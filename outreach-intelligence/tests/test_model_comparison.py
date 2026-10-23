"""Model comparison (StatsForecast / MLForecast vs the operational baseline) and solver regression."""
import pytest

from carelink_oi import data_adapter, model_comparison as mc, optimizer, synthetic

DATASET = data_adapter.parse(synthetic.hackathon_dataset())


@pytest.fixture(scope="module")
def result():
    return mc.compare(DATASET)


def test_every_candidate_is_scored_on_the_same_reported_weeks(result):
    assert result["status"] == "compared"
    counts = {m: v["n"] for m, v in result["table"].items() if m != "SeasonalNaive"}
    assert len(set(counts.values())) == 1, counts
    for name in ["CrostonClassic", "CrostonOptimized", "CrostonSBA", "TSB", "ADIDA", "IMAPA", "operational_baseline"]:
        assert name in result["table"]
    if result["mlforecast"]["status"] == "experimental":
        assert "mlf_poisson" in result["table"]
    else:
        assert "training weeks" in result["mlforecast"]["reason"]


def test_missing_weeks_are_imputed_for_input_only_never_scored(result):
    df = mc.long_frame(DATASET)
    unreported = df[~df.reported]
    assert len(unreported) == result["missing_weeks_imputed_for_input_only"] > 0
    reported_in_windows = df[df.reported].groupby("unique_id").tail(26)
    assert result["scored_weeks"] <= len(reported_in_windows)
    assert result["scored_weeks"] == result["table"]["operational_baseline"]["n"]


def test_imputation_uses_only_earlier_weeks():
    df = mc.long_frame(DATASET)
    c = df[df.unique_id == "village-c"].reset_index(drop=True)
    i = int(c.index[~c.reported][0])
    earlier = c.loc[: i - 1]
    assert c.loc[i, "y"] == pytest.approx(earlier[earlier.reported].y.mean())


def test_baseline_is_kept_unless_the_declared_rule_is_met(result):
    d = result["decision"]
    assert d["operational_model"] == "operational_baseline" and d["changed"] is False
    assert "not intermittent" in d["intermittency_note"]
    base = result["table"]["operational_baseline"]["mae"]
    best = min(v["mae"] for m, v in result["table"].items() if v["family"] == "statsforecast")
    assert best > base * (1 - mc.IMPROVEMENT), "no StatsForecast model reached a 10% improvement"


def test_decision_rule_switches_only_for_a_clear_and_fair_improvement():
    base = {"mae": 3.0, "by_community": {"a": 3.0, "c": 3.0}, "family": "operational"}
    good = {"mae": 2.5, "by_community": {"a": 2.4, "c": 3.1}, "family": "statsforecast"}
    unfair = {"mae": 2.5, "by_community": {"a": 2.0, "c": 3.6}, "family": "statsforecast"}
    ml = {"mae": 1.0, "by_community": {"a": 1.0, "c": 1.0}, "family": "mlforecast (experimental)"}
    assert mc.decide({"operational_baseline": base, "TSB": good})["operational_model"] == "TSB"
    assert mc.decide({"operational_baseline": base, "TSB": unfair})["operational_model"] == "operational_baseline", "worse for the poorly reported community"
    assert mc.decide({"operational_baseline": base, "TSB": unfair, "mlf": ml})["operational_model"] == "operational_baseline", "ML never becomes operational"


def test_comparison_is_reproducible():
    a, b = mc.compare(DATASET, with_ml=False), mc.compare(DATASET, with_ml=False)
    assert a["table"] == b["table"] and a["decision"] == b["decision"]


def test_short_history_is_not_compared():
    raw = synthetic.hackathon_dataset()
    raw["history"] = [r for r in raw["history"] if r["period_start"] >= "2026-08-01"]
    assert mc.compare(data_adapter.parse(raw))["status"] == "not_run"


# Solver regression: pinned results for the fictional demo (fails loudly if the formulation drifts).
DEMAND = [
    {"community_id": "village-a", "name": "A", "pending": 12, "barrier_level": "high", "data_coverage": 1.0},
    {"community_id": "village-b", "name": "B", "pending": 5, "barrier_level": "low", "data_coverage": 1.0},
    {"community_id": "village-c", "name": "C", "pending": 9, "barrier_level": "high", "data_coverage": 0.58},
]
PINNED = {
    "baseline": ({"village-a": 12, "village-b": 3, "village-c": 0}, 18.0),
    "longer-day": ({"village-a": 10, "village-b": 0, "village-c": 9}, 24.7),
    "second-nurse-no-vehicle": ({"village-a": 12, "village-b": 3, "village-c": 0}, 18.0),
    "second-nurse-second-vehicle": ({"village-a": 12, "village-b": 5, "village-c": 9}, 32.2),
}


@pytest.mark.parametrize("name", list(PINNED))
def test_solver_regression(name):
    r = optimizer.solve(DEMAND, synthetic.scenario(name))
    assert r["status"] == "OPTIMAL"
    assert (r["served"], round(r["weighted_served"], 2)) == PINNED[name]


def test_solver_regression_infeasible():
    assert optimizer.solve(DEMAND, synthetic.scenario("infeasible-confirmed"))["status"] == "INFEASIBLE"


def test_baseline_selection_precedes_every_evaluation_target(result):
    assert result['baseline_selected_through'] < min(s.periods[-26] for s in __import__('carelink_oi.forecast', fromlist=['series']).series(DATASET).values())
    assert result['baseline_method'] in __import__('carelink_oi.forecast', fromlist=['METHODS']).METHODS


def test_mlforecast_requires_52_training_observations_not_total_history():
    df = mc.long_frame(DATASET).groupby('unique_id', group_keys=False).tail(60)
    out = mc.mlforecast_experiment(df, 26)
    assert out['status'] == 'not_run' and 'training weeks' in out['reason']


def test_zero_error_baseline_is_kept_and_zero_error_communities_are_protected():
    perfect = {'mae': 0, 'by_community': {'a': 0}, 'family': 'operational'}
    worse = {'mae': 1, 'by_community': {'a': 1}, 'family': 'statsforecast'}
    assert mc.decide({'operational_baseline': perfect, 'TSB': worse})['changed'] is False
    base = {'mae': 3, 'by_community': {'a': 3, 'c': 0}, 'family': 'operational'}
    candidate = {'mae': 2, 'by_community': {'a': 2, 'c': .1}, 'family': 'statsforecast'}
    assert mc.decide({'operational_baseline': base, 'TSB': candidate})['changed'] is False


def test_mlforecast_runs_on_an_explicitly_fictional_sufficient_training_fixture():
    # This separate test fixture marks every synthetic week as observed. It is NOT
    # the live dataset and cannot affect the operational plan or coverage display.
    raw = synthetic.hackathon_dataset()
    for row in raw['history']:
        row['reported'] = True
    out = mc.mlforecast_experiment(mc.long_frame(data_adapter.parse(raw)), windows=2)
    assert out['status'] == 'experimental' and set(out['models']) == {'mlf_poisson', 'mlf_random_forest'}
    assert len(out['cv']) == 6
