# GitHub

The GitHub adapter plans direct, official `gh` CLI operations for a child
repository, exact local-source publication, Actions secret metadata, selected
settings and a draft pull request.

## Create or locate

Authenticate the intended account/organization, confirm repository name and
visibility, then dry-run. Source publication runs only after `verify-local`,
which includes the applicable secret and PII checks. The helper builds an
isolated Git index from tracked and non-ignored source without changing the
working index, creates an empty repository when needed, uploads blobs through
`gh api`, and advances the provider-created bootstrap branch only when GitHub
hashes the same exact tree.

The operation is reconciled again on resume instead of trusting an old local
idempotency-ledger result. An existing branch is accepted only when its commit
already points to the exact local tree or when it contains the helper's sole
bootstrap marker. A template-derived, unrelated, archived, differently visible,
or otherwise non-empty repository fails closed; the helper never force-pushes or
changes visibility implicitly.

### v0.2 repository-intent migration

`repository_intent: create_from_template` is a deprecated v0.1 compatibility
input in the default config loader. It no longer means that template contents
prove launch completion: the `repository` provider capability always plans
`repository.create_from_source`, and `template_repository` is ignored by that
provider plan. New child config should use `create_from_source` once the config
migration has rewritten the intent. If an earlier partial run already created a
stale template repository, choose a new empty target or review and migrate that
repository explicitly; the launch will not overwrite it.

## Secrets and settings

Secret values travel from the credential broker directly to `gh`; GitHub does
not return them. Verification is limited to secret-name/update metadata. Read
back repository identity, visibility, default branch, remote URL and requested
settings. Never infer a valid downstream credential from secret metadata alone.

## Draft pull request

Record branch, base, title and resulting draft PR URL/state. Creating a draft PR
does not authorize merge. Repository deletion, visibility expansion and branch
protection changes outside the envelope need separate review.

## Verify

The launch report includes owner/name, visibility, default branch, exact remote
commit and tree read-back, settings read-back and draft PR URL where applicable.
It never contains Actions secret values or claims CI/deployment success only
because a repository exists. No GitHub path in this template has been live
verified.
