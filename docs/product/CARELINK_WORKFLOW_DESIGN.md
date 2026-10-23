# CareLink Reach — Workflow Design

> All people and places are fictional. No form contains clinical assessment, risk scoring or treatment guidance.

## Roles

| Role (`roles` key) | Offline | Can create | Tabs | Explicitly withheld |
|---|---|---|---|---|
| Community contact (`carelink_community`) | Yes | Request help (`can_carelink_request`) | Communities & Households, Visits & Requests | Tasks, targets, messages, export, user management, coordination, visit, referral |
| CHO (`carelink_cho`) | Yes | Request, visit (`can_carelink_visit`), referral | + My Outreach, Outreach Indicators | Coordination/assignment, user management |
| Facility coordinator (`carelink_coordinator`) | Yes | Coordination (`can_carelink_coordinate`), referral | All four | Visit documentation |
| Facility supervisor (`carelink_supervisor`) | Yes | — (read and indicators) | Contacts, reports, indicators (`can_aggregate_targets`) | Tasks, editing |
| System admin (`carelink_admin`) | No | People/places/users/config | Admin app | — |

Messages are switched off for every role because no SMS gateway is configured. Deleting contacts, reports or messages is granted to no one.

**Two layers of enforcement:**

1. **Interface:** form visibility uses `context.expression` and `context.permission`.
2. **Server:** `_design/carelink-authority` rejects any write of a CareLink form from a role not listed for it. Even direct API calls are refused. It also makes coordination, visit and referral records append-only, and blocks app users from deleting CareLink records or changing a record's form.

| Form | Roles the server accepts |
|---|---|
| `carelink_request` | community contact, CHO |
| `carelink_coordination` | coordinator |
| `carelink_visit` | CHO |
| `carelink_referral` | CHO, coordinator |

## Forms

| Form | Shown to | Purpose |
|---|---|---|
| `carelink_request` — **Request help** | Community contact, CHO (household only; hidden while a request is open) | Follow-up type (visit / schedule question / follow-up), contact method, access barrier, **consent (required: "no" blocks submit)** |
| `carelink_schedule` — **View confirmed nurse visits** | Community contact, CHO | Read-only: shows recorded schedule; states it is not a delivery receipt |
| `carelink_information` — **Information and audio** | Community contact | Says that reviewed audio is not yet available (see §Audio) |
| `carelink_coordination` — **Review or update request** | Coordinator | Accept / contact attempt / assign worker / schedule / in progress / unable / cancel |
| `carelink_visit` — **Document outreach outcome** | CHO | Visit date, visit type, follow-up needed, referral recorded, outcome (completed / unable to complete) |
| `carelink_referral` — **Record referral follow-up** | CHO, coordinator | recorded / acknowledged / follow-up scheduled / follow-up completed / unknown |

Task actions fill in the request ID, predecessor event, purpose, barrier and contact method. Workers do not re-enter them.

## State machine (`lib/workflow.js`)

```
awaiting_assignment → accepted → assigned → scheduled → in_progress → completed
                         ↘ contact_attempt ↗          ↘ unable_to_complete
                    any non-terminal → cancelled
```

- Terminal states are `completed`, `unable_to_complete` and `cancelled`.
- A request is only **completed** by a `carelink_visit` event with `status=completed`. Creating, sending or assigning a task never completes it.
- Two events with the same predecessor put the request in **`conflict`**. No new task is created, and the card says "facility review required".

## Tasks (`tasks.js`)

| Task | Who | Appears when | Resolves when |
|---|---|---|---|
| Review outreach request | Coordinator | A request exists and is not in conflict | Request reaches a terminal state |
| Outreach visit | **Only the assigned CHO** (`assigned_worker_id === user._id`) | Latest valid event is `scheduled` or `in_progress` | A later event supersedes it |

The task shows the household and community label, purpose, barrier, contact method and scheduled date.

## Referral states vs. the brief

The brief asks for 7 referral states. 5 are form values. The other two come from CHT's own sync, not from anything a user types:

| Brief | Implementation |
|---|---|
| Referral recorded | form value `recorded` |
| Electronic delivery pending | CHT sync indicator: record is still local |
| Referral delivered | Record present on server (verified by `npm run verify`) |
| Acknowledged by facility | form value `acknowledged`, only by an authorised role |
| Follow-up scheduled / completed | form values |
| Outcome unknown | form value `unknown` |

## Access barriers

Request choices: distance, transport unavailable, transport cost, household decision-making, language, other, prefer not to answer, none. They are shown on tasks and request cards as **community-reported** text. They are never used for scoring.

## Targets (`targets.js`)

All are plain counts with no goals (`goal: -1`): communities, requests, reviewed, awaiting review, assigned (active), completed, unresolved, transport barriers. Each one is computed from the same `workflow()` replay, so every number can be traced to request IDs. Device targets only cover what that device has replicated, including local unsynced records. The server-wide snapshot is in `evidence/server-verification.json`.

## Navigation

The tabs are renamed through translations: People → **Communities & Households**, Tasks → **My Outreach**, Reports → **Visits & Requests**, Targets → **Outreach Indicators**. The community user's "three actions" are the three household forms above. They are opened from the household's action button. CHT 5.3 has no configurable home screen.

## Audio

Disabled: `audio/manifest.json` has `enabled: false`. CHT can attach media to XForms, but there are no reviewed recordings or speaker permissions yet. The manifest sets out the required metadata: language, source script, speaker permission, reviewer, approval status, version and sha256.

## Outreach Intelligence roles

Coordinators and supervisors have the dedicated planning tab and CHT task-page prerequisites. Authors submit their own proposals; only supervisors may review or decide, and the server rejects self-approval. The general `can_edit` prerequisite does not grant permission to write another role’s forms: `authority/validate_doc_update.js` remains authoritative. See the Outreach Intelligence architecture and demo documents.
