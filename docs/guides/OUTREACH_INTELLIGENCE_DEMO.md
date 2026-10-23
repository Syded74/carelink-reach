# Demonstrate Outreach Intelligence in CareLink

Use only the fictional local CHT instance at <http://localhost:5988/#/ui-extensions/carelink-outreach-intelligence>.

1. Sign in through CHT as `carelink_coordinator`. Open **Outreach Intelligence**.
2. Review Baobab Grove, Shea Valley and River Plain demand, explanations, missing-reporting warnings and fictional staff/transport.
3. Choose **Generate outreach plan**. Confirm the date, available staff, hours, vehicle and whether to use clearly labelled synthetic history. Submit and synchronize.
4. The Python worker runs CP-SAT. The tab refreshes when its proposal reaches the device. Review the route, time budget, unmet work, fairness, alternatives and binding constraints.
5. Open the matching **Submit outreach plan for review** task. Submit and synchronize; server acknowledgement changes the proposal to proposed.
6. In a separate browser profile, sign into the same CHT app as `carelink_supervisor`. Open the matching review task and synchronize the review.
7. Open the decision task. Disable the network, approve and save. The tab must show pending synchronization/server validation and the prior server state. It must not say **Approved on server**.
8. Restore the connection and synchronize. Only the accepted service acknowledgement changes that state to **Approved on server**.
9. The assigned CHO signs into CHT and receives **Planned outreach day**. The CHO does not receive the planning tab. This task is an operational plan, not an assertion that care occurred.
10. Before another offline test, synchronize the approved record to the viewing device and verify it is present. Disconnect, reload CHT and select that approved proposal. Read its route and audit trail offline.

## Run and reproduce

From this configuration project, after setting `CHT_URL` and `CHT_COUCH_URL` in your shell using local administrator credentials:

```sh
npm run build-oi-forms
npm run build-oi-extension
npm run deploy
npm run deploy-authority
# Initial creation only; this rotates the service password if it already exists:
npm run oi-setup
npm run oi-worker -- --watch 5
# Separate terminal:
npm run oi-cht-flow
```

Do not rotate the secret while a worker is running. Stop it first and restart after rotation. `~/.carelink-reach/oi-service.json` and `demo-credentials.json` are protected local files outside the project. Browser tests read those files without committing passwords. One worker per facility is required; a second local invocation is rejected by the lock.

The browser regression selects tasks by both title and proposal ID, so older interrupted demo drafts cannot receive the new plan's actions. It chooses an unoccupied future weekday instead of deleting old approved assignments. Existing requests, decisions and audit records are retained. Test-created records are fictional; use the protected backup/manifest instructions for cleanup rather than deleting historical plans indiscriminately.

## Evidence

- `evidence/oi-cht-flow.json`: each browser/server-verified checkpoint and any failure.
- `evidence/oi-cht-1-demand.png` through `oi-cht-7-offline.png`: real CHT screens.
- `evidence/oi-model-comparison.json`: measured rolling backtests.
- `evidence/oi-solver-regression.json`: solver status, coverage and time budgets.
- `evidence/unit-tests.txt`, `outreach-intelligence-tests.txt`, `existing-default-tests.txt`, `mch-flow.json`: regression results.

Chrome's network-disabled test is real browser offline execution, but is not a physical Android airplane-mode, storage-eviction, device-revocation or field-network test. Initial login and synchronization require connectivity.

The relevant existing Core configuration suite can be reproduced from `cht-core-master` with:

```sh
NODE_OPTIONS='--require=../carelink-reach-config/scripts/chrome-for-harness.cjs' npm run test-config-default
```

This is a test-only native-Chrome adapter for the bundled harness; it does not alter Core or its installed dependencies. The full Core API/Sentinel/Angular test matrix was not run for these configuration/Python changes.
