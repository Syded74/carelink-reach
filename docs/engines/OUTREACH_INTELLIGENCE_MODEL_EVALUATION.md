# Outreach Intelligence model evaluation

Fictional synthetic data only. Scores are routine work items per week, not medical risk or clinical outcomes.

Baseline: **ewma_0.3**, selected using data only through **2026-04-13**. Evaluation: 26 rolling one-week-ahead origins per community; 66 observed community-week targets after excluding missing reports.

| Model | MAE | RMSE | Scored targets |
|---|---:|---:|---:|
| operational_baseline | 2.787 | 3.523 | 66 |
| CrostonClassic | 2.610 | 3.376 | 66 |
| CrostonOptimized | 2.693 | 3.443 | 66 |
| CrostonSBA | 2.666 | 3.485 | 66 |
| TSB | 2.701 | 3.448 | 66 |
| ADIDA | 2.700 | 3.446 | 66 |
| IMAPA | 2.700 | 3.446 | 66 |
| Naive | 3.981 | 4.969 | 66 |
| WindowAverage | 2.752 | 3.553 | 66 |
| SeasonalNaive | 3.504 | 4.720 | 66 |
| HistoricAverage | 2.619 | 3.441 | 66 |
| SES | 2.813 | 3.559 | 66 |
| mlf_poisson | 2.839 | 3.798 | 66 |
| mlf_random_forest | 3.001 | 3.915 | 66 |

No candidate met the rule (≥10% lower pooled MAE and ≤10% worse for every community). Best StatsForecast model: CrostonClassic, MAE 2.61 vs 2.787 (6% lower overall; high-demand weeks 3.282 vs 3.178).

Demand here is not intermittent (at most 3% of reported weeks are zero), so Croston-family models are outside their intended use; their gains come from heavier smoothing.

The operational model is unchanged. The declared replacement rule requires at least 10% lower pooled MAE and no community more than 10% worse. MLForecast candidates remain experimental regardless of their rank.

Implementation: StatsForecast CrostonClassic, CrostonOptimized, CrostonSBA, TSB, ADIDA, IMAPA and simple baselines; MLForecast Poisson and random forest with past lags/rolling features. MLForecast requires 52 reported **training** weeks before the first evaluation window. No clinical/person-level predictors are supplied.

Missing weeks are not zeros: candidate inputs use the mean of earlier reported observations; leading missing values are omitted rather than invented as zero. Missing target weeks are excluded from scores. True reported zeros remain in training and evaluation.

Tests also cover insufficient history, causal imputation, zero-error baseline retention, fairness at zero-error communities and a separate sufficient-history synthetic ML fixture. See `evidence/oi-model-comparison.json` for per-community, low-demand/high-demand scores and the full decision.

Sources: [StatsForecast](https://github.com/Nixtla/statsforecast), [MLForecast](https://github.com/Nixtla/mlforecast), [OR-Tools routing examples](https://developers.google.com/optimization/routing/vrp). Installed versions are pinned in `outreach-intelligence/requirements.txt`.
