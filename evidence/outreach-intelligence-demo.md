# Outreach Intelligence — fictional demo results

Dataset `hackathon-villages` (synthetic, sha256 fa84c81aa992fe24…), as of 2026-10-21. Every number below was produced by running the code; nothing is hand-written.

## Demand estimate

| Community | Documented now | Estimate next week | Method | Back-test MAE | Weeks reported (12) |
|---|---:|---:|---|---:|---:|
| Village A (fictional) | 12 | 11.5 | mean_4 | 3.3 | 100% |
| Village B (fictional) | 5 | 4.8 | mean_4 | 1.74 | 100% |
| Village C (fictional) | 9 | 7.5 | mean_4 | 3.77 | 58% |

ML experiment: On held-out weeks the Poisson model's MAE is 2.8 vs 2.79 for the ewma_0.3 baseline (not lower; this baseline was chosen on the training weeks only, so it can differ from the one used for the live estimates). This is synthetic data, so it shows the pipeline works, not that the model is better for real communities. The planner keeps using the transparent baseline; the model stays experimental.

## Schedules

### 1 nurse, 1 motorbike, 6 hours, 1 day — OPTIMAL

Covers 15 of 26 documented routine items with 1 trip(s); 11 remain unmet.

- Nurse 1 (fictional) (motorbike-1): facility → village-a → village-b → facility; covers {'village-a': 12, 'village-b': 3}; travel 95 + visits 265 = 360 of 360 min
- Village A (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 12 item(s)): 12 documented routine follow-up item(s) pending, high reported transport barrier. Covers all item(s); priority weight 1.25.
- Village B (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 3 item(s)): 5 documented routine follow-up item(s) pending. Covers 3 of 5 item(s); priority weight 1.0. Village B (fictional) is partly covered (3 of 5): covering one more item there would lower the weighted items served from 18.0 to 17.75 (travel 95 → 95 min), so time is better spent where more documented items can be covered. 2 item(s) remain visible for the next planning cycle.
- Village C (fictional) is deferred: covering one more item there would lower the weighted items served from 18.0 to 15.2 (travel 95 → 130 min), so time is better spent where more documented items can be covered. 9 item(s) remain visible for the next planning cycle. It has high access barriers or poor reporting: consider the minimum-coverage policy.
- Constraint: Working hours: Nurse 1 (fictional)'s day on 2026-10-22 is full (360 of 360 minutes).
- What if one more working hour for each worker: +2 items
- What if one more vehicle each day: +0 items

### 1 nurse, 1 motorbike, 8 hours — OPTIMAL

Covers 19 of 26 documented routine items with 1 trip(s); 7 remain unmet.

- Nurse 1 (fictional) (motorbike-1): facility → village-a → village-c → facility; covers {'village-a': 10, 'village-c': 9}; travel 145 + visits 325 = 470 of 480 min
- Village A (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 10 item(s)): 12 documented routine follow-up item(s) pending, high reported transport barrier. Covers 10 of 12 item(s); priority weight 1.25. Village A (fictional) is partly covered (10 of 12): covering one more item there would lower the weighted items served from 24.7 to 24.59 (travel 145 → 145 min), so time is better spent where more documented items can be covered. 2 item(s) remain visible for the next planning cycle.
- Village C (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 9 item(s)): 9 documented routine follow-up item(s) pending, high reported transport barrier, only 58% of recent weeks reported (possible access gap). Covers all item(s); priority weight 1.355.
- Village B (fictional) is deferred: covering one more item there would lower the weighted items served from 24.7 to 23.2 (travel 145 → 150 min), so time is better spent where more documented items can be covered. 5 item(s) remain visible for the next planning cycle.
- Constraint: Working hours: Nurse 1 (fictional)'s day on 2026-10-22 is full (470 of 480 minutes).
- What if one more working hour for each worker: +3 items
- What if one more vehicle each day: +0 items

### 2 nurses, still 1 motorbike, 6 hours — OPTIMAL

Covers 15 of 26 documented routine items with 1 trip(s); 11 remain unmet.

- Nurse 1 (fictional) (motorbike-1): facility → village-a → village-b → facility; covers {'village-a': 12, 'village-b': 3}; travel 95 + visits 265 = 360 of 360 min
- Village A (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 12 item(s)): 12 documented routine follow-up item(s) pending, high reported transport barrier. Covers all item(s); priority weight 1.25.
- Village B (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 3 item(s)): 5 documented routine follow-up item(s) pending. Covers 3 of 5 item(s); priority weight 1.0. Village B (fictional) is partly covered (3 of 5): covering one more item there would lower the weighted items served from 18.0 to 17.75 (travel 95 → 95 min), so time is better spent where more documented items can be covered. 2 item(s) remain visible for the next planning cycle.
- Village C (fictional) is deferred: covering one more item there would lower the weighted items served from 18.0 to 15.2 (travel 95 → 130 min), so time is better spent where more documented items can be covered. 9 item(s) remain visible for the next planning cycle. It has high access barriers or poor reporting: consider the minimum-coverage policy.
- Constraint: Working hours: Nurse 1 (fictional)'s day on 2026-10-22 is full (360 of 360 minutes).
- Constraint: Transport: Nurse 2 (fictional) available on 2026-10-22, but every vehicle is already in use.
- What if one more working hour for each worker: +4 items
- What if one more vehicle each day: +11 items

### 2 nurses, motorbike + pickup, 6 hours — OPTIMAL

Covers 26 of 26 documented routine items with 2 trip(s); 0 remain unmet.

- Nurse 1 (fictional) (motorbike-1): facility → village-a → village-b → facility; covers {'village-a': 12, 'village-b': 3}; travel 95 + visits 265 = 360 of 360 min
- Nurse 2 (fictional) (pickup-1): facility → village-b → village-c → facility; covers {'village-b': 2, 'village-c': 9}; travel 130 + visits 205 = 335 of 360 min
- Village A (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 12 item(s)): 12 documented routine follow-up item(s) pending, high reported transport barrier. Covers all item(s); priority weight 1.25.
- Village B (fictional) is included (Nurse 1 (fictional) on 2026-10-22: 3 item(s); Nurse 2 (fictional) on 2026-10-22: 2 item(s)): 5 documented routine follow-up item(s) pending. Covers all item(s); priority weight 1.0.
- Village C (fictional) is included (Nurse 2 (fictional) on 2026-10-22: 9 item(s)): 9 documented routine follow-up item(s) pending, high reported transport barrier, only 58% of recent weeks reported (possible access gap). Covers all item(s); priority weight 1.355.
- Constraint: Working hours: Nurse 1 (fictional)'s day on 2026-10-22 is full (360 of 360 minutes).
- What if one more working hour for each worker: +0 items
- What if one more vehicle each day: +0 items

### Confirmed full Village C visit in a 3-hour day — INFEASIBLE

No feasible plan: the constraints cannot all be met. Nothing was scheduled.

- Infeasible: Confirmed assignment for Village C (fictional) needs at least 275 minutes (round trip 120 + setup 20 + 9 x 15), but Nurse 1 (fictional) has 180 minutes.

### Baseline with the minimum-coverage policy for Village C

Covers 12 of 26 documented routine items with 1 trip(s); 14 remain unmet.

- Nurse 1 (fictional): facility → village-b → village-c → facility; covers {'village-b': 3, 'village-c': 9}
