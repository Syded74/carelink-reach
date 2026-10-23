# CHPS weekly field workflow

**Principle:** outreach is an established, scheduled responsibility of the facility. CareLink does not decide *whether* outreach happens. It helps staff prepare, resource and track the outreach they already do.

**Flow:** Community needs → prepare the week's outreach → optimise the outreach day → supervisor approval → CHO activities → follow-up of unfinished work → progress.

## Observed weekly schedule

**Source:** the weekly activity plan photographed at Kalpohini CHPS during the team's learning visit, 22 October 2026 ([field findings](../field/KALPOHINI_FIELD_FINDINGS.md)). It is used as the demonstration facility's schedule. It is **not** a national Ghana Health Service rule and **not** confirmed by Tolon District Hospital.

| Day | Activity | In CareLink |
|---|---|---|
| Monday | Static services | Configured. A plan for Monday carries a calendar warning |
| Tuesday | Community outreach services | Configured as the outreach day. The plan request shows the next one |
| Wednesday | Defaulter tracing and home visits | Configured as an activity (warning if a routine plan falls on it). Unfinished work stays in CHO tasks; see below |
| Thursday | Static services | Configured. Warning, as for Monday |
| Friday | School health services | Configured. Warning, as for Monday |

## How it is implemented

- **Configuration, not code:** `planning/tolon-district.json` → `outreach_calendar.days` for Tolon District Hospital. The other facilities keep their own (illustrative) calendars. No weekday is hardcoded.
- **Recommended, not enforced** (`enforced: false`):
  - the plan request form shows "This facility's next scheduled outreach day is …", calculated from that facility's calendar;
  - if another weekday is chosen, the form says so;
  - the plan carries a calendar warning ("Friday is usually school health services at this facility; its usual outreach day is Tuesday…").
- **Why not enforced:**
  - the schedule is unconfirmed for this facility;
  - the existing regression flows plan on whichever weekday is free.
- **Turning enforcement on:** set `enforced: true` to make the engine plan routine outreach only on the outreach day; that switch was already supported and is tested in scenario F and the observed-week test. Enforcement affects routine outreach planning only. Urgent concerns and referrals are never part of routine plans.
- **Outreach tab wording:**
  - **Needs:** "Prepare for this week's outreach", with the next outreach date and documented visits by service (ANC, PNC, child welfare, household requests) separate from the forecast;
  - **Resources:** "Resources for the next outreach";
  - **Plan:** "Next scheduled outreach", with the weekly schedule and the ANC / PNC / child welfare / household-request split;
  - **Progress:** "Outreach completed and follow-ups still needed", including **Follow-ups needing attention**.

## Wednesday follow-up (defaulter tracing)

CareLink has no separate Wednesday scheduling, and none was invented. What exists:
- **Open obligations stay on the CHO's Tasks list:** an unvisited household request, an unresolved ANC/PNC/child welfare follow-up, or a missed appointment ("ANC follow-up due", "Missed appointment — follow up", "Household visit planned").
- **Unfinished planned work is listed:** **Progress → Follow-ups needing attention** lists the unfinished items from approved outreach days, with community and planned date.
- **Unfinished work is planned again:** it stays in the next plan's documented demand.

Nothing is moved to Wednesday or closed automatically. Outcomes are recorded by the CHO, as before.

## Community volunteers

Volunteers connect households and the facility. They do not assess or diagnose.

| How needs reach CareLink | Supported by |
|---|---|
| Household asks for a routine service or help reaching care | **Request help** on the household: service (ANC, PNC, child welfare, family planning…), the help wanted, contact method, access barrier, travel time, consent |
| CHO-directed follow-up | The CHO's own tasks; a volunteer can record a **household contact** on an open request |
| Outreach preparation | The request status on the household ("Acknowledged by the facility: …", scheduled date) |

**Request help notice (wording only, no new fields):** "Use this to report a routine need from the household. You do not need to assess anyone's health. Urgent or serious concern? Contact the CHO or the facility directly now; do not wait for a request or an outreach day."

## Roles in practice (existing CHT screens, no new app)

| Group | Account | Where they work | What they see first |
|---|---|---|---|
| Community volunteer | `aiddrisu` | People → household | **Request help** (report a routine need); the household's **Request status** card (status first) |
| CHO / nurse | `sabukari` | **Tasks** (their "My outreach") | **Planned outreach day** showing its services, e.g. "Dimabi · 9 visit(s): ANC 3 · PNC 2 · CWC 4"; then household visits and follow-ups, each recorded on its own |
| Coordinator | `rseidu` | **Community Outreach** tab | At a glance: Care needed · Resources · Current plan · Approval · Still open; then Needs / Resources / Plan / Progress |
| Supervisor | `mtahiru` | Same tab, opening on **Plan** | At a glance starts with **Approval**. A **Your decision is needed** card names the plan (date, communities, visits) with one button, **Open my tasks to decide** |

**Analytics wording:**
- **Requests:** "Requests submitted", "Requests reviewed by the facility", "Requests still open".
- **Visits:** "Visits assigned on approved outreach days", "Visits recorded completed", "Household visits not completed" (new count, from the recorded outcome), "Follow-ups still outstanding".

The coordinator and supervisor see partly done visits and reasons in **Progress**.

**Volunteers:** they have no Analytics tab, so request status is on each household.

## Outside CareLink's scope

- Static services and school health activities themselves.
- Urgent clinical decisions and triage.
- National schedules.
- Confirming this calendar for Tolon District Hospital (it needs facility confirmation).

## Files changed

| Area | File |
|---|---|
| Weekly schedule | `planning/tolon-district.json` |
| Plan form | `scripts/build-oi-forms.js` → `forms/app/carelink_oi_request.xml` |
| Request help notice | `forms/app/carelink_request.xml` |
| Tab wording, decision card, glance order | `ui-extensions-src/carelink-outreach-intelligence.js` |
| Request status card | `contact-summary.templated.js` |
| Outreach-day task label, target labels | `tasks.js`, `targets.js`, `translations/messages-en.properties` |
| Schedule passed to the tab | `scripts/build-oi-extension.js` |
| Hidden form helpers | `lib/report-labels.js` |
| Tests | `test/weekly-calendar.test.js`, `test/role-presentation.test.js` (new); `outreach-intelligence/tests/test_supply_scenarios.py` (updated scenario F, new observed-week test) |

The engines' forecasting and optimisation code is unchanged.
