# CareLink Reach

**Predict the need. Plan the outreach. Track the outcome.**

CareLink Reach is an AI-assisted, offline-first **community outreach planning and coordination layer** built on the [Community Health Toolkit](https://communityhealthtoolkit.org) (CHT 5.3). It helps a CHPS facility decide where routine maternal and child outreach is needed next and plan who goes, when and with what. It then tracks what was actually done and makes sure referrals reach the receiving facility and get closed.

It was built for the **UNICEF AI for Nurturing Care Hackathon**, for **Tolon District, Northern Region, Ghana**. It is a proof of concept on generated demonstration data. It does not replace Ghana Health Service registers, DHIMS2 or clinical judgement.

> ▶ **Watch the workflow:** [`demo-video/final/CareLink_Reach_App_Workflow_fast.mp4`](demo-video/final/CareLink_Reach_App_Workflow_fast.mp4) (3 min 20 s, 1.5×) or the [full-speed version](demo-video/final/CareLink_Reach_App_Workflow.mp4) (5 min). The recording shows the real app on a phone screen with real taps and saves, from household registration through to a closed referral.

---

## Contents

- [The problem](#the-problem)
- [What CareLink Reach does](#what-carelink-reach-does)
- [The field workflow](#the-field-workflow)
- [Roles](#roles)
- [The two AI engines](#the-two-ai-engines)
- [Architecture](#architecture)
- [Safety, privacy and human control](#safety-privacy-and-human-control)
- [Repository layout](#repository-layout)
- [Getting started (local)](#getting-started-local)
- [Android app](#android-app)
- [Cloud demo (Azure)](#cloud-demo-azure)
- [Testing](#testing)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)
- [Credits and license](#credits-and-license)

---

## The problem

CHPS teams in northern Ghana run weekly community outreach for antenatal care (ANC), postnatal care (PNC) and child welfare (CWC) with very limited means: one or two community health officers (CHOs), a shared motorbike, fuel and supplies. In practice:

1. **The need is invisible until the day.** Volunteers know which households need care, but that knowledge rarely reaches the facility in a form that can be planned around.
2. **Planning is guesswork.** Which communities, which day, which nurse, which motorbike, enough supplies? It is decided by hand, and people with transport barriers are easily missed.
3. **The loop does not close.** Referrals leave the community without confirmation that they arrived, and unfinished follow-ups fall through the cracks.

## What CareLink Reach does

| Question | How CareLink Reach answers it |
|---|---|
| **Where is care needed?** | Volunteers register households and report needs. CHOs record ANC/PNC/CWC visits. **Engine 1** estimates next week's routine workload per community and explains why. |
| **How do we get there?** | **Engine 2** (Google OR-Tools CP-SAT) builds an outreach plan that fits the staff, motorbikes, working hours, fuel, supplies, equipment and the facility's outreach calendar. |
| **Who decides?** | People. A coordinator submits the plan and a *different* supervisor approves it. The server enforces this. |
| **Did the outreach happen?** | CHOs receive the approved day as tasks and record each visit. Every record is stamped with the worker who made it. |
| **Did the referral arrive?** | Referrals go to the receiving facility. It acknowledges them, confirms arrival and records the outcome, and the CHO closes the loop. |
| **Who still needs attention?** | Unfinished visits and follow-ups stay open and flow into next week's plan. |

Everything works **offline** on the phone (CHT stores records locally and syncs when there is a connection).

## The field workflow

This is what the [workflow video](demo-video/final/CareLink_Reach_App_Workflow_fast.mp4) shows, step by step, in the real app:

```mermaid
flowchart LR
    V["Volunteer<br/>registers household"] --> C1["CHO<br/>registers mother / child"]
    C1 --> K["Coordinator<br/>sees need · confirms resources<br/>requests a plan"]
    K --> E["Engines 1 + 2<br/>estimate need · build plan"]
    E --> K2["Coordinator<br/>reviews and submits"]
    K2 --> S["Supervisor<br/>approves or rejects"]
    S --> C2["CHO<br/>outreach day: visit,<br/>complaints, vital signs"]
    C2 -- danger sign --> R["CHO<br/>starts referral"]
    R --> F["Receiving facility<br/>acknowledges · arrival · outcome"]
    F --> C3["CHO<br/>closes referral"]
    C2 --> P["Progress<br/>done vs. still open"]
    C3 --> P
    P --> K
```

1. **Volunteer** registers a household in their community and can submit a request for help (for example, antenatal care with a transport barrier).
2. **CHO** registers the people in the household (pregnant woman, mother after delivery, or child) and is given their follow-up tasks ("First ANC visit due").
3. **Coordinator** opens **Community Outreach** and sees the documented need per community. They record resource readiness (for example, *Blood pressure monitor: available, 1*). Then they request a plan for an outreach date, naming the CHO, working hours and motorbike.
4. **Engines 1 and 2** produce a plan with its reasons ("Why this plan?", "What's limiting this plan?"). The coordinator reviews it and submits it.
5. **Supervisor** reviews and approves (or rejects with a reason).
6. **CHO** gets the approved outreach day as a task. On the day she records each visit: complaints reported by the woman, vital signs (BP, weight, and so on) and any danger signs.
7. If a **danger sign** is recorded, an urgent task offers **Start a referral** to a receiving facility. Urgent cases never wait for a routine plan.
8. The **receiving facility** acknowledges the referral, confirms arrival and records the outcome. The **CHO** closes it.
9. **Progress** shows visits assigned, completed and still open by community and health worker. Open work goes into the next plan.

## Roles

| Role | Account (demo) | Home in the app | Can do |
|---|---|---|---|
| Community volunteer | `aiddrisu` | People → household | Register households, request help, see request status. No clinical data. |
| Community health officer (CHO) | `sabukari` | **Tasks** | Register individuals; record ANC/PNC/CWC visits, pregnancy, delivery and appointments; start and close referrals; record outreach days |
| Facility coordinator | `rseidu` | **Community Outreach** tab: Needs · Resources · Plan · Progress | Confirm resources, request and submit plans, acknowledge incoming referrals and record arrival/outcome |
| Facility supervisor | `mtahiru` | Community Outreach (opens on plans waiting for a decision) | Review and approve or reject plans, close referrals, see targets |
| System administrator | `kboateng` | CHT admin app | Users, places and configuration |

Passwords are never stored in this repository. They are passed as environment variables (see [Getting started](#getting-started-local)).

## The two AI engines

Both engines live in [`outreach-intelligence/`](outreach-intelligence/) (Python) and run on the server in a background worker. The worker reads community-level counts from CHT and writes back a proposed plan as a CHT report. It never edits a person's record.

### Engine 1: Demand estimate (explainable forecasting)

- **Predicts:** next week's *routine outreach workload* per community: new requests, follow-ups falling due, recorded missed appointments and open referrals.
- **Inputs:** community × week counts only. No person-level data, no vitals, no danger signs, and no demographic proxies.
- **Method:** four transparent baselines (last week, mean of the last 4 reported weeks, EWMA, seasonal naive). The one with the lowest back-test error is selected; on the demonstration data that is the **mean of the last 4 reported weeks**. Missing weeks count as *missing*, not zero. A community with fewer than 8 reported weeks gets no forecast and is labelled that way.
- **Explains itself:** for example, "Tolon has 3 documented routine follow-up item(s) pending now; in the last 4 reported weeks, workload came mostly from follow-ups falling due (4) and new help requests (2)".
- An experimental Poisson regression is evaluated alongside but **not used by the planner**, because it was not better than the transparent baseline. See the [model card](docs/engines/FORECASTING_MODEL_CARD.md).

### Engine 2: Resource-aware outreach scheduling (Google OR-Tools CP-SAT)

- **Decides:** which communities each CHO visits, on which day and with which vehicle, and how many documented visits each trip covers.
- **Hard constraints:** one place at a time; only available staff and days; working hours including travel and per-visit time; one vehicle per trip; never more visits than documented; confirmed assignments stay fixed; optional guaranteed communities; supplies and equipment readiness.
- **Objective:** cover as much documented need as possible. It weights under-served communities (transport barriers, poor reporting) and growing demand, and penalises travel time. The weights are policy settings for the facility to review.
- **Explains itself:** "What's limiting this plan?" names the binding constraint (hours, vehicle, fuel, a missing supply).
- See [scheduling optimiser](docs/engines/SCHEDULING_OPTIMIZER.md) and [supply-aware scheduling](docs/engines/SUPPLY_AWARE_OPTIMIZATION.md).

**Plans are recommendations.** Nothing is scheduled until a supervisor approves it, and the AI makes no clinical decision.

## Architecture

```mermaid
flowchart TB
    subgraph Phones["Phones and browsers (offline-first)"]
        A1["CHT web app / CareLink Android<br/>forms · tasks · targets<br/>Community Outreach tab"]
        DB1[("Local PouchDB")]
        A1 --- DB1
    end
    subgraph Server["CHT 5.3 server"]
        API["CHT API + Sentinel"]
        COUCH[("CouchDB<br/>validate_doc_update:<br/>CareLink authority rules")]
        API --- COUCH
    end
    subgraph Engines["Outreach Intelligence worker (Python)"]
        W["cht_integration.py<br/>service account"]
        E1["Engine 1<br/>forecast.py"]
        E2["Engine 2<br/>optimizer.py (OR-Tools CP-SAT)"]
        W --> E1 --> E2 --> W
    end
    DB1 <-- "sync when online" --> API
    W <-- "community counts in,<br/>plan proposals out" --> COUCH
```

| Layer | What CareLink adds on top of CHT |
|---|---|
| **CHT configuration** | Contact hierarchy (region → district → facility → community → household → individual), 19 app forms and 12 contact forms, tasks, targets, contact summaries, translations, branding and purge rules |
| **Community Outreach tab** | A CHT UI extension ([`ui-extensions-src/`](ui-extensions-src/)) with Needs, Resources, Plan and Progress, a CSV export, and role-specific "At a glance" summaries |
| **Shared rules** | [`lib/`](lib/): request and referral lifecycles, MCH follow-up tracking, links between plans and visits, report labels. Used by tasks, targets, the tab and tests. |
| **Server authority** | [`authority/validate_doc_update.js`](authority/validate_doc_update.js): who may do what (role per action), actor stamping, append-only events, and separation of duties for plan approval |
| **Engines and worker** | [`outreach-intelligence/`](outreach-intelligence/): forecasting, optimisation and the CHT worker |
| **Planning data** | [`planning/tolon-district.json`](planning/tolon-district.json): facilities, staff, motorbikes, travel times, resources and the outreach calendar |

More detail: [CHT architecture](docs/architecture/CARELINK_CHT_ARCHITECTURE.md) · [Outreach Intelligence architecture](docs/architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md) · [security and limitations](docs/architecture/CARELINK_SECURITY_AND_LIMITATIONS.md).

## Safety, privacy and human control

- **Human approval:** a plan is only a recommendation. The coordinator who submits a plan cannot approve it; the server refuses it.
- **No clinical AI:** the engines see community-level workload counts, not people, vitals or danger signs. Danger signs follow the facility's emergency referral protocol and **never wait for a plan**.
- **No unreviewed clinical rules:** BP and temperature alert thresholds and ANC/PNC/CWC schedules are **inactive, pending clinical review**. Forms record what was observed; they do not classify.
- **Honest records:** "Unknown" is kept separate from "absent". Reported values are kept separate from observed ones. A completed visit is staff documentation, **not independent verification**.
- **Server-enforced roles:** every record is stamped with the actor. Workflow events are append-only, and each action is allowed only for its role.
- **Least data on phones:** volunteers see no clinical data, and purge rules keep service-only planning records off volunteers' phones.
- **Generated data only:** every person, household and plan in this project is generated for demonstration. Simulated forecast history is labelled as simulated in the app.
- **No secrets in the repository:** credentials come only from environment variables or a private folder outside the project (`~/.carelink-reach/`).

## Repository layout

```
carelink-reach/
├── README.md
├── package.json                    npm scripts (build, deploy, tests, regression flows)
│
├── app_settings/                   ┐
├── forms/app/  forms/contact/      │
├── translations/  resources/       │  CHT configuration (cht-conf layout; must stay at the top level)
├── branding/  branding.json        │
├── tasks.js  targets.js            │
├── contact-summary.templated.js    │
├── purge.js  resources.json        ┘
│
├── ui-extensions-src/              Community Outreach tab (source)
├── ui-extensions/                  … built by `npm run build-oi-extension`
├── lib/                            shared rules (requests, referrals, MCH tracking, plan links)
├── authority/                      CouchDB validate_doc_update (server-side role rules)
├── planning/                       district planning data (Tolon)
│
├── outreach-intelligence/          Python: Engine 1, Engine 2, CHT worker, tests
│   ├── carelink_oi/                forecast.py · optimizer.py · cht_integration.py · …
│   ├── tests/
│   └── requirements.txt
│
├── scripts/                        form builders, deploy, accounts, backup, regression flows
├── test/                           JavaScript unit tests
├── android/                        CareLink flavors for cht-android (local and Azure)
├── core-patches/                   the one applied CHT Core patch (side menu), with instructions
├── audio/                          audio prompts manifest (disabled until reviewed recordings exist)
├── demo-video/                     workflow recording scripts and the final videos
├── evidence/                       regression results (*.json) and screenshots (generated data)
└── docs/                           documentation by topic (see docs/README.md)
```

## Getting started (local)

### Prerequisites

- A local **CHT 5.3** instance (CHT Core with CouchDB). This project expects a CHT Core checkout next to it at `../cht-core-master`, and `node_modules` is a symlink to that checkout's modules, which include `cht-conf`. Otherwise run `npm install` here.
- **Node.js** 20 or later, and **Python 3.12** for the engines.
- An admin account on the CHT instance.

### 1. Credentials (environment only)

```sh
export CHT_URL='http://ADMIN:PASSWORD@localhost:5988'        # cht-conf uploads
export CHT_COUCH_URL='http://ADMIN:PASSWORD@localhost:5984'  # scripts (backup, checks, flows)
export CARELINK_ACCOUNT_PASSWORD='…'                          # the five CareLink demo accounts
```

The scripts refuse non-localhost URLs. A remote server is reached through an SSH tunnel (see the [Azure guide](docs/guides/AZURE_DEMO_DEPLOYMENT.md)).

### 2. Configure CHT

```sh
npm run backup             # always first → ~/.carelink-reach/backups/<timestamp>/
npm test                   # compiles app settings, then runs the JavaScript unit tests
npm run deploy             # report labels, settings, forms, translations, resources, the tab
npm run deploy-authority   # server-side role and authorship rules
npm run setup-accounts     # volunteer, CHO, coordinator, supervisor, admin
```

### 3. Start the engines

```sh
cd outreach-intelligence
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q        # engine tests
cd ..
npm run oi-worker -- --watch 5       # the planning worker; keep it running
```

### 4. Use it

Open **http://localhost:5988** and sign in as one of the roles above. To use a phone over USB, run `adb reverse tcp:5988 tcp:5988` and install the `carelink_reach_local` Android build.

### Useful scripts

| Command | Purpose |
|---|---|
| `npm run build-forms` / `build-oi-forms` / `build-volunteer-forms` | Regenerate XForms from their builders, plus report labels |
| `npm run build-oi-extension` | Build the Community Outreach tab |
| `npm run plan` | Run a planning scenario from the command line |
| `npm run oi-export` | Export community-level counts (read-only) |
| `npm run verify` / `check-access` | Check a live server's configuration and role access |
| `npm run seed` / `cleanup` | Create or remove generated demonstration records |

## Android app

[`android/`](android/) holds two [cht-android](https://github.com/medic/cht-android) flavors with CareLink branding:

| Flavor | Server | App name |
|---|---|---|
| `carelink_reach_azure` | the Azure demo server | CareLink Reach |
| `carelink_reach_local` | `http://localhost:5988` via `adb reverse` | CareLink (local) |

Build with JDK 21 and `RELEASE_VERSION=v1.8.0 ./gradlew assembleCarelink_reach_azureDebug`. Step-by-step instructions are in [`android/README.md`](android/README.md).

## Cloud demo (Azure)

For the hackathon demo, CHT 5.3 runs on an Azure VM (Docker Compose, Let's Encrypt HTTPS) with the planning worker as a systemd service, so phones sync without the development laptop. CouchDB and the API listen only on localhost behind the HTTPS proxy, and SSH is restricted. Setup, deployment through an SSH tunnel, and operations are in [docs/guides/AZURE_DEMO_DEPLOYMENT.md](docs/guides/AZURE_DEMO_DEPLOYMENT.md).

## Testing

| Suite | Command | Result (23 Oct 2026) |
|---|---|---|
| JavaScript unit tests: rules, authority, purge, tasks/targets, labels, tab | `npm test` | **77 passed** |
| Python engine tests: forecast, optimiser, supply, worker integration | `npm run oi-test` | **89 passed** |

**End-to-end regression flows** drive the real CHT UI in a browser (or a physical phone over USB). They check every step against the server and write `evidence/<name>.json`:

```sh
npm run volunteer-flow && npm run oi-cht-flow   # volunteer request → plan → approval → CHO
npm run mch-flow             # ANC → delivery → PNC → CWC, duplicates, referrals
npm run walkthrough-flow     # one complete outreach cycle
npm run supply-flow          # supplies: unknown → 1 pack → 10 packs
npm run mch-outreach-flow    # maternal/child follow-ups through an approved day
npm run feedback-flow        # outcomes feed the next plan
npm run android-device-flow  # physical phone: offline save, restart, sync
```

The latest results are summarised in the [outreach-first simplification report](docs/product/OUTREACH_FIRST_SIMPLIFICATION_REPORT.md).

## Documentation

| Folder | Contents |
|---|---|
| [docs/guides/](docs/guides/) | How to run the demos and the Azure deployment |
| [docs/product/](docs/product/) | Workflow design, CHPS weekly field workflow, referral coordination, progress counting rules, usability reports |
| [docs/engines/](docs/engines/) | Forecasting model card, scheduling optimiser, supply-aware scheduling, model evaluation, limitations |
| [docs/architecture/](docs/architecture/) | CHT architecture, Outreach Intelligence architecture, MCH integration, security |
| [docs/field/](docs/field/) | Kalpohini CHPS field findings, Ghana Health Service register mapping |
| [docs/verification/](docs/verification/) | Earlier verification reports |
| [core-patches/README.md](core-patches/README.md) | The CHT Core patch and why it exists |

Start at [docs/README.md](docs/README.md).

## Known limitations

- **Proof of concept on generated data.** The forecasts have not been validated on real facility data, and the demonstration's past weeks are simulated.
- **Clinical thresholds and schedules are off** until clinicians review them, so vital signs are recorded but do not raise alerts.
- **Volunteers cannot register individuals.** The CHO registers mothers and children.
- **Supplies are planned, not dispensed.** There is no record of drugs issued.
- **Completion is documentation.** A visit marked done is the CHO's record, not independent verification.
- **Referral visibility** is limited to staff of the facility that serves the person.
- **Not integrated** with SMS, WhatsApp, voice or DHIMS2.
- **One CHT Core change:** a side-menu patch ([`core-patches/0002`](core-patches/)), approved by the project owner. Everything else is standard CHT configuration.

## Credits and license

Built for the UNICEF **AI for Nurturing Care Hackathon** on the open-source [Community Health Toolkit](https://communityhealthtoolkit.org) by Medic, with [Google OR-Tools](https://developers.google.com/optimization) for scheduling.

License: **AGPL-3.0-only** (as declared in `package.json`), matching the Community Health Toolkit.
