# Integrated maternal and child outreach

**Scope:** how ANC, PNC and CWC work and household requests are planned together in one community outreach plan, and what that does **not** mean. It describes existing behaviour; the engines were not changed in this refinement.

## Engine 1 — demand forecasting (`outreach-intelligence/carelink_oi/forecast.py`)

**Purpose:** estimate how much routine outreach each community may need next week.

**Inputs:**
- weekly counts of documented routine work from CHT: household requests, missed appointments, maternal and child follow-ups falling due;
- reporting coverage (weeks with data in the last 12).

**Operational method:** an explainable baseline, the **average of the last 4 reported weeks**.
- Candidate statistical models are evaluated, but are adopted only if they pass the existing selection rule: at least 10% lower pooled error and no more than 10% worse for any community.
- The current model check reports that no candidate met the rule, so the baseline stays in use.

**Frontline presentation (Needs section):**
- documented visits waiting (CHT records);
- "Expected routine outreach needs: about N next week";
- "Expected workload is estimated from recent recorded demand";
- "Limited reporting history — estimate may be less reliable" when coverage is under 50%.

The model version and validation statistics are under **Technical details**.

The demonstration's past weeks are **simulated** and labelled as such on screen.

## Engine 2 — integrated scheduling (`optimizer.py`, Google OR-Tools CP-SAT)

**What it assigns:** only **documented** routine obligations (`planning.demand_from`: "Planning demand = documented pending routine items now").

**What the forecast does:** it only adjusts each community's priority weight (`growth_weight`, when the estimate is above the recent average). It never creates household assignments.

**Visit types modelled separately within one trip:** `request`, `anc`, `pnc`, `cwc`. Each type has its own:

| Per visit type | Where it is set |
|---|---|
| Eligibility (documented demand of that type in that community) | `pending_by_type` from CHT records |
| Time per encounter | `service_minutes_by_visit_type` |
| Worker qualification | the staff `qualifications` in `planning/tolon-district.json` |
| Consumable supplies | `service_requirements` and readiness records |
| Equipment carried | `service_requirements` (blood pressure monitor for ANC/PNC; growth set for CWC) |

**Shared across all types:**
- one trip per worker per day;
- working hours;
- motorbikes per day;
- the fuel budget;
- the outreach calendar (warning, or enforced);
- approved days already committed;
- community fairness weights and guaranteed communities.

**Effect:** one community trip can serve ANC, PNC, CWC and household requests together. A shortage of one type's supply or equipment blocks only that type.
- **Verified by:** `tests/test_supply_scenarios.py` scenario G and `npm run supply-flow`.
- **Supply-flow result:** CWC unknown → 0 CWC visits, ANC still planned; 1 pack → 1 CWC visit; 10 packs → more (limited by the one growth-measurement set and time).

**Not modelled:**
- physical vehicle carrying capacity;
- rider availability separate from the worker;
- service components within one encounter (e.g. individual vaccines).

## Plan presentation (Plan section)

**Weekly schedule:** the demonstration facility's observed CHPS week (Tuesday outreach, Wednesday defaulter tracing and home visits, Monday and Thursday static services, Friday school health) is configured and *recommended*, not enforced. A Tuesday plan for one CHO serves ANC, PNC and child welfare together on one trip. This is tested by `test_observed_chps_week_tuesday_outreach_friday_school_health_integrated_trip`. See [CHPS weekly field workflow](../product/CHPS_WEEKLY_FIELD_WORKFLOW.md).


**The plan card shows:**
- date, assigned CHO, communities and motorbike;
- planned visits, and visits we could not plan;
- the split by type, e.g. "ANC: 4 · Child welfare: 4 · Household requests: 1";
- resource readiness;
- "What's limiting this plan?";
- one next action.

**A missing supply is stated simply:** "Child welfare outreach supplies need confirmation before these visits can be scheduled."

## Completion is per obligation, never per trip

Combining services on one trip does not mark any of them done:
- **Household requests** complete only through the CHO's visit record for that request.
- **Maternal and child follow-ups** close only through a resolution or a later qualifying record for that person and task (`lib/oi-links.js` `followUpOutcome`).
- **Recording the outreach day** is an operational record. It closes nothing.

## Safety boundaries kept

- Danger signs and referral follow-ups are excluded from routine demand and planning ("N danger-sign review(s) are not part of this routine plan").
- No vaccination schedules, due doses, clinical thresholds or classifications are added. Service requirements per visit type are illustrative, pending programme and clinical review.
- Simulated resource quantities are labelled "planning estimate, not confirmed stock".
