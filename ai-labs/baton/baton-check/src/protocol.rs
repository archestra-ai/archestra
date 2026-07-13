//! Wire types and the replay-then-check semantics.
//!
//! One invocation is stateless: the caller sends the full episode so far
//! (`executed`) plus one `proposed` call; baton-check rebuilds the trajectory
//! from scratch, evaluates the proposed call, and reports a decision. Permits
//! are born and consumed inside this single process run, so their linearity
//! never crosses the process boundary.

use std::collections::BTreeSet;

use baton_core::{
    Audience, Authority, AuthorityName, BlockReason, Decision, Effect, Effects, Grant, KnownTrust,
    Label, PolicyEngine, Requirements, Ruling, Speaker, TaintPolicy, ToolContract, ToolName,
    ToolRequest, Trajectory, Trust, UnknownPolicy, UserId, Violation,
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownPolicyIn {
    Deny,
    AllowWithAudit,
    Escalate,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
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
    Blocked {
        block_kind: BlockKind,
        violation_count: usize,
        /// `Display` of reason + violations — informational only.
        detail: String,
    },
}

/// One-to-one, exhaustive image of [`BlockReason`]; the `match` below has no
/// catch-all, so a new core variant is a compile error here, never a silent
/// misreport.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    DeniedByAuthority,
    UnknownDenied,
    RequiresStructuralFix,
    NoCompetentAuthority,
    InternalInvariantFailed,
}

impl From<&BlockReason> for BlockKind {
    fn from(reason: &BlockReason) -> Self {
        match reason {
            BlockReason::DeniedByAuthority { .. } => Self::DeniedByAuthority,
            BlockReason::UnknownDenied => Self::UnknownDenied,
            BlockReason::RequiresStructuralFix => Self::RequiresStructuralFix,
            BlockReason::NoCompetentAuthority => Self::NoCompetentAuthority,
            BlockReason::InternalInvariantFailed => Self::InternalInvariantFailed,
        }
    }
}

/// Universal mandate: covers every grant, so it is always the consulted
/// member, and it always denies. Within the `Authority` contract — a member
/// is consulted once its mandate covers the needed grant, and this mandate
/// covers all of them (the empty grant is covered by all; this extends that
/// to everything).
///
/// Because `rule` never returns `None`, `BlockKind::NoCompetentAuthority` is
/// unreachable under this authority: every escalated flow reports
/// `DeniedByAuthority`. That is deliberate fail-closed harness behavior, not
/// a claim about how a mandated panel would attribute the same block.
struct DenyAll;

impl Authority for DenyAll {
    fn rule(
        &self,
        _needed: &Grant,
        _request: &ToolRequest,
        _context: &Label,
        _violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        Some((
            AuthorityName::new("deny-all"),
            Ruling::Deny {
                reason: "deny-all harness authority never declassifies".to_owned(),
            },
        ))
    }
}

impl From<UnknownPolicyIn> for UnknownPolicy {
    fn from(policy: UnknownPolicyIn) -> Self {
        match policy {
            UnknownPolicyIn::Deny => Self::Deny,
            UnknownPolicyIn::AllowWithAudit => Self::AllowWithAudit,
            UnknownPolicyIn::Escalate => Self::Escalate,
        }
    }
}

impl From<TaintPolicyIn> for TaintPolicy {
    fn from(policy: TaintPolicyIn) -> Self {
        match policy {
            TaintPolicyIn::Allow => Self::Allow,
            TaintPolicyIn::Escalate => Self::Escalate,
        }
    }
}

impl From<TrustIn> for Trust {
    fn from(trust: TrustIn) -> Self {
        match trust {
            TrustIn::Trusted => Self::TRUSTED,
            TrustIn::Suspicious => Self::SUSPICIOUS,
            TrustIn::Unknown => Self::Unknown,
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
            requires: Requirements {
                trust: contract.requires.trust.map(KnownTrust::from),
                audience: Default::default(),
                attention: Default::default(),
                forbid_prior_effects: effect_set(&contract.requires.forbid_prior_effects),
            },
            output_label: Label {
                audience: Audience::Public,
                trust: contract.output.trust.into(),
                effects: Effects::declared(
                    contract.output.effects.iter().copied().map(Effect::from),
                ),
                audit: Vec::new(),
            },
        }
    }
}

impl From<&CallIn> for ToolRequest {
    fn from(call: &CallIn) -> Self {
        let mut request = Self::new(ToolName::new(&call.tool));
        request.recipients = call.recipients.iter().map(UserId::new).collect();
        request
    }
}

fn effect_set(effects: &[EffectIn]) -> BTreeSet<Effect> {
    effects.iter().copied().map(Effect::from).collect()
}

/// A protocol violation: caller and baton-check disagree about the episode. Never
/// a decision — exit 2 upstream.
#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
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
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateContract { tool } => {
                write!(f, "a contract for `{tool}` is declared twice")
            }
            Self::ReplayBlocked { index, tool } => write!(
                f,
                "executed[{index}] `{tool}` was blocked on replay; \
                 the caller must only replay permitted calls"
            ),
            Self::ReplayRejected { index, tool } => {
                write!(
                    f,
                    "executed[{index}] `{tool}`: permit rejected during replay"
                )
            }
        }
    }
}

/// Rebuild the episode and check the proposed call.
pub fn run(input: &Input) -> Result<Output, ProtocolError> {
    let mut engine = PolicyEngine::new(DenyAll, input.unknown_policy.into())
        .with_taint_policy(input.taint_policy.into());
    for contract in &input.contracts {
        engine
            .register(contract.into())
            .map_err(|duplicate| ProtocolError::DuplicateContract {
                tool: duplicate.tool.to_string(),
            })?;
    }

    let mut trajectory = Trajectory::new();
    trajectory.push_message(
        Label::identity(),
        Speaker::user(UserId::new("user")),
        &input.user_prompt,
    );

    for (index, call) in input.executed.iter().enumerate() {
        match engine.evaluate(&trajectory, &call.tool_request()) {
            Decision::Permitted(permit) => {
                trajectory.record_result(permit, "").map_err(|_| {
                    ProtocolError::ReplayRejected {
                        index,
                        tool: call.tool.clone(),
                    }
                })?;
            }
            Decision::Blocked { .. } => {
                return Err(ProtocolError::ReplayBlocked {
                    index,
                    tool: call.tool.clone(),
                });
            }
        }
    }

    Ok(
        match engine.evaluate(&trajectory, &input.proposed.tool_request()) {
            Decision::Permitted(permit) => Output::Permitted {
                audited: !permit.result_label().audit.is_empty(),
                context: trajectory.context_label().to_string(),
            },
            Decision::Blocked { violations, reason } => {
                let detail = std::iter::once(reason.to_string())
                    .chain(violations.iter().map(|v| v.to_string()))
                    .collect::<Vec<_>>()
                    .join("; ");
                Output::Blocked {
                    block_kind: (&reason).into(),
                    violation_count: violations.len(),
                    detail,
                }
            }
        },
    )
}

impl CallIn {
    fn tool_request(&self) -> ToolRequest {
        self.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let Output::Blocked { block_kind, .. } = run(&input(spec)).unwrap() else {
            panic!("deny must block an unregistered tool");
        };
        assert_eq!(block_kind, BlockKind::UnknownDenied);

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
