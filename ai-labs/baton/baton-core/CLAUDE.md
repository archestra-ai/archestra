# baton-core

Prototype value-granular IFC policy engine (edition 2024, `publish = false`).
Dependencies: `tracing` (facade), `serde` (derive), `thiserror` (error types).
Dev-only: `tracing-subscriber`, `criterion`, `proptest`, `clap`. Concepts and
semantics live in `src/lib.rs`; the plan-of-record in
`../baton-authority-model-design.md` (with `../baton-declassifier-design.md`
as the foundation rationale it builds on); this file is the invariants an edit
must not silently break.

## Two structures — never conflate them

- **Taint fold** — `dimension.rs::combine` and `ValueLabel::combine`: how
  provenance combines. Per dimension a commutative, idempotent semilattice
  where `Unknown` has a *definite* position (absorbing for audience/effects;
  between Trusted and Suspicious for trust). The operation is `combine`; do
  not call it a join.
- **Adequacy relation** — `dimension.rs::{covers, at_least, avoids}` returning
  `Adequacy<W>` (`Holds` / `Fails(witness)` / `Unprovable`): the sink-side
  proof. Here `Unknown` is **incomparable / bottom → `Unprovable`**, the
  opposite of its fold position. Trust is the only dimension where the two
  orders disagree on `Unknown`.

`Requirements::check_flow` is a thin *ordered* composition over the adequacy
relations — the emission order (trust, audience, attention, effects) is
observable; preserve it (there is a typed-order test).

## Values, flows, admission

- Values are **immutable**: body, label, and provenance fixed at admission. A
  transformer derives a *new* value; nothing mutates or relabels a source.
- Checks fold **exactly a flow's dependencies**:
  `L_flow = combine(L_args, L_control)` from the request's argument-tree
  leaves plus its mandatory control set — never the whole trajectory.
  Requests carry control *dependency sets*, never a caller-supplied control
  label (that would be a relabeling hole).
- **Admission is engine-owned.** `Trajectory::ingress` is the only
  caller-labeled path (the explicit trust boundary). Model outputs fold their
  mandatory read+control sets; tool outputs fold
  `combine(intrinsic, args, control)` where the contract's intrinsic label can
  only worsen the fold; only a validated transformer admission may sit below
  the conservative fold, and only under its *declared* output label.
  `ValueStore` mutators stay `pub(crate)` — never add a public
  `insert(bytes, label)`.
- Effects are **monotone trajectory state** (`TrajectoryState::past_effects`),
  committed at release (may-effects: failure removes nothing). Audit is
  **control-plane history** (`AuditEvent`), never a label field; failed
  transitions audit an event and create no value or action.

## Revisions and linear capabilities

- Every public `Trajectory` mutation advances `Revision` exactly once, as one
  transaction. Overflow fails loudly (no wrap).
- Capabilities — `ExecutionToken`, `DispatchReceipt`, `StepCapability`,
  `PendingApproval` — are **non-`Clone`, `Serialize`-only, no public
  constructor**, bound to trajectory + revision (+ action/plan/step), spent on
  use. Plans, step capabilities, and pending approvals additionally bind the
  `EngineId` whose registries produced them — a capability never resolves
  against another engine's registries. Never add `Deserialize`: deserializing
  one forges the linearity. `Trajectory` itself is not serde at all.
- Two-phase dispatch: `release` commits may-effects, spends any pending
  confirmation, renders the **one** canonical request from the exact checked
  tree, and mints the receipt; `record_output`/`record_failure` consume the
  receipt and close the action. There is deliberately no one-call shortcut
  that skips the canonical request — do not add one. Binding failures
  (stale/foreign) refuse *without* touching state; the capability is consumed
  either way. The pending action's (possibly constrained) proposed effects
  are the single source of truth for what release commits.
- Confirmation stays structural on user turns; it survives remedy steps on
  the confirmed action and is spent atomically at release (the
  spent-confirmation marker exists so a receipt-declared failure cannot
  resurrect it).

## Pending action, plans, remedies

- At most one `PendingAction`; it keeps the **immutable original** proposal
  (identity basis for idempotent re-entry) and the **current** constrained
  form (what is checked and dispatched). A different proposal while one is
  pending is refused, never queued. Terminal blocks clear the slot;
  remediable blocks keep it.
- `Blocked::Terminal` is an explicit type; `Blocked::Remediable` carries a
  `NonEmptyVec<RemedyPlan>` — "remediable with zero plans" is
  unrepresentable. Plans are predictions, not permits: plain serializable
  data, revision-bound, recomputed after every applied step.
- The closed `TransitionKind` variants enforce conservation laws: transforms
  cannot touch actions or past effects; constraints go only through
  registered tool-identity mappings verified never wider
  (`ActionTransition::narrows` — subset or unknown-confinement; the target
  contract must declare exactly the transition's effects and must not widen
  the resolved recipient set — the PoC's structural relation covers tool
  identity, effects, and recipient roles; egress-destination and
  runtime-capability sets are not modeled); a **transient waiver** changes no
  stored state — a check-transient lift (`waiving` a prior effect, standing in
  for a confirmation, excluding a control dep) plus an audit record. A
  **fiat relabel** (`EndorseValue`), by contrast, mints a *durable* value like a
  transform: an authority raises `source`'s label with the raise helpers
  (`raised_to`/`admitting`, never `combine`), and a new value carries the raised
  label under `Provenance::Endorsed` — the source is untouched. So raising trust
  or audience is a relabel, not a waiver; a waiver never raises trust or
  audience. A `TransientWaiver` is proposal data, not a capability; the
  `ProposedGrant` an authority rules on carries both the lift and any
  acknowledge-only facts it clears, so `AuthorityMandate::covers` requires
  `acknowledge_unknown` to clear an unknown even when the lift dimensions alone
  are covered. Authority comes from competence routing + the fail-closed recheck
  (`PostconditionFailed`, or a re-evaluation that re-routes the residual, blocks
  rather than permitting an under-covered flow).
- Registration is an operator trust decision, not content correctness: audit
  wording says "admitted under the transition declared by registered
  transformer X", never "verified as clean". Registries are populated at
  construction, duplicates refused, never silently replaced. Authorities
  (`Authority { name, mandate, mode: Inline(fn) | External }`) share one
  registry and name space; a grant routes to competent authorities inline-first
  then external, each in registration order, and an inline abstention (`None`)
  falls through to the next competent authority. Routing is resolved **live at
  application** against the current registry (a minted plan no longer pins its
  authority), so the construction-time-only rule is load-bearing for *safety*,
  not merely determinism: registering an authority between minting a plan and
  applying its step would change which authority rules it. Do not mutate the
  registry after the first evaluation.
- Transformers are plain `fn` pointers (`TransformerFn`) beside a
  serializable descriptor. No capturing closures, no `dyn`/`Box` in engine
  state.

## Conventions

- No `dyn`/`Box`; newtypes over primitives; pattern matching over if-chains.
  Core ops emit `tracing` events (decision path at `debug!`, algebra at
  `trace!`) — borrow-only, never behavior-changing; `demo -- -v`/`-vv`
  selects the level.
- Validate every change: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, `cargo run --example demo`.
- The algebra **laws** are real `proptest` properties
  (`src/test_strategies.rs`), not fixture loops. Do not assert on `Display`
  output or doc text; behavior tests assert typed values.
