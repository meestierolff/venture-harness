# ADR-006: Spend reservations commit inside a database transaction

- Status: accepted
- Date: 2026-08-08
- Supersedes: the in-memory reservation model introduced in commit `9e951eb`

## Context

The first spend ledger held reservations in a `Map` and argued it was
concurrency-safe because `reserve()` performed its cap check and its write in
one synchronous block, with no `await` in between.

That argument is true and insufficient. It only covers interleaving inside a
single event loop. Reservations are taken by things that share no memory at all:

- two worker processes;
- two containers or serverless instances;
- two queue consumers draining the same paid-test queue;
- a reconciliation job running beside the workers;
- a retry after a process crashed mid-flight.

Each of those reads its own copy of the headroom and each concludes there is
room. The cap is then exceeded by exactly the amount of concurrency, and the
ledger reports that everything was fine — the failure mode is silent overspend
of real money.

## Decision

The cap check and the reservation write commit or fail together inside one
serialized database transaction. Correctness comes from the store, not from
JavaScript's execution model.

`SpendStore` is an interface with two implementations:

- **`createSqliteSpendStore(path)`** — production-capable local store. Uses
  `BEGIN IMMEDIATE`, which acquires the write lock before reading, so concurrent
  writers serialize instead of both observing stale headroom. WAL journaling and
  a 5s busy timeout let independent clients queue rather than fail. Marked
  `productionSafe: true`.
- **`createMemorySpendStore()`** — unit tests and single-process fixtures only.
  Marked `productionSafe: false`, and a test demonstrates precisely why: two
  memory stores each hand out 6,000 minor units against the same 10,000 cap.

`node:sqlite` is loaded lazily so the Node >= 22.5 requirement applies only to
callers that ask for the SQLite store; the package still declares Node >= 20.9.

Additions that follow from having a real store:

- **Idempotency keys** are unique-constrained. A repeated key returns the
  original reservation rather than minting a second one, which is what makes
  retry-after-crash safe.
- **Cap hierarchy** evaluated widest to narrowest: grant total, monthly venture,
  daily venture, daily account, per-campaign, per-paid-test, per-creative. The
  error names which cap rejected the request.
- **Incidents.** A provider overspend is recorded at its real value, raises a
  `provider_overspend` incident, and freezes the grant. The ledger must reflect
  money that actually moved; understating it to keep a cap looking intact is the
  more dangerous lie.

## Consequences

Reservations now require a durable store, so the ledger is no longer a pure
value. Tests that only needed the ledger's arithmetic use the memory store; tests
that assert concurrency or persistence use SQLite against a temp file, including
one that closes the client and reopens it to prove committed reservations
survive a restart.

A hosted Postgres/Neon store implementing the same interface is the remaining
step for multi-region deployment; the interface is deliberately narrow enough
that it is a direct translation, with `SELECT ... FOR UPDATE` or a serializable
transaction replacing `BEGIN IMMEDIATE`.
