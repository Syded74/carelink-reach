# Outreach progress counting rules

**Applies to:** the **Progress** section of the Community Outreach tab (`ui-extensions-src/carelink-outreach-intelligence.js`, `progressOf`).

**Source of the counts:** existing CHT records only.
- Approved plans (`carelink_oi_proposal` with a server acknowledgement of approval);
- day plans (`carelink_oi_day_plan`) and their request and follow-up links (`lib/oi-links.js`);
- household visit records (`carelink_visit`);
- maternal and child resolutions and visits;
- outreach-day records (`carelink_oi_outreach_day`);
- referral chains (`lib/mch.js`).

**Principles:**
- **A planned visit is not a completed visit.**
- **A synchronized report is not independent proof that a service was delivered.**
- **Recording an outreach day does not mean every household was visited.**

## Rules as implemented

| # | Rule | How it is applied |
|---|---|---|
| 1 | Count only currently valid assignments | Only day plans of plans the **server** has acknowledged as approved (`proposalStatus(...).approvedOnServer`). Drafts, plans awaiting review and rejected plans have no assignments |
| 2 | Exclude superseded and cancelled assignments | Rejected plans produce no assignments. A recorded day (done or not done) releases the CHO and is not re-planned; its unvisited items stay open as obligations. There is no separate "superseded assignment" record, so none is invented |
| 3 | Count each obligation once | Requests: one link per request per day (`linkId`). Maternal and child follow-ups: one link per CHT task id (`followUpLinkId`). `dayProgress` counts per link |
| 4 | Deduplicate synchronization replays | `lib/oi-links.js` and `lib/workflow.js` index records by `_id`. The server also refuses replays: records are append-only (`authority/validate_doc_update.js`) |
| 5 | Use existing completion records | Completed = the request lifecycle reached `completed` through the CHO's visit record, or the follow-up was resolved or closed by a later record |
| 6 | Keep separate obligations for the same person separate | Follow-up links are per task id. A mother's ANC follow-up and missing-assessment task are two obligations |
| 7 | Household contact ≠ clinical service delivery | Household visit records document outreach outcomes. Clinical documentation stays in the ANC/PNC/CWC forms. The progress view never marks a service delivered from a household visit |
| 8 | Keep unfinished visits visible | "Still outstanding" counts open and partly done items. Unvisited requests and follow-ups stay open and appear in the next plan's demand |
| 9 | Attribute activity to the authenticated worker | Visits and resolutions carry `actor`, and the server rejects an actor that differs from the signed-in user. A visit by someone other than the assigned CHO is shown as "unverified" |
| 10 | Exclude generated test records | Day plans belonging to a plan with `includes_test_records` are excluded from all totals. A test plan can still be opened on its own, labelled "Test plan" |
| 11 | Not completed ≠ not yet synchronized | The tab reads records synchronized to the device. A day without a record shows "Outreach day not recorded yet (or its record has not synchronized to this device)". CHT's sync indicator shows unsent records on the CHO's phone. **Limitation:** the tab cannot see another device's unsynced records |
| 12 | Never infer verification | Completed counts are labelled "documentation, not independent verification". No timestamp, location or author is treated as proof |

## What each figure means

| Figure | Definition |
|---|---|
| Visits assigned | Linked household requests plus linked maternal/child follow-ups on approved, non-test outreach days |
| Completed and documented | Requests completed by a visit record, plus follow-ups resolved by the assigned CHO or closed by a later record |
| Partly done | Requests visited with the follow-up still open, and follow-ups seen but still open |
| Visited, could not complete | Requests whose visit recorded "unable to complete" |
| Still outstanding | Open plus partly done (household requests and follow-ups) |
| Last documented outreach | The latest approved day in that community with an outreach-day record |
| Reasons recorded for unfinished work | The reason on a not-done outreach-day record, and the outcome note on unable or partly done visit records (up to 3 shown) |

## Health worker and volunteer summaries

- **Health worker:** outreach days assigned, visits assigned, completed and documented, still outstanding. There are **no ratings, rankings or scores**, and the view says it is "documented work to support planning, not a performance rating".
- **Community volunteer:** requests submitted, requests reviewed (any state after `submitted`), requests still open, household contacts recorded, and communities supported. The view states that requests and contacts are documentation, not proof that outreach took place. Requests and contacts about test households (`record_origin: 'test'`, looked up through the CHT contact API) are not counted.

## Period and download

- **Period:** All time, Last 4 weeks or This month. Outreach days are filtered by their planned date; volunteer requests and contacts by the date they were recorded.
- **Download (CSV):** the same figures by community, health worker and volunteer, for the chosen period. Tested in a browser; downloading inside the Android app was not tested.

## Not implemented

- A server-side progress report. The figures are computed on the device from synchronized records; the CSV download exports what the device shows.
- Per-household proof of attendance. Not built by design.
