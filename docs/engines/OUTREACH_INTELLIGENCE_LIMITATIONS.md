# Outreach Intelligence: limitations and readiness

This is a fictional-data development prototype. It is not clinically validated, institutionally authorized or ready for real-patient deployment.

## Implemented boundaries

- One CHT application/session, a role-limited UI extension, the existing Python engines, and CHT records as the operational source of truth.
- Server role/actor validation and service-only acknowledgement/assignment records. The proposal author cannot review or approve their own plan.
- Append-only plan actions and server acknowledgements, explicit stale/conflict results, stable IDs and retry repair after interrupted assignment writes.
- Device state is not server acceptance. A proposal is delivery evidence; an accepted acknowledgement is approval evidence. No task proves a visit or treatment occurred.
- Routine aggregate workload only. Danger-sign reviews and clinical urgency stay outside optimization.

## Remaining technical limits

- One active worker per facility. The local OS lock is not a distributed lock; multi-host leadership/fencing and cross-host atomic booking are not implemented.
- The online service account currently has broad read access through CHT before facility scoping and privacy aggregation. Least-privilege server-side read minimization is a pilot prerequisite.
- The custom CouchDB validator is a maintained extension, not an official CHT configuration feature. Administrators and database operators retain privileged capabilities. Append-only application records are not cryptographically tamper-proof audit storage.
- The worker polls the CHT document API every five seconds. Change-feed ingestion, bounded queries, monitoring, backpressure, alerting, secret rotation, disaster recovery and scale tests remain outstanding.
- Local HTTP is acceptable only for this development instance. Production requires HTTPS, reviewed CHT hosting/session controls, server-side secret management and network isolation. The localhost-only scripts need reviewed remote-deployment configuration.
- Browser network emulation does not establish Android resilience, cache retention, offline revocation, secure device storage or usability in target communities.
- Forecast scores use synthetic weekly history. The live CHT records are fictional, with very short historical coverage. No clinical due date, urgency, diagnosis or personalized advice is inferred.
- Volunteer reporting coverage is **unknown** without an expected-reporter roster and reporting denominator. Weekly data availability is shown separately and must not be described as volunteer participation.
- Missing reporting and genuine zero demand remain distinct. Imputation is for candidate model inputs only, based on earlier observations; missing targets are not scored.
- CP-SAT is exact only for the modeled/enumerated trip choices when it returns OPTIMAL. OR-Tools routing for larger stop sets is heuristic. Road times, staff availability, service duration, vehicle suitability, break requirements and fairness weights need operational validation.
- An approved outreach-day task is a community-level operational instruction. Existing household assignments are not replaced. Clinical ANC/PNC/CWC protocols and danger-sign procedures retain their existing professional-review restrictions.
- Legacy developer website/audit files are retained, not migrated into accepted CHT decisions. It must not be used as a second operational approval system.

## Required before a pilot

Programme and clinical review of workload definitions and referral separation; facility confirmation of staffing, vehicles, routes and fairness policy; privacy/security and institutional approvals; representative historical data and prospective evaluation; least-privilege service access; device and cross-facility adversarial tests; leadership/failover design; backup/restore drills; accessibility and reviewed local-language testing. No improvement in health outcomes or real-world service efficiency is claimed.
