# Referral coordination workflow

**Field context:** at Kalpohini CHPS, CHOs photograph referral documents and share them in a WhatsApp group. CareLink Reach does **not** add a chat or broadcast channel. It strengthens structured, role-scoped CHT referral records.

## What already existed (verified earlier)

- **The referral record:** the `carelink_mch_referral` form and `lib/mch.js`. A referral is an append-only chain: created → acknowledged → arrival confirmed → outcome recorded → closed. A referral can also be cancelled or marked unresolved. Transitions are validated on the device, and a branch becomes a conflict.
- **Server-side role per state** (`REFERRAL_ROLES`, `authority/validate_doc_update.js`):

  | State | Who may record it |
  |---|---|
  | created | CHO |
  | acknowledged | coordinator (the receiving facility role) |
  | arrival confirmed, outcome recorded | CHO or coordinator |
  | closed, cancelled, unresolved | CHO or supervisor |

- **The CHO's task:** "Referral awaiting outcome or follow-up". A referral task is never resolved by hand.
- **Offline:** the record is saved on the device and synchronised later.

## Implemented now

| Item | Detail |
|---|---|
| Receiving facility | A new referral must name a receiving facility from the facility directory. The record stores `receiving_facility_id` and its name |
| Facility directory | Each facility in `planning/tolon-district.json` has `directory`: type (read from the published name only), services supported (empty), referral relationships (empty), contacts (none), `verification_status: unverified`. No capability is assumed from the facility type |
| Routing notice on the form | "Saving this referral does not alert the receiving facility. It reaches them only after synchronization, and only staff of the facility that serves this person can see it in CHT. Urgent cases follow the established referral and transport procedures now, including direct communication." |
| Author on every event | Every referral event records `actor`, and the server rejects an event whose actor is not the signed-in user. Acknowledgements therefore show who acknowledged |
| Acknowledgement task | "Referral awaiting acknowledgement" for the coordinator whose facility is the receiving facility, while the referral is in `created`. It resolves when the chain moves on |
| Originating CHO visibility | The referral card shows the receiving facility, "Acknowledged by …" or "Awaiting the receiving facility", and a sync note |
| Indicators (CHT targets) | Referrals created, awaiting acknowledgement, acknowledged, and with an outcome documented. One per chain: a duplicate synced copy is ignored, and two acknowledgements of one step are a conflict, never two counts |
| Duplicate replay | The chain replay keeps one document per `_id`. Re-sending a stored event is refused, because records are append-only |

## Lifecycle and what each state means

| State | Meaning | Not |
|---|---|---|
| Saved on the phone | Recorded locally | Received by anyone |
| Synchronized (on the server) | The facility can see it | Read or acted on |
| Acknowledged | The receiving facility's coordinator recorded receipt (named) | Proof the person attended |
| Arrival confirmed | Recorded attendance | An outcome |
| Outcome recorded, then closed | Documented outcome, then closed by an authorised role | Automatic |

## Permissions

- Only CHOs create referrals; only coordinators acknowledge. These are enforced in CouchDB's `validate_doc_update`, not in the user interface.
- CHT replication limits who receives a referral. Volunteers do not receive clinical reports. Staff outside the person's facility area do not see them.
- Unauthorised acknowledgement is rejected: a volunteer, a CHO, or someone writing an event in another person's name. Unit tests cover this in `test/mch.test.js`.

## Messaging review

- The CHT **Messages** tab handles SMS through a gateway. `gateway_number` is empty and no role has message permissions, so **no SMS is configured or claimed**.
- WhatsApp, voice and real-time notifications are **not integrated**. They would need an external gateway and an authorised data-sharing agreement.
- Referral photographs are not stored or forwarded by CareLink.

## Known limitations

- **Cross-facility referrals.** A receiving facility *outside* the person's facility area cannot see the referral in CHT, because CHT replicates by place. Structured cross-facility routing would need a minimal, authorised referral notice on the receiving facility. That is designed but not implemented; established direct communication remains necessary.
- **Unverified directory.** Facility services, referral relationships and contacts are empty and unverified until confirmed by the district.
- **No triage.** CareLink does no automated triage. Urgent referrals stay outside routine planning: routine scheduling never includes `recordedConcern` or `referralFollowUp` items.

## Verification

- **Unit:** `test/mch.test.js` (roles per state, author stamping, unauthorised acknowledgement) and `test/coverage-targets.test.js` (counts once, duplicate replay, conflict).
- **Browser:** `npm run mch-flow` steps 6, 13 and 13b. The CHO creates a referral naming Tolon District Hospital; the coordinator acknowledges from "Referral awaiting acknowledgement"; the CHO sees "Acknowledged by rseidu".
- **Offline:** referral creation offline on the physical phone was **not re-run in this session** (no device connected). The same offline mechanism was verified on the phone for requests and resolutions on 22 October 2026.
