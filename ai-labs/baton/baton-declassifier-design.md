# Transitions and declassifiers in baton: design note

Status: foundation design — fully built, then extended by the authority model
and finally by the **compact architecture** (two-kind Reduce/Authorize remedy
vocabulary, unified tri-state flow outcomes with the response as an ordinary
mediated sink, complete-search nondominated plan frontiers, and append-only
event-log trajectory state). The five-kind transition taxonomy and the mutable
trajectory state this note describes no longer exist in code. Superseded in
places (marked inline with `> **Superseded.**` blockquotes);
`baton-authority-model-design.md` is the plan-of-record and `docs/spec.md` the
normative spec. The code sketches below are historical: the code is the
reference.

This revision follows source review of `baton-core`, the platform Dual LLM
implementation, and recent agent IFC work. It makes three scope decisions explicit:

1. Post-hoc sanitization (B2) is in scope, so baton needs value-granular IFC. A fresh
   turn cannot untaint the current whole-trajectory fold.
2. A human-registered transformer is a trusted primitive at the algebra boundary.
   baton validates its declared state transition, not whether its implementation
   actually removed sensitive content. Implementation robustness belongs to the
   harness.
3. Remedy planning is generic, but application uses closed typed transition domains.
   A value transform, an action constraint, and a waiver preserve different
   invariants even when they share one planning vocabulary.

The PoC deliberately defers product-scoped transformer bindings, temporal revocation,
durable signed approvals, and the low-integrity presentation of remedy plans.

---

## 1. Three ways a blocked flow can become legal

The previous design grouped too much under "declassification." There are three
different state transitions:

### A. Waive a requirement

> **Superseded.** Trust/audience loosening is no longer a transient waiver:
> since Build 3, raising trust or audience is a *durable* fiat relabel
> (`EndorseValue` minting a new value under endorsed provenance). A transient
> waiver covers only prior effects, a confirmation stand-in, and named
> control-dep release. See `baton-authority-model-design.md` §1.4/§5 Build 3.

The recipient needs the original bytes. An authority accepts the risk for this flow.
The value and its label do not change; the engine transiently loosens the sink check,
rechecks, and records the exception.

This is baton's current mechanism. Depending on the dimension, the canonical operation
is declassification (audience), endorsement (trust), or authorization (effects and
confirmation).

### B. Transform a value

The recipient needs a derived value, not the original bytes. A registered transformer
creates a new immutable value with a declared label transition:

```text
F: V[l] -> V'[l']
```

The source value remains present and keeps `l`. `V'` receives new identity and
provenance. This supports post-hoc B2 without claiming the earlier raw turn disappeared.

Examples include PII redaction, aggregation, format conversion, and an operator-trusted
LLM rewrite. baton treats `F` as trusted because an operator registered it. It does not
inspect the bytes or prove that `l'` is semantically correct.

### C. Constrain a pending action

Some remedies change how an operation will run rather than changing a value:

```text
G: A[e] -> A'[e']
```

Examples:

- replace a network fetch with a cache-only fetch;
- run a command in a sandbox with no network capability;
- replace a general connector with a read-only execution profile.

These transformations can reduce the *proposed* effects of a pending action. They
cannot erase effects that already happened.

The common rule is:

> A generic transition protocol plans remedies; typed transition domains enforce what
> each remedy is allowed to change.

---

## 2. Why B2 requires values, not supersession

> **Superseded.** The pre-B2 code this opening describes
> (`Trajectory::context_label` folding every turn) is gone; the value-granular
> model this section motivates is what was built. The argument stands as
> rationale only.

baton currently checks a request against one label folded from every turn:

- `ToolRequest` has only a tool name and recipients, with no arguments or per-value
  labels (`contract.rs`).
- `Trajectory::context_label` folds every turn (`turn.rs`).
- `Requirements::check` receives that whole folded label (`contract.rs`).
- a tool result receives its contract's static `output_label` (`engine.rs`).

Therefore appending a scrubbed turn cannot repair earlier taint. `Public` is the
audience fold identity, `Trusted` cannot remove prior suspicion, and empty effects
cannot remove effects already unioned into the context.

Supersession would make the fold more permissive by pretending an earlier observation
no longer influences the agent. That is unsound after the agent has read the raw value:
the raw value may still influence future text, recipients, tool choice, or whether an
action occurs.

The B2 upgrade instead introduces immutable labeled values.

> **Superseded.** Historical sketch. The shipped `Provenance` (`value.rs`)
> differs: `ModelOutput`/`ToolOutput` carry `control` dependency sets,
> `ToolOutput` names an `action`, and Build 3 added
> `Endorsed { source, authority, delta }` for fiat relabels.

```rust
struct ValueId(u64);

struct StoredValue {
    body: OpaqueValue,
    label: ValueLabel,
    provenance: Provenance,
}

enum Provenance {
    Ingress { turn: TurnId },
    ModelOutput { reads: BTreeSet<ValueId> },
    ToolOutput { call: CallId, arguments: BTreeSet<ValueId> },
    Transformed {
        source: ValueId,
        transition: TransitionId,
        transformer: TransformerRef,
    },
}
```

`ValueId` identifies provenance, not byte equality. Two byte-identical values may have
different labels and derivations.

All values are immutable. A transformer creates a new value; it never mutates or
relabels its source.

### Tool requests bind the checked values to the executed values

The request must contain the argument tree that will actually be rendered for the
tool. A detached label sidecar is not sufficient.

> **Superseded.** Historical sketch. The shipped `ToolRequest` (`request.rs`)
> carries a control dependency *set* (`BTreeSet<ValueId>`), never a
> caller-supplied `control: ValueLabel` — this sketch's shape is exactly the
> relabeling hole `baton-core/CLAUDE.md` forbids.

```rust
struct ToolRequest {
    tool: ToolName,
    arguments: ArgumentTree<ValueId>,
    control: ValueLabel,
}

enum ArgumentTree<T> {
    Value(T),
    List(Vec<ArgumentTree<T>>),
    Object(BTreeMap<ArgumentName, ArgumentTree<T>>),
}
```

Recipients, paths, commands, URLs, headers, and other observable arguments are values
in this tree. The adapter executes from the same tree the engine checked. There is no
second, unbound argument object for the harness to substitute later.

There should be no general public `insert(bytes, label)` API. Ingress is the explicit
trust boundary; model outputs, tool outputs, and transformer outputs receive labels
through engine-owned admission paths.

Every ordinary computation is label-monotone. For a non-transformer output:

```text
L_output = combine(L_intrinsic, L_control, labels of every input dependency)
```

`L_intrinsic` is the tool/model's declared provenance; it cannot override dependencies.
A registered `TransformValue` is the only admission path allowed to produce an output
below this conservative fold.

---

## 3. Explicit and control dependence

Checking only the selected payload values misses implicit flows:

```text
d = F(secret)       // d is legitimately lower-labeled
if secret:
    email(d)        // whether the email exists leaks one bit
```

The same problem applies to tool selection, recipient selection, argument omission,
ordering, retry count, and model-generated literals. If a model reads a sensitive
value and then writes the literal `"0"` or `"1"`, the literal depends on the sensitive
value even though it is not a substring of it.

The PoC therefore tracks an action/control label in addition to argument labels.

```text
L_args    = fold(labels of all values rendered into the request)
L_control = fold(labels of values read by the component that selected the
                 invocation, tool, argument structure, and recipients)
L_flow    = combine(L_args, L_control)
```

Audience and trust requirements check `L_flow`, not the whole trajectory and not only
the payload. A raw value elsewhere in the trajectory no longer taints an unrelated
sink, but it still taints any action whose data or control provenance depends on it.

A useful sanitized action after raw access therefore needs at least one of:

- trusted orchestration fixed the action independently of the raw value;
- a precommitted request plan left only a transformed value slot open;
- another registered transition explicitly releases the relevant control choice;
- a waiver authorizes the control-dependent flow.

The final assistant response is also a completely mediated sink. Model-generated text
is first admitted as a value with the model step's read/control dependencies. Emission
requires a revision-bound request referencing immutable values:

> **Superseded.** Historical sketch. The shipped `ResponseRequest`
> (`request.rs`) carries a control dependency *set*, not a caller-supplied
> `control: ValueLabel` (the same relabeling hole as the `ToolRequest`
> sketch above).

```rust
struct ResponseRequest {
    body: ArgumentTree<ValueId>,
    control: ValueLabel,
    basis: Revision,
}
```

The engine checks its explicit and control labels, and the harness emits only bytes
rendered from that exact checked tree. There is no separate raw model string that may be
returned after the check.

Timing, termination, resource usage, and other covert channels remain outside the PoC
guarantee. The harness may normalize them, but baton does not model them.

---

## 4. Labels, effects, and typed deltas

There is no single useful `l' < l` implementation in current baton. Audience, trust,
and effects have different fold and adequacy orders, and `Unknown` has dimension-specific
semantics. Registration must declare and validate a typed delta per dimension.

The B2 model also separates value metadata from trajectory history:

```rust
struct ValueLabel {
    audience: Audience,
    trust: Trust,
    // Future deployment-defined value dimensions compose here.
}

struct TrajectoryState {
    past_effects: Effects,
    audit: Vec<AuditEvent>,
}

struct ProposedAction {
    request: ToolRequest,
    proposed_effects: Effects,
}
```

A registered value transformer may declare changes to any value-label dimension. For
example, it may lower confidentiality, endorse provenance, or do both. The audit record
describes each changed dimension instead of forcing one singular `Declassify` kind.

An action transformer may reduce `proposed_effects` or otherwise narrow the pending
action. When dispatch begins, its constrained proposed effects append conservatively to
`past_effects` and cannot be removed by a later transition.

"Narrow" is verified, not inferred from a smaller effect set alone. Each registered
action transition declares the exact fields it may change and a structural capability
relation. The engine requires the transformed action to use no broader recipient,
egress-destination, or runtime-capability sets; unchanged arguments retain their
identities; replacement arguments are checked values; and the control label is preserved
unless a separate audited transition explicitly releases it. Tool identity may change
only through an explicitly registered mapping, such as network fetch to cache-only fetch.

Confirmation remains structural interaction state rather than a value label.

---

## 5. What registration means

For this PoC, transformer registration is universal and structural:

- a transformer has immutable identity and version;
- it declares an input predicate and output mapping;
- it declares its transition domain and typed label/effect delta;
- if the input state matches, the planner may use it.

The product design should later add explicit tool/argument bindings so a globally
registered transformer is applicable only where policy allows it. That binding is not
needed to demonstrate the algebra.

Registration establishes an operator trust decision, not content correctness. baton
can enforce:

- the selected transformer was registered;
- the source identity and label match its declared precondition;
- the returned state uses the declared output label/effects;
- undeclared dimensions and unrelated state were not changed;
- the result is bound to the right trajectory revision and plan step.

baton cannot enforce:

- that PII was actually removed;
- that an LLM ignored prompt injection;
- that a verifier's semantic judgement was correct;
- that a remote model or prompt remained unchanged behind a mutable alias.

Audit wording must therefore say "admitted under the transition declared by registered
transformer X/version Y," never "baton verified this content as Public."

### Bounded-channel guidance belongs to the harness

A confined raw-reading model, finite output domain, deterministic renderer, cumulative
release budget, and independent verification can make a transformer implementation
safer. They are useful harness patterns, not requirements the label algebra can prove.

The platform Dual LLM is an integrity firewall for indirect prompt injection, not a
confidentiality declassifier proof. Its raw-reading stage returns an integer, but the
main model chooses adaptive questions and unbounded option sets from the caller's
request, and repeated runs have no cumulative release budget. It should not be cited as
evidence that arbitrary `Sensitive -> Public` prose is sound.

---

## 6. Generic plans, typed application

The engine precomputes remedy plans when it has enough structural information.

> **Superseded.** Historical sketch. The shipped `TransitionKind` (`plan.rs`)
> has five variants — `TransformValue` / `ConstrainAction` / `ApplyWaiver` /
> `AcceptGrowth` / `EndorseValue` — with inline fields, not `ValueTransition` /
> `WaiverTransition` payloads; the shipped `TransitionSpec` carries pre- and
> postcondition postures but no `id` field, and routes are categorized by
> `ExitKind`.

```rust
struct RemedyPlan {
    id: PlanId,
    steps: NonEmptyVec<TransitionSpec>,
    final_postcondition: Posture,
}

struct TransitionSpec {
    id: TransitionId,
    precondition: Posture,
    postcondition: Posture,
    kind: TransitionKind,
}

enum TransitionKind {
    TransformValue(ValueTransition),
    ConstrainAction(ActionTransition),
    ApplyWaiver(WaiverTransition),
}
```

The common envelope supports planning, serialization, explanation, and audit. The
closed variants enforce conservation laws:

- `TransformValue` may create one or more derived values but cannot mutate sources,
  pending actions, or past effects.
- `ConstrainAction` may replace or narrow a pending action but cannot rewrite values or
  past effects. It must satisfy its registered structural capability relation and cannot
  lower control provenance implicitly.
- `ApplyWaiver` changes no stored value or past-effect state. It appends audit history
  and transiently loosens only its bound check.

> **Superseded.** The "policy/transformer version" binding below was not
> built: authority routing is resolved *live at application* against the
> current registry — a minted plan does not pin its authority (Build 1 S2).
> Capabilities bind trajectory, revision, plan/step, and engine identity.

A plan is a prediction, not a permit. Before each step, the engine mints an opaque,
linear capability bound to:

- trajectory identity and current revision;
- exact plan and step;
- exact source value or pending action;
- declared precondition and postcondition;
- policy/transformer version.

Applying any step consumes the capability and advances the trajectory revision. The
engine validates the step's postcondition and re-evaluates the original flow. If the
trajectory changed, the transition failed, or the predicted postcondition does not
hold, the remaining plan is discarded and the engine blocks or replans.

External execution uses a conservative two-phase boundary. Consuming an execution
capability first appends the constrained action's proposed effects to `past_effects` and
advances the revision, then releases the exact checked action for dispatch. This is a
may-effect history: after dispatch starts, a timeout or crash cannot prove that an effect
did not happen. An undeclared or ambiguous effect adds `Unknown`; failure never removes
the pre-recorded effects.

This supports compositions such as:

```text
TransformValue -> ConstrainAction -> ApplyWaiver -> recheck -> Permit
```

It also supports two independent authorities without attributing their combined grant
to whichever happened to run last. Each step has its own competence check and audit
record.

> **Superseded.** `Grant` became the typed `ProposedGrant`
> (Endorse / Waive / Accept / Acknowledge) an authority rules on, and the
> step composition below exists.

Current baton already product-composes multiple dimensions into one `Grant`; what it
lacks is composition across independently authorized and state-changing steps.

### Terminal and remediable blocks are different types

Do not encode "no remedy" as an empty incidental vector:

```rust
enum Blocked {
    Terminal(TerminalBlock),
    Remediable {
        violations: Vec<Violation>,
        plans: NonEmptyVec<RemedyPlan>,
    },
}
```

Which projection of these plans is visible to a low-integrity agent is a harness concern,
not part of the PoC algebra.

---

## 7. Policy rules and external approval

> **Superseded wholesale.** The policy-rule / external-adjudicator split below
> was built, then replaced in Build 1 S2 by the unified
> `Authority { name, mandate, mode: Inline(fn) | External }` registry: one
> registry and name space, competence-routed on the `ProposedGrant`,
> inline-first in registration order, abstain falls through. The
> `PendingApproval` linearity guarantees at the end of this section survive
> unchanged. See `baton-authority-model-design.md` §1.8/§4 S2.

The current `Authority` trait combines mandate discovery, synchronous execution,
attribution, and adjudication. It explicitly admits humans, webhooks, and LLM judges,
then `evaluate` calls it inline. That prevents a pure structural evaluation boundary.

Split it into two surfaces:

- **Policy rules** execute inside `evaluate`. They are intended to be deterministic
  functions of registered policy and the structural request state.
- **External adjudicators** are registered metadata. `evaluate` may produce an
  `ApplyWaiver` step for one, but never invokes the human/webhook/model itself.

A Rust trait cannot prove an implementation is pure, so `PolicyRule` means "allowed to
run inline," not "formally established pure." A later product can use a closed
declarative policy representation if reproducibility requires stronger enforcement.

For the PoC, external approval is process-local:

```text
evaluate -> PendingApproval -> harness adjudication
         -> apply_approval(pending, ruling) -> re-evaluate
```

`PendingApproval` is opaque, non-`Clone`, non-deserializable, and bound to the exact
trajectory revision, request, waiver delta, targeted violations, and adjudicator
registration. Restart invalidates it. This reuses the spirit of the existing
one-shot/stale/foreign `Permit` guards without introducing signatures, stable trajectory
IDs, expiry, or a replay database.

---

## 8. Audit is control-plane history, not a value-label field

The current `AuditEntry` vector is folded inside `Label`. At value granularity that is
awkward: referencing the same value twice can duplicate its history, while a failed
transition has no output label on which to record its failure.

Move audit to append-only trajectory/control-plane state.

> **Superseded.** Historical sketch. The shipped `AuditEvent` (`audit.rs`) is
> larger — Accept and Endorse events among others, `BTreeSet` collections —
> and its waiver event names the authority and the granted lift, not a
> `NonEmptySet<WaiverKind>`.

```rust
enum AuditEvent {
    ValueTransition {
        transition: TransitionId,
        transformer: TransformerRef,
        source: ValueId,
        derived: Option<ValueId>,
        input: ValueLabel,
        declared_output: ValueLabel,
        outcome: TransitionOutcome,
    },
    ActionConstrained {
        transition: TransitionId,
        before: ActionId,
        after: Option<ActionId>,
        outcome: TransitionOutcome,
    },
    WaiverApplied {
        transition: TransitionId,
        changes: NonEmptySet<WaiverKind>,
        authority: AuthorityName,
        resolved: Vec<Violation>,
    },
}
```

Failures append an event but create no derived value or action. Raw bytes and plain
content digests do not belong in the public audit record. A protected harness may keep
a keyed linkage token or redaction manifest separately.

Transformer identity/version is provenance. Temporal revocation and re-sanitization are
out of scope for the PoC; versioning here supports attribution and future extension only.

---

## 9. Preserved properties and explicit non-guarantees

Preserved or strengthened:

- Source values and turns remain append-only and immutable.
- B2 creates a derived value instead of loosening or superseding prior context.
- Past effects remain monotone.
- Tool execution is bound to the exact argument tree that policy checked.
- Control dependence prevents sanitized payloads from laundering secret-dependent tool
  or recipient choices.
- Every applied remedy is independently competent, revision-bound, one-shot, audited,
  and rechecked against the original sink postcondition.
- A block with no plan remains an explicit terminal outcome.

Not guaranteed by baton:

- semantic correctness or prompt-injection robustness of a registered transformer;
- timing-, termination-, retry-, or resource-based noninterference;
- safe product policy for where a transformer may be used;
- low-side confidentiality of violation witnesses or plan topology;
- durable approval across process restarts;
- revocation of already-derived values or knowledge already disclosed externally.

The precise PoC confidentiality claim is:

> Given correct ingress labels, complete mediation, conservative explicit and control
> dependency propagation, and trusted registered transformers, baton prevents
> unauthorized value and action flows modulo the transitions and waivers explicitly
> declared by policy.

---

## 10. PoC implementation sequence

> **Superseded.** All nine steps are done (and extended by the authority
> model's Builds 1–3). Kept as the record of what the foundation pass built.

1. Split `Label` into value dimensions, monotone trajectory effects, and audit events.
2. Add the immutable trajectory-local value store and provenance graph.
3. Replace free `String` turns and detached request metadata with `ValueId` references
   and an executable argument tree.
4. Derive every ordinary model/tool output by folding its intrinsic label with all
   explicit and control dependencies; add a completely mediated response sink.
5. Add registered value and action transition contracts using universal structural
   compatibility.
6. Add generic remedy plans with closed typed transition variants.
7. Replace turn-count freshness with a trajectory revision covering values, actions,
   effects, audit, and turns.
8. Split inline `PolicyRule` evaluation from process-local external approval re-entry.
9. Add behavior tests for explicit flow, implicit flow, stale/foreign transition use,
   undeclared state changes, multi-step plans, and terminal blocks.

This is intentionally a breaking PoC revision. Compatibility constructors that accept
arbitrary bytes plus a caller-supplied label would recreate the relabeling hole the value
model is meant to close.

---

## 11. Remaining implementation questions

These are concrete design details, not unresolved scope:

1. **Transformer arity.** Start unary (`V -> V'`) or permit multi-input transforms whose
   input label is the fold of all sources?
2. **Read-set precision.** Treat every value serialized into a model prompt as read, or
   add finer runtime tracking later?
3. **Plan search.** Bound enumeration by step count and deterministic preference, or
   initially return only the first valid plan?
   *Answered (Build 2 S7):* the full candidate cartesian is generated with no
   pre-trim cap (a cap starves route categories), then `select_fair` keeps the
   best route per applicable `ExitKind` before filling remaining slots.
   Relatedly, control-release attribution — *which* control deps a release
   must name — is answered by the inclusion-minimal fixpoint release solver
   (Build 2 S5): never over- or under-releases.
4. **Propagation precision.** The conservative output rule folds every dependency; which
   trusted tool contracts may later justify a more precise non-declassifying dependency
   projection?
5. **Failure revisions.** Which rejected attempts advance trajectory revision, and how
   does a failed transition invalidate concurrently minted capabilities?
6. **Value lifetime.** Whether unreachable values remain in the PoC store indefinitely
   or require explicit retention rules.

## Research cross-check

- CaMeL extracts control/data flow from a trusted query and enforces capabilities around
  tool calls: <https://arxiv.org/abs/2503.18813>.
- Fides formalizes agent planners with confidentiality/integrity labels and deterministic
  policy enforcement: <https://arxiv.org/abs/2505.23643>.
- IsolateGPT supports treating raw-reading components as confined rather than trusted by
  prompt: <https://doi.org/10.14722/ndss.2025.241131>.
- Progent separates deterministic privilege narrowing from approval-required expansion,
  which motivates the action-transition domain:
  <https://arxiv.org/abs/2504.11703>.
- Adaptive attacks against indirect prompt-injection defenses reinforce that model-level
  semantic checks are empirical defenses, not algebraic proofs:
  <https://doi.org/10.18653/v1/2025.findings-naacl.395>.
- VIGIL's finite-trace argument/value-flow policies are relevant to future plan-level
  enforcement but are not required for this PoC:
  <https://arxiv.org/abs/2606.26524>.
