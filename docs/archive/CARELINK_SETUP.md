# CareLink Reach — Setup

## Prerequisites

- A local CHT 5.3 instance at `http://localhost:5988` (see the CHT Core `DEVELOPMENT.md`).
- Node from the CHT Core checkout. `node_modules` is a symlink to `../cht-core-master/node_modules`.
- An admin account on that instance.

Credentials are passed **only as environment variables** for the current shell. Never write them into this folder.

```sh
export CHT_URL='http://ADMIN:PASSWORD@localhost:5988'        # used by cht-conf
export CHT_COUCH_URL='http://ADMIN:PASSWORD@localhost:5984'  # used by backup/seed/verify scripts
# optional: export CARELINK_STATE_DIR=~/.carelink-reach
```

## 1. Back up first

```sh
npm run backup        # → ~/.carelink-reach/backups/<timestamp>/{medic,_users}.json
```

Check that the backup folder exists and is not empty before going further.

## 2. Test and deploy configuration

```sh
npm test              # 15 workflow / permission / authority / form / translation tests
npm run compile       # compile app_settings.json (gitignored build output)
npm run deploy        # settings, resources, branding, translations, app + contact forms
npm run deploy-authority              # server-side role check (_design/carelink-authority)
node scripts/retire-legacy-forms.js   # optional: hide default CHT forms (no deletion)
```

### Brand colours (optional core patch)

Follow `core-patches/README.md`: apply the patch, rebuild the webapp, then run `npm run deploy` again. The deploy re-uploads branding, which makes CHT regenerate its service worker. Browsers then pick up the new stylesheet without restarting the API. If a browser still shows old colours, reload it once.

## 3. Seed fictional data

```sh
npm run seed
```

This creates the demo hierarchy, users and reports. Every record is prefixed `DEMO ·` / `carelink-demo-`. Demo user passwords are random and written to `~/.carelink-reach` (mode 0600). They are never printed into the project. The seed writes a manifest of every document and user it created.

## 4. Verify

```sh
npm run verify          # → evidence/server-verification.json
npm run check-access    # → evidence/access-tests.json (includes server-side authority checks)
npm run offline-demo    # → evidence/offline-test.json + screenshots   (demo steps 1–3)
npm run demo-flow       # → evidence/demo-flow.json + screenshots      (demo steps 4–7)
```

Run them in that order. `offline-demo` creates the Household 04 request, and `demo-flow` carries it through review, assignment, scheduling, the visit and the supervisor's indicators. Both refuse to run on a request that has already been used. To repeat the run, do `npm run cleanup && npm run seed` first.

`verify`, `check-access`, `offline-demo` and `demo-flow` all need both `CHT_URL` and `CHT_COUCH_URL`.

## 5. Clean up / restore

```sh
npm run cleanup       # deletes ONLY documents and users listed in the seed manifest
                      #   (+ demo reports on those households, + those users' task/target docs)

CARELINK_BACKUP=~/.carelink-reach/backups/<timestamp> node scripts/restore-config.js
                      # restores settings, branding, resources, forms, translations only;
                      # never restores user password hashes or overwrites data records
```

`restore-config.js` puts the original forms back, so the default forms reappear. CareLink form documents are **not** deleted. Remove them by hand if you need a fully original state.

## Outreach Intelligence continuation

Use the integrated CHT tab and worker described in [Outreach Intelligence architecture](../architecture/OUTREACH_INTELLIGENCE_ARCHITECTURE.md) and [demo guide](../guides/OUTREACH_INTELLIGENCE_DEMO.md). The separate developer website is retained only for regression work. Model evaluation and deployment limits are documented alongside them.
