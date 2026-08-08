/goal

You are Opus 5 operating as an autonomous senior engineering and quantitative-research agent inside VS Code.

You have direct access to the currently opened workspace, its files, the integrated terminal and Git. The workspace should contain the existing repository:

https://github.com/meestierolff/trading-bayesian-multivariate-cointegration

Your mission is not merely to review or describe the repository. You must transform it from an experimental and mathematically inconsistent prototype into a secure, reproducible, paper-faithful Bayesian time-varying cointegration research framework.

The finished repository must provide:

1. a mathematically verified implementation of time-varying cointegration and time-varying cointegrating rank;
2. correct Bayesian posterior inference and MCMC diagnostics;
3. trustworthy terminal, historical and predictive rank probabilities;
4. mathematically defensible rank-aware trading research;
5. separate, correct long-short and benchmark-relative long-only strategies;
6. a leakage-free walk-forward backtesting engine;
7. exact portfolio accounting and realistic transaction-cost handling;
8. secure market-data and model-state handling;
9. rigorous analytical, simulation, regression and security tests;
10. an intuitive CLI and reporting workflow;
11. honest public documentation, references and licensing treatment;
12. paper-trading readiness only, with live trading explicitly disabled.

Do not stop after a surface-level refactor. Do not simply add disclaimers around broken mathematics. Correct the underlying implementation.

Continue until every implementable P0, P1 and P2 requirement in this prompt is complete and verified. Anything that genuinely cannot be completed because it requires external access, copyright permission, paid market data, independent academic review or a human risk decision must be explicitly classified as an EXTERNAL_BLOCKER or HUMAN_DECISION.

Never leave an implementable requirement as a vague TODO.

──────────────────────────────────────────────────────────────────────────────
VS CODE OPERATING CONTRACT
──────────────────────────────────────────────────────────────────────────────

You are working inside the repository, not writing hypothetical code snippets for me.

Use the integrated terminal and edit the actual files.

At the beginning:

1. Determine the workspace and repository root:

   pwd
   git rev-parse --show-toplevel
   git status --short
   git branch --show-current
   git remote -v
   git log --oneline --decorate -10

2. Inspect all repository instructions:

   - `AGENTS.md`
   - `CLAUDE.md`
   - `.github/`
   - README files
   - development documentation
   - package configuration
   - test configuration

3. Inspect the complete tracked file tree and relevant ignored files.

4. Check available tooling:

   python --version
   uv --version
   git --version
   gh --version
   gh auth status

5. Preserve all existing uncommitted user work. Never discard, overwrite, stash destructively or reset user changes.

6. Create a dedicated branch such as:

   fix/paper-faithful-cointegration-framework

7. Do not work directly on `main`.

8. Do not merely return a plan. Begin inspecting and implementing immediately.

9. Keep concise progress notes while working, but spend the majority of the session editing, testing and validating.

10. When a failure occurs:
    - investigate the root cause;
    - fix it;
    - rerun the relevant test;
    - rerun the broader suite;
    - record the evidence.

11. Do not ask me to choose between routine implementation approaches. Select the most conservative, mathematically defensible option and document it.

12. Only ask for input if the next action requires an irreversible external decision. Lack of routine clarification is not a reason to stop.

13. When the context becomes large, persist all state and decisions in the repository documentation before continuing. Do not lose requirements across context compaction.

14. If `gh` is installed and authenticated, push the branch and open a draft PR. If GitHub authentication is unavailable, complete all local work and provide the exact push and PR commands at the end. GitHub authentication must not block mathematical or engineering work.

──────────────────────────────────────────────────────────────────────────────
ROLE AND STANDARD OF PROOF
──────────────────────────────────────────────────────────────────────────────

Act simultaneously as:

- a senior Bayesian econometrician;
- a state-space-model specialist;
- a numerical linear algebra engineer;
- a quantitative researcher;
- an adversarial backtest reviewer;
- a Python package maintainer;
- a security and open-source publication reviewer.

Correctness has priority over:

- backward compatibility;
- preserving current abstractions;
- runtime;
- cosmetic output;
- keeping current file names;
- preserving unsupported README claims.

Do not trust as authoritative:

- the current README;
- current comments and docstrings;
- the current paper-derived Markdown files;
- current tests;
- current matrix orientation;
- current vectorization order;
- current α/β terminology;
- current rank calculations;
- current trading rules;
- current backtest results;
- the claim that the implementation extends correctly from N=2 to N≥2.

Use authoritative academic sources and independently derived mathematical tests as the source of truth.

A passing unit test is not sufficient evidence if the test merely reproduces the same erroneous implementation.

Never claim that the repository is:

- production-ready;
- mathematically verified;
- statistically significant;
- market-neutral;
- profitable;
- safe for live capital;
- a faithful implementation of a paper;

unless the exact claim is supported by concrete evidence.

Live trading must remain disabled even after the code is improved.

──────────────────────────────────────────────────────────────────────────────
NON-NEGOTIABLE SAFETY RULES
──────────────────────────────────────────────────────────────────────────────

Never:

- merge into `main`;
- force-push;
- rewrite public Git history without explicit approval;
- change repository visibility;
- create live broker execution;
- submit or simulate submission of live orders;
- commit credentials, tokens or private keys;
- commit real personal portfolio files;
- commit downloaded proprietary market data;
- commit copyrighted publisher PDFs;
- use `shell=True` for user-controlled input;
- use pickle-based deserialization for model state;
- hide numerical failures behind broad exceptions;
- replace a failed posterior draw with random noise;
- silently fall back to arbitrary matrices;
- select strategy parameters using the final holdout;
- use future prices in an as-of signal;
- label a reduced approximation as the canonical Gibbs sampler;
- equate cointegrating rank with trading direction.

All generated target weights and orders must be labelled:

RESEARCH OUTPUT — NOT AN EXECUTABLE BROKER ORDER

──────────────────────────────────────────────────────────────────────────────
CREATE A COMPLETION SYSTEM BEFORE REFACTORING
──────────────────────────────────────────────────────────────────────────────

Create:

`docs/plans/active/COINTEGRATION_COMPLETION_MATRIX.md`

Give every material requirement in this prompt a stable ID.

For every requirement record:

- priority: P0, P1, P2 or P3;
- category;
- requirement;
- implementation location;
- validation evidence;
- status.

Allowed terminal statuses are only:

- VERIFIED
- EXTERNAL_BLOCKER
- HUMAN_DECISION

During implementation an item may temporarily be IN_PROGRESS, but the final matrix must contain no implementable P0, P1 or P2 items in that state.

Also create:

`docs/IMPLEMENTATION_LOG.md`

Continuously record:

- audit findings;
- mathematical decisions;
- source references;
- broken assumptions;
- migrations;
- commands run;
- tests added;
- validation results;
- numerical warnings;
- security findings;
- remaining external gates.

Create:

`docs/BASELINE_AUDIT.md`

Record the initial state of the repository before changing it, including:

- current commit;
- current package layout;
- current test status;
- current lint/type status;
- current security scan status;
- current mathematical claims;
- current backtest claims;
- current public-repository risks.

──────────────────────────────────────────────────────────────────────────────
PHASE 1 — AUTHORITATIVE PAPER ALIGNMENT
──────────────────────────────────────────────────────────────────────────────

Locate and study authoritative versions of:

1. Chua and Tsiaplias’ bivariate time-varying cointegration and rank work;
2. the final multivariate publication: “A Bayesian Approach to Modeling Time-Varying Cointegration and Cointegrating Rank”;
3. the accepted-author manuscript if the publisher version is inaccessible;
4. Durbin and Koopman’s simulation smoother paper;
5. other primary sources explicitly relied on for:
   - identification;
   - SVD parameter expansion;
   - Markov switching;
   - state-space sampling;
   - posterior conditionals.

Use primary sources only for the mathematical implementation.

Do not rely on blogs, copied equations, AI summaries or the current repository paper Markdown as authoritative evidence.

Do not commit copyrighted PDFs. Local temporary access is acceptable when lawful, but committed documentation must use concise original summaries and citations.

Create:

`docs/PAPER_ALIGNMENT.md`

For every model component, record:

- definitive publication metadata;
- source section;
- source equation;
- source page where available;
- source notation;
- repository notation;
- dimensions;
- matrix orientation;
- vectorization convention;
- prior;
- state transition;
- observation equation;
- conditional posterior or sampling step;
- identification restriction;
- implementation function;
- corresponding validation test;
- verification status.

Explicitly resolve and document:

- whether the source model samples α and β directly or uses an SVD-based parameter expansion;
- how the parameter-expanded matrices map to Π_t;
- which quantities are structural and which are identified only up to basis, sign, scale or rotation;
- the support of the rank state;
- how rank zero is represented;
- how full rank is represented;
- deterministic terms;
- lag order;
- transition-matrix orientation;
- initial-state distributions;
- covariance structure;
- state innovation covariances;
- row-major versus column-major vectorization;
- whether equations are stacked by time or by equation.

If an equation cannot be verified from an authoritative source:

- do not invent it;
- mark the exact dependency as an external verification blocker;
- disable any output that depends on it;
- continue all independently verifiable work.

Correct publication years, titles, DOI and references throughout the repository.

──────────────────────────────────────────────────────────────────────────────
CONFIRMED AUDIT FINDINGS TO FIX
──────────────────────────────────────────────────────────────────────────────

Treat every item below as a confirmed defect that must be independently rechecked, fixed and covered by regression tests.

MATH-001 — INVALID IDENTIFICATION CLAIM

The current implementation normalizes both lower-triangular α and β matrices by setting their diagonals to one and claims this is equivalent to the source paper’s SVD approach.

That is not generally equivalent and can over-constrain Π_t.

Implement the exact paper-faithful identification or parameter expansion. Remove every unsupported equivalence claim.

Do not normalize both α and β in a way that fixes economically meaningful scale unless the source derivation justifies it.

MATH-002 — RANK MASK APPLIED TO THE WRONG ORIENTATION

The current code changes between column-major and row-major representations and then applies masks as if the blocks still represented columns. For rank one, this can retain a row such as `[1, 0, 0]` rather than the learned cointegrating component.

Define one canonical representation.

For all N and all states r, verify numerically that:

    rank(Pi_t) = r

within a documented tolerance.

Tests must verify that masks activate the intended SVD/rank components, not flattened rows or arbitrary array slices.

MATH-003 — INVALID BIVARIATE-TO-MULTIVARIATE GENERALIZATION

Several conditional sampling blocks preserve bivariate assumptions and do not correctly condition on all remaining components for N>2.

Re-derive every multivariate conditional from the source model.

Do not patch individual indices without deriving the complete equations, dimensions and residualization steps.

MATH-004 — INCORRECT DURBIN–KOOPMAN SIMULATION SMOOTHER

The current auxiliary-state simulation does not correctly sample the initial auxiliary state and applies an inconsistent mean correction.

Replace it with a canonical implementation of the simulation smoother.

Validate it independently against exact Gaussian posterior moments.

MATH-005 — INCORRECT INITIAL COVARIANCE

Where a stationary AR(1) state follows:

    x_t = rho x_(t-1) + eta_t
    eta_t ~ N(0, Q)

the unconditional covariance must incorporate Q:

    P0 = Q / (1 - rho^2)

when that initialization is the specified model.

Do not use:

    I / (1 - rho^2)

unless Q is actually I.

Derive the exact initialization from the source model.

MATH-006 — INITIAL STATE IS OVERWRITTEN AFTER SAMPLING

The current implementation overwrites t=0 state values with near-zero random noise and then uses those artificial values in later posterior steps.

Remove this completely.

Identification-fixed elements must never be randomly overwritten.

MATH-007 — BROKEN RHO SAMPLER

The current proposal scale is much wider than the allowed interval, causing the chain to remain nearly fixed.

Re-derive the conditional target for rho.

Implement a numerically stable constrained sampler, preferably on an unconstrained transformed scale when appropriate.

Requirements:

- correct target density;
- correct treatment of Q;
- Jacobian where required;
- warm-up-only adaptation;
- fixed proposal after warm-up;
- acceptance-rate reporting;
- trace diagnostics;
- simulation recovery tests;
- no initial value outside the permitted support.

MATH-008 — INCONSISTENT VECTORIZATION OF DETERMINISTIC AND LAG TERMS

The current response vector and design matrix use incompatible stacking orders.

Choose and document one canonical convention.

Add deterministic hand-calculated tests where every row and coefficient can be inspected explicitly.

MATH-009 — INCORRECT COVARIANCE BLOCK SELECTION

Audit all slicing of time-varying covariance and observation blocks.

Do not select the final T contiguous rows when the intended quantity is one equation at every time step.

Add tests with uniquely labelled synthetic matrices so incorrect indexing is immediately visible.

MATH-010 — HISTORICAL OCCUPANCY REPORTED AS CURRENT RANK

The current rank output averages state membership across both time and posterior draws and then treats this as the current rank.

Implement and clearly distinguish:

1. terminal posterior:
   P(S_T = r | y_1:T)

2. smoothed historical posterior:
   P(S_t = r | y_1:T)

3. average historical occupancy;

4. filtered posterior where relevant;

5. predictive posterior:
   P(S_T+h = r | y_1:T)

Never label average historical occupancy as current rank.

MATH-011 — FINAL DRAW USED AS POSTERIOR ESTIMATE

Do not use the final Gibbs draw of:

- transition matrix;
- rho;
- α;
- β;
- Π;
- covariance;
- rank state;

as the posterior result.

Store retained draws or mathematically sufficient posterior summaries, credible intervals and Monte Carlo error.

MATH-012 — INCORRECT RANK SEMANTICS

Correct all documentation and UI language:

- rank 0 means no cointegrating relation detected under the specified model and sample; it does not imply independence;
- ranks 1 through N-1 are cointegrating ranks;
- rank N means a full-rank/stationary level system under the model;
- rank N is not automatically N tradable arbitrage spreads.

MATH-013 — INADEQUATE MCMC DIAGNOSTICS

Implement multiple independent chains.

For decision-relevant continuous quantities report:

- rank-normalized split R-hat;
- bulk ESS;
- tail ESS;
- Monte Carlo standard error;
- chain traces;
- acceptance statistics;
- numerical failures;
- posterior predictive checks.

Use ArviZ-compatible `InferenceData` unless an equally transparent standard is strongly justified.

Default fail-closed expectations should normally include:

- R-hat <= 1.01;
- adequate bulk and tail ESS;
- MCSE sufficiently small relative to posterior uncertainty.

Discrete state sequences require appropriate discrete diagnostics; do not blindly apply continuous diagnostics to raw state labels.

MATH-014 — NO INDEPENDENT REFERENCE VALIDATION

Build independently verifiable low-dimensional reference cases:

- scalar Gaussian state-space posterior moments;
- exact Kalman/FFBS posterior;
- Durbin–Koopman sample moments;
- brute-force Markov-state enumeration;
- direct analytical conjugate-regression posteriors;
- hand-counted transition matrices;
- explicit rank-mask matrices.

Do not generate expected results with the implementation under test.

MATH-015 — BASIS-DEPENDENT SUBSPACE COMPARISON

For rank greater than one, raw β columns can rotate while spanning the same cointegrating space.

Use basis-invariant quantities such as:

    P_beta = beta (beta' beta)^(-1) beta'

and principal angles between subspaces.

Use Procrustes alignment only for visualization where appropriate.

Do not report arbitrary column rotation as structural instability.

MATH-016 — CURRENT PRICE IS ONE OBSERVATION OLD

Audit the timing convention in the data loader and signal generator.

Ensure a signal with as-of time T uses the valid market information available at T, not y_(T-1) accidentally labelled as current.

Add an explicit timing test.

MATH-017 — LONG-SHORT SIGN IS INCONSISTENT WITH THE VECM

Under the chosen convention:

    Delta y_t = alpha z_(t-1) + ...
    z_(t-1) = beta' y_(t-1)

the error-correction expected-return contribution is:

    alpha z_(t-1)

The current daily signal uses an inconsistent negative sign.

Derive and test the correct sign for each supported strategy.

MATH-018 — DAILY SIGNAL AND BACKTEST IMPLEMENT DIFFERENT PORTFOLIOS

The current live-style signal and backtest use materially different α/β weighting formulas.

Create a single canonical strategy API shared by both signal generation and backtesting.

MATH-019 — COMPONENT-WISE ALPHA WEIGHTING DESTROYS THE SPREAD

Do not multiply each β component by a different absolute α component and still call the result the original cointegrating spread.

A transformed vector must be mathematically justified and independently validated.

MATH-020 — FALSE MARKET-NEUTRAL CLAIM

Normalizing:

    sum(abs(w)) = 1

does not imply:

    sum(w) = 0

and does not imply beta, factor, sector, currency or market neutrality.

Only claim a type of neutrality if it is explicitly constrained and verified.

MATH-021 — INVALID HALF-LIFE

Delete every use of:

    log(2) / mean(abs(alpha))

as a VECM half-life.

For a locally constant rank-one model without extra lags, derive the scalar spread dynamics under the exact orientation:

    z_t = phi z_(t-1) + u_t
    phi = 1 + beta' alpha

A scalar half-life may be reported only when the dynamics support it:

    half_life = log(0.5) / log(abs(phi))

Handle separately:

- abs(phi) >= 1;
- phi < 0 and oscillatory convergence;
- posterior uncertainty;
- near-unit-root dynamics.

For multiple ranks, additional lags or time-varying coefficients, use the full companion dynamics or posterior predictive impulse responses.

Report a posterior distribution, not a false exact scalar.

MATH-022 — LONG-ONLY IS NOT COINTEGRATION ARBITRAGE

The current long-only mode is effectively an equal-weight portfolio with an unvalidated α tilt.

Reframe it as:

    cointegration-informed benchmark-relative long-only active allocation

Its value must be measured versus its benchmark.

MATH-023 — LONG-ONLY FLAG IS IGNORED BY THE BACKTEST

The long-only configuration must actually alter target-weight construction.

Add tests proving:

- no negative weights;
- weights sum to one;
- no-signal output equals the benchmark;
- the long-only path is used in the backtest.

MATH-024 — PER-LEG STOPS BREAK THE BASKET

Independent stops can leave an unintended unhedged position.

Use basket-level risk and exit rules as the primary mechanism.

MATH-025 — SAME-CLOSE LOOKAHEAD

A signal calculated using close T cannot be filled at that same close unless a specific executable closing-auction model is implemented and justified.

Default execution must occur at the next tradable bar.

MATH-026 — OPEN TRADE IS CLOSED USING A DIFFERENT SPREAD

Persist the exact model and spread definition used when opening a trade.

Choose and document one policy:

- freeze the opening spread until exit;
- explicitly rehedge;
- close the old trade and open a new trade.

Do not silently open with one β and exit using another.

MATH-027 — APPROXIMATE LOG-RETURN PNL PRESENTED AS EXACT CASH PNL

Track exact:

- holdings;
- quantities;
- cash;
- prices;
- FX;
- fills;
- costs.

Do not use weighted log-price differences as exact realised portfolio P&L.

MATH-028 — COST CONFIGURATION IS IGNORED

Correctly implement and test:

- flat costs;
- percentage costs;
- basis-point costs;
- minimum commissions;
- spread;
- slippage;
- borrow costs;
- FX costs where applicable.

MATH-029 — ZERO-RETURN DAYS REMOVED FROM SHARPE

All valid portfolio days must remain in the return series.

Do not remove zero-return or zero-position days before calculating volatility or Sharpe.

MATH-030 — INVALID STATISTICAL-SIGNIFICANCE LANGUAGE

A Sharpe above an arbitrary threshold or a profit factor above one is not automatically statistically significant.

Remove all such claims unless a documented test is actually performed.

MATH-031 — SENSITIVITY ANALYSIS IS PARAMETER MINING

Implement nested validation and preserve an untouched final holdout.

Do not use the final test period to choose:

- entry thresholds;
- holding periods;
- rank gates;
- costs;
- strategy variants;
- risk limits.

MATH-032 — BACKWARD FILL CREATES FUTURE LEAKAGE

Remove all backward filling from price histories.

MATH-033 — DATES ARE REMOVED

Preserve timezone-aware timestamps through the entire pipeline.

MATH-034 — CROSS-CURRENCY LEVELS ARE MIXED

Implement an explicit base-currency and FX policy.

Do not model USD and EUR price levels as directly comparable numerical units.

MATH-035 — FALSE WARM-START CLAIM

Do not call a partial NPZ containing incomplete point estimates a full warm start.

Implement schema-validated resumption correctly or remove the claim.

MATH-036 — MEMORY COMPLEXITY IS MISSTATED

Measure actual scaling with:

- N;
- T;
- chains;
- warm-up draws;
- retained draws.

Do not describe total storage as O(N²) when trajectories scale with time and draws.

──────────────────────────────────────────────────────────────────────────────
PHASE 2 — ONE CANONICAL PACKAGE
──────────────────────────────────────────────────────────────────────────────

Replace duplicate, inconsistent mathematical implementations with one canonical package.

A preferred structure is:

src/coinrank/
    __init__.py
    cli.py
    config.py
    exceptions.py
    version.py

    data/
        models.py
        validation.py
        alignment.py
        provenance.py
        providers/
            base.py
            yahoo.py
            local.py

    model/
        specification.py
        parameterization.py
        identification.py
        kalman.py
        simulation_smoother.py
        markov.py
        conditionals.py
        sampler.py
        posterior.py
        predictive.py
        diagnostics.py
        storage.py

    trading/
        models.py
        signals.py
        posterior_returns.py
        rank_one_spread.py
        long_only_overlay.py
        optimization.py
        risk.py
        costs.py
        positions.py

    backtest/
        engine.py
        execution.py
        portfolio.py
        metrics.py
        validation.py
        reporting.py

    reports/
        html.py
        plots.py
        schemas.py

tests/
    unit/
    mathematical/
    simulation/
    integration/
    backtest/
    security/

Compatibility wrappers for old entrypoints are allowed only when they do not preserve incorrect behaviour. Emit deprecation warnings.

Use:

- Python 3.12 where supported;
- `pyproject.toml`;
- `uv.lock`;
- a `src/` layout;
- complete type hints at public boundaries;
- `numpy.random.Generator`;
- `SeedSequence` for chain seeds;
- Cholesky-based solves;
- `solve_triangular` or equivalent;
- `logsumexp`;
- xarray dimensions;
- ArviZ-compatible posterior storage;
- dataclasses or Pydantic for validated external configuration.

Do not use global `np.random`.

Avoid explicit matrix inverses where a solve is appropriate.

Do not add arbitrary jitter silently.

If numerical regularization is mathematically justified:

- bound it;
- log it;
- expose it in diagnostics;
- test it;
- fail above a configured threshold.

Replace broad exception handlers with typed errors containing:

- chain;
- iteration;
- sampler block;
- array shapes;
- condition diagnostics;
- safe metadata.

Do not include sensitive raw data in exceptions.

──────────────────────────────────────────────────────────────────────────────
FORMAL MODEL SPECIFICATION
──────────────────────────────────────────────────────────────────────────────

Create:

`docs/METHODOLOGY.md`

Specify formally:

- observed series y_t;
- whether y_t contains log prices, adjusted levels or total-return indexes;
- information timing;
- VECM lag order;
- deterministic terms;
- observation equation;
- state equations;
- rank process;
- transition matrix;
- priors;
- initial distributions;
- identification;
- posterior factorization;
- every sampler block;
- derived quantities;
- signal timing.

For every mathematical array define named dimensions such as:

- time;
- asset;
- rank_component;
- chain;
- draw;
- state;
- lag;
- equation.

Add runtime shape assertions at mathematical and public boundaries.

Support configurable deterministic terms only where implemented and tested:

- no intercept;
- restricted intercept;
- unrestricted intercept;
- trend.

Do not expose configuration flags that are ignored internally.

Add tests for:

- asset-permutation invariance;
- permitted sign invariance;
- permitted normalization invariance;
- cointegrating-subspace invariance;
- all supported N and rank combinations.

──────────────────────────────────────────────────────────────────────────────
SIMULATION SMOOTHER
──────────────────────────────────────────────────────────────────────────────

Implement the exact authoritative simulation smoother, including:

- proper initial-state simulation;
- auxiliary observations;
- auxiliary state path;
- correct mean correction;
- proper handling of time-varying matrices;
- stable filtering and smoothing.

Required independent tests:

1. scalar Gaussian state-space model;
2. exact posterior state mean;
3. exact posterior state covariance;
4. lag-one covariance where relevant;
5. many simulation-smoother draws;
6. sample moments versus exact posterior;
7. tolerances predeclared in Monte Carlo standard-error units;
8. proper initial-state case;
9. diffuse case only if the production model uses one.

The independent reference implementation must not call the production smoother.

──────────────────────────────────────────────────────────────────────────────
MARKOV-RANK INFERENCE
──────────────────────────────────────────────────────────────────────────────

Implement:

- Hamilton forward filtering;
- log-space likelihood calculations;
- backward state sampling;
- transition-count calculation;
- Dirichlet transition draws;
- filtered state probabilities;
- smoothed state probabilities;
- terminal state probabilities;
- h-step predictive state probabilities;
- marginal likelihood where applicable.

For small K and T, enumerate every possible state path and compare:

- total likelihood;
- filtered probabilities;
- smoothed probabilities;
- terminal posterior;
- sampled state frequencies;
- transition counts.

Store transition-matrix posterior draws or sufficient summaries.

Report:

- posterior mean and credible intervals for every P_ij;
- expected state duration;
- probability of transition to rank zero;
- predictive probability of rank zero;
- rank entropy;
- terminal probability of ranks 1 through N-1.

Define:

    p_cointegration_t =
        sum_{r=1}^{N-1} P(S_t = r | data)

Keep rank N separate.

──────────────────────────────────────────────────────────────────────────────
MCMC, CHAINS AND STORAGE
──────────────────────────────────────────────────────────────────────────────

Implement:

- multiple independently seeded chains;
- configurable warm-up;
- retained draws;
- dispersed initializations;
- optional checkpoints;
- schema-versioned runs;
- safe resumption;
- run IDs;
- configuration hashes;
- data-manifest hashes;
- source commit hashes.

A prior run may be used to initialize a new run only when:

- state schema matches;
- model specification matches;
- asset order matches;
- data lineage matches;
- configuration matches;
- use is recorded;
- independent-chain convergence remains measurable.

Do not keep all O(chains × draws × time × N²) paths in RAM by default.

Use an appropriate combination of:

- chunked Zarr;
- NetCDF;
- online posterior summaries;
- selective path retention;
- terminal-state draw retention;
- configurable trajectory retention.

Do not use thinning as a substitute for diagnostics or storage engineering.

For all decision-relevant summaries report:

- mean;
- median where useful;
- credible interval;
- ESS;
- MCSE;
- R-hat where applicable.

A signal command must fail closed when required model diagnostics are missing or unacceptable.

──────────────────────────────────────────────────────────────────────────────
PHASE 3 — DATA PIPELINE
──────────────────────────────────────────────────────────────────────────────

Implement a secure, as-of market-data pipeline.

DATA-001 — NO BACKWARD FILL

Never backward-fill price history.

DATA-002 — CONTROLLED FORWARD FILL

Default to a common valid observation set.

If forward filling is explicitly enabled:

- configure a maximum stale interval;
- retain a stale flag;
- report every fill;
- exclude stale observations from signals by default;
- account for exchange calendars.

DATA-003 — PRESERVE TIMESTAMPS

Keep timezone-aware timestamps in downloaded files, model input, reports and backtests.

DATA-004 — VALIDATION

Validate:

- unique timestamps;
- strictly increasing timestamps;
- positive finite prices;
- sufficient history;
- missing observations;
- stale observations;
- currency;
- exchange;
- corporate actions;
- data freshness;
- no future information relative to the as-of time.

DATA-005 — CROSS-MARKET TIMING

Do not assume that closes on different exchanges were known simultaneously.

Implement a common information cutoff or reject an invalid mixed-market signal.

DATA-006 — CORPORATE ACTIONS

Explicitly distinguish:

- modelling series;
- adjusted data;
- total-return data;
- executable prices;
- dividends;
- splits.

DATA-007 — CURRENCY

Introduce an explicit base-currency policy.

For multiple currencies:

- convert prices, returns and valuations with as-of FX; or
- model or hedge FX explicitly.

Block signals when required FX data is missing.

DATA-008 — PROVIDER ABSTRACTION

Treat yfinance/Yahoo as a research adapter.

Make explicit:

- package version;
- interval;
- auto-adjust;
- repair;
- actions;
- timezone;
- requested and resolved symbols.

DATA-009 — PROVENANCE

Write a manifest for every dataset:

- provider;
- requested symbols;
- resolved symbols;
- retrieval timestamp;
- as-of timestamp;
- start and end;
- timezone;
- currency;
- adjustment mode;
- package version;
- checksum;
- missing-data report;
- stale-data report.

DATA-010 — SAFE DOWNLOADS

Write to a temporary file, validate it and atomically rename it.

DATA-011 — SAFE PROCESS EXECUTION

Prefer direct Python APIs.

Where subprocesses are necessary:

- use `sys.executable`;
- pass an argument list;
- never use `shell=True`;
- set `check=True`;
- set a timeout;
- capture and sanitize errors.

DATA-012 — SAFE SYMBOLS AND PATHS

Validate user-supplied tickers and paths.

Reject:

- `..`;
- slashes;
- absolute paths;
- control characters;
- unexpected filename components.

After resolving a path, assert it remains inside the approved data or run root.

DATA-013 — NO-LOOKAHEAD PROPERTY TEST

Changing any observation after as-of time T must not change:

- the dataset available at T;
- preprocessing at T;
- fitted inputs at T;
- a signal calculated at T;
- target weights calculated at T.

──────────────────────────────────────────────────────────────────────────────
PHASE 4 — POSTERIOR SIGNAL DESIGN
──────────────────────────────────────────────────────────────────────────────

Do not treat rank as a directional signal.

Rank is a regime, model-validity and uncertainty variable.

Direction must come from:

- posterior predictive returns; or
- a correctly replicated rank-one spread.

Create one canonical strategy interface used by both live-style research signals and backtests:

    posterior
    + market_state
    + current_positions
    + strategy_config
    -> signal_decision
    -> target_weights
    -> hypothetical_orders
    -> diagnostics
    -> no_trade_reasons

Implement three distinct strategies.

STRATEGY A — GENERAL POSTERIOR-PREDICTIVE RETURN

For every retained posterior draw, calculate the model-consistent predictive return:

    mu_t(draw)
      = Pi_t(draw) y_t
      + sum_l Gamma_l(draw) Delta y_(t-l+1)
      + deterministic_terms(draw)

Use the exact timing and orientation derived in `docs/METHODOLOGY.md`.

Do not omit Γ or deterministic terms while claiming to use the full VECM.

Aggregate the full predictive distribution.

Construct target weights using a risk-aware optimization that can include:

- posterior expected return;
- posterior covariance;
- uncertainty penalty;
- gross leverage;
- net exposure;
- maximum weight;
- liquidity;
- turnover;
- transaction costs;
- borrow availability;
- FX exposure;
- optional dollar neutrality;
- optional beta neutrality;
- optional factor neutrality.

Positive predictive return supports long exposure; negative predictive return supports short exposure.

Add hand-calculated sign and orientation tests.

STRATEGY B — RANK-ONE SPREAD

Only activate this strategy when rank one is sufficiently probable and all diagnostic gates pass.

Under the documented convention:

    z_t = beta_t' y_t

a candidate spread exposure is:

    w_spread proportional to -sign(z_t) beta_t

subject to:

- normalization;
- tradability;
- risk limits;
- costs;
- uncertainty;
- timing.

The resulting trade must be invariant to replacing β by -β.

Add an explicit sign-invariance test.

Do not replace β with α.

Do not multiply every β component by a different |α_i| and still call it the same spread.

For rank greater than one, do not arbitrarily trade raw β columns. Use the general posterior-return strategy unless a separate basis-invariant construction is rigorously derived and tested.

STRATEGY C — LONG-ONLY ACTIVE OVERLAY

Implement long-only as:

    cointegration-informed benchmark-relative active allocation

Let:

    w = b + delta

with:

    sum(w) = 1
    w_i >= 0
    sum(delta) = 0

where b is the configured benchmark.

Include configurable constraints for:

- maximum active weight;
- tracking error;
- turnover;
- transaction costs;
- sector exposure;
- factor exposure;
- liquidity;
- minimum order size;
- currency exposure.

Use posterior predictive returns and uncertainty.

When no valid edge exists or diagnostics fail:

    delta = 0
    w = b

Require current positions to determine actual hypothetical trades.

Do not assume a zero portfolio every time.

Measure and report active return versus the benchmark.

──────────────────────────────────────────────────────────────────────────────
RANK-AWARE FAIL-CLOSED GATES
──────────────────────────────────────────────────────────────────────────────

No position may be proposed unless all required gates pass.

Include:

- data freshness;
- valid timestamps;
- valid currency;
- no future leakage;
- sampler diagnostics;
- terminal cointegration probability;
- rank entropy;
- predictive probability of rank zero;
- subspace stability;
- reversion stability;
- liquidity;
- borrow availability for shorts;
- expected transaction costs;
- posterior probability of positive net edge;
- expected shortfall;
- leverage and position constraints.

Expose documented thresholds such as:

- minimum P(rank in 1..N-1);
- maximum rank entropy;
- maximum predictive P(rank 0);
- minimum P(net P&L > 0);
- maximum expected shortfall;
- maximum subspace angle;
- maximum data staleness;
- minimum effective sample size.

Do not optimize these thresholds on the final holdout.

Scale exposure with uncertainty rather than relying only on modal rank.

Every signal report must include:

- run ID;
- source commit;
- as-of timestamp;
- data vintage;
- strategy;
- terminal rank distribution;
- predictive rank distribution;
- rank entropy;
- model diagnostic status;
- current weights;
- target weights;
- hypothetical trades;
- expected gross return distribution;
- expected transaction costs;
- expected net return distribution;
- credible intervals;
- risk estimates;
- all no-trade and sizing reasons.

Default to NO TRADE whenever required evidence is unavailable.

──────────────────────────────────────────────────────────────────────────────
REVERSION AND HALF-LIFE
──────────────────────────────────────────────────────────────────────────────

For rank one with locally constant parameters and no additional lags, derive the spread dynamics under the exact orientation.

Validate:

    phi = 1 + beta' alpha

only if that expression follows from the implemented convention.

Report a scalar half-life only when mathematically meaningful.

Handle:

- abs(phi) >= 1;
- phi < 0;
- oscillatory paths;
- non-monotonic impulse responses;
- posterior uncertainty;
- model switching during the holding horizon.

For higher rank or additional lags:

- construct the companion matrix; or
- use posterior predictive impulse responses.

Estimate a posterior reversion-time distribution.

If no meaningful half-life exists, report that and prevent strategies from depending on it.

──────────────────────────────────────────────────────────────────────────────
BASKET RISK AND TRADE LIFECYCLE
──────────────────────────────────────────────────────────────────────────────

Primary risk controls must operate on the complete basket.

Implement:

- basket P&L stop;
- spread-divergence stop;
- rank-collapse stop;
- subspace-instability stop;
- diagnostic-failure stop;
- data-quality stop;
- maximum holding period;
- posterior-edge disappearance;
- complete unwind or controlled rehedge.

Emergency per-asset limits may exist only if they trigger:

- full basket unwind; or
- explicit immediate rehedging.

Persist at entry:

- run ID;
- model version;
- as-of time;
- posterior snapshot;
- rank distribution;
- β or subspace;
- target weights;
- fill assumptions;
- strategy configuration;
- risk thresholds.

Do not use a new model definition to retrospectively redefine an existing trade without an explicit rehedge event.

──────────────────────────────────────────────────────────────────────────────
PHASE 5 — REBUILD THE BACKTEST
──────────────────────────────────────────────────────────────────────────────

Do not preserve the current backtest results as evidence.

Create a genuinely as-of, event-driven or carefully vectorized walk-forward engine.

BACKTEST-001 — INFORMATION TIMING

For every signal record:

- information cutoff;
- training-window endpoint;
- model-fit timestamp;
- signal timestamp;
- earliest allowed execution time.

Default:

- data through close T;
- decision after close T;
- execution at next tradable open or configured later bar.

BACKTEST-002 — WALK-FORWARD FITTING

At every refit:

- use only data available then;
- fit preprocessing only on training data;
- store the model configuration;
- store diagnostics;
- store the run ID;
- preserve the posterior snapshot used for decisions.

BACKTEST-003 — EXACT ACCOUNTING

Track:

- cash;
- shares or quantities;
- entry and exit fills;
- executable prices;
- FX;
- dividends;
- splits;
- commissions;
- bid-ask spread;
- slippage;
- market impact where configured;
- borrow fees;
- cash interest;
- gross exposure;
- net exposure;
- realised P&L;
- unrealised P&L;
- equity.

BACKTEST-004 — COST MODES

Correctly implement and hand-test:

- flat fee;
- percentage fee;
- basis points;
- minimum fee;
- spread;
- slippage;
- borrow fee;
- FX conversion cost.

BACKTEST-005 — LONG-ONLY

The long-only strategy must use its benchmark-relative optimizer and must never produce a negative asset weight.

BACKTEST-006 — NEUTRALITY

Distinguish:

- dollar neutrality;
- beta neutrality;
- factor neutrality;
- sector neutrality;
- currency neutrality.

Only label a strategy with a neutrality property when it is explicitly constrained, measured and passed.

BACKTEST-007 — RETURN SERIES

Include all valid portfolio dates, including:

- zero-position days;
- zero-return days;
- cash-only days.

BACKTEST-008 — METRICS

Implement correctly:

- time-weighted return;
- active return;
- annualized return;
- volatility;
- downside volatility;
- Sharpe;
- Sortino;
- maximum percentage drawdown;
- Calmar with compatible units;
- turnover;
- gross exposure;
- net exposure;
- tracking error;
- hit rate;
- profit factor;
- average holding period;
- tail loss;
- expected shortfall;
- transaction-cost attribution.

Record the risk-free or cash-return assumption.

BACKTEST-009 — BENCHMARK

For long-only, always report:

- benchmark return;
- active return;
- tracking error;
- information ratio where valid;
- active drawdown.

For long-short, include appropriate null and baseline comparisons.

BACKTEST-010 — STATISTICAL EVIDENCE

Where sample size permits, implement or document:

- block bootstrap intervals;
- Deflated Sharpe Ratio;
- Probability of Backtest Overfitting;
- correction for multiple tested variants;
- confidence intervals;
- final untouched holdout.

Do not call a result statistically significant without a performed test.

BACKTEST-011 — NESTED VALIDATION

Use:

1. outer training period;
2. inner validation for strategy hyperparameters;
3. outer walk-forward test;
4. final untouched holdout.

The final holdout must not affect:

- model choices;
- signal thresholds;
- transaction-cost assumptions;
- rank gates;
- risk limits;
- holding periods.

BACKTEST-012 — REPRODUCIBILITY

Record:

- random seeds;
- dependency versions;
- source commit;
- dataset hash;
- config hash;
- hardware metadata where useful.

Distinguish strategy-parameter sensitivity from Monte Carlo sampling variance.

BACKTEST-013 — LEAKAGE TESTS

Prove through tests that:

- future price changes do not alter past signals;
- final-holdout mutations do not alter prior parameter selection;
- fills occur after information availability;
- scalers and transformations use training data only;
- an updated β does not retroactively redefine an open trade;
- asynchronous market closes cannot leak unavailable information.

──────────────────────────────────────────────────────────────────────────────
PHASE 6 — SCIENTIFIC VALIDATION
──────────────────────────────────────────────────────────────────────────────

Create:

`docs/VALIDATION.md`

Also create a machine-readable validation summary.

Validation tiers:

TIER A — FAST CI

Include:

- scalar state-space tests;
- simulation-smoother moment tests with modest seeded draw counts;
- matrix shape tests;
- vectorization tests;
- rank-mask tests;
- rank(Pi) tests;
- Markov brute-force tests;
- hand-calculated conditional posterior tests;
- signal-sign tests;
- spread sign-invariance tests;
- accounting tests;
- no-lookahead tests;
- security tests.

TIER B — SEEDED SCIENTIFIC VALIDATION

Include synthetic DGPs for:

- N=2, rank 0;
- N=2, rank 1;
- N=2, full rank;
- N=3, constant rank;
- N=3, switching rank;
- structural break;
- near-unit-root state;
- low transition persistence;
- high transition persistence;
- time-varying cointegrating space;
- different asset permutations;
- different permissible normalizations.

Evaluate:

- posterior parameter recovery;
- interval coverage;
- rank-state recovery;
- transition-probability recovery;
- cointegrating-subspace principal angles;
- predictive calibration;
- false-positive cointegration rates;
- false-negative rates.

TIER C — PAPER REPLICATION

Recreate the source paper’s simulation designs as faithfully as legally and technically possible.

Clearly label every outcome:

- exact replication;
- approximate replication;
- externally blocked replication.

Compare against reported source results without copying copyrighted tables.

Predeclare tolerances.

For stochastic tests, evaluate differences in Monte Carlo standard-error units.

Do not widen tolerances after observing failures.

Run dispersed initializations and multiple chains.

The validation report must record:

- code version;
- source commit;
- package versions;
- seeds;
- DGP settings;
- chain settings;
- acceptance rates;
- R-hat;
- ESS;
- MCSE;
- tolerances;
- failures;
- warnings;
- runtime;
- peak memory.

Do not declare the core methodology validated while a posterior-correctness or paper-alignment test fails.

──────────────────────────────────────────────────────────────────────────────
PHASE 7 — USER-FRIENDLY CLI
──────────────────────────────────────────────────────────────────────────────

Provide one coherent command-line interface, for example:

    coinrank doctor
    coinrank fetch --config configs/example.yaml
    coinrank fit --config configs/example.yaml
    coinrank diagnose --run RUN_ID
    coinrank signal --run RUN_ID --positions positions.csv
    coinrank backtest --config configs/backtest.example.yaml
    coinrank report --run RUN_ID
    coinrank validate --tier fast
    coinrank validate --tier scientific

Use Typer, argparse or another maintained framework.

`coinrank doctor` must inspect:

- Python version;
- dependency environment;
- configuration validity;
- writable directories;
- data availability;
- currencies;
- data freshness;
- model-state schema;
- posterior diagnostics;
- security-sensitive settings;
- live execution state.

Create:

- `configs/example.yaml`;
- `configs/backtest.example.yaml`;
- synthetic demo data;
- a synthetic positions example;
- generated synthetic report fixtures where appropriate;
- JSON schemas for model output;
- JSON schemas for signal output.

Do not commit downloaded real market data.

The default workflow is research and paper trading.

Add a hard gate such as:

    live_execution_enabled = false

No broker integration or order-submission code may be added.

Hypothetical orders must be explicitly labelled as non-executable research output.

──────────────────────────────────────────────────────────────────────────────
REPORTING
──────────────────────────────────────────────────────────────────────────────

Generate JSON and readable HTML reports containing:

- package version;
- source commit;
- run ID;
- as-of timestamp;
- data vintage;
- assets;
- currencies;
- data-quality results;
- sample period;
- model specification;
- priors;
- MCMC diagnostics;
- numerical warnings;
- terminal rank posterior;
- smoothed historical rank posterior;
- historical occupancy;
- predictive rank posterior;
- rank entropy;
- transition matrix posterior;
- expected state durations;
- cointegrating-subspace stability;
- ECT or spread diagnostics;
- predictive-return distribution;
- reversion distribution where valid;
- strategy;
- current weights;
- target weights;
- hypothetical trades;
- expected gross edge;
- costs;
- expected net edge;
- credible intervals;
- risk estimates;
- gate decisions;
- no-trade reasons;
- limitations;
- disclaimer.

Use precise rank language.

For rank zero:

    No cointegration detected under the specified model and sample.

For full rank:

    Stationary level system under the specified model.

Do not use language suggesting guaranteed arbitrage.

──────────────────────────────────────────────────────────────────────────────
PHASE 8 — PUBLIC-REPOSITORY SECURITY
──────────────────────────────────────────────────────────────────────────────

SECURITY-001 — SECRET SCAN

Scan both the current tree and full Git history using an available reputable scanner such as gitleaks.

Also search manually for:

- API keys;
- access tokens;
- private keys;
- credentials;
- account identifiers;
- emails;
- private positions;
- local absolute paths;
- secrets in notebooks;
- secrets in generated output.

Never print a discovered secret value.

If a confirmed credential is found:

- do not push;
- report only path and commit;
- state that rotation is required;
- remove it safely from the current branch;
- do not rewrite public history without explicit approval.

SECURITY-002 — GITIGNORE

Ensure `.gitignore` covers at least:

    .env
    .env.*
    !.env.example
    *.pem
    *.key
    *.p12
    credentials.*
    secrets.*
    data/raw/**
    data/private/**
    data/output/**
    runs/**
    *.npz
    *.pkl
    *.pickle
    .DS_Store
    .venv/
    __pycache__/
    .pytest_cache/
    .mypy_cache/
    .ruff_cache/

Explicitly allow safe synthetic fixtures where needed.

SECURITY-003 — SAFE SERIALIZATION

Remove every use of:

    allow_pickle=True

Use validated formats such as:

- NPZ with `allow_pickle=False`;
- JSON;
- Parquet;
- NetCDF;
- Zarr.

Every model state must include:

- schema version;
- package version;
- model-specification version;
- config hash;
- data-manifest hash;
- source commit;
- expected arrays;
- expected dimensions;
- dtypes;
- checksums.

Reject malformed or incompatible files.

SECURITY-004 — PATH SAFETY

Resolve and validate every user-controlled output path.

Assert paths remain within an approved root.

SECURITY-005 — DEPENDENCY SAFETY

Add and configure:

- locked dependencies;
- `pip-audit`;
- `bandit`;
- `ruff`;
- type checking;
- pre-commit;
- Dependabot;
- GitHub Actions CI;
- CodeQL where appropriate.

SECURITY-006 — CI PERMISSIONS

Use least-privilege workflow permissions.

Pin third-party GitHub actions to commit SHAs where practical.

SECURITY-007 — SHELL SAFETY

Audit all shell scripts and subprocess calls.

SECURITY-008 — ATOMIC STATE

Use run-specific directories and atomic writes.

Prevent concurrent processes from corrupting shared state.

SECURITY-009 — PRIVACY

Document which generated files may contain:

- portfolio positions;
- account values;
- trading decisions;
- downloaded market data.

Do not commit them by default.

Create:

- `SECURITY.md`;
- `.env.example`;
- `docs/SECURITY_AND_PUBLICATION.md`.

──────────────────────────────────────────────────────────────────────────────
LICENSING AND COPYRIGHT
──────────────────────────────────────────────────────────────────────────────

The repository currently uses MIT.

Do not change the code license without a documented HUMAN_DECISION.

Audit:

- `docs/bivariate_model_paper.md`;
- `docs/multivariate_model_paper.md`;
- copied equations;
- copied tables;
- long source passages;
- converted paper content;
- citation placeholders.

Do not assume paper-derived material can be relicensed under MIT.

Unless compatible permission is established:

- replace extensive paper conversions with concise original summaries;
- remove copied tables and long passages;
- retain only implementation-relevant equations with proper attribution;
- cite and link to authoritative sources;
- state that third-party publications remain copyrighted by their respective authors or publishers.

Add:

- `CITATION.cff`;
- `THIRD_PARTY_NOTICES.md`;
- `docs/references.bib` or an equivalent references file.

Clarify that MIT applies to original repository code and original repository documentation, not to third-party papers.

──────────────────────────────────────────────────────────────────────────────
README REWRITE
──────────────────────────────────────────────────────────────────────────────

Rewrite the README to match only verified functionality.

Place a prominent status near the top:

    Experimental research software.
    Live execution is disabled.
    Validation status and known limitations are documented.
    Do not use generated output as financial advice or as an unattended order.

Remove or correct unsupported claims including:

- production-ready;
- works with any asset group;
- market-neutral without explicit constraints;
- statistically significant without testing;
- actual Gibbs sampler for an approximation;
- full warm start when incomplete;
- rank zero means independence;
- every positive rank means a tradable arbitrage relation;
- half-life based on mean absolute alpha;
- triangular normalization is equivalent to the paper’s SVD;
- memory scales only with N²;
- direct recommendations to execute trades.

Document:

- verified model scope;
- supported N and lag configurations;
- validation status;
- installation through `uv`;
- CLI usage;
- synthetic demo;
- data limitations;
- currency handling;
- posterior diagnostics;
- rank interpretation;
- long-short strategies;
- long-only benchmark overlay;
- public-repository security;
- paper-trading limitations;
- live-readiness blockers;
- authoritative references.

Every README command must be executed successfully in a clean environment before completion.

──────────────────────────────────────────────────────────────────────────────
TESTING AND CODE QUALITY
──────────────────────────────────────────────────────────────────────────────

Configure:

- `ruff format`;
- `ruff check`;
- pytest;
- sufficiently strict type checking;
- deterministic seeds;
- coverage of critical mathematical paths;
- Hypothesis/property tests where useful;
- Linux CI;
- macOS CI if reasonably inexpensive.

Tests must assert semantic correctness, not only shapes and finite values.

Required regression tests include:

1. rank-one masking preserves the learned rank component;
2. rank(Pi) equals the requested state;
3. asset-permutation invariance;
4. permitted sign invariance;
5. permitted normalization invariance;
6. cointegrating-subspace invariance;
7. simulation-smoother posterior moments;
8. exact Markov probabilities;
9. deterministic-term vectorization;
10. covariance block indexing;
11. current-price timing;
12. terminal rank differs from historical occupancy in a constructed example;
13. posterior summary differs from the final draw;
14. full VECM predictive-return sign;
15. rank-one spread sign;
16. spread output is invariant to β -> -β;
17. known-process half-life;
18. invalid half-life is rejected;
19. long-only weights are non-negative;
20. long-only weights sum to one;
21. no-signal long-only equals benchmark;
22. the long-only backtest path is genuinely used;
23. dollar-neutral means sum(weights) is zero;
24. market-neutral label is absent without verified beta neutrality;
25. basket exit unwinds or rehedges all legs;
26. execution happens after signal availability;
27. future-data mutation does not alter past results;
28. every transaction-cost mode;
29. exact portfolio P&L;
30. zero-return days remain in Sharpe;
31. open trades retain or explicitly update their spread definition;
32. no backward fill;
33. timestamps survive persistence;
34. stale observations are surfaced;
35. FX mismatch is converted or blocked;
36. model-state loading rejects pickle;
37. malformed state schemas are rejected;
38. ticker path traversal is rejected;
39. failed download cannot silently reuse stale data;
40. current rank is not historical occupancy;
41. rank N receives correct semantics;
42. broad numerical fallbacks no longer exist.

Delete tests that only certify the old erroneous implementation.

──────────────────────────────────────────────────────────────────────────────
PERFORMANCE AND MEMORY
──────────────────────────────────────────────────────────────────────────────

Create reproducible benchmarks for representative cases:

- N=2;
- N=3;
- N=6;
- short and long T;
- multiple chains;
- test draw counts;
- research draw counts.

Measure:

- wall-clock time;
- peak RAM;
- disk use;
- output size;
- storage complexity;
- major bottlenecks.

Do not optimize before the reference implementation is correct.

If a faster approximation is introduced:

- give it a different class and CLI name;
- document the approximation;
- validate it against the reference model;
- never use it silently;
- never label it the canonical paper-faithful sampler.

──────────────────────────────────────────────────────────────────────────────
LIVE-READINESS GATES
──────────────────────────────────────────────────────────────────────────────

Create:

`docs/LIVE_READINESS.md`

Keep the overall status:

NOT PASSED

Code completion must not automatically pass:

- independent econometric review;
- independent code audit;
- market-data licensing review;
- realistic execution validation;
- borrow availability validation;
- paper-trading period;
- untouched out-of-sample evidence;
- risk-budget approval;
- monitoring and alerting;
- incident response;
- kill-switch procedures;
- regulatory and tax review.

The repository may become:

- mathematically validated for tested cases;
- suitable for research;
- suitable for controlled paper trading.

It may not claim approval for real-money use.

──────────────────────────────────────────────────────────────────────────────
GIT AND COMMIT WORKFLOW
──────────────────────────────────────────────────────────────────────────────

Make small, intentional commits.

A recommended sequence is:

1. `chore: capture baseline audit and safety status`
2. `docs: define paper-aligned mathematical specification`
3. `refactor: establish canonical coinrank package`
4. `fix: implement validated simulation smoother`
5. `fix: implement paper-aligned rank parameterization`
6. `fix: correct multivariate posterior blocks`
7. `feat: add posterior storage and MCMC diagnostics`
8. `fix: rebuild data pipeline without lookahead`
9. `feat: add posterior predictive and spread strategies`
10. `feat: add benchmark-relative long-only overlay`
11. `fix: rebuild walk-forward portfolio accounting`
12. `test: add mathematical and simulation validation`
13. `security: harden public repository and CI`
14. `docs: rewrite README and validation reports`

Before every commit:

- inspect the diff;
- ensure no generated market data or secrets are staged;
- run relevant tests.

Before pushing:

- run the full fast suite;
- run the scientific suite where computationally feasible;
- run format, lint, type and security checks;
- inspect `git diff main...HEAD`;
- inspect staged and untracked files;
- rerun the secret scan.

Never squash away useful mathematical history unless explicitly requested.

──────────────────────────────────────────────────────────────────────────────
ADVERSARIAL FINAL REVIEW
──────────────────────────────────────────────────────────────────────────────

After implementation, perform a fresh review as if another team wrote the code.

1. Re-read the authoritative paper.
2. Re-check every equation-to-code mapping.
3. Independently verify dimensions and orientations.
4. Re-run exact low-dimensional reference cases.
5. Search the full repository for stale formulas and unsafe claims.
6. Search specifically for:

   allow_pickle=True
   .bfill
   except Exception
   mean(abs(alpha))
   production
   market-neutral
   statistically significant
   works with any
   actual Gibbs
   warm start
   same-close
   last posterior draw
   ignored long_only

7. Confirm no signal uses historical rank occupancy as the current rank.
8. Confirm no strategy trades rank as direction.
9. Confirm long-only is genuinely benchmark-relative.
10. Confirm backtest fills occur after signal availability.
11. Confirm all dates and currencies survive the pipeline.
12. Confirm generated reports are ignored by Git.
13. Confirm README commands work from a clean environment.
14. Run security scans again.
15. Run the complete synthetic demo.
16. Build the package.
17. Compare the implementation with `docs/PAPER_ALIGNMENT.md`.
18. Update the completion matrix with objective evidence.

Do not review only formatting or architecture. Review mathematics, inference, timing, execution and claims.

──────────────────────────────────────────────────────────────────────────────
DEFINITION OF DONE
──────────────────────────────────────────────────────────────────────────────

Do not declare completion until:

- a single canonical paper-aligned implementation exists;
- identification is derived and documented;
- rank masking is correct;
- rank(Pi) is verified;
- N>2 conditionals are mathematically derived and tested;
- the simulation smoother passes exact-reference tests;
- current, historical and predictive rank probabilities are distinct;
- posterior summaries do not use final draws as point estimates;
- multiple-chain diagnostics exist;
- rank and subspace uncertainty are reported;
- invalid half-life calculations are gone;
- rank is used as a regime gate, not direction;
- posterior-return and rank-one-spread strategies are distinct;
- spread signs are correct and β-sign invariant;
- long-only is benchmark-relative and tested;
- current positions are incorporated;
- basket-level risk controls exist;
- no same-close lookahead remains;
- exact portfolio accounting exists;
- transaction-cost modes work;
- zero-return days remain in metrics;
- nested validation and a final holdout are supported;
- backward fill is removed;
- timestamps, currencies and data provenance are retained;
- state serialization is safe;
- path traversal is blocked;
- failed downloads fail explicitly;
- full-history secret scan is completed;
- dependencies are locked and audited;
- CI passes;
- paper-derived documentation is licensing-safe;
- the README contains only supportable claims;
- live execution remains disabled;
- no implementable P0, P1 or P2 completion-matrix row remains unfinished;
- a draft PR is opened when GitHub authentication permits.

If a core mathematical component remains externally unverifiable:

- identify it precisely;
- mark the corresponding rows EXTERNAL_BLOCKER;
- disable dependent trading output;
- do not claim the framework is fully paper-faithful;
- still complete every independent requirement.

──────────────────────────────────────────────────────────────────────────────
FINAL TERMINAL COMMANDS
──────────────────────────────────────────────────────────────────────────────

Before your final response, execute all applicable commands, adapting names only to the implemented tooling:

    uv sync --all-extras --dev
    uv run ruff format --check .
    uv run ruff check .
    uv run mypy src tests
    uv run pytest tests/unit tests/mathematical tests/security -q
    uv run pytest tests/integration tests/backtest -q
    uv run coinrank validate --tier fast
    uv run coinrank validate --tier scientific
    uv run pip-audit
    uv run bandit -r src
    git status --short
    git diff --check
    git diff --stat main...HEAD

Run any repository-specific alternatives required by the final implementation.

Do not claim a command passed unless it was actually executed successfully.

If the full scientific validation is intentionally too expensive for normal CI:

- run a seeded reduced scientific suite;
- provide the command for the full suite;
- clearly distinguish executed evidence from deferred extended validation.

──────────────────────────────────────────────────────────────────────────────
DRAFT PULL REQUEST
──────────────────────────────────────────────────────────────────────────────

When the implementation is complete and `gh auth status` succeeds:

1. push the feature branch;
2. open a draft pull request;
3. do not merge it.

The PR description must include:

- original critical defects;
- mathematical source used;
- architecture changes;
- validation evidence;
- security evidence;
- breaking changes;
- remaining external blockers;
- explicit statement that live trading is disabled;
- completion-matrix counts.

──────────────────────────────────────────────────────────────────────────────
FINAL RESPONSE FORMAT
──────────────────────────────────────────────────────────────────────────────

Return a precise completion report with these sections:

1. GOAL REACHED

   State exactly what is mathematically verified, what is suitable for research and what is not approved.

2. CRITICAL DEFECTS FIXED

   Map every original audit finding to the implementation and regression test.

3. PAPER ALIGNMENT

   State the definitive publications used and point to `docs/PAPER_ALIGNMENT.md`.

4. MATHEMATICAL VALIDATION

   Report:
   - exact-reference tests;
   - simulation recovery;
   - rank recovery;
   - subspace recovery;
   - tolerances;
   - failures or warnings.

5. MCMC EVIDENCE

   Report:
   - chains;
   - warm-up;
   - retained draws;
   - R-hat;
   - ESS;
   - MCSE;
   - acceptance rates;
   - posterior predictive checks.

6. TRADING DESIGN

   Explain:
   - how rank is used;
   - how direction is obtained;
   - posterior-return strategy;
   - rank-one spread strategy;
   - long-only benchmark overlay;
   - no-trade gates;
   - basket risk;
   - why live execution remains disabled.

7. BACKTEST CORRECTNESS

   Report:
   - information timing;
   - fill timing;
   - accounting;
   - costs;
   - benchmarks;
   - leakage tests;
   - nested validation;
   - holdout policy.

8. SECURITY AND PUBLICATION

   Report:
   - secret scan;
   - dependency scan;
   - serialization safety;
   - path safety;
   - subprocess safety;
   - generated-data exclusions;
   - paper-document licensing treatment;
   - whether the branch is appropriate to remain public.

9. USER WORKFLOW

   Provide exact copy-paste commands for:
   - installation;
   - doctor;
   - synthetic validation;
   - fetching data;
   - fitting;
   - diagnostics;
   - long-short signal;
   - long-only signal;
   - backtest;
   - HTML report.

10. TEST AND TOOL RESULTS

    List every command actually executed and its result.

11. FILES AND COMMITS

    Summarize major changed files and logical commits.

12. COMPLETION MATRIX

    Give exact counts for:
    - VERIFIED;
    - EXTERNAL_BLOCKER;
    - HUMAN_DECISION.

13. GITHUB

    Provide:
    - branch;
    - final commit;
    - push status;
    - draft PR URL, or exact commands if authentication was unavailable.

14. REMAINING EXTERNAL GATES

    List only genuine external blockers or human decisions.

Do not finish with generic recommendations or a new plan. Perform the work, validate it, document it, commit it and open the draft PR where possible.
