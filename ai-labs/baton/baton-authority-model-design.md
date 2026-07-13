# baton-core: declassification-as-sudo / authority model — converged design

**Status:** design converged (maintainer + two Codex review rounds). This is the
**single plan-of-record** for the whole project, and everything lives here: the
decisions (§1–3), the work to do now (§4, "Build 1"), and the remaining work
explicitly deferred to next passes (§5, "Builds 2–3"). **One doc, one branch** —
each next pass converts its §5 block into §4-style slices in place; no separate
plan files, no per-build branches. It supersedes the relevant sections of
`baton-declassifier-design.md` (which remains the value-granular foundation).

The model below was expensive to converge, so it is recorded in full: anything
not built in the current pass is called out explicitly in §5, ready to pick up.

---

## 1. The model

1. **One invariant.** Any move that is not "downhill" is soft-banned and cleared
   only by an explicit, audited elevation routed to a registered authority.
   **No implicit accept anywhere.** Permissiveness is config (which authorities
   exist), never a code path. The algebra stays minimal and total; deployments
   get ugly by adding authorities, not by bending the model.
2. **Free iff downhill on both axes.** (2) meets the sink `Requirements` AND
   (1) non-expansive on the effects surface: `past.combine(proposed) == past`.
   Fail either → soft-ban with categorized routes.
3. **`L` is per-field algebra.** Effects are the trajectory-monotone field
   (`past_effects`). Confidentiality (audience/trust) stays value-granular; a
   grown "trajectory audience" is *emergent* from durable per-value relabels —
   no monotone confidentiality field, no ledger (that would reintroduce the
   whole-trajectory fold the crate deliberately removed).
4. **Relabel family (produces a new value), two justifications.**
   - **Sanitize** — bytes transformed; new label content-justified; authorized
     by **registration** (a registered transformer).
   - **Endorse** — bytes unchanged (identity `run`); new label = the source
     label **raised** by an authority-granted ΔL; justified by nothing in the
     bytes, so authorized by a **per-flow authority** whose mandate covers ΔL.
   "Endorse = sanitize with a no-op runner." Durability is *by construction*:
   both mint a real stored value; downstream references the derived value and is
   downhill. No ledger.
5. **Accept (grows the surface, produces no value).** An authority-signed
   authorization to acquire a new effect. It does **not** relabel a value and
   does **not** commit the effect early (see §3, Accept semantics).
6. **Transient waivers (change no stored state).** The flow-local lifts that do
   not relabel a value: `confirms` (one-shot confirmation), `waive_prior_effects`
   (waive an already-committed effect for one sink check), `control_release`
   (exclude named control deps for one flow).
7. **Persistence ⟺ monotone contribution to `L`.** Relabels (audience/trust) and
   the effect surface persist by construction; transient waivers do not. No
   time-caching (harness concern, out of scope for the algebra).
8. **One authority concept.** `Authority { name, mandate, mode }`,
   `mode ∈ { Inline(fn), External }`. Universal: it may grant a ΔL at one turn
   and deny another at the next — the mandate is *routing competence*, not a
   per-value cap. Accept-all = a max-mandate `Inline` authority. Routing: first
   authority whose mandate covers the *proposed grant*, Inline-first, in
   registration order, **abstain falls through** to the next competent one.
9. **`UnknownPolicy` fully dissolves** into authority registration. Unknown facts
   route through the same chain as breaches. This is an **intentional** semantic
   change, not equivalence. Old modes map: `Escalate`→normal routing; `Deny`→no
   acknowledge authority registered; `AllowWithAudit`→register a max-mandate
   Inline authority.
10. **The block returns categorized routes** (Endorse / Sanitize / Accept /
    Constrain / Waiver-or-Acknowledge + competent authority), not a flat list.

### Endorse vs. Accept (the distinction that took the longest)
Both clear a soft-ban; they differ in what label the outcome carries.
- **Accept** — "yes, it's dirty, proceed." Taint **preserved**, `L` rises
  honestly. Cheap authority. Clears a **criterion-(1) surface-growth** checkpoint
  *only* — never a sink breach (acknowledging data is attacker-controlled does
  not make a trust-demanding sink take it).
- **Endorse** — "it's actually clean, I vouch." Taint **erased** (label raised),
  `L` flat. Pricey authority (robustness-dangerous). Clears a **criterion-(2)
  sink breach**. Sanitize does the same but content-justified instead of by fiat.

---

## 2. Ratified decisions (were open questions)

- **D1 — response sink stays strict emit-or-terminal.** The final answer to the
  user is the front door: no remediation there. If a value is too dirty to show,
  it is relabeled *upstream*, before the response is composed. `ResponseDecision`
  keeps emit-or-`Blocked`; no remedy/approval carrier.
- **D2 — control release: concrete set on the request, capability on the
  mandate.** The applied/request `control_release` is `BTreeSet<ValueId>`
  (least-privilege, per-conversation). An authority mandate carries a
  trajectory-independent `may_release_control` capability — never `ValueId`s
  (they are trajectory-local; an engine-global mandate cannot name them).
- **D3 — robustness is engine-exposed, not engine-enforced.** No hard guard. The
  authority sees the whole trajectory (each endorsed value's provenance and its
  suspicious control ancestry) and makes the judgment. A reckless accept-all can
  launder — the deployment's audited choice, consistent with "permissiveness is
  config."
- **D4 — control release is least-privilege:** scoped to the named control deps;
  releasing dep A never releases dep B.

---

## 3. Hard-won mechanics (from Codex review rounds — do not relitigate)

These resolve concrete blockers/majors found while pressure-testing the model.
They are decisions, not open questions.

- **Type split (was: one `WaiverDelta` for everything).** Three distinct types:
  - `AuthorityMandate` — competence flags/bounds, trajectory-independent:
    endorse dims (`trust: Option<KnownTrust>`, `audience: Option<Set<UserId>>`),
    `acquire_effects` competence, `waive_prior_effects` competence (**distinct**
    from acquire), `confirms`, `acknowledge_unknown`, `may_release_control`.
  - `ProposedGrant` — the typed operation an authority rules on (so it knows
    *what* it is ruling on, incl. the Endorse **source `ValueId`**, the Accept
    effects, the concrete control-release set): `Endorse{source, delta}` |
    `Accept{effects}` | `Waive{prior_effects, confirms, control_release}` |
    `Acknowledge{facts}`.
  - `TransientWaiver` — applied plan data for non-relabel waivers only:
    `{prior_effects, confirms, control_release: BTreeSet<ValueId>}`.
- **Acknowledge routing.** An "empty ask" is covered by every mandate, so
  acknowledgment must route on the explicit `acknowledge_unknown` capability,
  not on `covers(empty)`; abstain falls through to the next competent authority.
- **Unknown idempotence.** Acknowledgment of a pending action is recorded on that
  action, so re-evaluating the still-pending request does not re-acknowledge /
  re-audit (replaces today's `UnknownPolicy` `existing_action.is_none()` guard).
- **Relabel output algebra.** Endorse raises the label with the **lift helpers**
  (`Trust::raised_to`, `Audience::admitting`) — **not** `combine` (the taint fold
  cannot improve a label). Source keeps its own label; a new value is minted.
- **Endorse attribution.** New `Provenance::Endorsed { source, authority, delta }`
  and audit event; existing provenance/audit only name a transformer.
- **Accept semantics.** Accept authorizes the growth *on the pending action*
  (a transient authorization the criterion-(1) recheck consults); the effect
  still commits to `past_effects` **at release**, as today. Abandoning the token
  commits nothing. Persistence of "first egress soft-bans, second is downhill"
  comes from the normal release-commit, not an early commit. (Do **not**
  redefine `past_effects` to mean "acquired-but-not-dispatched.")
- **Control attribution (least-privilege).** `SimFlow` keeps control deps
  individually (`control_labels: BTreeMap<ValueId, ValueLabel>`), not one
  pre-folded aggregate. A control dep "carries" a breach dimension iff removing
  it from the fold changes that dimension's adequacy; `needed_delta` names the
  minimal such set. Overlapping arg-borne taint is attributed to arguments, not
  released via control.
- **Criterion (1) in SimFlow.** `SimFlow` carries `proposed_effects`, updated
  during constrain simulation; the trigger `past.combine(proposed) != past` runs
  on the **finalized** (post-narrowing) effects so a constrained request is not
  blocked for effects it will not dispatch. Total over `Unknown` by construction
  (`UNKNOWN` is the join top).
- **Ruling context.** Inline authorities get a borrowed read-only view
  (`&Trajectory`/a narrow `TrajectoryView`, taken before any mutation) **plus**
  the `ProposedGrant`. External authorities get an **owned snapshot** of the
  relevant ancestry embedded in `PendingApproval` (a borrow cannot cross the
  async approval boundary) — scoped to the operation, not the whole trajectory.
- **`ExitKind` derivation.** Categorize a route from its typed steps (its
  decisive/highest-privilege step), and include a Waiver/Acknowledge category —
  waiver-only and composite (transform+constrain+waiver) routes exist today and
  must map to a category.
- **Plan-cap fairness.** The `MAX_PLANS` cap must not starve later route
  categories; guarantee at least one route per applicable category before
  filling remaining slots.
- **Sanitizer/authorization honesty.** Acceptance is "every non-downhill flow
  names its *authorizer*" — an `Authority` for endorse/accept/waiver/acknowledge,
  **or a registered transformer/transition** for sanitize/constrain (registration
  is a distinct, audited authorization root; it does not become an `Authority`).
- **Composition is least-privilege.** A flow may trip both criteria (a dirty
  payload *and* a surface-growing sink), so a plan composes a reduce step with an
  authorize step. Ordering: apply the registration-cheap **reductions first** —
  Sanitize (shrinks the data taint) and Constrain (shrinks the tool effects) —
  recompute the residual against the reduced state (SimFlow simulates each step),
  then route only the **irreducible residual** to a pricey authority elevation:
  Endorse (residual sink breach), Accept (residual surface growth), transient
  Waiver (confirmation / control-release / prior-effect). The reduce/authorize
  pairs are **per axis**: Constrain↔Accept on the effect axis, Sanitize↔Endorse
  on the confidentiality axis — each reduction shrinks what its own elevation must
  authorize; across axes the steps compose additively (a relabel does not shrink
  what an Accept authorizes). This extends today's `enumerate_plans`
  (`transform → constrain → waiver-the-residual`, which already computes a final
  waiver over what remains); Accept slots into the same residual computation.

### Open encoding choices (decide at Build time, low-risk)
- **OQ1:** one `TransitionKind::Relabel { source, via: Sanitize(TransformerRef)
  | Endorse{delta, authority} }` vs two sibling variants. Lean: one variant, with
  `via` explicit in provenance/audit/validation/candidate-enumeration.
- **OQ2:** resolved — split into the three types above (not one).

---

## 4. The work — Build 1 (this pass): authority foundation

The type/authority/routing foundation done right — it absorbs **every** Codex
round-2 blocker. Deliberately **not** in this pass (see §5): Endorse-as-relabel,
Accept, scoped control release, criterion (1). Trust/audience endorsement keeps
working as a *transient* waiver under the new types until Build 3 relocates it;
`control_release` stays a bool until Build 2 scopes it.

Each slice compiles all targets, migrating its own demo/bench so no slice leaves
the crate red. Per slice: change · invariant · validation · escalation.

- [ ] **S1 — Type split.** Replace the tri-purpose `WaiverDelta` with
  `AuthorityMandate` (competence flags/bounds — endorse dims, `acquire_effects`,
  `waive_prior_effects`, `confirms`, `acknowledge_unknown`, `may_release_control`),
  `ProposedGrant` (the typed operation an authority rules on, incl. the Endorse
  source `ValueId`), and `TransientWaiver` (applied non-relabel lift:
  trust/audience/prior_effects/confirms/control_release-bool for now).
  *Invariant:* invalid states unrepresentable (a mandate can't carry request-only
  IDs; a request can't carry competence flags). *Validation:* build + clippy +
  adapted waiver tests. *Escalate* if a live call site needs a field that fits
  none of the three.
- [ ] **S2 — Authority unification + routing.** `Authority { name, mandate,
  mode: Inline(fn)|External }`; one registry; `register_authority`; delete
  `PolicyRule`/`Adjudicator`/`WaiverAuthority`. Routing = first mandate covering
  the `ProposedGrant`, Inline-first, registration order, **abstain (`None`) falls
  through** to the next competent authority; acknowledgment routes on the explicit
  `acknowledge_unknown` capability, **not** `covers(empty)`. Migrate demo/bench.
  *Invariant:* determinism (inline-first, reg-order); abstain never becomes
  denial. *Validation:* first-match-shadowing + abstain-fallthrough tests.
- [ ] **S3 — Ruling context.** Widen the inline decision fn to
  `fn(&ProposedGrant, &[Violation], &TrajectoryView) -> Option<Ruling>` (borrow
  taken before any mutation); external authorities get an **owned** ancestry
  snapshot embedded in `PendingApproval`, scoped to the operation, with a public
  accessor. *Invariant:* inline borrow ends before mutation; external snapshot is
  owned + serializable. *Validation:* an inline rule inspecting the grant source
  + a violation; an external round-trip carrying the snapshot.
- [ ] **S4 — `UnknownPolicy` dissolution + idempotence.** Delete the enum, field,
  ctor arg, both `match unknown_policy` blocks, `AuditEvent::UnknownAudited`,
  `BlockReason::UnknownDenied`. Unprovables route through the chain; an
  `acknowledge_unknown`-competent authority grants (audited
  `WaiverApplied`/`Acknowledgment`), else terminal. Record acknowledgment on the
  pending action so re-evaluation is idempotent. `PolicyEngine::new()` no arg;
  default fail-closed. Migrate demo/bench. *Invariant:* default fail-closed;
  unknown re-entry writes no duplicate audit. *Validation:* four `Unprovable`
  variants routed; no-authority → terminal; ack-authority → granted; unknown
  re-entry idempotent; response-with-no-`ResponsePolicy` → terminal (D1).
- [ ] **Gate.** Full `fmt`/`clippy`/`test`/`demo`; external + internal
  `REVIEW(diff)`; address findings; then check the Build-1 boxes above.

## 5. Next steps — deferred, NOT this pass

Explicitly out of Build 1. The mechanics are fully specified in §3, so each block
is pick-up-ready: when a pass starts, convert it into §4-style slices **in this
same doc, on this same branch**.

### Build 2 — control-release scoping + criterion (1) + Accept
- [ ] `control_release` bool → `BTreeSet<ValueId>` (D2/D4); `SimFlow.control_labels`
  + `needed_delta` source attribution; `may_release_control` capability enforced.
- [ ] Criterion (1): `SimFlow.proposed_effects`; trigger
  `past.combine(proposed) != past` on finalized effects; `SurfaceGrowth` violation.
- [ ] `Accept` transition + enumeration branch + on-pending-action authorization
  (no early `past_effects` commit); `acquire_effects` capability enforced.
- [ ] `ExitKind`-tagged, cap-fair categorized routes (derive tag from steps;
  include Waiver/Acknowledge).
- [ ] **Composition (Constrain↔Accept).** A flow that both breaches a sink and
  grows the surface enumerates a plan that Constrains first, then Accepts the
  residual growth; Accept is computed on the *reduced* effects (a full constrain
  to no-egress leaves no Accept step). Test the residual computation, not just
  the two remedies in isolation.

### Build 3 — Endorse as relabel + robustness visibility
- [ ] Move trust/audience endorsement out of `TransientWaiver` into the relabel
  family (OQ1); mint `X'` via the value-admission path (label raised via
  `raised_to`/`admitting`, not `combine`); substitute + fail-closed recheck;
  `Provenance::Endorsed { source, authority, delta }` + audit attribution.
- [ ] Multi-source relabel enumeration (endorse >1 leaf for an aggregate breach).
- [ ] D3: populate the ruling context with provenance/control ancestry; demo an
  authority refusing to endorse a value with suspicious ancestry.
- [ ] Refine crate `CLAUDE.md`: transient waivers change no stored state; a
  fiat-relabel mints a value like a transform.
- [ ] **Full-composition test.** One flow needing Sanitize + Constrain (cheap
  reductions) then Endorse + Accept (authority residual, across both axes),
  proving the residual is recomputed after each reduction and the authority signs
  off only on the irreducible remainder.

## Validation commands (every pass)
```
cargo fmt -p baton-core -- --check
cargo clippy -p baton-core --all-targets -- -D warnings
cargo test -p baton-core
cargo run -q --example demo
```

Gate discipline (every pass): full validation → external + internal
`REVIEW(diff)` before any push → address findings → push to the one project
branch. Escalate to the maintainer on any change to approved scope, observable
behavior, or an API/data contract.
