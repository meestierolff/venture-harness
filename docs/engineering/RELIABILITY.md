# RELIABILITY

Reliability means evidence integrity and recoverable operation before uptime.

## Launch runtime

- Validate the graph before creating a run.
- Persist state atomically and append redacted events.
- Use stable idempotency keys, provider read-back and bounded retries.
- Classify failures as retryable, terminal, manual or authorization-blocked.
- Resume the same graph; do not infer success from a prior request.
- Compensate only declared reversible effects and report failures honestly.

## Product evidence

- A model-host status is not completion. Product nodes require before/after
  file hashes, node-specific artifact roles, and a relevant passed direct check.
- A no-change result must be typed `already_compliant`; its validator must prove
  that every required artifact existed unchanged. Empty changes or checks fail.
- Persist high-intent submissions independently of third-party analytics.
- Exact displayed prices travel with price-bearing evidence.
- Missing/stale data is visible and never smoothed to zero.
- Consent-denied users retain the core product path.
- A provider outage degrades that source without erasing independent datasets.

## Failure behavior

| Failure                             | Behavior                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| Missing credential/scope            | `auth_required` with an exact login/test action; no apply      |
| Provider rate limit/outage          | bounded retry only when classified safe; preserve run state    |
| Manual DNS/Apple prerequisite       | `waiting_manual_action`; continue independent nodes            |
| Graph or handler mismatch on resume | stop; require the original definition/bindings                 |
| Database unavailable                | fail the material write loudly; no fake evidence               |
| Required data stale/missing         | learning status `insufficient_evidence`; zero actions          |
| Managed upgrade conflict            | stop before writes and preserve child work                     |
| Lock write failure                  | restore attempted files where feasible; lock remains unchanged |

## Quality evidence

Staged profiles produce a machine report under `.venture/reports/quality/`.
Live checks that cannot run are skips with a reason and exact proof required,
not silent passes.

The local web gate uses `pnpm test:e2e` against a production build in desktop
and mobile Chromium. It covers the public/pricing journey, strict consent,
visible private-write failure, semantic landmarks, keyboard focus, horizontal
overflow, and attached review screenshots. It does not replace a child
venture's live multi-browser or assistive-technology review.

After an authorized production deployment, `verify-production` extracts one
safe HTTPS origin from the provider's verified read-back output and runs the
read-only post-deploy Playwright journey against it. The check performs no form
submission or provider mutation. A missing or ambiguous URL, HTTP/browser
failure, or runtime error blocks `launch-report`; it is never converted into a
live-success claim.

## Related

- [WORKFLOW_GRAPHS.md](WORKFLOW_GRAPHS.md)
- [ANALYTICS.md](ANALYTICS.md)
- [../operations/ROLLBACK.md](../operations/ROLLBACK.md)
