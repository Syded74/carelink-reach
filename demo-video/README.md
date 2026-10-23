# CareLink Reach workflow video

| File | What it is |
|---|---|
| [`final/CareLink_Reach_App_Workflow.mp4`](final/CareLink_Reach_App_Workflow.mp4) | The full field workflow recorded in the real app, about 5 minutes |
| [`final/CareLink_Reach_App_Workflow_fast.mp4`](final/CareLink_Reach_App_Workflow_fast.mp4) | The same recording at 1.5× speed, about 3 min 20 s |

The video shows only the app, on a phone-sized screen (412 × 915 at 2× pixel density, recorded at 824 × 1830). It has no captions, narration or screenshots. The only addition is a grey circle where the screen is tapped, like Android's "Show taps". It is the CHT web app in Chrome set to a phone screen, which is the same app the CareLink Android build loads.

## What it shows

1. **Volunteer** registers *Mahamudu Household, House 21* in Tolon.
2. **CHO** registers the mother, *Fatima Mahamudu* (ANC), in that household. Volunteers cannot register individuals in this build.
3. **Coordinator** checks the households in Tolon and the documented need. They confirm the blood pressure monitor is available and request an outreach plan for Tuesday 3 November 2026 (CHO, 08:00–14:00, motorbike 1). Then they review the generated plan and submit it.
4. **Supervisor** reviews and approves the plan.
5. **CHO** sees the planned outreach day and records the ANC visit: the complaint, BP 128/84, weight, and the "Bleeding reported" danger sign. Then she starts a referral to Tolon District Hospital.
6. **Receiving facility** (Tolon District Hospital coordinator) acknowledges the referral, confirms arrival and records the outcome.
7. **CHO** closes the referral.
8. **Coordinator** is back at outreach planning.

Every step is a real tap or keystroke and is saved. Each save was confirmed on the server before the next role continued. Login screens are not filmed, and time spent waiting for sync and the planning worker is cut out. The household, mother and notes are generated demonstration data, recorded on a local CHT copy.

## Re-recording

Re-recording needs a local CHT with the CareLink configuration, the demo accounts, the planning worker running, and FFmpeg.

```sh
cd demo-video
npm install
export CARELINK_ACCOUNT_PASSWORD='…'                         # the demo accounts' password
export CHT_COUCH_URL='http://ADMIN:PASSWORD@localhost:5984'  # read-only checks that each save reached the server
npm run record-flow   # → clips/workflow/<step>.webm, timings.json, state.json
npm run build-flow    # → final/CareLink_Reach_App_Workflow.mp4
```

- `record-flow.js` refuses any server other than `localhost`, because it saves records.
- Each step is recorded in its own browser. A rerun skips steps already listed in `clips/workflow/state.json`, so a failure never saves the same record twice.
- To record again from scratch, use new names in `record-flow.js` (`HOUSEHOLD`, `MOTHER`, `OUTREACH_DAY`) and delete `clips/workflow/`.
- `clips/` is not committed.
