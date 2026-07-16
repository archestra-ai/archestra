# baton-core: compact architecture — plan-of-record

**Status:** implemented. This is the **single plan-of-record** for the whole
project: the model as built, the standing decisions that shaped it, and the
decisions it superseded (kept legible in §4 — a plan-of-record does not erase
its history). It supersedes the relevant sections of
`baton-declassifier-design.md` (which remains the value-granular foundation
rationale). The normative integration spec is `docs/spec.md`; concepts and
semantics live in `baton-core/src/lib.rs`.

---

## 1. The model

1. **One invariant.** Any move that is not "downhill" is soft-banned and cleared
   only by an explicit, audited elevation routed to a registered authority.
   **No implicit accept anywhere.** Permissiveness is config (which authorities
   and reducers are registered), never engine behavior.

2. **One outcome shape.** Every well-formed flow proposal — a tool dispatch or
   an assistant emission, checked by the same pipeline — settles in exactly one
   policy outcome:
   - **Allowed now** (`FlowOutcome::AllowedNow(permit)`): the checked flow
     satisfies policy; the permit is linear and basis-bound.
   - **Remediable** (`FlowOutcome::Remediable`): a soft block carrying a
     `NonEmptyVec<RemedyPlan>` — "remediable with zero plans" is
     unrepresentable.
   - **Terminal** (`FlowOutcome::Terminal`): a **proven** claim that no remedy
     exists under the current policy and registered capabilities. The search is
     complete (no caps), so Terminal is never "nothing found within a budget".

   Invalid, stale, foreign, or conflicting proposals are `FlowRefusal`s on a
   separate channel, outside the tri-state, touching no state. `NeedsApproval`,
   remedy failure, and remedy stall are continuations within a remediable flow.
   Core never infers that a turn is "final": the caller presents an emission to
   the sink (`EmissionRequest` → the reserved `assistant.response` sink), and
   caller-labeled assistant ingress does not typecheck (`Speaker` is user-only).

3. **Two remedy kinds.** A plan step (`PlannedRemedy`) is either:
   - **Reduce** (`ReductionTarget::DeriveValue | NarrowAction`): change the flow
     so it fits — derive a value through a registered transformer under its
     declared output label, or narrow the pending action through a registered
     `ActionTransition` verified never wider (`narrows`: subset or
     unknown-confinement; the target contract declares exactly the transition's
     effects; recipients never widen). Every reducer answers to a registered,
     validated reduction relation — fewer arguments or changed bytes are never
     inherently safer.
   - **Authorize** (`Authorization { delta, scope }` plus the competent
     `routes` and the `targets` shown to the authority — the projected residual
     it is asked to clear): grant the irreducible residual.
     `AuthorizationDelta` is a canonical product of atomic `DeltaCoordinate`s
     (raise label / acquire effects / except prior effects / stand in for
     confirmation / release control / acknowledge unknown; one coordinate per
     kind; no-op coordinates unrepresentable — `Authorization::new` validates).
     `AuthorizationScope` makes durability explicit: `DerivedValue` (durable —
     mints a new value under the raised label via `raised_to`/`admitting`,
     never `combine`; the immutable source untouched; `Provenance::Endorsed`),
     `PendingAction` (an acquired effect growth that still commits only at
     release), `PolicyCheck` (one check of one flow — issued and consumed as
     grant facts, so a one-off can never be spent twice). Scope–coordinate
     compatibility is enforced at construction.

4. **Plans are predictions, never permits.** `RemedyPlan { id, flow, steps,
   basis, engine }`. Only the head step is executable (`mint_step`/`apply_step`
   refuse any index > 0 with `NotNextStep`); applying any remedy triggers the
   full re-evaluation as an execution invariant, which re-plans the remainder.
   Plans live in a side cache bound to their basis and append nothing.

5. **Complete search, irreducible frontier.** Plan generation is an exhaustive
   reachable-flow-state search (multiple transformed leaves, chained action
   transitions; visited-state dedup over per-leaf labels × tool × effects
   terminates it), with durable raises peeled one leaf at a time and the
   projection re-derived after each (a single raise can re-mask remaining
   `Unknown`s in the min-fold; a batch would over-endorse), plus the
   joint-release rescue search (streaming cardinality-ordered subsets — no
   width or count caps; the exponential worst case is an accepted prototype
   trade, documented at the search site). Ordinary and rescue candidates share
   one dominance pool. Every returned plan is irreducible (removing any step
   breaks the predicted unlock — replay-checked), and the returned set is the
   nondominated frontier: plans are comparable only when they predict the same
   resulting flow (derivation identity — source + transformer + declared
   output — never runtime bytes); asks compare per atomic (delta, scope)
   coordinate (absent < present; trust by level; sets by inclusion; scopes
   `PolicyCheck < PendingAction < DerivedValue`); ≤ everywhere and < somewhere
   → dominated; incomparable alternatives are all retained; serialization is
   deterministic (fewest steps first). One refinement vs. the letter of the
   compact notes: the rescue frontier returns all incomparable releases of the
   **first successful cardinality** — full inclusion-minimal enumeration across
   sizes would forfeit early exit and go exponential even when a one-value
   release exists; the Terminal proof still performs the complete sweep when
   nothing succeeds.

6. **Append-only algebraic state.** The trajectory is an `EventSet` of scoped
   facts (`Event { subject, fact, scope, issuer, basis }`); one public mutation
   = prevalidation + one atomic batch; lifecycle contradictions (a second
   release, a completion before release, a second consumption of a grant) are
   refused at admission — the single enforcement point. Labels, effects,
   action/emission lifecycle, grant availability, confirmation, provenance,
   turns, and audit are **projections** — one build path, reprojected from the
   log after each batch, so there is no second representation to drift. `Revision` is the digest of the event frontier;
   permits, plans, and approvals bind to it, so any appended fact stales
   everything minted before it. Release appends the may-effect commitment
   before dispatch; failure appends and removes nothing.

7. **Generalized no-widening.** Each dimension carries a widening relation
   (`widening_over`, the dual of adequacy). A declared output label wider than
   the causal input fold is a violation remediable only by an explicit
   Authorize; effects growth is the effects-axis instance (the former
   criterion-(1) surface-growth check, now behind the dimension interface).
   Trust and audience widening are prevented at admission by construction —
   `admit_tool_output` folds the declared intrinsic with the dependency fold,
   which absorbs any wider declaration; the relation guards that invariant as a
   `debug_assert` plus tests (a laundering contract still blocks at the sink
   and is remediable only by the exact raise).

## 2. Standing decisions (survive from the previous plan-of-record)

- **D2 — control release: concrete set on the request, capability on the
  mandate.** The applied `ReleaseControl` coordinate carries
  `BTreeSet<ValueId>` (least-privilege, per-conversation); the mandate carries
  the trajectory-independent `may_release_control` capability.
- **D3 — robustness is engine-exposed, not engine-enforced.** The authority
  sees the transitive provenance/ancestry context (borrowed `TrajectoryView`
  inline; owned `AncestrySnapshot` across the external approval boundary) and
  makes the judgment; a reckless approve-all is the deployment's audited
  choice.
- **D4 — control release is least-privilege.** Scoped to the named deps;
  releasing dep A never releases dep B; `SimFlow` attributes breaches to
  individual control deps (per-dep labels, never a pre-folded aggregate), and
  arg-borne taint is never released via control.
- **M1 — durable raises target argument-tree values only.** A confidentiality
  breach carried by a control dependency clears via `ReleaseControl` (needing
  `may_release_control`), never by raising the control value's label.
- **Acknowledge routing.** Acknowledgment routes on the explicit
  `acknowledge_unknown` competence (an empty ask must not be covered by every
  mandate); inline abstention falls through; denial is decisive; a lift
  coordinate cannot launder an unknown (the product delta carries the
  acknowledged facts, and competence requires every coordinate).
- **Live routing.** A plan's `routes` are prediction metadata; application
  resolves the authority live against the current registry — which is why the
  registries-fixed-before-first-evaluation rule is load-bearing for safety,
  not merely determinism.
- **Fail-closed recheck.** Every grant application re-evaluates the original
  flow; a recheck that no longer clears blocks or re-plans — an under-covered
  flow is never permitted.
- **Acquisition semantics.** `AcquireEffects` authorizes growth on the pending
  action; the effect commits to the past only at release; abandoning commits
  nothing; "first egress soft-bans, second is downhill" comes from the release
  commit, never an early one.
- **Composition is least-privilege and per-axis.** Reductions first (a
  derivation shrinks the data taint, a narrowing shrinks the tool effects),
  then only the irreducible residual routes to authorization —
  NarrowAction↔AcquireEffects on the effect axis, DeriveValue↔RaiseLabel on
  the confidentiality axis; across axes, steps compose additively.
- **Reducer/authorization honesty.** Every non-downhill flow names its
  authorizer: an `Authority` for Authorize steps, a registered
  transformer/transition for Reduce steps (registration is a distinct, audited
  authorization root; it does not become an `Authority`).
- **Prediction artifact (not a defect).** A derive-then-raise plan serializes
  the raise's `source` as the pre-derivation leaf id; application re-ids the
  value and the recheck re-plans, so a stale downstream `source` is never
  applied — a display artifact of the shared simulation, not an unsafe path.

## 3. Linearity and dispatch (contract unchanged, basis generalized)

Capabilities — `ExecutionToken`, `DispatchReceipt`, `StepCapability`,
`PendingApproval` — are non-`Clone`, `Serialize`-only, no public constructor,
bound to trajectory + basis (+ flow/plan/step + engine), spent on use;
stale/foreign bindings refuse without touching state; double application is
unrepresentable (consumed by value), and a ruling landing after any interleaved
mutation refuses stale and re-escalates fresh — a fail-closed re-ask, never a
duplicate application. Two-phase dispatch: `release` commits may-effects,
consumes any pending confirmation grant, renders the **one** canonical request
from the exact checked tree, and mints the receipt;
`record_output`/`record_failure` consume the receipt and close the action.
Emission permits are the same discipline with an atomic emit (`Emitted`
carries the rendering of the exact checked tree; a blocked emission emits
nothing and never clears a pending tool action). The two pending slots
(action, emission) are independent and per-kind single-slot.

## 4. Superseded decisions (history — do not resurrect silently)

- **D1 — "response sink stays strict emit-or-terminal."** Superseded: the
  response is an ordinary mediated sink through the unified pipeline; a
  response flow can be Remediable, and remediation routes through the same
  reducers and authorities. (`ResponseDecision` and the separate
  `evaluate_response` pipeline are gone.)
- **Five-kind remedy taxonomy** (Sanitize / Constrain / Endorse / Accept /
  Waive-Acknowledge) **and its type split** (`TransitionKind` with the
  `Content|Fiat` justification, `ProposedGrant`, `TransientWaiver`,
  `EndorseDelta`, `WaiverKind`). Superseded by the two-kind vocabulary of
  §1.3: the old distinctions survive as typed coordinates and scopes, not as
  top-level kinds.
- **`ExitKind` categorization + plan-cap fairness** (`MAX_PLANS`,
  `select_fair`, "at least one route per category"). Superseded by the
  uncapped irreducible nondominated frontier (§1.5); with no cap there is
  nothing to keep fair.
- **Bounded rescue** (`RESCUE_EXHAUSTIVE_MAX`, rescue-only-when-ordinary-empty
  gating). Superseded: no search bounds, one dominance pool; Terminal is a
  proven claim (§1.5).
- **Plan postures** (`TransitionSpec` pre/postconditions, `Posture`,
  `final_postcondition`, posture-mismatch step failures). Superseded: the
  recheck is an execution invariant inside application, not a public plan
  object; only the head step is executable (§1.4). Typed reducer-relation
  rejections (predicate mismatch, `narrows`/`constrain_gate`, transformer
  runtime error) survive as audited failures.
- **Mutable trajectory state** (the revision counter and per-mutation
  `advance()`, `spent_confirmation`, mutable `PendingAction` aggregates,
  direct `past_effects` commits). Superseded by the append-only event algebra
  and projections (§1.6); confirmation spend is grant consumption.
- **Attention as a label dimension** (early notes). Never built: attention is
  a requirement satisfied structurally by a confirming user turn (and its
  grant), not a label axis.

## 5. Validation commands (every pass)

```sh
cd ai-labs && cargo test --workspace \
  && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --check
cd ai-labs/baton/baton-demo && cargo test --all-features && cargo fmt --check
cd ai-labs && cargo test -p baton-check --test cli
cd ai-labs/baton/agentdojo-harness && uv run pytest
```

Gate discipline (every pass): full validation → external + internal
`REVIEW(diff)` before any push → address findings → push to the one project
branch. Escalate to the maintainer on any change to approved scope, observable
behavior, or an API/data contract.
