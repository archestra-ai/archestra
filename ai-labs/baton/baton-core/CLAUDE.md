# baton-core

Prototype IFC policy engine (edition 2024, `publish = false`). Dependencies:
`tracing` (facade), `serde` (derive), `thiserror` (the two error types).
Dev-only: `tracing-subscriber`, `criterion`, `proptest`, `clap`. Concepts and
semantics live in `src/lib.rs`; this file is the invariants an edit must not
silently break.

## Two structures — never conflate them

- **Taint fold** — `dimension.rs::combine` and `Label::combine`: how
  provenance combines as turns meet. Per data dimension a commutative,
  idempotent semilattice where `Unknown` has a *definite* position (absorbing
  for audience/effects; between Trusted and Suspicious for trust). The whole
  `Label` is a **monoid** = (semilattice product) × (append-only `audit` Writer
  log), **not** a join-semilattice. The operation is `combine`; do not call it
  a join.
- **Adequacy relation** — `dimension.rs::{covers, at_least, avoids}` returning
  `Adequacy<W>` (`Holds` / `Fails(witness)` / `Unprovable`): the sink-side
  proof. Here `Unknown` is **incomparable / bottom → `Unprovable`**, the
  opposite of its fold position. Trust is the only dimension where the two
  orders disagree on `Unknown`.

`Requirements::check` is a thin *ordered* composition over the adequacy
relations — no `match` on label values, no set-difference. The emission order
(trust, audience, attention, effects) is observable; preserve it.

## Grants, lift, authorities

- `Grant` is **proposal data, not a capability**: public fields, harness-trusted
  like `Label`. Authority comes only from engine routing + fail-closed recheck,
  never from the type. Do not add authority-only constructors or treat a `Grant`
  as evidence.
- `Label::lift` is **check-transient** (never store a lifted label) and
  **monotone/inflationary in the adequacy order** (Unknown = bottom in every
  dimension). Trust-lift is a **join (max), not a replace** — it must never
  demote a Trusted context. Unknown effects stay Unknown (which is why
  `EffectsUnknown` is acknowledge-only, not grant-fixable). `confirms` is check
  *input*, not applied by `lift`.
- Authorities implement one method:
  `Authority::rule(needed, request, context, violations) -> Option<(AuthorityName, Ruling)>`.
  Name and ruling come from a **single traversal** — attribution is consistent
  by construction. A non-covering member must return `None` **before** running
  its judgement, so coverage stays decidable from the declared mandate and an
  uncovered flow blocks without consulting anyone. Compose with tuples
  (`impl Authority for (A, B)`, first-success `or_else`): **no `dyn`/`Box`**,
  `PolicyEngine<A: Authority>` stays generic.

## Engine invariants (`engine.rs`)

- Two orthogonal axes on a violation. **Fixability** (`Violation::fixability`):
  `Structural` blocks first without consulting; `GrantFixable` derives a grant;
  `AcknowledgeOnly` rides through as an acknowledgment. **Provability** (breach
  vs unprovable) drives `UnknownPolicy`, unchanged: `Deny` fails closed,
  `AllowWithAudit` audits through (`by: None`), `Escalate` routes.
- Approval = derive `needed_grant` → route by mandate → apply grant →
  **recheck fail-closed** → record. The recheck verifies **only the targeted
  grant-fixable set**; policy-audited unknowns and acknowledge-only violations
  are expected to remain — do not fail on them. A failure is
  `InternalInvariantFailed` (a control-flow check, never a `debug_assert`).
- `evaluate` never mutates the trajectory; an approval is one-shot on the
  `Permit`. Permits are linear (not `Clone`), bound to trajectory id + head;
  `Trajectory::record_result` enforces freshness. Confirmations are structural
  on user turns, never label state.
- **serde capability line**: pure data (`Label`, `Grant`, `AuditEntry`,
  contracts, dimensions and their preset algebras, violations) derives
  `Serialize + Deserialize`; `Decision`/`Permit`/`BlockReason`/`TrajectoryId`
  are `Serialize`-only. Never add `Deserialize` to `Permit` (or
  `Decision`/`TrajectoryId`): a permit has no public constructor by design, so
  deserializing one forges the linear capability, and a deserialized
  `TrajectoryId` could alias a live trajectory. `Trajectory` itself is not serde
  at all.
- `register` fails on a duplicate contract (contracts are the policy boundary);
  never silently overwrite.

## Conventions

- no `dyn`/`Box`; prefer newtypes over primitives; prefer pattern matching over
  `if`-chains. Core ops emit `tracing` events (decision path at `debug!`,
  algebra at `trace!`) — borrow-only, never behavior-changing; `demo -- -v`/`-vv`
  selects the level.
- Validate every change: `cargo test`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, `cargo run --example demo`.
- The algebra **laws** are real `proptest` properties (`combine`/`lift`/`covers`
  over generated inputs, in `src/test_strategies.rs`), not fixture loops.
  Commutativity/idempotence hold on the data dimensions only — the `audit`
  Writer log appends. Do not assert on `Display` output or doc text.
