# Troubleshooting

Start with:

```bash
vh doctor
vh status <run-id>
vh explain <run-id> <node-id>
```

| Symptom                                              | Meaning                                                  | Next action                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `auth_required`                                      | reference missing, expired, revoked or lacks scope       | `vh auth login <provider>` then `vh auth test <provider>`                                         |
| transport unavailable                                | official CLI/API integration is not installed/injected   | install the named CLI or configure the supported API transport; rerun doctor                      |
| `waiting_manual_action`                              | automation is unavailable or unsafe                      | follow the node fields, attach required evidence, use the run completion surface, resume same run |
| `failed_retryable`                                   | classified transient provider failure                    | wait per retry policy; resume, do not start a second launch                                       |
| `failed_terminal`                                    | invalid input, unsafe state or exhausted retry           | fix the exact cause; plan again if graph inputs change                                            |
| graph fingerprint mismatch                           | resume loaded a different definition                     | restore the original graph/bindings or start an explicitly new run                                |
| provider request succeeded but state is not verified | read-back missing/mismatched                             | run the named verification; keep state `configured`/`degraded`                                    |
| scheduled cadence reports `disabled`                 | `enabled: false` in `config/loops.yaml`                  | leave neutral, or configure direct inputs/metrics first and deliberately enable the cadence       |
| scheduled sync reports `not_configured`              | no declared loop input has a usable default connector    | declare inputs and configure credential refs; do not enable a fixture fallback                    |
| scheduled sync reports `incomplete`                  | a connector failed or required evidence is stale/missing | inspect failures/freshness, repair the direct source, then rerun `vh data sync`                   |
| learning reports insufficient evidence               | required source missing/stale                            | `vh data sync`; fix credential/outage; do not use zero                                            |
| upgrade conflict                                     | child edited a harness-owned file or baseline is absent  | reconcile or mark ownership deliberately; rerun with `--release <local-release-root> --dry-run`   |
| CLI says service is not configured                   | command shell exists but default integration is absent   | wire the named launch/auth/data/upgrade service; no external action occurred                      |

## Safe reset

Do not delete `.venture/runs/` to hide a failed launch. Keep the audit trail,
cancel the run if appropriate, and start a new run only when inputs or graph
semantics genuinely changed. Never edit provider state to `verified` by hand.

## Reporting a live gap

Record provider/account (non-secret), command, error class, whether retry is
safe, resource IDs already created, exact read-back still needed and rollback or
forward-repair option. Redact values before attaching logs.
