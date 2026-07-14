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
   Inline authority. **`Unknown` stays first-class** — a definite fold position,
   not an error or a missing value — so it is a *routable* state, not a dead end:
   an authority must be able to map an unknown to a known label (Endorse raises an
   unknown-trust/audience value to a vouched label; Acknowledge clears an
   unprovable fact), exactly as it clears a breach. Nothing silently coerces an
   `Unknown` to a default; every unknown→known step is an authority's audited
   decision.
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
    `waive_prior_effects` competence, `confirms`, `acknowledge_unknown`,
    `may_release_control`. (`acquire_effects` competence — **distinct** from
    waiving a prior effect — lands with the `Accept` grant in Build 2; it is not
    in the Build-1 mandate, since nothing reads it until then.)
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
`control_release` stays a bool until Build 2 scopes it. *(Build-1-era framing,
since superseded: both happened — Build 3 relocated endorsement into the
durable relabel, Build 2 scoped `control_release` to a `ValueId` set.)*

Each slice compiles all targets, migrating its own demo/bench so no slice leaves
the crate red. Per slice: change · invariant · validation · escalation.

- [x] **S1 — Type split.** Replace the tri-purpose `WaiverDelta` with
  `AuthorityMandate` (competence flags/bounds — endorse dims,
  `waive_prior_effects`, `confirms`, `acknowledge_unknown`, `may_release_control`),
  `ProposedGrant` (the typed operation an authority rules on), and
  `TransientWaiver` (applied non-relabel lift:
  trust/audience/prior_effects/confirms/control_release-bool for now).
  *Invariant:* invalid states unrepresentable (a mandate can't carry request-only
  IDs; a request can't carry competence flags). *Validation:* build + clippy +
  adapted waiver tests. *Escalate* if a live call site needs a field that fits
  none of the three. — **Encoding decisions:** `ProposedGrant::Waive` wraps
  `TransientWaiver` rather than duplicating it; the `Endorse`/`Accept` variants
  (and `acquire_effects`) are omitted until Builds 2/3 wire them, so Rust
  exhaustiveness forces each later build to handle them.
- [x] **S2 — Authority unification + routing.** `Authority { name, mandate,
  mode: Inline(fn)|External }`; one registry; `register_authority`; delete
  `PolicyRule`/`Adjudicator`/`WaiverAuthority`. Routing = first mandate covering
  the `ProposedGrant`, Inline-first, registration order, **abstain (`None`) falls
  through** to the next competent authority; acknowledgment routes on the explicit
  `acknowledge_unknown` capability, **not** `covers(empty)`. Migrate demo/bench.
  *Invariant:* determinism (inline-first, reg-order); abstain never becomes
  denial. *Validation:* first-match-shadowing + abstain-fallthrough tests. —
  **Built as live apply-time routing** (the plan step no longer pins its
  authority; `apply_step` walks the competent set live). This makes the
  construction-time-only registry rule load-bearing for safety; a mid-run
  registration TOCTOU is accepted-and-documented (maintainer decision), not
  hardened, in Build 1.
- [x] **S3 — Ruling context.** Widen the inline decision fn to
  `fn(&ProposedGrant, &[Violation], &TrajectoryView) -> Option<Ruling>` (borrow
  taken before any mutation); external authorities get an **owned** ancestry
  snapshot embedded in `PendingApproval`, scoped to the operation, with a public
  accessor. *Invariant:* inline borrow ends before mutation; external snapshot is
  owned + serializable. *Validation:* an inline rule inspecting the grant source
  + a violation; an external round-trip carrying the snapshot. — The snapshot is
  the **direct** operation scope (arg leaves + control), not the transitive
  provenance closure; walking that closure is Build 3 (D3).
- [x] **S4 — `UnknownPolicy` dissolution + idempotence.** Delete the enum, field,
  ctor arg, both `match unknown_policy` blocks, `AuditEvent::UnknownAudited`,
  `BlockReason::UnknownDenied`. Unprovables route through the chain; an
  `acknowledge_unknown`-competent authority grants (audited
  `WaiverApplied`/`Acknowledgment`), else terminal. Record acknowledgment on the
  pending action so re-evaluation is idempotent. `PolicyEngine::new()` no arg;
  default fail-closed. Migrate demo/bench. *Invariant:* default fail-closed;
  unknown re-entry writes no duplicate audit. *Validation:* four `Unprovable`
  variants routed; no-authority → terminal; ack-authority → granted; unknown
  re-entry idempotent; response-with-no-`ResponsePolicy` → terminal (D1). —
  **Built as remedy-chain routing:** unprovables route through `enumerate_plans`;
  a grant-fixable gap is a `Waive`, an acknowledge-only residual an `Acknowledge`
  (or a `Waive` *carrying* the acknowledged facts when a lift rides alongside —
  `covers` then requires `acknowledge_unknown`, so a lift dimension cannot
  launder an unknown). Idempotence is **structural**: acknowledgment is audited
  at application (a consumed capability), so re-evaluation writes no audit —
  simpler than the pending-action marker §3 anticipated.
- [x] **Gate.** Full `fmt`/`clippy`/`test`/`demo` green (111 lib tests);
  external (Codex) + internal `REVIEW(diff)`, three rounds. Round 1 found the
  `acknowledge_unknown` bypass (blocker) — fixed by making `Waive` carry its
  acknowledged facts and gating `covers` on them. Round 2 confirmed the fix and
  caught a control-release regression it introduced — fixed by comparing
  `needed_delta`s (not counts). Two findings **deferred by maintainer decision**:
  the live-routing registry TOCTOU (accept + document, above) and approval
  re-entry idempotence (pre-existing revision-binding; follow-up ledger).

## 5. Builds 2–3 — were deferred past Build 1; both done

Originally the deferred queue (out of Build 1; mechanics fully specified in
§3). Both builds below have since been executed as §4-style slices **in this
same doc, on this same branch**, per the one-doc/one-branch rule; the blocks
now read as the record of what shipped, deviations included.

### Build 2 — control-release scoping + criterion (1) + Accept (done)
Built as slices S5–S8 on this branch; 126 lib tests; external (Codex) + internal
`REVIEW(diff)`, three rounds to convergence.
- [x] **S5 — `control_release` bool → `BTreeSet<ValueId>`** (D2/D4). `SimFlow` keeps
  `control_labels` per-dep (not a pre-folded aggregate); `violations` excludes exactly
  the named deps; `may_release_control` gates. Attribution is an **inclusion-minimal
  release solver**: from "release all", drop each redundant dep to a **fixpoint** (a
  single pass over-releases a dep masked by a later one — e.g. Suspicious masking
  Unknown in the trust fold — so it iterates until stable). Never over- or
  under-releases (D4).
- [x] **S6 — Criterion (1) + `Accept`.** `SurfaceGrowth { growth: Effects }` (carries
  `Effects`, so a known→`Unknown` jump is representable and still needs acquisition),
  emitted by a shared growth check consulted on **every** decision (initial evaluate,
  planning, apply-time rechecks) — not just planning. `Accept` records an
  `accepted_effects` marker on the pending action and re-evaluates; **no early commit**
  (release stays the sole committer, and every permit path clones the pending action's
  proposed effects). `acquire_effects` capability; authority-attributed `AcceptApplied`
  audit naming only the growth it acquired. The approval carrier generalized from a
  waiver to a typed `ProposedGrant`, so Accept round-trips the external path and
  composes with a residual waiver as two sequential single-grant steps.
- [x] **S7 — `ExitKind`-tagged, cap-fair routes.** `ExitKind` (Sanitize < Constrain <
  Accept < WaiverOrAcknowledge — the design's singular "Waiver-or-Acknowledge"
  category) is the route's decisive step; `select_fair` keeps the best route of each
  applicable category before filling in enumeration order. **No pre-trim cap:** a
  candidate/plan cap starves a category (confirming a category has no clearing route
  needs all its candidates), so the full candidate cartesian is generated — the residual
  O(leaves²) enumeration cost is a follow-up (bounded by construction-time registries
  and the agent's own request, not adversarial).
- [x] **S8 — Composition (Constrain↔Accept).** A flow that both breaches a sink and
  grows enumerates [constrain → accept] with Accept computed on the *reduced* effects
  (a full constrain to no-egress leaves no Accept step); the walk asserts both steps
  ran at runtime.
- **Deferred to the follow-up ledger:** approval/acknowledgment re-entry idempotence
  (the Build-1 item; Accept→Acknowledge makes it more reachable but S6 did not regress
  it) and the enumeration-perf scaling above.

### Build 3 — Endorse as relabel + robustness visibility (D3, done)
Converted to §4-style slices S9–S12 on this branch. Ratified encoding choices:
**OQ1** originally resolved to a *sibling* `TransitionKind::EndorseValue { source, delta }`
beside the shipped `TransformValue` (merging both judged behavior-preserving churn
for no semantic gain; shared minting lives in `turn.rs`/`value.rs` regardless).
*Superseded 2026-07-14 (maintainer-ratified, surface-reduction branch):* the two
variants merged into `Derive { source, justification: Content(..) | Fiat { .. } }` —
the justification split materializes the "shared mint-and-substitute, different
voucher" ontology in the type. Behavior (routing, byte rules, `ExitKind` ranking,
audit wording) is unchanged; the serialized plan tag shape did change, accepted
while plans have no out-of-process consumer. **`ExitKind`
ordering:** Endorse is the top/max variant (`Sanitize < Constrain < Accept <
WaiverOrAcknowledge < Endorse`) — taint erasure is the priciest elevation, so a
composite route's decisive category is its Endorse step. **Canonical remedy
order** (enumeration, tests, docs alike): Sanitize → Constrain (reductions) →
Endorse (confidentiality) → Accept (effect) → residual Waiver/Acknowledge.
**M1 (maintainer-ratified):** Endorse durably relabels *argument-tree* values
only; a confidentiality breach carried by a **control dependency** clears via
`control_release`, not by raising trust/audience — the intended tightening of
§3's arg-vs-control attribution split (a control-borne breach now needs
`may_release_control`, not endorse competence).

- [x] **S9 — Endorse relabel family (additive).** `EndorseDelta { trust, audience }`
  + `covered_by(&AuthorityMandate)`; `ProposedGrant::Endorse { source, delta }`;
  `Provenance::Endorsed { source, authority, delta }`; `ValueStore::admit_endorsed`
  + `Trajectory::endorse_value` (no-op body, label raised via `raised_to`/`admitting`
  never `combine`, `substitute_argument`, audit, advance); `AuditEvent::EndorseApplied`;
  `TransitionKind::EndorseValue` + `ExitKind::Endorse`; `apply_step`/`apply_approval`/
  `endorse_permit` arms with the pre-mutation fail-closed recheck; external Endorse
  snapshot site. `TransientWaiver::{trust,audience}` stay (removed in S10) so the
  slice is additive and the 126 tests stay green. *Invariant:* new value carries
  `Provenance::Endorsed`, source label unchanged, label only rises. *Validation:*
  build + clippy + unit tests (durable relabel + provenance + audit + downhill
  recheck; uncovered delta → no route; external round-trip). Every exhaustive match
  the new variants touch gains its arm this slice (Rust forces it).
- [x] **S10 — Relocate endorsement into enumeration; retire the transient lift.**
  `enumerate_plans` peels a sink-breach residual into `EndorseValue` step(s) — one
  per *arg leaf* failing the sink's trust/audience requirement in the current
  (post-reduction) `SimFlow`, each raising exactly that leaf (multi-source: N failing
  leaves → N steps); residual recomputed after. Remove `trust`/`audience` from
  `TransientWaiver`, `SimFlow::violations`' lift, `needed_delta`, `grant_for`;
  remove `WaiverKind::{Trust, Audience}`. **Control-release preservation (B1):**
  `minimal_control_release` measures a release's effect on the residual `Vec<Violation>`
  (which retains `TrustBelow`/`AudienceExceeds`), not the waiver delta, so a
  control-borne breach still yields release. *Invariant:* endorsement's sole path is
  the durable relabel; a breach both arg- and control-borne composes (release +
  endorse, residual recomputed). *Validation:* migrated endorse tests drive the
  Endorse route; a two-leaf aggregate audience breach enumerates two `EndorseValue`
  steps and clears only after both; control-borne breach still yields control release.
- [x] **S11 — D3: transitive ancestry in the ruling context.** A visited-set BFS
  provenance closure over `ValueStore`, done *inside* `AncestrySnapshot::of` so all
  three grant sites (Waive/Accept/Endorse) carry the closure; `TrajectoryView::ancestry`
  accessor for inline authorities; drop the "direct scope only / D3 later" caveat.
  Demo + test an inline endorse authority that abstains when an ancestor is
  `SUSPICIOUS` — the refusal test uses a non-suspicious source whose suspicious
  dependency is ≥2 provenance edges back (exercises the transitive walk). *Invariant:*
  exposure only, no hard guard (D3); the walk terminates (values form a DAG — provenance
  names only lower-id admitted values).
- [x] **S12 — Full-composition test + crate `CLAUDE.md`.** One flow: a registered
  sanitizer shrinks (not erases) the data taint, a registered constraint shrinks (not
  erases) the effects, leaving a residual sink breach → Endorse and residual surface
  growth → Accept. Assert all four steps ran in canonical order on the *reduced*
  residual (authority signs off only on the irreducible remainder). Refine `CLAUDE.md`:
  transient waivers change no stored state; a fiat-relabel (Endorse) mints a value like a
  transform (durable, provenance-attributed).
- **As built (deviations, maintainer-noted):** (a) *all four steps mandatory in one walk
  is not constructible* — the effect axis's `acquire_effects` is a boolean, so an
  available Accept always makes Constrain optional; the test instead drives the
  most-composed route (a guided walk over `plans`, forcing Sanitize via a
  trust-incompetent endorse authority) and asserts the four-step plan carries the reduced
  residuals (Endorse vouches only the post-Sanitize audience, Accept acquires only the
  post-Constrain growth). Constrain↔Accept alone stays covered by S8. (b) *D3 refusal is
  demonstrated by the `endorse_authority_refuses_a_suspicious_transitive_ancestry` test*
  (acceptance criterion reads "demo/test"); the narrative `demo` keeps the Endorse
  happy-path, since a visible refusal there would need its own single-authority engine.
- **Joint Endorse×control-release solve (was the "known fail-closed limitation";
  fixed in the pre-merge cleanup pass, maintainer-approved).** Ordinary enumeration
  peels Endorse from the *unreleased* residual and measures a control release against
  the release-all raw vector — both assume releasing control monotonically improves
  adequacy, which is false when a `Suspicious` control masks an argument's `Unknown`
  trust (the trust fold and the adequacy order disagree on `Unknown`). Such a flow used
  to be enumerated terminal despite having a valid *Endorse-then-release* plan. **As
  built:** a terminal-rescue solver (`rescue_plans`), consulted **only when ordinary
  enumeration yields no plan** (existing plan sets untouched), searches release
  candidates for *joint cleanability*: project the release, derive per-leaf Endorse
  deltas from the projected residual (`violations(None)`, so acknowledge-only facts and
  growth survive the projection; a candidate may need **no** endorse at all — a
  non-monotone *subset* release can be clean on its own, which the release-all-anchored
  ordinary solver misses), compose an Accept for projected growth and the final waiver
  (carrying acknowledged facts, so `acknowledge_unknown` competence is still required),
  and keep the candidate iff every grant is authorizable and the projection clears. The
  search is an exhaustive size-ascending subset walk (deterministic; the first hit is
  size-minimal, hence inclusion-minimal), bounded by the request's own control set and
  hard-capped at 12 deps — past the cap the rescue *refuses* (fail-closed terminal): a
  partial search anchored anywhere would inherit exactly the non-monotone blindness
  this solver exists to fix. Raises are peeled one at a time with the projection
  re-derived after each — a single raise can clear more than its own deficit (raising
  one leaf to the bottom bar re-masks the remaining `Unknown`s in the min-fold), so a
  batch would over-endorse. Each Endorse step carries an explicit `targets` field — the
  projected residual *at its own peel* that the authority is asked to clear — because
  the actual posture may not mention trust at all while the mask holds; plan postures
  stay the actual vectors (apply-time preconditions compare against reality).
  Regression matrix: `rescue_*` tests (composition, projected-target visibility inline
  and via the external approval's `resolves`, subset-clean release with and without an
  endorser, least-privilege, Accept and acknowledge-only composition walked to permit,
  and both missing-authority configs staying terminal).
- **Prediction artifact (not a defect).** A `Transform → Endorse` plan serializes the
  Endorse step's `source` as the *pre-transform* leaf id, but the transform re-ids the
  value at application and Endorse then targets the transformed descendant. A plan is a
  prediction, re-enumerated after every applied step (revision-binding forces it), so a
  stale downstream `source` is never applied; it is a display artifact of the shared
  `SimFlow` (which swaps a leaf's label in place without re-id-ing), not an unsafe path.
- **Approval/acknowledgment re-entry idempotence — investigated, not a defect
  (pre-merge cleanup pass).** `PendingApproval` is non-`Clone`, never `Deserialize`,
  and consumed by value, so double-application is unrepresentable; a ruling landing
  after any interleaved mutation refuses (`StepRefused::StalePlan`) without touching
  state and the flow re-escalates with a fresh `ApprovalRequested` (a fail-closed
  re-ask, never a duplicate application); transient waiver grants are deliberately
  permit-scoped (re-entry re-escalates, each ruling audited once), and the durable
  grants are idempotent by construction. Pinned by
  `accept_re_entry_writes_no_duplicate_audit`, `unprovable_re_entry_writes_no_audit`,
  and `stale_and_foreign_step_capabilities_are_refused`.
- **Deferred to the follow-up ledger (unchanged):** the enumeration O(leaves²) perf.

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
