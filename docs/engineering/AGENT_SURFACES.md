# Agent Surfaces

- Status: locally verified command-generation contract
- Live verification: not applicable to generation; provider effects invoked by
  commands remain pending until read back
- Canonical sources: `packages/command-bus/`, `packages/agent-runtime/`, and
  `packages/*-generator/`

## One command, six invocation paths

Define business behavior once as a `CommandContract`, register one handler on
the command bus, and derive every surface from that catalog.

| Path   | Derived shape for `campaigns.launch`                     |
| ------ | -------------------------------------------------------- |
| Direct | `runtime.execute("campaigns.launch", input, invocation)` |
| REST   | `POST /v1/commands/campaigns.launch`                     |
| CLI    | `vh campaigns launch --input <json> ...`                 |
| MCP    | `campaigns_launch`                                       |
| SDK    | `commands.campaigns.launch(...)`                         |
| UI     | action ID `campaigns.launch`                             |

REST, CLI, MCP, SDK, and UI are adapters. They must not implement a second
authorization path, mutate inputs differently, or call handlers directly.

## Command contract

A command definition includes:

- a lowercase `namespace.method` ID and positive version;
- title and plain-language description;
- runtime input/output parsers plus JSON Schemas;
- active-subscription, entitlement, command-grant, and actor-scope requirements;
- an optional meter.

`deriveCommandSurfaces` generates names deterministically. The current v0.2
grammar allows exactly one namespace and one method. Changing an ID or version
is a contract migration, not a display-copy edit.

## Execution boundary

The command bus checks, in order:

1. non-empty actor identity;
2. organization and venture tenant membership;
3. active or trialing subscription when required;
4. every declared entitlement;
5. a non-revoked, unexpired grant covering the command and required scopes;
6. actor scopes;
7. parsed input;
8. tenant/command/idempotency binding;
9. parsed output.

Only then may it emit the success event and meter. Requested, succeeded,
denied, and failed audit outcomes stay tenant-scoped. Authorization denial must
leave event and metering sinks untouched.

## Idempotency rule

An invocation needs a non-empty idempotency key. The stored request hash covers
the canonical command ID, command version, and parsed input. The ledger key also
includes organization, venture, and command. An identical replay returns the
prior parsed output; the same key with different input fails with
`idempotency_conflict` before the handler.

Do not weaken this to “key exists.” That would let a caller replay one result for
materially different input.

## Add a command

1. Define typed JSON input and output in the owning runtime or pack.
2. Implement strict runtime parsers and matching JSON Schemas.
3. Call `defineCommandContract`; declare every authorization requirement and
   meter.
4. Register one handler on the command bus.
5. Include the command in its pack and Service Blueprint where applicable.
6. Generate or compose every surface through `createAgentGateway`; do not
   hand-author parallel routes.
7. Add parity tests that invoke direct, REST, CLI, MCP, SDK, and UI with
   independent idempotency keys and compare outputs.
8. Add negative tests for identity, tenant, subscription, entitlement, grant,
   grant expiry, scope, invalid input/output, replay, and request-binding
   conflict.

## Source-checkout CLI compatibility

The generated CLI bundle owns generated command contracts. In this repository
checkout, unknown generated commands can delegate to the older operational CLI
for `auth`, `doctor`, `create`, `plan`, `launch`, `status`, `resume`, `cancel`,
`explain`, `data`, `learn`, and `upgrade`. That compatibility bridge is not a
license to add a second implementation of a generated command.

Materialized ventures record venture-specific CLI, MCP-prefix, SDK-package, and
REST-prefix names in `venture.manifest.json`. The current workspace gateway
still derives command suffixes from the canonical catalog.

## Verification

```bash
pnpm workspace:build
pnpm workspace:check
pnpm test:workspace
```

Evidence is **locally verified** by `tests/command-surfaces-parity.test.ts`,
`tests/workspace-boundaries.test.ts`, and the packed-consumer test. These tests
do not verify any live provider effect reached through a command.
