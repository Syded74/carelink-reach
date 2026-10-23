# Implementation verification report (Kalpohini field-validated changes)

**Date:** 22 October 2026.
**Scope:** changes made after the Kalpohini CHPS learning visit. Field evidence is in `KALPOHINI_FIELD_FINDINGS.md`.

**What "fresh" means:** every result below was produced in this session against the local CHT 5.3 stack (CouchDB, API, Sentinel and the Outreach Intelligence worker). No historical number is reused as a fresh result. Android is the exception and is reported separately.

**Order of runs:**
- The unit tests, `volunteer-flow`, `oi-cht-flow` and `mch-outreach-flow` were re-run after the last engine fix (supply staleness judged on the plan-creation day).
- The walkthrough, supply, MCH and feedback flows ran earlier in this session. They passed then and should be re-run before a formal sign-off.

## 1. Changed and added files

| Area | Files |
|---|---|
| Engine 2: supply, equipment, fuel, calendar | `outreach-intelligence/carelink_oi/readiness.py` (new), `optimizer.py`, `planning.py`, `cht_integration.py`, `data_adapter.py`, `features.py` (new) |
| Planning configuration | `planning/tolon-district.json`: `service_requirements`, `fuel_policy`, `resource_policy`, and per-facility `resources`, `outreach_calendar` and `directory` |
| Resource readiness in CHT | `scripts/build-oi-forms.js` (`carelink_resource_status` form), `authority/validate_doc_update.js`, `targets.js` (resources needing confirmation), UI extension readiness section |
| Referral coordination | `scripts/build-mch-forms.js` (receiving facility, routing notice, actor), `tasks.js` (acknowledgement task), `lib/mch.js`, `lib/mch-summary.js`, `targets.js` (four referral indicators) |
| Feedback and coverage | `lib/mch-outreach.js`, `lib/oi-links.js`, `lib/oi-export.js`, `lib/workflow.js` (dedupe by `_id`), UI extension coverage section |
| Privacy and replication | `purge.js`, `lib/test-records.js` |
| Tests | `test/*.test.js` (JS), `outreach-intelligence/tests/test_supply_scenarios.py` (new) and additions to `test_optimizer.py` and `test_cht_integration.py` |
| Browser flows | `scripts/supply-flow.js` (new), plus updates to `mch-flow.js`, `oi-cht-flow.js`, `walkthrough-flow.js`, `mch-outreach-flow.js` and `browser-helpers.js` |
| Android (not re-run) | `scripts/android-helpers.js`, `android-device-flow.js` and `android-roles-flow.js`; the cht-android flavor `carelink_reach_local` |
| Documentation | `KALPOHINI_FIELD_FINDINGS.md`, `GHS_REGISTER_TO_CHT_MAPPING.md`, `SUPPLY_AWARE_OPTIMIZATION.md`, `REFERRAL_COORDINATION_WORKFLOW.md`, `CARELINK_END_TO_END_DEMO.md`, this report |

CHT Core was not modified. No third engine was added.

## 2. Fresh test results

| Suite | Command | Result |
|---|---|---|
| JS unit tests (rules, authority, purge, targets, links, export) | `npm test` | **66 / 66 passed** |
| Python unit tests (forecasting, optimizer, scenarios A–H, readiness, integration) | `pytest` | **88 / 88 passed** |
| Volunteer flow | `npm run volunteer-flow` | **14 / 14** |
| Planning, approval and CHO flow | `npm run oi-cht-flow` | **13 / 13** recorded steps |
| End-to-end walkthrough | `npm run walkthrough-flow` | **9 / 9** |
| Supply-aware planning | `npm run supply-flow` | **6 / 6** |
| Maternal and child health, including referrals | `npm run mch-flow` | **20 / 20** |
| MCH ↔ Outreach Intelligence | `npm run mch-outreach-flow` | **11 / 11** recorded steps |
| Feedback loop | `npm run feedback-flow` | **10 / 10** recorded steps |
| Android device flows | `npm run android-device-flow`, `android-roles-flow` | **Not run this session** (no device connected) |

Each browser flow writes `evidence/<name>.json` and screenshots.

**Failures found and fixed during this verification:**

| Failure | Cause | Fix |
|---|---|---|
| A second MCH outreach plan was infeasible | Supply staleness was judged against the planning horizon date, not the day the plan was made | Staleness is now judged on the plan-creation day (`planning.live_resources`) |
| A replayed referral copy was treated as a conflict | The same document was replayed twice | Event chains keep one document per `_id` (`lib/mch.js`, `lib/workflow.js`) |
| `mch-flow` crashed opening a task | A single-action task opens its form directly | The test helper skips the action choice when the form is already open |
| `oi-cht-flow` step 12 counted recorded days | Recorded days were counted as active | Only unrecorded assignments are counted |
| `oi-cht-flow` step 13 flaked once | A radio click was lost while the form was still laying out | The test helper scrolls the input into view and retries (test-only change) |
| Optimizer explanations missed binding limits | Working hours were judged against a flat visit time; fuel was flagged only at exactly zero | Hours use the shortest unmet visit type; fuel uses the cheapest round trip to unmet work |

## 3. Optimizer scenarios

| Scenario | Status |
|---|---|
| A. Adequate capacity | Unit-tested |
| B. Supply shortage | Unit-tested |
| C. No motorbike | Unit-tested |
| D. Limited fuel | Unit-tested |
| E. One worker, two communities | Unit-tested |
| F. Fixed calendar (warn and enforce) | Unit-tested |
| G. Mixed services, ANC supplies unavailable | Unit-tested |
| H. Unknown or stale stock | Unit-tested |
| Unknown → confirmed 1 → confirmed 10 | Browser-tested (`supply-flow`) |
| I–L (prompt extensions) | Partly covered by existing tests: approved-day commitments and no double booking (`test_cht_integration.py`, `oi-cht-flow` step 12); infeasible commitments named (`_diagnose`); guaranteed minimum blocked by a resource (unit-tested). No separate I–L test file exists |

## 4. Privacy checks

- Generated records carry `record_origin: 'test'`. They are excluded from operational demand, exports and targets. Test plans are labelled in the UI.
- Volunteers do not replicate clinical reports, assignments, day plans or follow-up links. This is confirmed by `volunteer-flow` step 12 and `test/purge.test.js`.
- The server refuses volunteer writes of clinical, referral and coordination records (`volunteer-flow` step 13), events written in another person's name (`oi-cht-flow` step 8b), and replayed events (`mch-outreach-flow` step 16).
- Passwords come from `CARELINK_ACCOUNT_PASSWORD`. They are not stored in the repository or printed in evidence files.
- The Kalpohini photographs were used only for blank template headings. No client entries were transcribed.
- No referral photographs are stored or forwarded.

## 5. Android status

- **What was verified:** the cht-android flavor `carelink_reach_local` builds. On 22 October 2026, before these changes, offline capture, restart persistence and sync were verified on a physical phone (8 / 8).
- **What was not:** that run predates the supply, referral and calendar changes and is **not** a fresh result. `android-roles-flow` has never completed, because the phone locked during the run.
- **To re-verify:** connect the phone, `adb reverse tcp:5988 tcp:5988`, then `npm run android-device-flow` and `npm run android-roles-flow`.

## 6. Gaps and limitations

- **Resource values:** all are **simulated** planning assumptions. Service requirements per visit type are illustrative and await programme and clinical review.
- **Inventory:** vaccines are recorded but not linked to services. There are no reservation or consumption records, no live inventory feed, and no per-vehicle carrying capacity.
- **Outreach calendar:** modelled on one handwritten Kalpohini plan, unverified, and not enforced by default.
- **Facility directory:** services, referral relationships and contacts are empty and unverified.
- **Cross-facility referrals:** CHT replication by place limits cross-facility visibility. The minimal referral notice is designed, not implemented.
- **Register mapping:** documented only. The proposed fields (Vitamin A, ITN, TD/IPT dates, birth weight and length) are not implemented. No Z-scores or nutrition classification.
- **Local language:** the framework is documented. No reviewed translations or audio exist.

## 7. Integrations not configured

SMS (no gateway number, no message permissions), WhatsApp, voice, real-time notifications and DHIMS2 are **not** integrated or claimed.
