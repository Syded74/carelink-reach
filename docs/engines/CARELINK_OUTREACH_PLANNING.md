# CareLink Reach — Outreach Planning (need score + scheduling engine)

> Fictional-data prototype. Plans are **recommendations**. The facility coordinator approves them, and nothing is assigned automatically.

Two questions, one pipeline:

1. **Where is outreach needed most?** → `lib/need-score.js`. This is a transparent need score, version 1 of demand estimation.
2. **How do we reach those communities with limited resources?** → `lib/scheduler.js`, the constraint-aware scheduler.

```
Server records ─► need score (per household + community, with reasons) ─► scheduler ─► plan report
staff, vehicles, hours, travel times (planning/resources.*.json) ─────────┘                 │
                                         coordinator approves ─► coordination form in CHT ◄─┘
```

Run it: `npm run plan` (dry season) or `npm run plan -- --season rainy`. Options:
- `--start YYYY-MM-DD`
- `--today YYYY-MM-DD`
- `--resources <file>`

Output: `evidence/outreach-plan-<season>.md` (for the coordinator) and `.json`. It is read-only and writes nothing to CHT.

## 1. Need score

Every point comes from a recorded item and carries that record's id.

| Source | Points | Comes from |
|---|---|---|
| Open outreach request (not completed, unable or cancelled) | 20 | `lib/workflow.js`, the same replay as tasks and targets |
| Barrier on an open request: distance, no transport, transport cost | +10 | request form |
| Barrier: household decision-making, language, other | +5 | request form |
| Recorded danger sign needing CHO review | 50 | `lib/mch.js` `projectTasks`, the same logic as the CHO's tasks |
| Referral awaiting outcome | 30 | 〃 |
| Appointment recorded as missed | 25 | 〃 |
| Appointment due | 20 | 〃 |
| Follow-up due | 15 | 〃 |
| Missing assessment / first visit due | 10 | 〃 |
| **Coverage floor:** community with no visit for more than 14 days | +1 per extra day (max 30); never visited = 30 | last completed outreach visit or MCH visit |

How each part works:
- **Maternal and child items** are exactly the items that raise a task for the responsible CHO, so planning and the CHO's task list never disagree. This is unit-tested.
- **The coverage floor** handles a key fairness problem: requests measure *access*, not need. A community that has gone quiet earns points over time and gets a community check-in, so silence is never read as "no need".
- **Weights** are programme settings for ranking outreach work (`approval_status: pending_programme_review`). They are **not** clinical risk scores and make no diagnosis. Change them in one place (`WEIGHTS`).

## 2. Scheduler

**Hard constraints** (never relaxed; tested across five resource scenarios):
- A household is visited only by its **responsible worker**, which the coordination form also enforces.
- Staff work only on their **available days**.
- **One worker per vehicle per day.**
- Travel plus visits fit within **working hours**, using **seasonal travel times** (dry or rainy).
- At most **N households per worker per day**.

**Method:** deterministic and greedy by need.
1. Each working day, the worker with the most urgent pending work goes first.
2. They take a free vehicle and build one round trip from the facility.
3. They add their highest-need households, community by community, while the trip still fits.
4. Whatever does not fit is listed as **unmet, with dated reasons**, for example:
   - "2026-10-22: no vehicle free (used by a higher-need trip)"
   - "Round trip to River Plain (300 min) leaves no time for a visit"

Greedy is explainable but **not guaranteed optimal**. For larger districts, an optimiser such as OR-Tools could replace `buildTrip`, keeping the same inputs, constraints and report.

**Explanations in the report:**
- the need breakdown for each community
- why each household is on each trip
- why a visit could not happen earlier
- the route with its travel, visit and total time
- every unmet need with its reasons

## 3. Resources (`planning/resources.demo.json`, fictional)

Staff and availability, vehicles, working hours, minutes per household visit, daily household limit, and one-way travel minutes between the facility and each community for each season.

**Every value is invented.** Before real use, the facility must provide confirmed staff rosters, vehicles and measured travel times, including rainy-season access. Later this could move into CHT, for example as facility fields or a UI-extension tab.

## 4. Approval: people decide

The plan creates no records. For each recommended visit, the coordinator either approves or adjusts it:
- **Outreach requests:** records *Accept → Assign → Confirm outreach date* with the coordination form, which leaves the audit trail.
- **Maternal and child items:** these are already tasks for the responsible CHO. The plan tells the coordinator and the CHO which day to go.

## 5. Demo result (2026-10-21 server data)

| Community | Need | Main reasons |
|---|---|---|
| Baobab Grove | 225 | danger sign, 2 referrals, 2 missed appointments, missing assessments, 1 request |
| River Plain | 90 | 3 open requests; never visited (coverage +30) |
| Shea Valley | 20 | 1 open request |

Recommended plan:
- **Thu 22 Oct:** CHO A takes Baobab Grove → Shea Valley (4 households, 4h20 of 8h). Both mothers with recorded concerns go first.
- **Tue 27 Oct:** CHO B takes River Plain (check-in plus 3 households, 5h30 dry or 7h20 rainy).
  - CHO B works Tuesdays and Thursdays. On Thursday the only motorbike was used by the higher-need trip.
  - The report states this delay. The facility can decide whether a second vehicle is worth it.

All 8 visit targets are met within 5 working days. With a 4-hour rainy-season day, River Plain cannot be reached at all, and the report says so.

## 6. Limits

- Uses only records that have reached the server. Records still on phones are not counted.
- Re-plans requests that the coordinator has already scheduled. Keep confirmed dates when approving.
- No demand forecasting yet. Add a statistical forecast only after 6–12 months of real data, and only if it beats this score when checked against outcomes.
- The plan report names (fictional) people and their recorded concerns. With real data, treat it as confidential and share it only with authorised staff.
