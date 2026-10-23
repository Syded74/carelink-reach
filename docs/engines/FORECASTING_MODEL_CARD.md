> Current integration: use the CHT Outreach Intelligence tab and Python worker. Historical baseline/optimizer design is preserved below; current measured comparisons are in [OUTREACH_INTELLIGENCE_MODEL_EVALUATION.md](OUTREACH_INTELLIGENCE_MODEL_EVALUATION.md), and deployment behavior is in [OUTREACH_INTELLIGENCE_ARCHITECTURE.md](../architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md).

# Model card — CareLink Reach outreach demand estimate

| | |
|---|---|
| Version | `carelink-oi-forecast 0.2.0` (`outreach-intelligence/carelink_oi/forecast.py`) |
| Status | **Research prototype. Not validated on real data. Not for clinical use.** |
| Target | Next week's **routine outreach workload** per community: new help requests + follow-ups falling due + **recorded** missed appointments + open referrals |
| Unit | Operational work items per community per week |
| Not | A clinical risk, an urgency, or a prediction about any person, illness, pregnancy outcome or death |

## Intended use

- Help a facility coordinator see which communities may need more routine outreach next week, and why.
- Weight priorities in the scheduler, on top of documented pending items.
- Always with human review.

## Out of scope

- Triage, diagnosis, treatment or referral decisions.
- Danger signs: these follow professionally defined referral procedures and never wait for this estimate.
- Activating ANC, PNC, CWC or EPI schedules: they stay inactive, `pending_clinical_review`.
- Ranking individuals.

## Inputs

**Community × week counts only** (see the architecture doc, §2).

Explicitly excluded:
- danger signs
- vitals and clinical measurements
- person-level data
- demographic or personal characteristics as risk proxies

**Missing weeks** (data that never reached the server) are treated as *missing, not zero*.

## Method

**Stage A — used for estimates.** Four transparent baselines:
- last reported week
- mean of the last 4 reported weeks
- EWMA (α = 0.3)
- seasonal naive (52 weeks)

One is selected per dataset by the lowest pooled back-test MAE over the last 26 weeks. A rolling origin is used, so each forecast uses only earlier weeks. A community with fewer than 8 reported weeks gets **no forecast**: it shows the recent average labelled "too little history".

**Stage B — experimental.** `PoissonRegressor(alpha=1.0)`.
- **Features:** lag 1, lag 2, 4-week mean, seasonal sin and cos, recent transport barriers, share of recent weeks unreported, and the community barrier level.
- **Split:** time-based. Train on the earlier weeks and test on the last 26. The comparison baseline is chosen on training weeks only.
- **When it runs:** only with at least 52 reported weeks per community.
- **Use:** never used by the planner.

## Evaluation (synthetic hackathon data, seed 2026; produced by `demo.py`)

| Baseline back-test (pooled) | MAE | RMSE | Bias | n |
|---|---:|---:|---:|---:|
| last value | 3.91 | 4.89 | −0.15 | 66 |
| **mean of last 4 (selected)** | **2.78** | 3.50 | −0.18 | 66 |
| EWMA 0.3 | 2.79 | 3.52 | −0.25 | 66 |
| seasonal naive 52 | 3.52 | 4.76 | +0.67 | 61 |

| Held-out weeks (2026-04-20 → 2026-10-12) | Poisson MAE | Baseline (EWMA) MAE |
|---|---:|---:|
| All | 2.80 | 2.79 |
| Low-demand weeks | 2.25 | 2.44 |
| High-demand weeks | 3.41 | 3.18 |
| Village A | 3.36 | 3.39 |
| Village B | 1.62 | 1.78 |
| Village C (35% weeks unreported) | 3.94 | 3.55 |

**Conclusion:**
- The ML model is **not better** than the transparent baseline overall.
- It is worse in high-demand weeks and in the poorly reported village, which are exactly where errors matter most.
- It stays experimental.
- Synthetic data cannot show that either method works for real communities.

## Explanations

Each estimate reports:
- forecast period, estimate, input period and method
- model version and validation status
- back-test MAE as "typically off by about N items"
- the main contributors over the last 4 weeks
- reported transport difficulties
- warnings: synthetic data, low data coverage, too little history

There are **no confidence intervals or probabilities**: none are computed, so none are shown.

## Fairness and known risks

- **Requests measure access, not need.** A community that reports less is flagged ("low reporting can mean poor access, not low need"). The scheduler's fairness weight *raises* its priority, and an optional hard minimum-coverage policy can guarantee it a visit.
- **Seasonality.** Rainy-season access and reporting both worsen. The synthetic data includes this; real seasonal patterns are unknown.
- **Small numbers.** With a handful of communities and weekly counts below about 15, errors of 2–4 items are large relative to the counts.

## Before any real use

- 6–12 months of real, deduplicated, server-synchronised data.
- Re-run the back-test and the experiment on it.
- Check results per community, especially poorly connected ones.
- Programme and data-protection review.
- Keep it a decision aid with a human always deciding.
