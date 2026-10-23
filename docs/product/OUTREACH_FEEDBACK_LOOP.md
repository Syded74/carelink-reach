# Outreach feedback loop: approved days → household requests → forecasting input

CareLink records not only that a CHO visited a community, but which household requests that day took on and what happened to each.

## How it works

1. **Approval.** The planning worker writes the approved assignment as before: CHO, date, community, vehicle and planned workload.
2. **Day plan** (`carelink_oi_day_plan`, stable ID `carelink-oi-dayplan-<assignment>`). The worker writes this once, on the community, for each approved day that is today or later and not yet recorded. It lists the eligible requests, oldest first, up to the day's planned workload.
   - A request is eligible when the facility has accepted it (`accepted`, `assigned` or `contact_attempt`) and no pending day holds it.
   - A request held by another day becomes eligible again once that day's outreach-day record exists. That record is the explicit release event.
3. **Request link** (`carelink_oi_request_link`, stable ID `carelink-oi-link-<assignment>-<request>`). One per request, on the household. It is a `scheduled` event in the request's own append-only lifecycle (`lib/workflow.js`), allowed only from `accepted`, `assigned`, `contact_attempt` or a released `scheduled`.
   - A link is written only onto the event the day plan saw. If the request moved on in the meantime, nothing is written.
   - A link that the planning service did not write is a conflict.
4. **Visit.** The CHO's existing *Confirmed outreach visit* task and visit form complete the request.
   - The visit stamps `actor`, which the server enforces as the signed-in user. It also stores the request's `assignment_id` and `proposal_id`.
   - A `partly` (`in_progress`) visit keeps the task open. `unable_to_complete` is kept as recorded.
   - Other requests stay open.
5. **Outreach day.** The CHO's *Planned outreach day* form lists the planned households. Recording the day closes no request.
6. **Progress.** The Outreach Intelligence tab shows, for each approved day: planned, completed, unable, partly, still open, and changed outside the day.
   - A completion counts only if the visit followed that day's link and its `actor` is the CHO named on the day plan. Otherwise it is `unverified`.
7. **Forecasting input.** `lib/oi-export.js` counts open requests as pending routine work and completed visits as visits in the week they happened. The next export therefore sees the change. Re-sending a record changes nothing, because IDs are stable and records are append-only.

## Server rules (`authority/validate_doc_update.js`)

- Day plans and request links: written only by the planning service account, and append-only.
- `carelink_visit`: CHO role only, append-only, and `actor` must equal the signed-in user.

## Test records

Contacts that the regression flows create carry `record_origin: 'test'`. The following always leave them, their descendants and every report about them out:

- operational exports;
- the facility demand estimate;
- supervisor indicators.

A plan request carrying `include_test_records: 'yes'` (sent only by tests, through the CHT API) is planned from data that includes them. Its proposal is labelled `includes_test_records` and the tab shows it as a **Test plan**.

## Evidence (`npm run feedback-flow`, run 2026-10-22)

All 11 steps passed against the real CHT application. Tolon forecasting inputs, including this run's test households:

| Snapshot | Pending now | Requests this week | Visits this week | Next-week estimate | Operational (tests excluded) |
|---|---|---|---|---|---|
| Before | 21 | 22 | 19 | 12.5 | 0 / 0 / 0 |
| Two requests recorded | 23 | 24 | 19 | 13.0 | 0 / 0 / 0 |
| One visit completed | 22 | 24 | 20 | 13.0 | 0 / 0 / 0 |
| Same visit re-sent | 22 | 24 | 20 | 13.0 | 0 / 0 / 0 |

**Why the forecast changed.** The estimate is the mean of the last four weeks' recorded routine workload (`mean_4`, with simulated past weeks). Two new requests added 2 to this week's workload, so the four-week mean rose by 0.5.

**Why it did not change after the visit.** A completed visit reduces pending work. It does not reduce workload that was already recorded, so the estimate stayed the same, as it should.

**Recorded demand versus missing reporting.** Weeks are marked as reported or not reported, and missing weeks are never scored as zero demand (see `FORECASTING_MODEL_CARD.md`). This run did not add a new browser check for that.

## Not yet done

- Moving a request from one approved day to another needs an explicit coordinator event. There is no "reassign to day X" action yet; a request released by a recorded day simply becomes eligible again.
- Day plans are frozen at approval. A request accepted after approval waits for the next plan.
- Maternal and child follow-ups are now linked to approved days too, and pending workload is counted in encounters: see `MCH_OUTREACH_INTELLIGENCE_INTEGRATION.md`.
- Two CHO devices completing the same request offline produce a lifecycle conflict for the coordinator to resolve. The second visit is not merged automatically.
- All clinical forms and rules remain `pending_clinical_review`. No ANC, PNC or CWC schedules are generated, and urgent referrals stay outside routine planning.
