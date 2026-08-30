# Controlled standard-SaaS token benchmark protocol

This protocol compares one Venture Harness build path with one blank-repository
build path. It measures a bounded app build; it does not establish a universal
token-saving claim.

**Status: validation-only draft.** No benchmark execution is enabled and no
token result exists. The requirements below are the gate for the first real run,
not evidence that the current draft executor satisfies them.

## Fixed comparison contract

Each application must bind both paths to the canonical SHA-256 of one valid
Launch Contract. The final preregistered spec derives the same primary journey
and success signal from that contract and binds byte-identical design-quality
criteria plus an immutable held-out acceptance evaluator to both outputs. It
pins the OpenAI model family, exact version, exact CLI model ID, Codex CLI
version, clean Core SHA, seed/lock digest, dogfood receipt digest, and acceptance
digest. Each path gets at most two model calls: one build and one normal
review/test/focused-repair task. No silent retry is permitted.

Path A must be the source-bound public `vh launch` graph evidenced by a
self-verified dogfood bundle; direct seed materialization is not the Venture
Harness treatment. Path B must prove that its temporary directory began empty,
receive only the canonical contract, shared criteria, and evaluator contract,
and ignore repository rules. This method difference is the treatment being
measured; the product brief, quality bar, model, and call cap remain fixed.

## Required path isolation

The first controlled run is intended for macOS only. Before either model path
begins, `/usr/bin/sandbox-exec` must prove that each path can read its copied
criteria and cannot read the peer path, Venture Harness checkout, configured
dogfood source/design/implementation roots, or unrelated home and credential
locations. The attested policy must wrap both model calls on both paths. Codex
also retains its `workspace-write` sandbox.
Known non-Codex credential and configuration locations—including SSH, cloud,
Git credential, npm, GitHub CLI, container, Kubernetes, GPG, password-store, and
macOS keychain paths—are denied too, and only their scope digests enter the
attestation. Provider credential environment variables and agent sockets are not
passed to Codex.

The authenticated Codex CLI must still access its own session boundary. Its
authentication root therefore is not copied into the repository or blanket
denied to the parent CLI process; `--ignore-user-config` prevents unrelated user
configuration from becoming benchmark context. This is an explicit CLI trust
boundary, not evidence that credentials were exposed to the model. A future
process-differentiated credential broker can narrow it without changing the
portable report schema.

Execution refuses on another platform. The report stores a portable attestation
shape—driver, platform, policy digest, allowed-probe digest, and denied scope and
probe digests—so another audited driver can be added without changing the
comparability rules.

The runner also rejects Path B when Codex tool arguments, final structured
output, file paths, or generated text reference denied Core, seed, skill, or
dogfood material. Exact protected source-file hashes are rejected too. Only the
canonical contract and shared criteria bytes are an allowed overlap. These
content checks are defense in depth; the OS read denial is the primary boundary.

## Accounting and evidence

Codex `exec --json` events are parsed in memory. Per call and per path the report
records input, cached-input, output, and total tokens; model and tool calls;
retries; hashed failed model commands; elapsed time; self-reported files read;
independently measured files changed; criterion assessments; defects; and file
hash provenance. Cached input is already included in input tokens, so total is
`input + output`, never `input + cached input + output`.

The held-out evaluator must live outside model-writable source and execute one
fixed typed operation in a no-auth, no-network sandbox. Its output is not
stored; only evaluator and criteria digests, status, exit code, elapsed time, and
an output digest are recorded. Prompts, JSONL, command text, file contents, and
full transcripts are not written to the canonical report. Any credential-like
value found recursively in a model result or model command is rejected with a
sanitized error before an observation can be accepted.

Savings use `(1 - Path A total / Path B total) * 100` only when every
comparability check passes: one contract digest, byte-identical inputs, exact
model and CLI, the two-call cap, complete token/file/criterion accounting,
attested isolation on both paths, an empty Path B start, exact observed model on
every call, zero undeclared retries, every phase completed without a blocking
defect, and equivalent passing held-out acceptance. Otherwise the saving is
`null` and failed checks remain explicit. An append-only attempt ledger is
written before the first model call so failed and aborted attempts remain in the
denominator and cannot disappear through reruns.

A comparable, accepted one-application run is labeled exactly:

> First controlled dogfood benchmark. Not yet a universal result.

The spec accepts multiple application IDs. Repeat the controlled run for at
least three materially different standard SaaS applications before considering
any broader claim.

## Safe operation

Copy `benchmarks/standard-saas-token-benchmark.template.json`, replace every
placeholder, and validate without execution:

```bash
pnpm benchmark:standard-saas -- --spec /absolute/path/to/benchmark-spec.json
```

Validation makes no model call and writes no report. Founder alpha deliberately
refuses `--execute`: the draft runner materializes Path A directly and therefore
does not yet represent the public `vh launch` graph. Execution remains closed
until the final reviewed spec binds all of the following before any call:

- a self-verified dogfood evidence bundle from the real public launch path;
- the clean Venture Harness source SHA and exact dogfood Launch Contract digest;
- one byte-identical, immutable held-out acceptance evaluator and its digest;
- attested outer isolation for both paths, including peer, Core, dogfood, home,
  credential, write, and acceptance-network denial;
- a predeclared path order and retry/abort/exclusion rule; and
- append-only attempt evidence that retains failed and aborted starts.

The only accurate result before those prerequisites exist is that both token
totals and the saving percentage are unavailable. The canonical JSON and
Markdown report paths must remain absent; validation never creates them.
