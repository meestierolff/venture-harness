# TECH_DEBT

Known debt, honestly stated. Every entry names the risk it carries and the
trigger that would force repayment. Cleared entries move to the bottom with
the date and commit.

## Open

| #   | Debt                                                                                      | Risk                                        | Repayment trigger                                                                   |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `verify:raw-html` needs a running server; it is CI-only and easy to skip locally          | crawler regressions land unnoticed until CI | first crawler-related CI failure → add a local pre-push reminder                    |
| 2   | Static PII checks in `verify-analytics-pii.ts` are pattern-based, not type-based          | novel property names could slip past greps  | first false negative → move prohibited-prop enforcement into the TrackedEvent types |
| 3   | Evidence API idempotency is time-bucket based, not token based                            | duplicate events under aggressive retries   | first observed duplicate in weekly analysis                                         |
| 4   | No automated Lighthouse/axe run in CI (thresholds documented in config/quality.yaml only) | performance/a11y drift                      | before first production launch                                                      |

## Cleared

(none yet)
