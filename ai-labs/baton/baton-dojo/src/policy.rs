//! A baton policy gate over the agent's tool calls.
//!
//! [`BatonGate`] links [`baton_core`] in-process (no subprocess, full access to
//! audience/effects labels) and drives baton's value-granular enforcement
//! protocol — `evaluate → release → record_output` — over one run:
//!
//! * [`begin`](BatonGate::begin) seeds a trusted user turn;
//! * [`check`](BatonGate::check) evaluates a proposed call against the folded
//!   read context; a downhill call yields an [`ExecutionToken`] directly, while
//!   a remediable one is driven through its plan by the registered inline
//!   authorities (a durable endorse, an effect accept) to a permit or a block;
//! * [`commit`](BatonGate::commit) releases the stashed token and folds the
//!   tool's contract-fixed output label into the trajectory as a new value.
//!
//! The engine is value-granular: a request names the values it depends on. The
//! gate cannot see the model's real per-argument data-flow, so it conservatively
//! folds the *whole* read context (the user turn and every prior tool output)
//! into each call as its *body* argument leaves — the over-approximation of "the
//! agent has seen all of this". Body leaves are endorsable, so a mandated
//! authority can declassify the data in for a recipient.
//!
//! PoC limitations of this coarse gate (all pre-dating and preserved by the
//! value-granular port; see the follow-up ledger): the checked request is a
//! whole-context proxy, not the exact JSON the agent dispatches; `commit`
//! releases after the tool ran (not the engine's release-before-dispatch order);
//! and control-only influence is modelled as endorsable data (so an authority
//! without control-release competence can clear it). Acceptable for a benchmark
//! substrate; a faithful gate needs the model's real argument provenance.

use std::collections::HashMap;

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, AttentionRule, Authority, ExecutionToken, OpaqueValue, PolicyEngine,
    Pursuit, Speaker, StallCause, ToolContract, ToolName, ToolRequest, Trajectory, UserId, ValueId, ValueLabel,
    Violation,
};

use crate::error::DojoError;

/// The gate's verdict on a proposed tool call.
pub enum GateVerdict {
    /// The call may execute; the gate has stashed the permit for [`BatonGate::commit`].
    Allow,
    /// The call is refused; `reason` is a human-readable block description.
    Block { reason: String },
}

/// The internal argument key under which the gate places a call's resolved
/// recipients. Each recipient-bearing contract's [`ArgumentSchema`] is wired to
/// read recipients from this key, so it is a fixed part of the *policy* request,
/// not the tool's own JSON argument name.
const RECIPIENT_ARG: &str = "__recipients";

/// The internal argument key under which the gate places the run's read context
/// as the call's body — argument leaves (endorsable), not control deps.
const BODY_ARG: &str = "__body";

type RecipientFn = Box<dyn Fn(&serde_json::Value) -> Vec<UserId> + Send + Sync>;

/// An in-process baton policy gate carrying one run's trajectory.
pub struct BatonGate {
    engine: PolicyEngine,
    recipients: HashMap<String, RecipientFn>,
    trajectory: Trajectory,
    /// Every value committed so far (the user turn and each tool output). Folded
    /// as the control dependencies of every proposed call — see the module doc.
    context: Vec<ValueId>,
    pending: Option<ExecutionToken>,
}

impl BatonGate {
    /// Start building a gate. With no registered authority the gate is fully
    /// fail-closed: any non-downhill flow blocks. Register authorities with
    /// [`BatonGateBuilder::authority`] to let a mandated sign-off declassify.
    pub fn builder() -> BatonGateBuilder {
        BatonGateBuilder {
            authorities: Vec::new(),
            contracts: Vec::new(),
            recipients: HashMap::new(),
        }
    }

    /// Seed the trajectory with the (trusted) user prompt.
    pub(crate) fn begin(&mut self, user_prompt: &str) {
        let id = self.trajectory.ingress(
            Speaker::user(UserId::new("user")),
            ValueLabel::identity(),
            OpaqueValue::new(user_prompt),
        );
        self.context.push(id);
    }

    /// Evaluate a proposed call. A downhill call permits directly; a remediable
    /// one is driven through its first plan by the registered inline authorities.
    /// On a permit the token is stashed and the caller must execute the tool and
    /// then call [`commit`](BatonGate::commit).
    pub(crate) fn check(&mut self, tool: &str, args: &serde_json::Value) -> GateVerdict {
        // Refuse before touching the trajectory: building a request ingresses
        // recipient values, which advances the revision and would stale the
        // stashed token — the previous permit must be committed first.
        if self.pending.is_some() {
            return GateVerdict::Block {
                reason: "a permitted call is awaiting commit".to_owned(),
            };
        }
        let request = self.build_request(tool, args);
        // A plan needs at most one Endorse per audience-failing context leaf,
        // plus an Accept and a waiver. Bound the walk on the context, not a
        // fixed count, so a longer run still converges; the bound is a
        // fail-closed backstop, not the expected path.
        let max_steps = self.context.len() + 8;
        match self.engine.pursue(&mut self.trajectory, request, max_steps) {
            Pursuit::Permitted(token) => {
                self.pending = Some(token);
                GateVerdict::Allow
            }
            // The engine cleared this request's slot on a terminal block.
            Pursuit::Terminal(block) => GateVerdict::Block {
                reason: block.reason.to_string(),
            },
            // Inline authorities resolve synchronously; a needs-approval means
            // only an out-of-process authority could clear it, which this
            // in-process gate cannot answer — fail closed, discarding the
            // approval and freeing the slot the pursuit deliberately kept.
            Pursuit::NeedsApproval(pending) => {
                let reason = format!("needs external ruling from {}", pending.authority());
                drop(pending);
                self.trajectory.abandon_pending();
                GateVerdict::Block { reason }
            }
            // A stalled pursuit already abandoned the pending action.
            Pursuit::Stalled { violations, cause } => GateVerdict::Block {
                reason: match cause {
                    StallCause::BoundExhausted => "remedy did not converge within the step bound".to_owned(),
                    StallCause::Refused(refused) => {
                        format!("policy step refused: {refused:?}; {}", block_reason(&violations))
                    }
                    StallCause::Failed(failure) => format!("remedy step failed: {failure:?}"),
                },
            },
        }
    }

    /// Fold an executed call's result into the trajectory, consuming the stashed
    /// token via the two-phase `release → record_output`. Called after every
    /// permitted execution — including a failed one, since the tool may have
    /// mutated state before erroring.
    pub(crate) fn commit(&mut self, result_content: &str) -> Result<(), DojoError> {
        let token = self.pending.take().ok_or_else(|| DojoError::Policy {
            detail: "commit called without a pending token".to_owned(),
        })?;
        let (_canonical, receipt) = self.trajectory.release(token).map_err(|e| DojoError::Policy {
            detail: format!("{e:?}"),
        })?;
        let id = self
            .trajectory
            .record_output(receipt, OpaqueValue::new(result_content))
            .map_err(|e| DojoError::Policy {
                detail: format!("{e:?}"),
            })?;
        self.context.push(id);
        Ok(())
    }

    /// Build the value-granular request. The whole read context is folded in as
    /// the call's *body* — argument leaves, not control deps — so an authority
    /// can endorse the tainted data in for a recipient (a control dep could only
    /// be released). Recipients (if any) sit under the recipient key.
    fn build_request(&mut self, tool: &str, args: &serde_json::Value) -> ToolRequest {
        let body: Vec<ArgumentTree<ValueId>> = self.context.iter().copied().map(ArgumentTree::Value).collect();
        let mut fields = vec![(ArgumentName::new(BODY_ARG), ArgumentTree::List(body))];
        if let Some(recipients) = self.recipients.get(tool).map(|extract| extract(args)) {
            let leaves = recipients
                .into_iter()
                .map(|uid| {
                    let id = self.trajectory.ingress(
                        Speaker::user(UserId::new("user")),
                        ValueLabel::identity(),
                        OpaqueValue::new(uid.as_str()),
                    );
                    ArgumentTree::Value(id)
                })
                .collect();
            fields.push((ArgumentName::new(RECIPIENT_ARG), ArgumentTree::List(leaves)));
        }
        ToolRequest::new(ToolName::new(tool), ArgumentTree::object(fields), [])
    }
}

/// One line per violation, for a human-readable block reason.
fn block_reason(violations: &[Violation]) -> String {
    violations
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Builder for a [`BatonGate`]. Add baton contracts, escalation authorities, and
/// per-tool recipient extractors, then [`build`](BatonGateBuilder::build).
pub struct BatonGateBuilder {
    authorities: Vec<Authority>,
    contracts: Vec<ToolContract>,
    recipients: HashMap<String, RecipientFn>,
}

impl BatonGateBuilder {
    /// Register an escalation authority. A mandated authority can declassify a
    /// boundary-crossing flow it vouches for (e.g. endorsing a send to a specific
    /// external recipient, or accepting an effect's first egress) instead of
    /// blocking. With none registered the gate is fully fail-closed.
    pub fn authority(mut self, authority: Authority) -> Self {
        self.authorities.push(authority);
        self
    }

    /// Register a baton contract (baton's real boundary: a tool's `requires`,
    /// `output_label`, and declared `effects`).
    pub fn contract(mut self, contract: ToolContract) -> Self {
        self.contracts.push(contract);
        self
    }

    /// Declare how to read the audience a tool exposes to from its JSON arguments
    /// (e.g. an email's recipients). Tools without one expose to no one.
    ///
    /// Only consulted by a contract whose `requires.audience` is
    /// `AudienceRule::FromRecipients`; for other audience rules the
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

    /// Build the gate. Rejects duplicate authorities and contracts, and any
    /// contract requiring an explicit confirmation (no confirming-turn API this
    /// slice). Contracts for tools with a recipient extractor have their argument
    /// schema wired to the gate's recipient key.
    pub fn build(self) -> Result<BatonGate, DojoError> {
        let mut engine = PolicyEngine::new();
        for authority in self.authorities {
            engine.register_authority(authority).map_err(|e| DojoError::Policy {
                detail: format!("{e:?}"),
            })?;
        }
        for mut contract in self.contracts {
            // `None` (unknown requirements) never declares an explicit
            // confirmation demand — that is a distinct fail-closed gap the
            // engine enforces itself (`RequirementsUnknown`), not this
            // slice's "no confirming-turn API" restriction.
            let wants_confirmation = contract
                .requires
                .as_ref()
                .is_some_and(|requires| requires.attention == AttentionRule::ExplicitConfirmation);
            if wants_confirmation {
                return Err(DojoError::UnsupportedContract {
                    detail: format!(
                        "tool `{}` requires explicit confirmation, unsupported this slice",
                        contract.name.as_str()
                    ),
                });
            }
            let tool = contract.name.as_str().to_owned();
            if self.recipients.contains_key(&tool) {
                contract.arguments = ArgumentSchema::with_recipients(ArgumentName::new(RECIPIENT_ARG));
            }
            engine
                .register(contract)
                .map_err(|_| DojoError::DuplicateContract { tool })?;
        }
        Ok(BatonGate {
            engine,
            recipients: self.recipients,
            trajectory: Trajectory::new(),
            context: Vec::new(),
            pending: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use baton_core::{
        Audience, AudienceRule, Authority, AuthorityMandate, Effect, Effects, ProposedGrant, Requirements, Ruling,
        ToolContract, ToolName, TrajectoryView, Trust, UserId, ValueLabel, Violation,
    };
    use serde_json::json;

    use super::*;

    const ALICE: &str = "alice@archestra.ai";
    const BOB: &str = "bob@archestra.ai";
    const AUDITOR: &str = "alex@finance-audit.com";

    fn allow(verdict: GateVerdict) {
        assert!(matches!(verdict, GateVerdict::Allow), "expected Allow");
    }

    /// A read tool: internal-only output, no effects.
    fn read_contract(name: &str) -> ToolContract {
        ToolContract {
            name: ToolName::new(name),
            requires: Some(Requirements::default()),
            output_label: ValueLabel {
                audience: Audience::readers([UserId::new(ALICE), UserId::new(BOB)]),
                trust: Trust::TRUSTED,
            },
            effects: Effects::none(),
            arguments: baton_core::ArgumentSchema::opaque(),
        }
    }

    /// An egressing sink guarded by `FromRecipients`.
    fn sink_contract(name: &str) -> ToolContract {
        ToolContract {
            name: ToolName::new(name),
            requires: Some(Requirements {
                audience: AudienceRule::FromRecipients,
                ..Requirements::default()
            }),
            output_label: ValueLabel::identity(),
            effects: Effects::declared([Effect::Egress]),
            arguments: baton_core::ArgumentSchema::opaque(),
        }
    }

    fn approve(_: &ProposedGrant, _: &[Violation], _: &TrajectoryView<'_>) -> Option<Ruling> {
        Some(Ruling::Approve {
            reason: "vouched".to_owned(),
        })
    }

    /// Vouches in exactly the auditor and accepts the resulting first egress.
    fn auditor_mandate() -> AuthorityMandate {
        AuthorityMandate::none()
            .vouch_audience([UserId::new(AUDITOR)])
            .acquire_effects()
    }

    fn auditor_authority() -> Authority {
        Authority::inline("finance-approver", auditor_mandate(), approve)
    }

    fn auditor_gate() -> BatonGate {
        BatonGate::builder()
            .authority(auditor_authority())
            .contract(read_contract("list_invoices"))
            .contract(sink_contract("send_email"))
            .recipients_for("send_email", |a| {
                a.get("to")
                    .and_then(|v| v.as_str())
                    .map(|to| vec![UserId::new(to)])
                    .unwrap_or_default()
            })
            .build()
            .unwrap()
    }

    #[test]
    fn mandated_send_is_endorsed_and_accepted_to_a_permit() {
        let mut gate = auditor_gate();
        gate.begin("email the report to the auditor");
        allow(gate.check("list_invoices", &json!({})));
        gate.commit("<invoices>").unwrap();
        // Crosses the audience boundary and is the first egress; the finance
        // approver endorses the auditor in and accepts the egress.
        allow(gate.check("send_email", &json!({ "to": AUDITOR })));
    }

    #[test]
    fn send_outside_the_mandate_blocks() {
        let mut gate = auditor_gate();
        gate.begin("email the report to a stranger");
        allow(gate.check("list_invoices", &json!({})));
        gate.commit("<invoices>").unwrap();
        // No mandate covers "eve": nothing declassifies the boundary crossing.
        assert!(matches!(
            gate.check("send_email", &json!({ "to": "eve@evil.com" })),
            GateVerdict::Block { .. }
        ));
    }

    /// Competent for the auditor, but rules out of process — so a walk that
    /// reaches its grant step blocks with `NeedsApproval` rather than permitting.
    fn external_auditor_gate() -> BatonGate {
        BatonGate::builder()
            .authority(Authority::external("finance-approver", auditor_mandate()))
            .contract(read_contract("list_invoices"))
            .contract(sink_contract("send_email"))
            .recipients_for("send_email", |a| {
                a.get("to")
                    .and_then(|v| v.as_str())
                    .map(|to| vec![UserId::new(to)])
                    .unwrap_or_default()
            })
            .build()
            .unwrap()
    }

    #[test]
    fn a_check_before_commit_blocks_without_staling_the_stashed_token() {
        let mut gate = auditor_gate();
        gate.begin("email the report to the auditor");
        allow(gate.check("list_invoices", &json!({})));
        // A second check — on the recipient-bearing tool — is refused before
        // recipient ingress can advance the revision, so the stashed permit
        // still commits.
        assert!(matches!(
            gate.check("send_email", &json!({ "to": AUDITOR })),
            GateVerdict::Block { .. }
        ));
        gate.commit("<invoices>").unwrap();
    }

    #[test]
    fn a_walk_that_blocks_does_not_wedge_later_calls() {
        let mut gate = external_auditor_gate();
        gate.begin("email the report to the auditor");
        allow(gate.check("list_invoices", &json!({})));
        gate.commit("<invoices>").unwrap();
        // The remediable walk reaches an external grant it cannot resolve
        // in-process and blocks, discarding the approval and freeing the slot.
        assert!(matches!(
            gate.check("send_email", &json!({ "to": AUDITOR })),
            GateVerdict::Block { .. }
        ));
        // A later downhill call must still be evaluable — not refused with
        // `ActionAlreadyPending` from a leaked pending action.
        allow(gate.check("list_invoices", &json!({})));
    }

    #[test]
    fn mandated_send_converges_over_a_multi_value_context() {
        let mut gate = auditor_gate();
        gate.begin("read everything then email the auditor");
        // Several restricted reads: each becomes an audience-failing body leaf,
        // so the send peels one Endorse per leaf — the walk must converge.
        for _ in 0..4 {
            allow(gate.check("list_invoices", &json!({})));
            gate.commit("<invoices>").unwrap();
        }
        allow(gate.check("send_email", &json!({ "to": AUDITOR })));
    }

    #[test]
    fn public_egress_blocks_with_no_authority() {
        let mut gate = BatonGate::builder()
            .contract(read_contract("fetch_recording"))
            .contract(sink_contract("open_issue"))
            .recipients_for("open_issue", |_| vec![UserId::new("world")])
            .build()
            .unwrap();
        gate.begin("open a public bug for the crash");
        allow(gate.check("fetch_recording", &json!({})));
        gate.commit("<transcript naming the customer>").unwrap();
        // Fail-closed: the internal recording cannot egress to the public.
        assert!(matches!(
            gate.check("open_issue", &json!({ "repo": "acme/app" })),
            GateVerdict::Block { .. }
        ));
    }
}
