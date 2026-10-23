# CareLink Reach end-to-end demonstration

All people, households and plans are generated. Records created by scripts are marked `record_origin: 'test'` and never count in operational demand or indicators. Geography: Northern Region → Tolon District → Tolon District Hospital → Tolon, Gburimani, Dimabi.

## Roles

| Username | Role |
|---|---|
| `aiddrisu` | Community volunteer (Tolon) |
| `sabukari` | CHO (Tolon, Gburimani, Dimabi) |
| `rseidu` | Facility coordinator (Tolon District Hospital) |
| `mtahiru` | Supervisor (Tolon District Hospital) |
| `kboateng` | CareLink admin |

Passwords are set with `CARELINK_ACCOUNT_PASSWORD` (`npm run setup-accounts`); they are not stored in the project.

## Start the stack

```
COLIMA_HOME=~/.flutter-config/colima colima start
docker start cht-local-nouveau cht-local-couchdb
# in cht-core-master:
COUCH_NODE_NAME=nonode@nohost COUCH_URL=http://medic:password@localhost:5984/medic node api/server.js
COUCH_NODE_NAME=nonode@nohost COUCH_URL=http://medic:password@localhost:5984/medic node sentinel/server.js
# in carelink-reach-config:
npm run oi-worker -- --watch 5
```

## Automated demonstrations (real CHT; each writes `evidence/<name>.json`)

```
export CHT_COUCH_URL=http://medic:password@localhost:5984 CARELINK_ACCOUNT_PASSWORD=...
npm run walkthrough-flow    # volunteer need → MCH follow-up → demand → plan → approval → CHO → outcome → next inputs
npm run supply-flow         # unknown supply → confirm 1 → confirm 10: plans change and explain why
npm run mch-outreach-flow   # maternal and child follow-ups through an approved day, offline resolution
npm run mch-flow            # ANC → delivery → PNC → CWC, referral with receiving facility and acknowledgement
npm run android-device-flow # physical phone: volunteer and CHO offline, restart, sync (phone on USB)
```

## Live presentation sequence

1. **Volunteer (`aiddrisu`).** People → Tolon → *Add household* → open it → *Request help* (antenatal care, transport barrier, over 1 hour). Optionally, disconnect first: the request stays on the phone and syncs later.
2. **CHO (`sabukari`).** Open a mother → record an ANC visit with a follow-up date. Her profile shows the open follow-up.
3. **Coordinator (`rseidu`).** Tasks → *Review outreach request* → accept. Then open the **Outreach Intelligence** tab and show:
   - community demand (forecast, weeks reported, warnings);
   - community coverage (last documented outreach, open requests, maternal and child follow-ups, unserved planned work, reporting %);
   - documented work by source.
4. **Resources.** In the same tab → *Update resource readiness* → set *Child welfare outreach supplies* to **unknown** → *Generate outreach plan*. The plan schedules no child welfare visits and lists what needs confirmation.
5. **Shortage experiment.** Record CWC supplies **confirmed 1** and generate again: one CWC visit, "limited by Child welfare outreach supplies". Then confirm 10 and generate again: more CWC visits. Point out that ANC visits were planned throughout.
6. **Approval.** The coordinator submits (task). The supervisor (`mtahiru`) reviews, then approves (tasks). The coordinator cannot approve her own plan.
7. **CHO.** Tasks show *Planned outreach day*, *Confirmed outreach visit* and the mother's follow-up. Record the household visit (completed), then *Resolve with a reason* on the ANC follow-up. Leave the missing-assessment task open.
8. **Referral.** On a mother → *Referral* → new, with a reason, receiving facility Tolon District Hospital. The coordinator gets *Referral awaiting acknowledgement* → acknowledges. The CHO's referral card shows "Acknowledged by rseidu".
9. **Feedback.** The coordinator's tab shows the day's progress ("planned … completed … still open"). The next plan's "documented work from" shows the reduced counts.
10. **Reporting.** Analytics → targets: open requests, follow-ups, people awaiting, planned and completed encounters, referrals awaiting acknowledgement, resources needing a readiness check.

## Failure recovery

| Problem | Fix |
|---|---|
| "Loading error" on sign-in after a VM restart | Check `docker logs cht-local-nouveau` for `IndexFormatTooOldException`. Move only the named corrupt shard index directory aside, restart Nouveau, and it rebuilds from CouchDB |
| No free weekday for the CHO | Old test plans keep days booked. The scripts release leftover *test* days by recording them "not done" (`releaseTestDays`); real plans are untouched |
| Phone cannot reach the server | `adb reverse tcp:5988 tcp:5988` |
| Phone locked during a test | `adb shell svc power stayon true`, then unlock it by hand |

## Offline demonstration notes

"Offline" on the phone means the app cannot reach the CHT server: the USB port forward is removed. It is not airplane mode, and the first login needs the network. In Chrome tests, offline is DevTools network emulation.
