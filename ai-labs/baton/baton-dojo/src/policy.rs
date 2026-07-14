//! A baton policy gate over the agent's tool calls.
//!
//! [`BatonGate`] links [`baton_core`] in-process (no subprocess, full access to
//! audience/effects labels) and drives baton's enforcement protocol —
//! `evaluate → execute → record_result` — over one run:
//!
//! * [`begin`](BatonGate::begin) seeds a trusted user turn;
//! * [`check`](BatonGate::check) evaluates a proposed call against the folded
//!   context and, on a permit, stashes the linear [`Permit`] for the caller to
//!   execute;
//! * [`commit`](BatonGate::commit) consumes that permit, folding the tool's
//!   contract-fixed output label into the trajectory.
//!
//! Only the user turn and permitted tool results are pushed to the trajectory
//! (assistant text carries no independent label), matching `baton-check`.

use std::collections::HashMap;

use baton_core::{
    AttentionRule, Authority, AuthorityName, Decision, Grant, Label, Permit, PolicyEngine, Ruling, Speaker,
    ToolContract, ToolName, ToolRequest, Trajectory, UnknownPolicy, UserId, Violation,
};

use crate::error::DojoError;

/// The gate's verdict on a proposed tool call.
pub enum GateVerdict {
    /// The call may execute; the gate has stashed the permit for [`BatonGate::commit`].
    Allow,
    /// The call is refused; `reason` is a human-readable block description.
    Block { reason: String },
}

/// A fail-closed harness authority: it holds a universal mandate and always
/// denies, so any escalated flow blocks (`DeniedByAuthority`) rather than being
/// declassified. Mirrors `baton-check`'s authority.
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

/// Type-erases the gate's authority so [`BatonGate`] stays one concrete type
/// (and `Agent`/`run_episode` need no authority type parameter). A local newtype
/// is required: the orphan rule forbids `impl Authority for Box<dyn Authority>`.
struct DynAuthority(Box<dyn Authority + Send + Sync>);

impl Authority for DynAuthority {
    fn rule(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        self.0.rule(needed, request, context, violations)
    }
}

type RecipientFn = Box<dyn Fn(&serde_json::Value) -> Vec<UserId> + Send + Sync>;

/// An in-process baton policy gate carrying one run's trajectory.
pub struct BatonGate {
    engine: PolicyEngine<DynAuthority>,
    recipients: HashMap<String, RecipientFn>,
    trajectory: Trajectory,
    pending: Option<Permit>,
}

impl BatonGate {
    /// Start building a gate. `unknown_policy` governs tools with no contract.
    /// The escalation authority defaults to the fail-closed [`DenyAll`]; override
    /// it with [`BatonGateBuilder::authority`].
    pub fn builder(unknown_policy: UnknownPolicy) -> BatonGateBuilder {
        BatonGateBuilder {
            unknown_policy,
            authority: Box::new(DenyAll),
            contracts: Vec::new(),
            recipients: HashMap::new(),
        }
    }

    /// Seed the trajectory with the (trusted) user prompt.
    pub(crate) fn begin(&mut self, user_prompt: &str) {
        self.trajectory
            .push_message(Label::identity(), Speaker::user(UserId::new("user")), user_prompt);
    }

    /// Evaluate a proposed call. On a permit, the permit is stashed and the
    /// caller must execute the tool and then call [`commit`](BatonGate::commit).
    pub(crate) fn check(&mut self, tool: &str, args: &serde_json::Value) -> GateVerdict {
        let recipients = self.recipients.get(tool).map(|f| f(args)).unwrap_or_default();
        let request = if recipients.is_empty() {
            ToolRequest::new(ToolName::new(tool))
        } else {
            ToolRequest::exposing(ToolName::new(tool), recipients)
        };
        match self.engine.evaluate(&self.trajectory, &request) {
            Decision::Permitted(permit) => {
                self.pending = Some(permit);
                GateVerdict::Allow
            }
            Decision::Blocked { violations, reason } => GateVerdict::Block {
                reason: format!("{reason} [{} violation(s)]", violations.len()),
            },
        }
    }

    /// Fold an executed call's result into the trajectory, consuming the stashed
    /// permit. Called after every permitted execution — including a failed one,
    /// since the tool may have mutated state before erroring.
    pub(crate) fn commit(&mut self, result_content: &str) -> Result<(), DojoError> {
        let permit = self.pending.take().ok_or_else(|| DojoError::Policy {
            detail: "commit called without a pending permit".to_owned(),
        })?;
        self.trajectory
            .record_result(permit, result_content)
            .map_err(|e| DojoError::Policy { detail: e.to_string() })
    }
}

/// Builder for a [`BatonGate`]. Add baton contracts and per-tool recipient
/// extractors, then [`build`](BatonGateBuilder::build).
pub struct BatonGateBuilder {
    unknown_policy: UnknownPolicy,
    authority: Box<dyn Authority + Send + Sync>,
    contracts: Vec<ToolContract>,
    recipients: HashMap<String, RecipientFn>,
}

impl BatonGateBuilder {
    /// Override the escalation authority (default: the fail-closed [`DenyAll`]).
    /// A mandated authority can declassify a boundary-crossing flow it vouches for
    /// (e.g. approving a send to a specific external recipient) instead of blocking.
    pub fn authority(mut self, authority: impl Authority + Send + Sync + 'static) -> Self {
        self.authority = Box::new(authority);
        self
    }

    /// Register a baton contract (baton's real boundary: a tool's `requires` +
    /// `output_label`).
    pub fn contract(mut self, contract: ToolContract) -> Self {
        self.contracts.push(contract);
        self
    }

    /// Declare how to read the audience a tool exposes to from its JSON arguments
    /// (e.g. an email's recipients). Tools without one expose to no one.
    ///
    /// Only consulted by a contract whose `requires.audience` is
    /// `AudienceRule::RecipientsWithinContext`; for other audience rules the
    /// recipients are ignored. For such a contract, an extractor that returns no
    /// recipients (e.g. the arg is missing) yields a structural block.
    pub fn recipients_for(
        mut self,
        tool: &str,
        f: impl Fn(&serde_json::Value) -> Vec<UserId> + Send + Sync + 'static,
    ) -> Self {
        self.recipients.insert(tool.to_owned(), Box::new(f));
        self
    }

    /// Build the gate. Rejects duplicate contracts and any contract requiring an
    /// explicit confirmation (no confirming-turn API this slice).
    pub fn build(self) -> Result<BatonGate, DojoError> {
        let mut engine = PolicyEngine::new(DynAuthority(self.authority), self.unknown_policy);
        for contract in self.contracts {
            if contract.requires.attention == AttentionRule::ExplicitConfirmation {
                return Err(DojoError::UnsupportedContract {
                    detail: format!(
                        "tool `{}` requires explicit confirmation, unsupported this slice",
                        contract.name.as_str()
                    ),
                });
            }
            let tool = contract.name.as_str().to_owned();
            engine
                .register(contract)
                .map_err(|_| DojoError::DuplicateContract { tool })?;
        }
        Ok(BatonGate {
            engine,
            recipients: self.recipients,
            trajectory: Trajectory::new(),
            pending: None,
        })
    }
}
