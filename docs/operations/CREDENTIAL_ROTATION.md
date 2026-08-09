# Credential rotation

Rotate references without placing either old or new values in the repository.

## Procedure

1. Create a new provider credential with the least required scopes.
2. Store it in the selected broker backend under a new logical reference, for
   example `cred://stripe/primary-2026-08`.
3. Run `vh auth test <provider>` and inspect account, mode, scopes and expiry.
4. Update the non-secret provider/environment mapping to the new reference.
5. Run provider doctor/read-back and the dependent sandbox or critical journey.
6. Revoke the old provider token/session and local broker reference.
7. Verify the old reference is unavailable and record date, operator and evidence.

Never overwrite the old secret in place before the replacement passes. Never
copy a credential from one child venture to another.

## Incident rotation

For suspected exposure, stop affected apply runs, revoke provider-side access
first, rotate downstream generated secrets (database roles, webhooks, signing
keys) as applicable, inspect audit logs and then repair references. Do not commit
the leaked value to a denylist; use a fingerprint only if one is needed.
