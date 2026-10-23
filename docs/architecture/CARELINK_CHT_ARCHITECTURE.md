# CareLink Reach — CHT Architecture

> Fictional-data proof of concept. Not approved for real patients.

## 1. What runs where

| Component | Location | Notes |
|---|---|---|
| CHT Core source | `~/Downloads/cht-core-master` | CHT **5.3.0** (from `package.json`). Not a git checkout, so there is no branch. The only change is one stylesheet patch (§2). |
| CouchDB | Docker `cht-local-couchdb`, `cht-local-nouveau` | Images `public.ecr.aws/medic/cht-couchdb(-nouveau):5.3.0-alpha`. |
| API / webapp | `http://localhost:5988` | Run from the CHT Core source in development mode. Its health check reported `medic-api` ready, with all services running, on 2026-10-21. |
| CareLink configuration project | `~/Downloads/carelink-reach-config` | Separate `cht-conf` project (this folder). |
| Private state (backups, seed manifest, demo passwords) | `~/.carelink-reach` (override with `CARELINK_STATE_DIR`) | Mode `0700`, outside the project, never committed. |
| Existing CareLink product (Flutter, Python, admin web) | Separate repos | Not touched, linked or migrated. See §6. |

Tooling: `cht-conf` 6.6.1 and `cht-conf-test-harness` 5.0.4, resolved via a `node_modules` symlink to the CHT Core checkout. `scripts/cht.js` wraps `cht-conf` and refuses to upload unless `CHT_URL` is set.

## 2. Configuration-only approach

All CareLink behaviour uses supported CHT configuration:

| Need | CHT mechanism | File(s) |
|---|---|---|
| Roles and permissions | `roles`, `permissions` | `app_settings/base_settings.json` |
| Hierarchy | Configurable contact types (`contact_types`) | `app_settings/base_settings.json`, `forms/contact/*` |
| Forms | XForms + `.properties.json` (`context.expression`, `context.permission`) | `forms/app/*` |
| Tasks | `tasks.js` (rules engine) | `tasks.js`, `lib/workflow.js` |
| Targets | `targets.js` | `targets.js` |
| Contact summary / request cards | `contact-summary.templated.js` | — |
| Branding | `branding.json` + `upload-branding` | `branding/` |
| Icons | `resources.json` + `upload-resources`; `header_tabs.*.resource_icon` | `resources/` |
| Tab labels and text | Custom translations | `translations/messages-en.properties` |

The pre-existing default forms were hidden (not deleted) by `scripts/retire-legacy-forms.js`. It sets their `context.permission` to a permission that no role holds (`carelink_legacy_disabled`). Restoring the configuration backup reverses this.

Two additions go beyond `cht-conf` configuration. Both are kept in this project:

1. **Server-side authority** (`authority/validate_doc_update.js` → `_design/carelink-authority`). This is a separate CouchDB design doc. It is **not** a change to CHT's own design docs. CouchDB runs every design doc's `validate_doc_update` on every write. CHT forwards offline users' writes to CouchDB with the user's own credentials, so the function sees their real CHT roles. CHT's startup installs and compares only its bundled design docs and never removes extra ones (`api/src/services/setup/utils.js`). Remove it with `node scripts/deploy-authority.js --remove`.
2. **One core stylesheet patch** (`core-patches/0001-carelink-brand-colours.patch`) for header and navigation colours. CHT 5.3 hard-codes these in LESS. It changes colour variables only. See `core-patches/README.md` for the rebuild steps, how to revert, and the AGPL implications.

## 3. Contact hierarchy

```
carelink_region
 └─ carelink_district
     └─ carelink_facility        (partner health facility)
         └─ carelink_community
             └─ carelink_household
                 └─ carelink_individual (person; also allowed under facility/community for staff)
```

Each household stores explicit links: `responsible_worker_id`, `community_contact_id` and `partner_facility_id`. Users are attached to a place, so CHT replication limits each device to its own branch:

| Role | Assigned place |
|---|---|
| Community contact | One community |
| CHO | One or more communities (`can_have_multiple_places`) |
| Coordinator and supervisor | The facility |

## 4. Request workflow model

Coordination is stored as **append-only reports**, not by editing the request document:

- `carelink_request`: the original request.
- `carelink_coordination`: accepted, contact attempt, assigned, scheduled, in progress, unable to complete, cancelled.
- `carelink_visit`: completed or unable to complete.

Every event names the event it follows (`expected_event`). `lib/workflow.js` replays that chain against a fixed state machine (`TRANSITIONS`). If two events claim the same predecessor, for example two coordinators assigning offline at once, the request goes into a **`conflict`** state. The system does not pick a winner by timestamp. Downstream tasks stop until a person resolves it.

These business states are separate from CHT task states. A CHT task is only a prompt to act. Completing a task means a form was submitted. It does not mean care happened.

## 5. Offline model

This uses CHT's standard offline-first PouchDB ↔ CouchDB replication, unchanged. All operational roles have `offline: true`. The admin role is online only. Requests are saved to the local database first. The contact summary says on every card that "saved locally ≠ delivered". The CHT sync indicator in the menu is the source of truth for whether a record has been transmitted.

## 6. Relationship to the existing CareLink product

The Flutter app, Python backend, admin dashboard and nutrition component are **not** connected to this instance. The CHT prototype holds no ANC, PNC or CWC clinical forms. Any future integration needs its own design. Options would be the CHT API or an outbound push through `cht-conf` / `mediator`, with data-mapping, consent and security review first.

## 7. Licensing (AGPL-3.0)

CHT Core is licensed under AGPL-3.0. This configuration project is also marked `AGPL-3.0-only` in `package.json`.

- **This prototype runs a modified CHT Core** (the colour patch). If it is offered to users over a network, offer them the patch and the CHT source, for example by linking to `core-patches/`. Remove the patch to go back to unmodified CHT.
- Running unmodified CHT Core with custom configuration does not by itself require publishing that configuration. The configuration is data loaded into the app, not a modification of it. Many deployments publish their configuration anyway.
- **If CHT Core is modified** and users reach it over a network, AGPL §13 requires offering those users the corresponding source of the modified version.
- Brand assets in `branding/` and `resources/` are original CareLink artwork. No UNICEF, KOICA, GHS or other institutional marks are used.
- Get legal advice before distributing this to partners or institutions.

## Outreach Intelligence continuation

Use the integrated CHT tab and worker described in [Outreach Intelligence architecture](OUTREACH_INTELLIGENCE_ARCHITECTURE.md) and [demo guide](../guides/OUTREACH_INTELLIGENCE_DEMO.md). The separate developer website is retained only for regression work. Model evaluation and deployment limits are documented alongside them.
