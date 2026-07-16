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

Each dimension also carries `widening_over` — the **dual of adequacy** (is
this label strictly wider than a baseline). It powers the no-widening
invariant: effects growth binds live at the flow check; trust/audience
widening is prevented at admission by construction (the conservative fold
absorbs a wider declaration — `debug_assert`-guarded, test-pinned). It is a
third derived relation, not a third order to conflate with the two above.

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
- Effects are **monotone trajectory state**, committed at release (a
  may-effect commitment fact: failure appends and removes nothing); the
  committed past is a projection over commitment facts. Audit is
  **control-plane history** (`AuditEvent`), never a label field; failed
  transitions audit an event and create no value or action.

## The event log, revisions, linear capabilities

- The `EventSet` is the authoritative state: every public `Trajectory`
  mutation prevalidates, then appends **one atomic batch** of facts; lifecycle
  contradictions (double release, completion-before-release, double grant
  consumption) are refused at admission — the single enforcement point.
- **One build path.** Every derived read model — labels, provenance, turns,
  committed effects, audit, both pending slots — is a `TrajectoryProjection`
  of the log, rebuilt in full by `Trajectory::commit` after each batch. Never
  add a second, incremental fold over `Fact` (that is what this design
  deleted: a parallel `apply` plus a parity suite to police it, whose state
  half was tautological — it rebuilt with the same `apply` it was checking).
  Full reprojection per mutation is deliberate. Its cost is O(dependency
  edges), not O(events): `value_labels` refolds every historical value's whole
  dependency set, so a trajectory whose values cite many predecessors is cubic
  over its life, not quadratic (the old admission-time fold paid each value's
  fold once). If that ever matters, make the *one* path incremental, never add
  a second. The
  `ValueStore` holds **bodies only**: a label lives in the projection, and
  `ValueRef` composes the two for reading.
- `Revision` digests the event frontier; every appended batch advances it.
  Plans live in a side cache bound to their basis and append nothing — the
  per-evaluation `CheckPerformed` fact is what preserves cross-evaluate
  staling.
- Capabilities — `ExecutionToken`, `DispatchReceipt`, `StepCapability`,
  `PendingApproval` — are **non-`Clone`, `Serialize`-only, no public
  constructor**, spent on use. All but the receipt bind trajectory + revision
  (+ action/plan/step); a `DispatchReceipt` is deliberately lifecycle-bound
  instead (trajectory + action in Released phase) — it records a dispatch
  that already happened, so unrelated later mutations must not wedge the
  action. Plans, step capabilities, and pending approvals additionally bind the
  `EngineId` whose registries produced them — a capability never resolves
  against another engine's registries. Never add `Deserialize`: deserializing
  one forges the linearity. `Trajectory` itself is not serde at all.
- Two-phase dispatch: `release` commits may-effects, spends any pending
  confirmation, renders the **one** canonical request from the exact checked
  tree, and mints the receipt; `record_output`/`record_failure` consume the
  receipt and close the action. There is deliberately no one-call shortcut
  that skips the canonical request — do not add one. Binding failures
  (stale/foreign) refuse *without* touching state; the capability is consumed
  either way. Receipts are lifecycle-bound, not revision-bound: a receipt
  closes a dispatch that already happened, so unrelated mutations after
  release (a checked emission, a new value) never wedge the released action —
  only foreign, wrong-action, or already-closed receipts refuse. Tokens,
  step capabilities, and approvals authorize *future* changes and stay
  revision-bound. The pending action's (possibly constrained) proposed effects
  are the single source of truth for what release commits.
- Confirmation stays structural on user turns; it survives remedy steps on
  the confirmed action and is spent atomically at release as a grant
  consumption fact (facts only grow, so a receipt-declared failure cannot
  resurrect a spent confirmation). One-off (`PolicyCheck`-scoped) grants
  follow the same issued/consumed model — a second consumption is
  unrepresentable at admission.

## Pending action, plans, remedies

- At most one `PendingAction`; it keeps the **immutable original** proposal
  (identity basis for idempotent re-entry) and the **current** constrained
  form (what is checked and dispatched). A different proposal while one is
  pending is refused, never queued. Terminal blocks clear the slot;
  remediable blocks keep it.
- Every checked flow — a tool dispatch or an assistant emission — settles in
  one tri-state `FlowOutcome`: `AllowedNow(permit)`, `Remediable` (carrying a
  `NonEmptyVec<RemedyPlan>` — "remediable with zero plans" is
  unrepresentable), or `Terminal`. Invalid, stale, foreign, or conflicting
  proposals are `FlowRefusal`s on a separate channel, outside the tri-state,
  touching no state. The two pending slots (action, emission) are
  independent and per-kind single-slot; a blocked emission never clears a
  pending action. Plans are predictions, not permits: plain serializable
  data, revision-bound, recomputed after every applied step; each step is a
  `PlannedRemedy` (the remedy plus its competent routes and the violations
  the authority is shown), and applying any remedy triggers the full
  re-evaluation as an execution invariant, never a plan-step object.
- The two-kind remedy vocabulary enforces conservation laws. **Reduce**
  answers to registered reduction relations: a value derivation
  (`ReductionTarget::DeriveValue`) cannot touch actions or past effects and
  wears its transformer's declared output label; an action narrowing
  (`ReductionTarget::NarrowAction`) goes only through registered
  tool-identity mappings verified never wider (`ActionTransition::narrows` —
  subset or unknown-confinement; the target contract must declare exactly
  the transition's effects and must not widen the resolved recipient set —
  the PoC's structural relation covers tool identity, effects, and recipient
  roles; egress-destination and runtime-capability sets are not modeled).
  **Authorize** grants an exact `AuthorizationDelta` at an exact
  `AuthorizationScope`: a check-scoped lift (excepting a prior effect,
  standing in for a confirmation, releasing a control dep, acknowledging an
  unprovable fact) changes no stored state; a durable raise
  (`AuthorizationScope::DerivedValue`) mints a *new* value like a transform —
  the authority raises `source`'s label with the raise helpers
  (`raised_to`/`admitting`, never `combine`), and the new value carries the
  raised label under `Provenance::Endorsed`, the source untouched. So raising
  trust or audience is durable and scoped to the derived value, never a
  check-transient lift. An `Authorization` is proposal data, not a
  capability; a product delta carries every atomic coordinate it asks for,
  so `AuthorityMandate::authorizes` requires `acknowledge_unknown` to clear
  an unknown even when the lift coordinates alone are covered. Authority
  comes from competence routing + the fail-closed recheck
  (`PostconditionFailed`, or a re-evaluation that re-routes the residual,
  blocks rather than permitting an under-covered flow).
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
  applying its step would change which authority rules it. The rule is
  mechanical: the first evaluation freezes the registries, and any later
  registration is refused (`RegistryFrozen`).
- Transformers are plain `fn` pointers (`TransformerFn`) beside a
  serializable descriptor. No capturing closures, no `dyn`/`Box` in engine
  state.

## Conventions

- No `dyn`/`Box`; newtypes over primitives; pattern matching over if-chains.
  Core ops emit `tracing` events (decision path at `debug!`, algebra at
  `trace!`) — borrow-only, never behavior-changing; `baton-gateway -- -v`/`-vv`
  (in `../baton-proxy`) selects the level.
- Validate every change: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`.
- The algebra **laws** are real `proptest` properties
  (`src/test_strategies.rs`), not fixture loops. Do not assert on `Display`
  output or doc text; behavior tests assert typed values.
