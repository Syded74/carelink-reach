# Outreach-first simplification report

**Date:** 22 October 2026.

**Positioning:** CareLink Reach is an AI-assisted, offline-first **community outreach planning and coordination layer** on CHT 5.3. It does not replace Ghana Health Service registers, DHIMS2 or clinical processes.

**Not changed:**
- CHT Core, with one owner-approved exception: `core-patches/0002-carelink-sidebar-menu.patch` removes Storage info, Training materials, About and Report bug from the side menu (see `core-patches/README.md`);
- the forecasting and optimization mathematics;
- record schemas, IDs and authorization rules.

Clinical forms, referrals and safeguards are kept as they were.

**Evidence:** screenshots in `evidence/outreach-first/` and `evidence/usability/`; flow results in `evidence/<flow>.json`.

## 1. What changed

| Area | Change | Files |
|---|---|---|
| Coordinator and supervisor home | The Outreach Intelligence tab is now **Community Outreach**: a freshness line, one safety line, an **At a glance** card answering "Where is care needed? / What resources are ready? / Current outreach plan / Needs approval / Who still needs attention?", then four sections: **Needs · Resources · Plan · Progress**. One section is shown at a time; tapping a tab brings it into view | `ui-extensions-src/carelink-outreach-intelligence.js` |
| Needs | Community cards: documented visits waiting (records), expected routine outreach needs (Engine 1), open requests and follow-ups, last documented outreach, reasons for attention. "Limited reporting history — estimate may be less reliable" below 50% coverage. "Not yet reported" instead of 0 when no data reached the device. The forecast method and model check are under **Technical details** | same |
| Resources | **Check outreach resources**: health workers, motorbikes, then each fuel, supply and equipment item as Available / Not enough / Not available / Needs confirmation / Resource needs an updated check / Planning estimate (not confirmed). Quantities, reserved amounts, check dates, checked by and sources are folded under **Resource details**. Vaccine stock is listed but not counted as a planning shortage | same; `scripts/build-oi-extension.js` (resource config passed to the tab) |
| Plan | Plan card: date, assigned CHO, communities, motorbike name, planned visits, **visits we could not plan**, split by ANC / PNC / Child welfare / Household requests, resource readiness, **What's limiting this plan?**, the danger-sign notice, and **one** next action. Statuses: **Draft, Awaiting review, Awaiting approval, Approved, Rejected**, with a separate "waiting to sync — not yet confirmed by the server" flag. No feasible plan: "We could not create a plan with the available resources." Folded: **Why this plan?**, **Planning assumptions**, **Decision history**, **How this plan was created** (fairness weights, planner, solver, input hash). The 100+ older plans are folded under **Other plans** | same |
| Progress | Visits assigned, completed and documented, still outstanding, communities with unfinished work. **By community** and **by health worker** (with outreach days assigned), with partly done, could not complete, changed outside the day or not by the assigned CHO, last documented outreach, and recorded reasons. Referral coordination counts. **Volunteer contributions** (requests submitted, reviewed, open, communities). No ratings or rankings. Rules: `OUTREACH_PROGRESS_COUNTING_RULES.md` | same |
| Supervisor | Opens on **Plan**, showing the plan waiting for their decision; decisions are recorded from Tasks | same |
| One rule for "waiting for you" | Superseded drafts and day-old test plans drop out of both CHT tasks and the tab (`oiWorkflow.actionable`) | `lib/oi-workflow.js`, `tasks.js` |
| CHO | Tasks is their "My Outreach": *Planned outreach day* "Tolon · 7 visit(s) planned", *Household visit planned*, *ANC follow-up due*, etc. (from the earlier usability work). The outreach-day form lists the households and follow-ups and says recording the day closes nothing | `tasks.js` |
| Volunteer | Unchanged: household → *Request help*; status on the household profile | — |
| Cleanup preview | Read-only inventory of generated records (`npm run cleanup-inventory`) | `scripts/cleanup-inventory.js` |
| Evidence scripts | `npm run outreach-screens` (Chrome at phone width), `npm run outreach-phone` (physical phone) | `scripts/outreach-screens.js`, `scripts/outreach-phone.js` |

**Defects found and fixed during this work:**
1. **"Plans waiting for you" was wrong.** The coordinator saw 26 plans waiting, counting superseded drafts and stale test plans, while their task list showed none. Fixed with the shared `actionable` rule.
2. **Tab taps were dropped.** A tap during the tab's 5-second background refresh was lost. Taps are now queued.
3. **Test work counted as real work.** Older test day plans lacked the test flag and were counted as operational progress, showing reasons such as "Test run finished; day released". Test status now comes from the parent plan.
4. **Progress totals did not add up.** Visits recorded outside the planned day, or by someone other than the assigned CHO, were in neither the completed nor the outstanding figure. They are now shown as their own line, and never counted as completed.

## 2. Before and after (real CHT instance)

| Screen | Before | After |
|---|---|---|
| Coordinator, phone width | `evidence/usability/refine-before-oi-tab-mobile-coordinator.png` (staff list and plan buttons first) | `evidence/outreach-first/phone-coord-0-at-a-glance.png` (physical phone), `after-coordinator-*-screen.png` (Chrome) |
| Plan | `evidence/usability/after-oi-tab-first-screen.png` (desktop, earlier round) | `evidence/outreach-first/after-coordinator-plan.png`, `phone-coord-plan.png` |
| Resources | readiness table of ids | `after-coordinator-resources.png`, `phone-coord-resources.png` |
| Progress | per-day cards only | `after-coordinator-progress.png`, `phone-coord-progress.png` |
| Supervisor | same view as coordinator | `after-supervisor-plan-screen.png` |
| CHO | `evidence/usability/refine-before-cho-tasks.png` | `phone-cho-tasks.png`, `phone-cho-outreach-day.png` |

Two phone captures that included personal phone notifications were deleted, not kept as evidence.

## 3. Verification (fresh, this session, after the final change)

| Suite | Kind | Result |
|---|---|---|
| JavaScript unit tests (`npm test`) | Node | **70 / 70** |
| Python engine tests (forecasting, optimizer, supply scenarios A–H, integration) | pytest | **88 / 88** |
| Volunteer request (`volunteer-flow`) | Chrome; offline = DevTools network emulation | **14 / 14** |
| Coordinator planning, supervisor approval (incl. offline approval), CHO outreach day (`oi-cht-flow`) | Chrome | **13 / 13** (rerun after the final deploy) |
| Maternal and child (`mch-flow`) | Chrome | **20 / 20** |
| Complete walkthrough | Chrome | **9 / 9** |
| Supply-aware scheduling | Chrome | **6 / 6** |
| Maternal and child follow-ups through an approved day (`mch-outreach-flow`) | Chrome | **11 recorded checks** (16 numbered steps), all passed |
| Feedback loop | Chrome | **10 recorded checks** (11 numbered steps), all passed |
| Physical Android: coordinator tab (glance, Needs, Resources, Plan, "Why this plan?", Progress), CHO task list, outreach-day form | Xiaomi 23076RN8DY, CareLink Android app | Rendered with the final configuration; read-only (`npm run outreach-phone`) |
| Physical Android: volunteer request offline, restart, sync; CHO offline resolution (`android-device-flow`) | Same phone; offline = USB port forward removed (server disconnection), **not airplane mode** | **8 / 8** (section 3a) |

**Planning flow failure and fix:** one run failed its offline-approval check. The supervisor's own note ("Approved: CHO and motorbike confirmed…") contains the word "Approved". The check was narrowed to the status and the server-confirmation line, and passed on rerun.

**Earlier results not reused:** results from before this change (JS 70/70, Python 88/88, Volunteer 14/14, Planning 13/13, MCH 20/20, Walkthrough 9/9, Supply 6/6) are historical. Every figure above comes from this session's runs.

### 3a. Physical Android flow (`evidence/android-device-flow.json`, 22 October 2026, 22:05–22:11)

**First attempt:** failed before any step. The phone was still signed in as the CHO from the screen check, so the volunteer login page could not open. The app was cleared after a sync; nothing was waiting to send, because only screens had been opened. The rerun passed every step:

| Step | Result |
|---|---|
| V1 | Volunteer signed in on the phone; a new Tolon household reached it by sync |
| V2 | Server unreachable: the volunteer saved a routine ANC request on the phone; nothing reached the server |
| V3 | App force-stopped and restarted while offline: the request is still on the phone ("Not yet acknowledged by the facility") |
| V4 | Reconnected: exactly one request reached the server; further syncs created no duplicate |
| C1 | CHO signed in; the mother's ANC follow-up is on the approved 2026-10-23 Dimabi day and on her profile |
| C2 | Server unreachable: the CHO resolved the follow-up from her task |
| C3 | Restarted offline: the resolution is still on the phone |
| C4 | Reconnected: one resolution reached the server, stamped with the CHO and the approved day; counted as completed for that day; no duplicate |

**Not covered on the phone:**
- the coordinator recording resource readiness (tested in Chrome by `supply-flow`);
- airplane mode.

**Known wording gap:** the profile's "Today" line still uses the earlier reason text ("Scheduled follow-up due"), while the task is titled "ANC follow-up due".

## 4. Engines (unchanged)

- **Engine 1:** the average of the last 4 reported weeks. Candidates are adopted only under the existing selection rule; the current model check keeps the baseline.
- **Engine 2:** OR-Tools CP-SAT. Assigns only documented obligations; the forecast adjusts priority only.

Details: `INTEGRATED_MCH_OUTREACH.md`.

## 5. Repository review

| Finding | Action |
|---|---|
| `scripts/oi-ui-flow.js`, `archive-legacy-oi.js`, `usability-phone.js`: unused | **Removed** in the submission cleanup (backup kept) |
| `demo-flow.js`, `offline-demo.js`: early demonstrations, superseded by `walkthrough-flow`, `feedback-flow` and `android-device-flow` | **Removed** in the submission cleanup (backup kept) |
| `docs/product/FRONTLINE_USABILITY_REPORT.md` refers to the previous tab layout ("Recommended schedule", "Nurses and transport") | Superseded by this report for the tab; its report-label and task-title findings still apply |
| Presentation labels (plan states, readiness statuses, referral states, visit types) | Centralized as constants at the top of the tab source; stored codes unchanged |
| UI transformation vs planning mathematics | Kept separate: the tab only reads records; the engines are in `outreach-intelligence/` |

## 6. Limitations and outstanding work

- **CHPS week (22–23 October):**
  - **Weekly schedule:** the observed Kalpohini schedule is configured for the demonstration facility, recommended rather than enforced, and the plan form shows the next outreach day.
  - **Tab wording:** aligned to the weekly schedule.
  - **Follow-ups needing attention:** listed in Progress.
  - **Request help notice:** clarified.
  - **Fresh results:** JavaScript 73/73; Python 89/89.
  - **Not rerun:** the browser flows, so as not to add generated records to the cleaned demonstration database; nor checked on Android.

  Details: [CHPS weekly field workflow](CHPS_WEEKLY_FIELD_WORKFLOW.md).

- **Phone layout:** the At a glance card fills most of the first phone screen; tapping a section scrolls to it.
- **Supervisor view:** the supervisor sees the same tab, opening on Plan. There is no separate supervisor-only layout.
- **CHO's "My Outreach":** this is CHT's Tasks tab; its label is not renamed. The volunteer's "Report need" and "My requests" are the existing household actions.
- **Test data in some counts:** volunteer contributions and referral counts include records from test runs on this device. The test marker is on the contacts, which the tab does not read; the screen says so.
- **Unsynced records:** the tab cannot show another phone's unsynced records. It says that records appear only after they sync.
- **Plan statuses:** "Completed" and "Superseded" are not shown, because there is no backend record for them.
- **No clean demonstration environment yet:** the inventory is ready (`OUTREACH_FIRST_DEMO.md`). No records were deleted; deletion needs explicit approval.
- **Integrations:** SMS, WhatsApp, voice, DHIMS2 and cross-facility referral delivery are not integrated or claimed.
