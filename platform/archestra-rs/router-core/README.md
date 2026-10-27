# router-core

Internal design notes for engineers working on auto routing.

`router_core` picks a model tier (fast, normal, smart) for each new agent session so that
the organization's expected spend stays at its daily budget while the expected value of the
chosen tiers is as high as possible. It is pure Rust with no Node dependency. `router-rs` is
a thin NAPI adapter that exchanges JSON strings with the backend
(`platform/backend/src/auto-routing`).

Two calls make up the public API:

- `plan(PlanInput) -> Plan` fits the models on recent history and solves the budget problem.
  The backend runs it off the request path (on a settings change, nightly, or on manual
  re-plan) and stores the result in `routing_plans`.
- `decide(&Plan, &Policy, &SessionFeatures, u) -> Decision` routes one session. It is cheap
  and deterministic given `u`, which the caller draws once per session.

## Architecture

```text
pre-run signals ─┐
budget inputs ───┼─> estimate (value, cost per tier) ─> allocate (hull, λ, q) ─> Decision
post-run signals ┘   (later: calibration, learning)
```

### Inputs

1. **Pre-run signals.** What we know about a session before its first model call. Today this
   is one scorer reading of the opening user message: `tier_needed`, a distribution over the
   weakest adequate tier, and `p_long`, the chance the session crosses the long-context
   threshold. The session's `source` (client) comes from request metadata. The backend stores each signal source's reading under its id and version in
   `routing_decisions.features.signals`, and `routerFeatures` flattens them into
   `SessionFeatures`.
2. **Budget constraints.** Tier prices (short- and long-context blocks, four token types each),
   the daily budget `B`, and daily volume (`Volume::Flat { sessions_per_day, tokens_per_day }`).
3. **Post-run signals.** Not used yet. Realized token usage per request is already recorded in
   `routing_usage`. Outcome signals will go to a separate table (see Extension seams).

### Estimate

Every history row carries a session weight `v_i`: 1 for an observed session, the inverse
inclusion probability for one scored from a sample of past traffic. Each fit, the token mix and
the allocation below count a row as `v_i` copies of it.

For each session `i` and tier `k`:

- **Size** `s_i` (expected tokens): a Poisson GLM,
  `log E[s / 1e6] = b0 + effect(source) + b_p · p_long + b_n · tier_needed_normal + b_s · tier_needed_smart`.
  Fast is the `tier_needed` reference level, since the three probabilities sum to 1. The tier
  terms matter because the allocator upgrades sessions by `tier_needed`: without them, the
  upgraded sessions' sizes are biased and so is the spend they are planned at. Sources outside the most frequent
  `MAX_FIT_SOURCES`, and sources never seen in training, use the baseline's zero effect. The
  fit is L2-penalized Newton with step halving. Each Newton step is solved as a weighted
  least-squares problem, not by forming the Hessian.
- **Long share** `ℓ_i`: the token-weighted share of tokens in long prompts. It is a clipped
  linear model on `[1, log s_i]`, fitted by weighted least squares.
- **Price** `π_ik` (USD per token): the tier's prices weighted by the historical token mix
  (input, cache read, cache write, output) of each block, blended as
  `π_ik = (1 − ℓ_i) · short_k + ℓ_i · long_k`.
- **Value** `a_ik = P(tier k is adequate) = Σ_{j ≤ k} tier_needed_j`.

The expected cost of serving session `i` on tier `k` is `c_ik = s_i · π_ik` USD.

Both fits share one solver: Householder QR (nalgebra) of the √weight-scaled design, with
columns in priority order. A column whose part independent of the earlier columns is at most
`1e-5` of the largest such part counts as dependent and gets coefficient 0. This drops
zero-variance and (near-)collinear regressors, e.g. a near-constant log size, instead of
fitting them as a huge offsetting pair.

### Allocate

The budget problem is a multiple-choice knapsack: each session gets exactly one tier, and the
spend summed over a day must stay within `B`. We solve its LP relaxation exactly, over the
history sessions reweighted to daily volume, with `w_i = T · v_i s_i / Σ v s` tokens per day for
`T = tokens_per_day`:

```text
max  Σ_i (w_i / T) Σ_k x_ik a_ik
s.t. Σ_i w_i Σ_k x_ik π_ik ≤ B,   Σ_k x_ik = 1,   x ≥ 0
```

1. **Hull.** For each session, drop dominated tiers and keep the upper concave hull of its
   `(π_ik, a_ik)` points. Moving one vertex up the hull is an upgrade with breakpoint
   `Δa / Δπ`. Breakpoints strictly decrease along the hull.
2. **λ\*.** Start everyone on their cheapest vertex. Take upgrades in order of descending
   breakpoint until the next group of equal breakpoints would overshoot `B`. That group's
   breakpoint is `λ*`. If the budget affords every upgrade, `λ* = 0`.
3. **Tie fraction q.** The tied group is taken with probability
   `q = (B − spend before the group) / cost of the group`, so expected spend equals `B`
   exactly. Sessions with identical features share their breakpoints, so a tie can cover
   many sessions.
4. **Route.** A session takes every upgrade with breakpoint `> λ`. It takes the upgrade with
   breakpoint `= λ` if `u < q`. Its **propensity** is 1, `q` or `1 − q`.

The dual has a direct reading. `λ*` is the value per USD of the marginal upgrade, in units of
size-weighted adequacy per (USD per token × daily tokens). The shadow price of the budget is

```text
dV/dB = λ* / T
```

This is the value gained per extra USD/day of budget, reported as `summary.value_per_usd`.
The same rule written per session is `argmax_k (a_ik − λ · π_ik)`: a bid-price control with
one price.

`decide` reuses the estimator code that `plan` uses, so a session with history-identical
features gets bit-identical breakpoints and the tie test `breakpoint == λ*` is exact.
`serde_json` with `float_roundtrip` keeps this true across the stored JSON.

### Decision

`Decision { tier_index, propensity, lambda, expected_cost_usd }`. `lambda` is the λ the
session was routed with. `expected_cost_usd` is `s_i · π_ik` for the chosen tier: the cost
the solver counts for this session. The backend stores both on `routing_decisions` for
planned decisions. They are null for `cold_start`, `scorer_error` and `plan_stale`.

## Plan contract and versioning

A `Plan` is self-contained JSON with these fields:

- `versions`: `plan_format_version` (`PLAN_FORMAT_VERSION`) and `core_version` (crate version).
- `tiers_fingerprint`: the tier trio and prices the plan was solved for. `decide` reads prices
  from here, and the backend compares it with the live trio first. A mismatch routes to
  normal as `plan_stale` and requests a re-plan.
- `size_model` (tagged enum), `long_share`, `token_mix`: the fitted estimators.
- `policy`: the plan's anchor `{ lam_star, q }`.
- `summary` (expected spend, value, tier shares, `value_per_usd`) and `diagnostics` (a size
  model holdout on the last 10 days).

The rules:

- `decide` rejects any other `plan_format_version`, as well as non-finite estimator or policy
  fields. Plans are otherwise trusted, since they come from `plan`.
- Bump `PLAN_FORMAT_VERSION` for any change that alters how a stored plan is read or routed.
  An old plan then fails as `plan_stale` and the next fit replaces it.
- Adding a variant to a tagged enum (`SizeModel`, `Volume`) is backward compatible for
  reading, but a plan using the new variant needs a binary that knows it.
- The backend fences plans by scorer version (`scorerVersionId`). Features from another scorer
  version cold-start instead of being routed by a plan fitted on different signals.

## Extension seams

These are in place, so the next steps do not need contract changes.

- **`Volume` enum** (`kind: "flat"`). A seasonal profile is a new variant.
- **`SizeModel` enum** (`kind: "poisson_glm"`). An overdispersed or quantile model is a new
  variant. `predict` and `coefficients` are its only touch points.
- **Caller-supplied policy.** `decide` takes `Policy` separately from `plan.policy`, and the
  `Decision` reports the λ used. A pacing controller passes `λ_t` without re-solving. The
  backend's `anchorPolicy` is the single place that chooses the policy today.
- **Segment index.** `routing_decisions` is unique on `(organization_id, session_key,
  segment)`, with `segment = 0`. A mid-session switch writes segment 1, 2, … with its own
  decision and propensity.
- **Keyed pre-run signals.** `features.signals` maps source id to `{ version, … }`, so an
  additional signal (e.g. an embedding neighbour score) is a new key and a new source version,
  not a schema change.
- **Post-run outcomes.** These will go to
  `routing_outcomes(decision_id, source, source_version, kind, value, observed_at)`, joined to
  decisions by id. Each decision's `propensity`, `u`, `lambda` and `expected_cost_usd` make it
  usable for evaluation and budget backtests.

## Later

The list is ranked. Each item gives its prerequisite.

1. **Online λ pacing.** Build an hourly spend plan `ρ_h` from history. Every few minutes,
   update `λ_t ← clip(λ_t + η · (committed_h − ρ_h) / ρ_h)`, anchored on and rate-limited
   around the nightly `λ*`, with a hard daily guard as a separate loop. Committed spend is the
   sum of `expected_cost_usd` over new sessions. *Prereq:* in place (caller policy, logged λ
   and expected cost). Next comes a controller state row per organization.
2. **Budget-error backtest diagnostics.** Compare predicted spend (`Σ expected_cost_usd`)
   with realized spend (from `routing_usage` at plan prices) per day and per tier, and
   surface the error with the plan. *Prereq:* both columns exist. This needs a few weeks of
   planned traffic.
3. **Post-run signals and the outcome table.** Create `routing_outcomes`, plus the first
   surrogates (cancel or interruption, manual model override, user pushback). Validate them
   within task type before trusting them. *Prereq:* the table and a labeled sample.
4. **Exploration and off-policy learning.** Explicitly deferred. v0 is for ops people who need
   predictable spend. The current propensities are deterministic away from ties, so they only
   support evaluating policies that agree with the logger. Learning would need a designed,
   budget-capped exploration band between adjacent tiers. *Prereq:* items 3 and 1 (budget-split
   arms, not a shared budget).
5. **Overdispersed size model and p90 guard.** Same-task session sizes vary by an order of
   magnitude, so a Poisson fit understates the variance that pacing has to absorb. Add a
   negative-binomial or quantile `SizeModel` variant and put a p90 margin on the guard.
   *Prereq:* item 1's guard.
6. **Per-organization calibration of scorer probabilities.** Fit isotonic recalibration of
   `tier_needed` at each re-plan, and check it near the λ decision boundary, not only
   globally. *Prereq:* outcomes from item 3.
7. **Mid-session downshift at cache expiry.** Once the prompt cache is cold, moving down a
   tier costs little. *Prereq:* the segment index (in place), inter-request gap logging, and a
   branched-rollout evaluation harness.
8. **Embeddings as signals.** Add a first-prompt embedding neighbour score as a keyed pre-run
   signal. Expect little gain over the scorer. *Prereq:* keyed signals (in place), and a
   holdout that compares against a tier-share-matched random baseline.
9. **Seasonal Volume.** Start with an hour-of-week volume profile shrunk toward the flat
   average, so thin hours do not swing the plan. Later, decompose with MSTL at periods 24 and
   168 (`augurs-mstl`) and forecast with `augurs-ets`, which already builds on nalgebra. Both
   need an hourly volume rollup table that outlives the 35-day fit window. *Prereq:* the
   `Volume` enum (in place). It feeds item 1's spend plan.
10. **Bandit algorithms.** What item 4 needs once exploration is allowed:
    - an online ridge regression oracle, with LinUCB or linear Thompson sampling on top, kept
      current by rank-1 Cholesky updates, and an RNG seeded by the caller so `decide` stays
      deterministic;
    - for Thompson sampling, a Monte-Carlo estimate of the propensity, logged for off-policy
      evaluation;
    - IPS, SNIPS and doubly robust estimators for that evaluation;
    - isotonic or Platt calibration of scorer probabilities (item 6);
    - a negative-binomial GLM or quantile model for the p90 guard (item 5);
    - PCA or random projection to bring embeddings (item 8) down to 64 dimensions or fewer.

    `decide` must stay at microseconds, so `plan` precomputes this state into the plan.

## References

The core papers behind the design. Preprints are marked.

- *The Best of Many Worlds: Dual Mirror Descent for Online Allocation* (2020, Operations
  Research, doi 10.1287/opre.2021.2242). The standard route from an offline λ\* to an online
  dual update with regret guarantees.
- *Optimal Spend Rate Estimation and Pacing for Ad Campaigns with Budgets* (2022, arXiv
  2202.05881, preprint). Offline multiplier, per-episode spend plan and online tracking:
  almost exactly our pacing plan.
- *A Practical Guide to Budget Pacing Algorithms in Digital Advertising* (2025, arXiv
  2503.06942, preprint). Engineering of dual pacing: step sizes, cadence, guardrails, replay
  cold start.
- *Smart Fast Finish* (2025, doi 10.1145/3774905.3794691). Delayed attribution causes
  overspend. One-way updates avoid controller feedback loops. This is the sticky-session
  analogue.
- *An Analysis of Bid-Price Controls for Network Revenue Management* (1998, Management
  Science, doi 10.1287/MNSC.44.11.1577). Constant bid prices are asymptotically optimal,
  which supports one daily λ\*.
- *A Re-Solving Heuristic with Uniformly Bounded Loss* (2018, Management Science, doi
  10.1287/mnsc.2019.3365). Frequent re-solves near degeneracy hurt. Threshold fractional
  allocations instead.
- *DCAF: A Dynamic Computation Allocation Framework for Online Serving System* (2020, arXiv
  2006.09684, preprint). The same argmax-minus-λ·cost rule for compute, with a separate
  safety cap.
- *Contextual Bandits with Packing and Covering Constraints: A Modular Lagrangian Approach via
  Regression* (2022, arXiv 2211.07484, preprint). A path to learning with budgets on top of
  linear regression oracles.
- *Off-policy Bandits with Deficient Support* (2020, KDD, doi 10.1145/3394486.3403139). Why
  deterministic logging only supports evaluation where policies agree.
- *Optimizing the tie-breaker regression discontinuity design* (2018, EJS, doi
  10.1214/20-ejs1765). How wide a randomization band around the cutoff should be.
- *Randomization and the Pernicious Effects of Limited Budgets on Auction Experiments* (2016,
  arXiv 1605.09171, preprint). A/B tests inside a shared budget are biased.
- *Trustworthy Online Marketplace Experimentation with Budget-split Design* (2020, arXiv
  2012.08724, preprint). Budget-split arms as the fix.
- *Task- and Session-Level Model Routing* (2026, arXiv 2608.14641, preprint). Session-level
  routers rarely beat a tier-share-matched random baseline. Use it as the evaluation baseline.
- *Dynamic LLM Routers are Often Misguided* (2026, arXiv 2610.02762, preprint). Value-minus-cost
  routing under-escalates hard queries and tracks length.
- *Evaluating Escalation Signals: Five Ways to Fool Yourself* (2026, arXiv 2610.07354,
  preprint). "Cheap tier is wrong" is not "escalation helps". These are the pitfalls in our
  value signal.
- *The Handoff Tax: Continuing Non-Native Trajectories in LLM Agents* (2026, arXiv 2608.24358,
  preprint). Escalating with the raw transcript is costly. Downshift is a good middle point.
- *How Do AI Agents Spend Your Money?* (2026, arXiv 2604.22750, preprint). Agent sessions are
  about 99% input tokens with heavy-tailed size. This motivates item 5.
- *TurnCost: Cache-Aware Loop Engineering for Coding Agents* (2026, doi
  10.1145/3843779.3844635). Cache hits dominate input. Delegating to a cheaper model can raise
  cost.
