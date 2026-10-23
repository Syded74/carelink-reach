# Supply-, equipment- and fuel-aware outreach scheduling (Engine 2)

This extends the existing Google OR-Tools CP-SAT model (`outreach-intelligence/carelink_oi/optimizer.py`). There is no new engine or service. It answers a Kalpohini finding: planned services fail when supplies run out, transport and fuel are limited, and equipment is hard to carry.

## Resource schema

**Configuration.** Each facility in `planning/tolon-district.json` has a `resources` list. The proof of concept ships **clearly labelled simulated values**. Each resource has:

| Field | Meaning |
|---|---|
| `id`, `name` | Identifier and display name |
| `category` | equipment, supply, fuel or vaccine |
| `unit` | e.g. pack, set, device, litres, dose |
| `quantity`, `reserved` | Amount on hand, and amount already set aside |
| `status` | simulated, confirmed, unavailable, insufficient, unknown or stale |
| `verified_at`, `verified_by` | When the status was confirmed, and by whom |

**Readiness records.** Coordinators and supervisors record readiness in CHT with the **Resource readiness** form (`carelink_resource_status`) on the facility. It records resource, status, quantity, reserved, date checked and a note.
- The server requires the author (`actor`) to be the signed-in user.
- Records can't be edited afterwards.
- The latest record per resource overrides the configuration (`carelink_oi/readiness.py`).
- Readiness records created by tests (`record_origin: 'test'`) count only for test plans.

**What counts as available:**
- simulated, or confirmed within `resource_policy.stale_after_days` (7): quantity minus reserved;
- insufficient: what was recorded;
- unavailable: 0;
- unknown, stale, or required but not configured: **0, and reported as needing confirmation.**

Unknown is never treated as available.

**Service requirements per visit type** (`service_requirements`, illustrative, pending programme and clinical review):

| Visit type | Consumables per encounter | Equipment carried |
|---|---|---|
| request | — | — |
| anc | 1 ANC outreach supplies pack | blood pressure monitor |
| pnc | 1 PNC outreach supplies pack | blood pressure monitor |
| cwc | 1 child welfare outreach supplies pack | growth measurement set |

Vaccine stock can be recorded, but it is **not tied to any visit type**. Linking vaccines to services needs reviewed clinical configuration.

**Fuel.** `fuel_policy` names the fuel resource (motorbike fuel, litres) and a planning assumption of 0.03 litres per travel minute.

## Model

**Decision variables.**
- **Existing:** x[w,d,r] = worker w makes trip r on day d; y[w,d,c] = items served in community c.
- **Per visit type:** y[w,d,c,t] for household request, ANC, PNC and CWC encounters.
- **New for equipment:** carry[w,d,e] = worker w carries equipment e on day d.

**Constraints.**
- **Existing:** one trip per worker per day; working hours (travel + setup + minutes per visit type); vehicles per day; documented demand; confirmed commitments; guaranteed minimums; qualifications.
- **Consumables:** for each resource, Σ y[w,d,c,t] × units per type ≤ usable quantity.
- **Equipment:** y[w,d,c,t] ≤ demand × carry[w,d,e] for every type that needs e, and Σ_w carry[w,d,e] ≤ sets on hand that day.
- **Fuel:** Σ x[w,d,r] × travel minutes(r) × litres per minute ≤ usable fuel.

**Objective:** unchanged. Maximise weighted documented items served, where the weights include the configurable fairness rules, minus a travel penalty.

**Per-service feasibility.** Each visit type is constrained separately, so a missing CWC supply blocks only CWC visits; ANC, PNC and request visits are still planned. Service components *within* one encounter (for example, one vaccine of several) are not modelled.

## Explanation

Every plan records:
- **`resource_plan`:** planned use per resource against what is usable, with status, verification date and source. This is a **planned allocation only**: stock is never deducted.
- **Per-community lines:** for example, "2 child welfare follow-ups not planned: limited by Child welfare outreach supplies (1 pack usable, all planned)", or "… availability is unknown (needs confirmation)".
- **Binding constraints:** working hours (judged against the shortest unmet visit type), transport, fully used resources, and fuel that can't cover the nearest round trip to unmet work.
- **`needs_confirmation`:** unknown or stale resources.
- **What-ifs:** one more working hour, one more vehicle, or 50% more of a binding supply (hypothetical).

The Outreach Intelligence tab shows:
- the latest readiness records, with an "Update resource readiness" button;
- each plan's resource allocation and what needs confirming.

## Fixed outreach calendar

Each facility has an `outreach_calendar` (weekday → activity). It is illustrative, modelled on the Kalpohini CHPS weekly CWC plan, and marked `unverified`:
- Monday and Thursday: static clinic;
- Tuesday: outreach;
- Wednesday: defaulter tracing and home visits.

| Setting | Behaviour |
|---|---|
| `enforced: false` (default) | A plan for a non-outreach day carries a "Calendar warning" naming the usual outreach day |
| `enforced: true` | Staff are unavailable for outreach on other days; the plan explains which day is kept for what |

Approved, unrecorded outreach days remain fixed commitments: no double-booking of a worker or vehicle. A recorded day releases the CHO.

## Scenarios (`outreach-intelligence/tests/test_supply_scenarios.py`)

| Scenario | Expected and verified |
|---|---|
| A. Adequate capacity | All 9 items served, no binding resource. With a 6-hour day, working hours bind and are reported |
| B. Supply shortage (2 CWC packs, 5 CWC visits) | CWC visits ≤ 2; ANC unaffected; "limited by"; a what-if with more packs |
| C. No motorbike | No trip; transport reported |
| D. Limited fuel (1.5 L) | Planned travel × rate ≤ 1.5 L; fuel reported as binding |
| E. One worker, two communities | One trip per worker per day; hours respected |
| F. Calendar | Warn (not enforced) or block (enforced) on a static-clinic day; the source and unverified status are carried; commitments kept |
| G. Mixed services, ANC supplies unavailable | ANC 0; request, PNC and CWC planned; "recorded as unavailable" |
| H. Unknown or stale stock | No CWC visits; "needs confirmation"; a required resource with no entry counts as zero |
| Readiness records | Override configuration; stale after 7 days; "unknown" makes the quantity 0 |

**Browser flow (`npm run supply-flow`, real CHT):**
1. The coordinator records "unknown" in the form.
2. The plan schedules no CWC visit and asks for confirmation; ANC proceeds.
3. With 1 pack confirmed, exactly one CWC visit is planned and the limit is named.
4. With 10 packs confirmed, more are planned; the recorded stock is unchanged.
5. The coordinator can't self-approve; the supervisor approves; the assignment carries the planned visit types.

## Not implemented

- Carrying capacity per vehicle.
- Rider availability separate from the worker.
- Service components inside one encounter.
- Reservation and consumption records (issued, used and returned quantities).
- Live inventory integration.

All quantities and requirements are planning assumptions until confirmed by the facility and reviewed.
