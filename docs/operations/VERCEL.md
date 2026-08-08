# Vercel

The Vercel adapter plans official CLI operations for project creation/linking,
environment-variable metadata, preview/production deployment and domain
attachment.

## Plan

```bash
vh auth login vercel
vh auth test vercel
vh doctor
vh launch --dry-run
```

Confirm account/team, project name, repository link, environment, domain,
credential references and possible spend. Environment values pass from the
broker to the CLI; reports keep only variable names and reference metadata.
Set `external_resource_ids.project_intent` to `create` for a new explicit slug or
`use_verified` for a project already proven by read-back. The built-in preview
composition orders `vercel project add`, local link, structured JSON deployment,
and exact deployment inspection. Production always requires the project to have
verified lifecycle evidence first.

## Apply boundary

Preview work belongs under `preview_launch`. Production deployment/domain work
requires an envelope that permits production deploy and the named Vercel
provider. A linked project is not a deployment.

## Verify

Read back project/team identity, environment-variable metadata, deployment ID,
state and URL, domain attachment and certificate state. Then run the active raw
HTML, accessibility, consent and critical-journey checks against the returned
URL. Only the read-back URL belongs in the launch report.

## Rollback

Record the prior verified deployment/alias before production apply. Restore it,
then repeat smoke and critical-journey checks. Do not delete the failed deployment
or its evidence as the first response.
