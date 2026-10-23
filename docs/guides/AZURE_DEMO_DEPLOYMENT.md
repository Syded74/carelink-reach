# Azure demonstration server

**Address:** https://carelink-reach-gh.southafricanorth.cloudapp.azure.com

**Purpose:** a public, always-on copy of CareLink Reach for the hackathon demonstration, so judges can try it without the development laptop. All data in it is generated.

## What runs where

| Item | Value |
|---|---|
| Azure subscription | Azure for Students |
| Resource group | `carelink-demo-rg` (South Africa North) |
| VM | `carelink-reach-vm`, Standard_B2as_v2 (2 vCPU, 8 GB; B2ms had no capacity in the region), Ubuntu 24.04, 64 GB disk |
| CHT | Official CHT **5.3.0** Docker images, in `~/cht/compose` on the VM (`cht-core.yml`, `cht-couchdb.yml`, `carelink-override.yml`, private `.env`) |
| HTTPS | Let's Encrypt certificate (CHT `CERTIFICATE_MODE=AUTO_GENERATE` plus a one-off Certbot run; no email registered). It expires on 21 January 2027 |
| Planning worker | systemd service `carelink-oi-worker` (`--watch 5`), from `~/carelink-reach-config` on the VM |
| Firewall | 443 and 80 open to the internet; SSH (22) only from the deploying machine's IP; CouchDB and the API listen on 127.0.0.1 only |

## Credentials (never in the project)

| Credential | Where it is |
|---|---|
| CHT/CouchDB admin `carelink_admin` | Random password in `~/.carelink-reach/azure/admin.json` (mode 0600) on the deploying Mac |
| Planning service account | `~/.carelink-reach/azure/oi-service.json`, and `~/.carelink-reach/oi-service.json` on the VM |
| CareLink user accounts | `aiddrisu`, `sabukari`, `rseidu`, `mtahiru`, `kboateng`, with the shared demonstration account password (`CARELINK_ACCOUNT_PASSWORD`) |
| SSH | Key `~/.ssh/carelink_azure_ed25519`; user `carelink` |

The default local admin (`medic`/`password`) does **not** exist on Azure.

## Not included

- **Side-menu patch:** the official images do not include `core-patches/0002`. Instead, the four entries are hidden with CSS: `core-patches/0002-azure-menu-hide.css` is appended to a copy of the image's `styles.css` (`~/cht/overrides/styles.css` on the VM), which `carelink-override.yml` mounts read-only over `/service/api/build/static/webapp/styles.css`. Redo this after any CHT upgrade, because the copy is from 5.3.0.
- **Data protection:** for real patient data, a data-protection review is needed first (hosting outside Ghana).

## Redeploying configuration

The scripts refuse non-localhost servers, so reach the server through SSH tunnels:

```sh
ssh -i ~/.ssh/carelink_azure_ed25519 -N -L 15984:127.0.0.1:5984 -L 15988:127.0.0.1:5988 carelink@carelink-reach-gh.southafricanorth.cloudapp.azure.com
# in another shell (values from ~/.carelink-reach/azure/admin.json):
export CHT_URL='http://carelink_admin:…@localhost:15988' CHT_COUCH_URL='http://carelink_admin:…@localhost:15984' CARELINK_STATE_DIR=~/.carelink-reach/azure
node scripts/build-report-labels.js && node scripts/cht.js --force compile-app-settings upload-app-settings upload-resources upload-custom-translations upload-app-forms upload-contact-forms upload-ui-extensions upload-branding
```

After code changes to `lib/` or `outreach-intelligence/`:
1. `rsync` the project to `~/carelink-reach-config` on the VM;
2. run `sudo systemctl restart carelink-oi-worker`.

## Checking it

`CARELINK_ACCOUNT_PASSWORD=… node scripts/azure-check.js` signs in as the volunteer, CHO, coordinator and supervisor at phone width, and opens each home screen. Screenshots go to `evidence/azure/`.

Result on 23 October 2026: all four passed; first sign-in took 20–27 s, including the offline download.

| Check | Result |
|---|---|
| Engine tests on the VM | 89/89 |
| Worker | Wrote the demand estimate for all four facilities |

## Cost and shutting down

The VM uses roughly US$2 a day of student credit while running.

| Action | Command |
|---|---|
| Stop billing for compute (data kept) | `az vm deallocate -g carelink-demo-rg -n carelink-reach-vm` |
| Start again | `az vm start -g carelink-demo-rg -n carelink-reach-vm` (the address stays the same) |
| Delete everything | `az group delete -n carelink-demo-rg` (irreversible) |
