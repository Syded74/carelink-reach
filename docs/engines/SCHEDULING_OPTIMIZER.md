> Current integration: use the CHT Outreach Intelligence tab and Python worker. Historical baseline/optimizer design is preserved below; current measured comparisons are in [OUTREACH_INTELLIGENCE_MODEL_EVALUATION.md](OUTREACH_INTELLIGENCE_MODEL_EVALUATION.md), and deployment behavior is in [OUTREACH_INTELLIGENCE_ARCHITECTURE.md](../architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md).

# Scheduling optimiser (Google OR-Tools CP-SAT)

This is **mathematical optimisation, not machine learning.** File: `outreach-intelligence/carelink_oi/optimizer.py`.

## Model

**Trips.** For each worker and day, a *trip* is a round route `facility → 1..3 communities → facility`. For every subset of the worker's communities, the shortest visiting order is precomputed from the **documented travel matrix**.

A missing travel time is an error. It is never estimated from straight-line distance.

**Decision variables:**
- `x[w,d,r] ∈ {0,1}`: worker *w* makes trip *r* on day *d*.
- `y[w,d,c] ∈ {0..pending_c}`: routine items covered in community *c*.

**Hard constraints:**

| Rule | Constraint |
|---|---|
| A worker is in one place at a time | Σ_r x[w,d,r] ≤ 1 |
| Only available workers | trips exist only on the worker's available days |
| Time | Σ x·(travel_r + setup·stops_r) + per_item·Σ_c y ≤ the worker's minutes that day |
| No nonexistent transport | Σ_w Σ_r x[w,d,r] ≤ vehicles available on *d*; every trip needs its own vehicle |
| Items only where visited | y ≤ pending_c · (trips visiting c), and y ≥ 1 if c is visited |
| Never more than documented | Σ_{w,d} y[w,d,c] ≤ pending_c |
| Confirmed assignments are fixed | the confirmed worker, day and community trip is forced, with at least its minimum items |
| Optional fairness policy | Σ y[·,·,c] ≥ min for each listed community (hard) |
| Responsible worker | a worker's trips include only their covered communities, when set |

**Objective** (configurable policy, integer-scaled):

```
maximise  Σ_c weight_c · items_c  −  travel_penalty · travel_minutes  +  continuity_bonus · [c kept from previous plan]
weight_c = 1 + fairness_weight · underserved_c + growth_weight · growth_c
underserved_c = ½ · barrier (high 1, low 0, unknown ½) + ½ · (1 − share of last 12 weeks reported)
growth_c = clamp((estimate − recent mean) / recent mean, 0, 1)
```

The defaults are fairness 0.5, growth 0.3, travel 0.01 per minute and continuity 0.5. These are policy choices for the facility to review.

**Solver settings:** 1 worker, seed 0, 10-second limit, so results are deterministic for fixed inputs (tested). The status is OPTIMAL, FEASIBLE or **INFEASIBLE**. When infeasible, no plan is returned, together with diagnosed reasons.

## Explanations (all from solver inputs and outputs)

- **Included communities:** documented items, barrier, coverage gap, growth, items covered and priority weight.
- **Deferred or partly covered communities:** the solver is **re-run** with one more item required there, and the explanation states the resulting change in weighted items and travel. If it is infeasible, it states the round-trip time that cannot fit.
- **Binding constraints:** a working day that is full (slack below one item), or an idle available worker while every vehicle is in use.
- **What-if:** the plan is re-solved with one more hour per worker and with one more vehicle, and the extra items covered are reported. If unmet demand remains and a what-if helps, the plan says more staffing or transport is needed.
- **Alternatives:** up to two next-best feasible plans. Each uses a different set of (day, route) trips, so swapping two equivalent workers does not count as an alternative.

## Demo results (`python demo.py`)

Fictional data: Villages A, B and C with 12, 5 and 9 documented items, 45, 20 and 60 minutes from the facility. Each stop takes 20 minutes of setup and each item 15 minutes.

| Scenario | Plan | Items covered | Binding / note |
|---|---|---|---|
| 1 nurse, 1 motorbike, 6 h | Facility → A → B → Facility (A 12, B 3) | 15 / 26 | Day full (360/360). C deferred: covering it lowers weighted items 18.0 → 15.2 |
| 1 nurse, 1 motorbike, 8 h | Facility → A → C → Facility (A 10, C 9) | 19 / 26 | B deferred (low barrier, fewest items) |
| 2 nurses, 1 motorbike, 6 h | Same as row 1 | 15 / 26 | **Transport**: Nurse 2 idle. +1 vehicle → +11 items |
| 2 nurses, motorbike + pickup | A + B (N1); B + C (N2) | 26 / 26 | All documented items covered |
| Confirmed C visit (9 items) in a 3 h day | **INFEASIBLE** | — | Needs 275 min (120 travel + 20 + 9 × 15); 180 available |
| Row 1 + minimum coverage for C | Facility → B → C → Facility (B 3, C 9) | 12 / 26 | Fairness costs 3 items, and the plan shows it |

## Limits

- One trip per worker per day, and one vehicle per trip. Sequential vehicle sharing within a day and team trips are not modelled.
- Service time is linear per item. Real visits vary.
- The trip enumeration is exact up to 3 stops per trip. With many communities per worker, switch to the CP-SAT routing model or OR-Tools routing.
- Travel times are fictional estimates. Real ones must come from the health team and include rainy-season access.
