//! Wire types and the replay-then-check semantics.
//!
//! One invocation is stateless: the caller sends the full episode so far
//! (`executed`) plus one `proposed` call; baton-check rebuilds the trajectory
//! from scratch, evaluates the proposed call, and reports a decision. Permits
//! are born and consumed inside this single process run, so their linearity
//! never crosses the process boundary.

use std::collections::BTreeSet;

use baton_core::contract::Breach;
use baton_core::{
    ArgumentSchema, ArgumentTree, Audience, Authority, AuthorityMandate, Authorization, BlockReason, DeltaCoordinate,
    Effect, Effects, FlowOutcome, FlowRefusal, KnownTrust, OpaqueValue, PolicyEngine, Pursuit, Requirements, Ruling,
    Speaker, ToolContract, ToolName, ToolRequest, Trajectory, TrajectoryView, Trust, UserId, ValueId, ValueLabel,
    Violation,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub unknown_policy: UnknownPolicyIn,
    #[serde(default)]
    pub taint_policy: TaintPolicyIn,
    pub contracts: Vec<ContractIn>,
    pub user_prompt: String,
    #[serde(default)]
    pub executed: Vec<CallIn>,
    pub proposed: CallIn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownPolicyIn {
    Deny,
    AllowWithAudit,
    Escalate,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaintPolicyIn {
    #[default]
    Allow,
    Escalate,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractIn {
    pub tool: String,
    pub output: OutputIn,
    #[serde(default)]
    pub requires: RequiresIn,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputIn {
    pub trust: TrustIn,
    #[serde(default)]
    pub effects: Vec<EffectIn>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustIn {
    Trusted,
    Suspicious,
    Unknown,
}

/// Sink requirements. Deliberately no audience rule: every output label this
/// baton-check mints is `Audience::Public` (there is no per-datum audience source
/// in the wire format yet), and against a public context a
/// recipients-within-context rule could only ever reject the empty recipient
/// set — a knob that cannot do what its name promises. Audience arrives
/// together with per-datum audience data, or not at all.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiresIn {
    #[serde(default)]
    pub trust: Option<KnownTrustIn>,
    #[serde(default)]
    pub forbid_prior_effects: Vec<EffectIn>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownTrustIn {
    Trusted,
    Suspicious,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectIn {
    Mutation,
    Egress,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallIn {
    pub tool: String,
    #[serde(default)]
    pub recipients: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Output {
    Permitted {
        audited: bool,
        /// `Display` of the folded context label after replay — informational
        /// only; callers must never assert on it.
        context: String,
    },
    /// A terminal *policy* outcome: the flow was well-formed and policy
    /// proved (or an authority ruled) it cannot proceed.
    Blocked {
        block_kind: BlockKind,
        violation_count: usize,
        /// `Display` of reason + violations — informational only.
        detail: String,
    },
    /// A protocol/state refusal: the proposal was invalid, stale, or
    /// conflicting — no policy judgment was made.
    Refused {
        refusal_kind: RefusalKind,
        /// `Display` of the refusal — informational only.
        detail: String,
    },
    /// A continuation the stateless oracle could not settle: neither a
    /// policy outcome nor a refusal.
    Unresolved {
        unresolved_kind: UnresolvedKind,
        /// Informational only.
        detail: String,
    },
}

/// Stable wire categories retained for the AgentDojo bridge. Current core
/// reasons are mapped exhaustively below.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    DeniedByAuthority,
    UnknownDenied,
    RequiresStructuralFix,
    NoCompetentAuthority,
    InternalInvariantFailed,
}

/// Wire categories for protocol/state refusals.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefusalKind {
    ActionAlreadyPending,
    EmissionAlreadyPending,
    UnknownValueReferenced,
    StaleBasis,
}

/// Wire categories for unsettled continuations.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedKind {
    NeedsApproval,
    Stalled,
}

// ── The one wire translation ────────────────────────────────────────────
// Every core reason, refusal, and continuation maps to its wire category
// here and nowhere else (the taint/unknown-policy denials below construct
// their `Blocked` outcomes through `unknown_denied_outcome`/`degrade_outcome`
// in this section too).

fn block_kind(reason: &BlockReason) -> BlockKind {
    match reason {
        BlockReason::DeniedByAuthority { .. } => BlockKind::DeniedByAuthority,
        BlockReason::RequiresStructuralFix => BlockKind::RequiresStructuralFix,
        BlockReason::NoRemedy | BlockReason::NoAuthorityRuled => BlockKind::NoCompetentAuthority,
        BlockReason::PostconditionFailed => BlockKind::InternalInvariantFailed,
    }
}

fn refusal_kind(refusal: &FlowRefusal) -> RefusalKind {
    match refusal {
        FlowRefusal::ActionAlreadyPending { .. } => RefusalKind::ActionAlreadyPending,
        FlowRefusal::EmissionAlreadyPending { .. } => RefusalKind::EmissionAlreadyPending,
        FlowRefusal::UnknownValueReferenced { .. } => RefusalKind::UnknownValueReferenced,
        FlowRefusal::StaleBasis { .. } => RefusalKind::StaleBasis,
    }
}

fn acquires_effects(grant: &Authorization) -> bool {
    grant
        .delta()
        .coordinates()
        .any(|coordinate| matches!(coordinate, DeltaCoordinate::AcquireEffects(_)))
}

fn approve_effect_growth(
    grant: &Authorization,
    _violations: &[Violation],
    _trajectory: &TrajectoryView<'_>,
) -> Option<Ruling> {
    acquires_effects(grant).then(|| Ruling::Approve {
        reason: "legacy baton-check treats declared effects as ordinary trajectory state".to_owned(),
    })
}

fn approve_unknown(
    grant: &Authorization,
    violations: &[Violation],
    _trajectory: &TrajectoryView<'_>,
) -> Option<Ruling> {
    (!acquires_effects(grant)
        && !violations.is_empty()
        && violations.iter().all(|violation| {
            matches!(
                violation,
                Violation::Unprovable(_) | Violation::Breach(Breach::SurfaceGrowth { .. })
            )
        }))
    .then(|| Ruling::Approve {
        reason: "legacy allow_with_audit policy acknowledged the unknown flow".to_owned(),
    })
}

fn deny_all(_grant: &Authorization, _violations: &[Violation], _trajectory: &TrajectoryView<'_>) -> Option<Ruling> {
    Some(Ruling::Deny {
        reason: "deny-all harness authority never declassifies".to_owned(),
    })
}

fn broad_mandate() -> AuthorityMandate {
    AuthorityMandate::none()
        .endorse_trust(KnownTrust::Trusted)
        .waive_prior_effects()
        .confirms()
        .acknowledge_unknown()
        .release_control()
        .acquire_effects()
}

impl From<TrustIn> for Trust {
    fn from(trust: TrustIn) -> Self {
        match trust {
            TrustIn::Trusted => Self::TRUSTED,
            TrustIn::Suspicious => Self::SUSPICIOUS,
            TrustIn::Unknown => Self::UNKNOWN,
        }
    }
}

impl From<KnownTrustIn> for KnownTrust {
    fn from(trust: KnownTrustIn) -> Self {
        match trust {
            KnownTrustIn::Trusted => Self::Trusted,
            KnownTrustIn::Suspicious => Self::Suspicious,
        }
    }
}

impl From<EffectIn> for Effect {
    fn from(effect: EffectIn) -> Self {
        match effect {
            EffectIn::Mutation => Self::Mutation,
            EffectIn::Egress => Self::Egress,
        }
    }
}

impl From<&ContractIn> for ToolContract {
    fn from(contract: &ContractIn) -> Self {
        Self {
            name: ToolName::new(&contract.tool),
            // `RequiresIn`'s JSON wire uses `#[serde(default)]`, so an absent
            // `requires` and an explicit `requires: {}` are indistinguishable
            // on this wire — baton-check always builds known requirements
            // here; honoring absent-means-`None` over JSON is out of scope.
            requires: Some(Requirements {
                trust: contract.requires.trust.map(KnownTrust::from),
                audience: Default::default(),
                attention: Default::default(),
                forbid_prior_effects: effect_set(&contract.requires.forbid_prior_effects),
            }),
            output_label: ValueLabel {
                audience: Audience::PUBLIC,
                trust: contract.output.trust.into(),
            },
            effects: Effects::declared(contract.output.effects.iter().copied().map(Effect::from)),
            arguments: ArgumentSchema::opaque(),
        }
    }
}

fn effect_set(effects: &[EffectIn]) -> BTreeSet<Effect> {
    effects.iter().copied().map(Effect::from).collect()
}

/// A protocol violation: caller and baton-check disagree about the episode. Never
/// a decision — exit 2 upstream.
#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    DuplicateAuthority {
        authority: String,
    },
    DuplicateContract {
        tool: String,
    },
    /// A replayed `executed` call came back `Blocked`; the caller only
    /// appends permitted calls, so this must be loud.
    ReplayBlocked {
        index: usize,
        tool: String,
    },
    /// `record_result` rejected a permit during replay — a baton-check bug, since
    /// nothing else touches the trajectory between evaluate and record.
    ReplayRejected {
        index: usize,
        tool: String,
    },
    ProposedRejected {
        tool: String,
    },
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateAuthority { authority } => {
                write!(f, "internal authority `{authority}` was registered twice")
            }
            Self::DuplicateContract { tool } => {
                write!(f, "a contract for `{tool}` is declared twice")
            }
            Self::ReplayBlocked { index, tool } => write!(
                f,
                "executed[{index}] `{tool}` was blocked on replay; \
                 the caller must only replay permitted calls"
            ),
            Self::ReplayRejected { index, tool } => {
                write!(f, "executed[{index}] `{tool}`: permit rejected during replay")
            }
            Self::ProposedRejected { tool } => {
                write!(f, "proposed `{tool}`: execution token rejected")
            }
        }
    }
}

enum CallOutcome {
    Permitted {
        value: ValueId,
        audited: bool,
    },
    Blocked {
        block_kind: BlockKind,
        violation_count: usize,
        detail: String,
    },
    Refused {
        refusal_kind: RefusalKind,
        detail: String,
    },
    Unresolved {
        unresolved_kind: UnresolvedKind,
        detail: String,
    },
}

#[derive(Debug)]
enum CallError {
    DependencyRejected,
    TokenRejected,
}

fn configure_authorities(engine: &mut PolicyEngine, unknown_policy: UnknownPolicyIn) -> Result<(), ProtocolError> {
    let mut authorities = vec![Authority::inline(
        "legacy-effects",
        AuthorityMandate::none().acquire_effects(),
        approve_effect_growth,
    )];
    if unknown_policy == UnknownPolicyIn::AllowWithAudit {
        authorities.push(Authority::inline("allow-unknown", broad_mandate(), approve_unknown));
    }
    authorities.push(Authority::inline("deny-all", broad_mandate(), deny_all));

    for authority in authorities {
        engine.register_authority(authority).map_err(|refused| match refused {
            baton_core::RegistrationRefused::Duplicate(duplicate) => ProtocolError::DuplicateAuthority {
                authority: duplicate.id,
            },
            baton_core::RegistrationRefused::Frozen(_) => {
                unreachable!("authorities are registered before any evaluation")
            }
        })?;
    }
    Ok(())
}

fn folded_context(trajectory: &Trajectory, context: &BTreeSet<ValueId>) -> Result<ValueLabel, CallError> {
    context
        .iter()
        .map(|value| {
            trajectory
                .value(*value)
                .map(|stored| stored.label().clone())
                .map_err(|_| CallError::DependencyRejected)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(ValueLabel::fold)
}

fn tool_request(
    trajectory: &mut Trajectory,
    context: &BTreeSet<ValueId>,
    call: &CallIn,
) -> Result<ToolRequest, CallError> {
    let mut recipients = Vec::with_capacity(call.recipients.len());
    for recipient in &call.recipients {
        let value = trajectory
            .admit_model_output(OpaqueValue::new(recipient), context.clone(), context.clone())
            .map_err(|_| CallError::DependencyRejected)?;
        recipients.push(ArgumentTree::Value(value));
    }
    Ok(ToolRequest::new(
        ToolName::new(&call.tool),
        ArgumentTree::object([("recipients", ArgumentTree::List(recipients))]),
        context.iter().copied(),
    ))
}

fn would_degrade(trajectory: &Trajectory, context: &ValueLabel, contract: Option<&ContractIn>) -> bool {
    let (output_label, effects) = match contract {
        Some(contract) => (
            ValueLabel {
                audience: Audience::PUBLIC,
                trust: contract.output.trust.into(),
            },
            Effects::declared(contract.output.effects.iter().copied().map(Effect::from)),
        ),
        None => (ValueLabel::unknown(), Effects::UNKNOWN),
    };
    context.clone().combine(output_label) != *context
        || trajectory.past_effects().clone().combine(effects) != *trajectory.past_effects()
}

fn blocked_violations<P>(blocked: &FlowOutcome<P>) -> &[Violation] {
    match blocked {
        FlowOutcome::AllowedNow(_) => &[],
        FlowOutcome::Terminal { violations, .. } | FlowOutcome::Remediable { violations, .. } => violations,
    }
}

/// A protocol/state refusal, kept on the wire where these cases mapped
/// before the outcome/refusal split (the wire redesign lands separately).
fn refused_outcome(refusal: &FlowRefusal) -> CallOutcome {
    CallOutcome::Refused {
        refusal_kind: refusal_kind(refusal),
        detail: refusal.to_string(),
    }
}

fn unresolved_outcome(kind: UnresolvedKind, detail: String) -> CallOutcome {
    CallOutcome::Unresolved {
        unresolved_kind: kind,
        detail,
    }
}

fn blocked_outcome(reason: &BlockReason, violations: &[Violation]) -> CallOutcome {
    let detail = std::iter::once(reason.to_string())
        .chain(violations.iter().map(ToString::to_string))
        .collect::<Vec<_>>()
        .join("; ");
    CallOutcome::Blocked {
        block_kind: block_kind(reason),
        violation_count: violations.len(),
        detail,
    }
}

fn dispatch(
    trajectory: &mut Trajectory,
    token: baton_core::ExecutionToken,
    audited: bool,
) -> Result<CallOutcome, CallError> {
    let (_, receipt) = trajectory.release(token).map_err(|_| CallError::TokenRejected)?;
    let value = trajectory
        .record_output(receipt, OpaqueValue::new(""))
        .map_err(|_| CallError::TokenRejected)?;
    Ok(CallOutcome::Permitted { value, audited })
}

fn evaluate_call(
    engine: &PolicyEngine,
    trajectory: &mut Trajectory,
    context: &BTreeSet<ValueId>,
    call: &CallIn,
    contract: Option<&ContractIn>,
    unknown_policy: UnknownPolicyIn,
    taint_policy: TaintPolicyIn,
) -> Result<CallOutcome, CallError> {
    let context_label = folded_context(trajectory, context)?;
    if taint_policy == TaintPolicyIn::Escalate && would_degrade(trajectory, &context_label, contract) {
        let (block_kind, violation_count) = match (contract, unknown_policy) {
            (None, UnknownPolicyIn::Deny) => (BlockKind::UnknownDenied, 2),
            _ => (BlockKind::DeniedByAuthority, 1 + usize::from(contract.is_none())),
        };
        return Ok(CallOutcome::Blocked {
            block_kind,
            violation_count,
            detail: "tool output would degrade the trajectory context".to_owned(),
        });
    }

    let request = tool_request(trajectory, context, call)?;
    match engine.evaluate(trajectory, request.clone()) {
        Err(refusal) => Ok(refused_outcome(&refusal)),
        Ok(FlowOutcome::AllowedNow(token)) => dispatch(trajectory, token, false),
        Ok(blocked) => {
            let violations = blocked_violations(&blocked);
            let has_unknown = violations
                .iter()
                .any(|violation| matches!(violation, Violation::Unprovable(_)));
            if unknown_policy == UnknownPolicyIn::Deny && has_unknown {
                let detail = violations
                    .iter()
                    .filter(|violation| !matches!(violation, Violation::Breach(Breach::SurfaceGrowth { .. })))
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("; ");
                let violation_count = violations
                    .iter()
                    .filter(|violation| !matches!(violation, Violation::Breach(Breach::SurfaceGrowth { .. })))
                    .count();
                trajectory
                    .abandon_pending()
                    .expect("an oracle-denied action was never released");
                return Ok(CallOutcome::Blocked {
                    block_kind: BlockKind::UnknownDenied,
                    violation_count,
                    detail,
                });
            }
            let audited = unknown_policy == UnknownPolicyIn::AllowWithAudit && has_unknown;
            // Step budget, not policy: a plan peels at most a handful of
            // remedies per involved value (raise, lift, acquire, release),
            // so 4×(context + recipients) + 8 comfortably exceeds any real
            // walk while keeping a runaway re-planning loop finite. Hitting
            // it reports `unresolved` (stall), never a policy outcome.
            let max_steps = context
                .len()
                .saturating_add(call.recipients.len())
                .saturating_mul(4)
                .saturating_add(8);
            match engine.pursue(trajectory, request, max_steps) {
                Pursuit::Permitted(token) => dispatch(trajectory, token, audited),
                Pursuit::Terminal { violations, reason } => Ok(blocked_outcome(&reason, &violations)),
                Pursuit::NeedsApproval(pending) => Ok(unresolved_outcome(
                    UnresolvedKind::NeedsApproval,
                    format!("needs an external ruling from {}", pending.authority()),
                )),
                Pursuit::Stalled { violations, cause } => Ok(unresolved_outcome(
                    UnresolvedKind::Stalled,
                    format!("remedy pursuit stalled ({} violations): {cause:?}", violations.len()),
                )),
                Pursuit::Refused(refusal) => Ok(refused_outcome(&refusal)),
            }
        }
    }
}

/// Rebuild the episode and check the proposed call.
pub fn run(input: &Input) -> Result<Output, ProtocolError> {
    let mut engine = PolicyEngine::new();
    configure_authorities(&mut engine, input.unknown_policy)?;
    for contract in &input.contracts {
        engine.register(contract.into()).map_err(|refused| match refused {
            baton_core::ContractRefused::Duplicate(duplicate) => ProtocolError::DuplicateContract {
                tool: duplicate.tool.to_string(),
            },
            baton_core::ContractRefused::Frozen(_) => {
                unreachable!("contracts are registered before any evaluation")
            }
        })?;
    }

    let mut trajectory = Trajectory::new();
    let prompt = trajectory.ingress(
        Speaker::user(UserId::new("user")),
        ValueLabel::identity(),
        OpaqueValue::new(input.user_prompt.as_str()),
    );
    let mut context = BTreeSet::from([prompt]);

    for (index, call) in input.executed.iter().enumerate() {
        let contract = input.contracts.iter().find(|contract| contract.tool == call.tool);
        match evaluate_call(
            &engine,
            &mut trajectory,
            &context,
            call,
            contract,
            input.unknown_policy,
            input.taint_policy,
        )
        .map_err(|_| ProtocolError::ReplayRejected {
            index,
            tool: call.tool.clone(),
        })? {
            CallOutcome::Permitted { value, .. } => {
                context.insert(value);
            }
            CallOutcome::Blocked { .. } | CallOutcome::Refused { .. } | CallOutcome::Unresolved { .. } => {
                return Err(ProtocolError::ReplayBlocked {
                    index,
                    tool: call.tool.clone(),
                });
            }
        }
    }

    let context_label = folded_context(&trajectory, &context).map_err(|_| ProtocolError::ProposedRejected {
        tool: input.proposed.tool.clone(),
    })?;
    let contract = input
        .contracts
        .iter()
        .find(|contract| contract.tool == input.proposed.tool);
    match evaluate_call(
        &engine,
        &mut trajectory,
        &context,
        &input.proposed,
        contract,
        input.unknown_policy,
        input.taint_policy,
    )
    .map_err(|_| ProtocolError::ProposedRejected {
        tool: input.proposed.tool.clone(),
    })? {
        CallOutcome::Permitted { audited, .. } => Ok(Output::Permitted {
            audited,
            context: context_label.to_string(),
        }),
        CallOutcome::Blocked {
            block_kind,
            violation_count,
            detail,
        } => Ok(Output::Blocked {
            block_kind,
            violation_count,
            detail,
        }),
        CallOutcome::Refused { refusal_kind, detail } => Ok(Output::Refused { refusal_kind, detail }),
        CallOutcome::Unresolved {
            unresolved_kind,
            detail,
        } => Ok(Output::Unresolved {
            unresolved_kind,
            detail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract: every decision tag and category string, pinned.
    /// These strings are the oracle's public API — the Python bridge
    /// dispatches on them.
    #[test]
    fn wire_decisions_and_categories_serialize_stably() {
        let permitted = serde_json::to_value(Output::Permitted {
            audited: false,
            context: "ctx".to_owned(),
        })
        .unwrap();
        assert_eq!(permitted["decision"], "permitted");
        let blocked = serde_json::to_value(Output::Blocked {
            block_kind: BlockKind::DeniedByAuthority,
            violation_count: 0,
            detail: String::new(),
        })
        .unwrap();
        assert_eq!(blocked["decision"], "blocked");
        let refused = serde_json::to_value(Output::Refused {
            refusal_kind: RefusalKind::StaleBasis,
            detail: String::new(),
        })
        .unwrap();
        assert_eq!(refused["decision"], "refused");
        let unresolved = serde_json::to_value(Output::Unresolved {
            unresolved_kind: UnresolvedKind::Stalled,
            detail: String::new(),
        })
        .unwrap();
        assert_eq!(unresolved["decision"], "unresolved");

        for (kind, wire) in [
            (BlockKind::DeniedByAuthority, "denied_by_authority"),
            (BlockKind::UnknownDenied, "unknown_denied"),
            (BlockKind::RequiresStructuralFix, "requires_structural_fix"),
            (BlockKind::NoCompetentAuthority, "no_competent_authority"),
            (BlockKind::InternalInvariantFailed, "internal_invariant_failed"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), wire);
        }
        for (kind, wire) in [
            (RefusalKind::ActionAlreadyPending, "action_already_pending"),
            (RefusalKind::EmissionAlreadyPending, "emission_already_pending"),
            (RefusalKind::UnknownValueReferenced, "unknown_value_referenced"),
            (RefusalKind::StaleBasis, "stale_basis"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), wire);
        }
        for (kind, wire) in [
            (UnresolvedKind::NeedsApproval, "needs_approval"),
            (UnresolvedKind::Stalled, "stalled"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), wire);
        }
    }

    fn input(json: serde_json::Value) -> Input {
        serde_json::from_value(json).expect("test input parses")
    }

    fn workspace_ish(unknown_policy: &str) -> serde_json::Value {
        serde_json::json!({
            "unknown_policy": unknown_policy,
            "contracts": [
                {"tool": "get_unread_emails", "output": {"trust": "suspicious"}},
                {"tool": "get_current_day", "output": {"trust": "trusted"}},
                {"tool": "send_email", "output": {"trust": "trusted"},
                 "requires": {"trust": "trusted"}},
            ],
            "user_prompt": "summarize my unread emails",
            "executed": [],
            "proposed": {"tool": "send_email", "recipients": ["mark@example.com"]},
        })
    }

    #[test]
    fn clean_context_permits_trusted_sink() {
        let mut spec = workspace_ish("deny");
        spec["executed"] = serde_json::json!([{"tool": "get_current_day"}]);
        let output = run(&input(spec)).unwrap();
        assert!(matches!(output, Output::Permitted { audited: false, .. }));
    }

    #[test]
    fn taint_escalation_blocks_a_degrading_output() {
        let mut spec = workspace_ish("escalate");
        spec["taint_policy"] = serde_json::json!("escalate");
        spec["proposed"] = serde_json::json!({"tool": "get_unread_emails"});
        let Output::Blocked { block_kind, .. } = run(&input(spec)).unwrap() else {
            panic!("a degrading output must escalate");
        };
        assert_eq!(block_kind, BlockKind::DeniedByAuthority);
    }

    #[test]
    fn tainted_context_blocks_trusted_sink_via_authority() {
        for policy in ["deny", "allow_with_audit", "escalate"] {
            let mut spec = workspace_ish(policy);
            spec["executed"] = serde_json::json!([{"tool": "get_unread_emails"}]);
            let output = run(&input(spec)).unwrap();
            let Output::Blocked {
                block_kind,
                violation_count,
                ..
            } = output
            else {
                panic!("expected a block under {policy}");
            };
            assert_eq!(block_kind, BlockKind::DeniedByAuthority, "under {policy}");
            assert!(violation_count >= 1, "under {policy}");
        }
    }

    #[test]
    fn unregistered_tool_disposition_follows_unknown_policy() {
        let proposed = serde_json::json!({"tool": "mystery_tool"});

        let mut spec = workspace_ish("deny");
        spec["proposed"] = proposed.clone();
        let Output::Blocked {
            block_kind,
            violation_count,
            ..
        } = run(&input(spec)).unwrap()
        else {
            panic!("deny must block an unregistered tool");
        };
        assert_eq!(block_kind, BlockKind::UnknownDenied);
        assert_eq!(violation_count, 1);

        let mut spec = workspace_ish("allow_with_audit");
        spec["proposed"] = proposed.clone();
        let Output::Permitted { audited, .. } = run(&input(spec)).unwrap() else {
            panic!("allow_with_audit must audit an unregistered tool through");
        };
        assert!(audited);

        let mut spec = workspace_ish("escalate");
        spec["proposed"] = proposed;
        let Output::Blocked { block_kind, .. } = run(&input(spec)).unwrap() else {
            panic!("escalate + deny-all must block an unregistered tool");
        };
        assert_eq!(block_kind, BlockKind::DeniedByAuthority);
    }

    #[test]
    fn unknown_taint_poisons_later_trusted_sink() {
        // An audited-through unknown tool degrades the fold: the sink is then
        // unprovable, not a breach.
        let mut spec = workspace_ish("allow_with_audit");
        spec["contracts"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"tool": "mystery_tool", "output": {"trust": "unknown"}}));
        spec["executed"] = serde_json::json!([{"tool": "mystery_tool"}]);
        let Output::Permitted { audited, .. } = run(&input(spec)).unwrap() else {
            panic!("allow_with_audit lets the unprovable sink flow through, audited");
        };
        assert!(audited);
    }

    #[test]
    fn replayed_blocked_call_is_a_protocol_error() {
        let mut spec = workspace_ish("deny");
        spec["executed"] = serde_json::json!([
            {"tool": "get_unread_emails"},
            {"tool": "send_email", "recipients": ["mark@example.com"]},
        ]);
        assert_eq!(
            run(&input(spec)).unwrap_err(),
            ProtocolError::ReplayBlocked {
                index: 1,
                tool: "send_email".to_owned(),
            }
        );
    }

    #[test]
    fn duplicate_contract_is_a_protocol_error() {
        let mut spec = workspace_ish("deny");
        spec["contracts"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"tool": "send_email", "output": {"trust": "trusted"}}));
        assert_eq!(
            run(&input(spec)).unwrap_err(),
            ProtocolError::DuplicateContract {
                tool: "send_email".to_owned(),
            }
        );
    }

    #[test]
    fn forbid_prior_effects_blocks_after_effectful_call() {
        let spec = serde_json::json!({
            "unknown_policy": "deny",
            "contracts": [
                {"tool": "send_email", "output": {"trust": "trusted", "effects": ["egress"]},
                 "requires": {"trust": "trusted"}},
                {"tool": "generate_report", "output": {"trust": "trusted"},
                 "requires": {"forbid_prior_effects": ["egress"]}},
            ],
            "user_prompt": "report, then mail it",
            "executed": [{"tool": "send_email", "recipients": ["mark@example.com"]}],
            "proposed": {"tool": "generate_report"},
        });
        let Output::Blocked { block_kind, .. } = run(&input(spec)).unwrap() else {
            panic!("prior egress must block the effect-guarded tool");
        };
        assert_eq!(block_kind, BlockKind::DeniedByAuthority);
    }

    #[test]
    fn audience_rules_are_not_expressible() {
        // See RequiresIn: with every output label public, an audience rule
        // could not do what its name promises, so the wire format rejects it.
        let spec = serde_json::json!({
            "unknown_policy": "deny",
            "contracts": [
                {"tool": "send_email", "output": {"trust": "trusted"},
                 "requires": {"trust": "trusted", "recipients_within_context": true}},
            ],
            "user_prompt": "mail it",
            "proposed": {"tool": "send_email"},
        });
        assert!(serde_json::from_value::<Input>(spec).is_err());
    }

    #[test]
    fn unknown_enum_values_fail_to_parse() {
        let spec = serde_json::json!({
            "unknown_policy": "shrug",
            "contracts": [],
            "user_prompt": "",
            "proposed": {"tool": "x"},
        });
        assert!(serde_json::from_value::<Input>(spec).is_err());
    }

    #[test]
    fn output_serializes_snake_case() {
        let blocked = Output::Blocked {
            block_kind: BlockKind::UnknownDenied,
            violation_count: 1,
            detail: String::new(),
        };
        let value = serde_json::to_value(&blocked).unwrap();
        assert_eq!(value["decision"], "blocked");
        assert_eq!(value["block_kind"], "unknown_denied");
    }
}
