//! A baton policy gate over the agent's tool calls.
//!
//! [`BatonGate`] links [`baton_core`] in-process (no subprocess, full access to
//! audience/effects labels) and drives baton's value-granular enforcement
//! protocol — `evaluate → release → record_output` — over one run:
//!
//! * [`begin`](BatonGate::begin) seeds a trusted user turn;
//! * [`check`](BatonGate::check) evaluates a proposed call against the folded
//!   read context; a permitted call is *released on the spot* — may-effects
//!   commit before anything runs — and the returned
//!   [`GateVerdict::Execute`] carries the tool identity and arguments
//!   recovered from the canonical checked request, the only call the harness
//!   may run;
//! * [`commit`](BatonGate::commit) consumes the dispatch receipt and folds the
//!   tool's contract-fixed output label into the trajectory as a new value.
//!
//! The engine is value-granular: a request names the values it depends on. The
//! gate cannot see the model's real per-argument data-flow, so it conservatively
//! folds the *whole* read context (the user turn and every prior tool output)
//! into each call as its *body* argument leaves — the over-approximation of "the
//! agent has seen all of this". Body leaves are endorsable, so a mandated
//! authority can declassify the data in for a recipient. The call's exact JSON
//! arguments enter the checked tree as their own leaf, so the canonical
//! request's rendering contains the very bytes the executor dispatches.
//!
//! PoC limitations of this coarse gate (pre-dating the value-granular port;
//! see the follow-up ledger): the *labels* are a whole-context proxy, not the
//! model's real argument provenance; and control-only influence is modelled
//! as endorsable data (so an authority without control-release competence can
//! clear it). Acceptable for a benchmark substrate.

use std::collections::HashMap;

use std::collections::BTreeSet;

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, AttentionRule, Authority, DispatchReceipt, EmissionPursuit,
    EmissionRequest, ExecutionToken, OpaqueValue, PolicyEngine, Pursuit, Requirements, ResponsePolicy, Speaker,
    StallCause, ToolContract, ToolName, ToolRequest, Trajectory, UserId, ValueId, ValueLabel, Violation,
};

use crate::error::DojoError;

/// The gate's verdict on a proposed tool call.
pub enum GateVerdict {
    /// The call was checked and released: may-effects are already committed,
    /// and `tool`/`args` are recovered from the canonical checked request —
    /// the only call the harness may execute, followed by
    /// [`BatonGate::commit`] with the result.
    Execute { tool: String, args: serde_json::Value },
    /// The call is refused; `reason` is a human-readable block description.
    Block { reason: String },
}

/// The gate's verdict on the agent's outward final text.
pub enum EmissionVerdict {
    /// The emission was permitted; `rendered` is the only bytes the harness
    /// may send outward.
    Emit { rendered: String },
    /// The emission is refused; `reason` is a human-readable block description.
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

/// The internal argument key carrying the call's exact JSON arguments as one
/// leaf, so the canonical request renders the very bytes the executor runs.
const ARGS_ARG: &str = "__args";

type RecipientFn = Box<dyn Fn(&serde_json::Value) -> Vec<UserId> + Send + Sync>;

/// An in-process baton policy gate carrying one run's trajectory.
pub struct BatonGate {
    engine: PolicyEngine,
    recipients: HashMap<String, RecipientFn>,
    trajectory: Trajectory,
    /// Every value committed so far (the user turn and each tool output). Folded
    /// as the control dependencies of every proposed call — see the module doc.
    context: Vec<ValueId>,
    /// The receipt of the released, not-yet-committed dispatch: `check`
    /// releases before execution, `commit` closes with the result.
    pending: Option<DispatchReceipt>,
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
            conversation_readers: None,
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
    /// A permit is released immediately — may-effects commit before anything
    /// runs — and the caller must execute exactly the returned canonical call,
    /// then [`commit`](BatonGate::commit) the result.
    pub(crate) fn check(&mut self, tool: &str, args: &serde_json::Value) -> GateVerdict {
        // Refuse before touching the trajectory: a released dispatch must be
        // committed before the next proposal.
        if self.pending.is_some() {
            return GateVerdict::Block {
                reason: "a released call is awaiting commit".to_owned(),
            };
        }
        let request = self.build_request(tool, args);
        // A plan needs at most one Endorse per audience-failing context leaf,
        // plus an Accept and a waiver. Bound the walk on the context, not a
        // fixed count, so a longer run still converges; the bound is a
        // fail-closed backstop, not the expected path.
        let max_steps = self.context.len() + 8;
        match self.engine.pursue(&mut self.trajectory, request, max_steps) {
            Pursuit::Permitted(token) => self.release_for_execution(token),
            // The engine cleared this request's slot on a terminal block.
            Pursuit::Terminal { reason, .. } => GateVerdict::Block {
                reason: reason.to_string(),
            },
            // Inline authorities resolve synchronously; a needs-approval means
            // only an out-of-process authority could clear it, which this
            // in-process gate cannot answer — fail closed, discarding the
            // approval and freeing the slot the pursuit deliberately kept.
            Pursuit::NeedsApproval(pending) => {
                let reason = format!("needs external ruling from {}", pending.authority());
                drop(pending);
                self.trajectory
                    .abandon_pending()
                    .expect("a stalled or blocked action was never released");
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
            // An invalid/stale/conflicting proposal touched nothing; the gate
            // reports it like any other block.
            Pursuit::Refused(refusal) => GateVerdict::Block {
                reason: format!("proposal refused: {refusal}"),
            },
        }
    }

    /// Two-phase boundary, first half: release the permit *before* the tool
    /// runs — committing may-effects and rendering the one canonical request
    /// from the exact checked tree — and hand back the call the executor must
    /// run: the canonical tool identity and the exact argument bytes the
    /// check covered.
    fn release_for_execution(&mut self, token: ExecutionToken) -> GateVerdict {
        let (canonical, receipt) = match self.trajectory.release(token) {
            Ok(released) => released,
            Err(rejected) => {
                return GateVerdict::Block {
                    reason: format!("release refused: {rejected:?}"),
                };
            }
        };
        // The checked tree carries the call's exact JSON arguments under
        // ARGS_ARG; the canonical rendering is therefore parseable and the
        // executed bytes come from it, not from the model's message.
        let args = serde_json::from_str::<serde_json::Value>(&canonical.rendered)
            .ok()
            .and_then(|rendered| {
                rendered
                    .get(ARGS_ARG)
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            });
        match args {
            Some(args) => {
                let tool = canonical.tool.as_str().to_owned();
                self.pending = Some(receipt);
                GateVerdict::Execute { tool, args }
            }
            None => {
                // The dispatch never happens; close the released action
                // honestly instead of leaving it open.
                let reason = "canonical request did not round-trip the call arguments".to_owned();
                if self.trajectory.record_failure(receipt).is_err() {
                    unreachable!("a just-minted receipt closes its own released action");
                }
                GateVerdict::Block { reason }
            }
        }
    }

    /// Two-phase boundary, second half: fold the executed call's result into
    /// the trajectory by consuming the dispatch receipt. Called after every
    /// released execution — including a failed one, since the tool may have
    /// mutated state before erroring.
    pub(crate) fn commit(&mut self, result_content: &str) -> Result<(), DojoError> {
        let receipt = self.pending.take().ok_or_else(|| DojoError::Policy {
            detail: "commit called without a released dispatch".to_owned(),
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

    /// Check the agent's outward final text through the engine's emission
    /// sink: the text is admitted as a model output reading the whole
    /// context (the same over-approximation every call check uses), and the
    /// emission is driven like any flow — remediable leaks walk their plans
    /// through the registered inline authorities. Requires
    /// [`BatonGateBuilder::conversation_readers`]; an unconfigured response
    /// sink fails closed like any uncontracted tool.
    pub(crate) fn check_emission(&mut self, text: &str) -> EmissionVerdict {
        if self.pending.is_some() {
            return EmissionVerdict::Block {
                reason: "a released call is awaiting commit".to_owned(),
            };
        }
        let reads: BTreeSet<ValueId> = self.context.iter().copied().collect();
        let body = match self
            .trajectory
            .admit_model_output(OpaqueValue::new(text), reads, BTreeSet::new())
        {
            Ok(id) => id,
            Err(unknown) => {
                return EmissionVerdict::Block {
                    reason: format!("final text references an unadmitted value: {unknown:?}"),
                };
            }
        };
        let request = EmissionRequest {
            body: ArgumentTree::Value(body),
            control: BTreeSet::new(),
            basis: self.trajectory.revision(),
        };
        let max_steps = self.context.len() + 8;
        match self.engine.pursue_emission(&mut self.trajectory, request, max_steps) {
            // The rendered bytes — from the exact checked tree — are the
            // only bytes the harness may send outward.
            EmissionPursuit::Emitted(emitted) => EmissionVerdict::Emit {
                rendered: emitted.rendered,
            },
            EmissionPursuit::Terminal { reason, .. } => EmissionVerdict::Block {
                reason: reason.to_string(),
            },
            EmissionPursuit::NeedsApproval(pending) => {
                let reason = format!("needs external ruling from {}", pending.authority());
                drop(pending);
                self.trajectory.abandon_pending_emission();
                EmissionVerdict::Block { reason }
            }
            EmissionPursuit::Stalled { violations, cause } => EmissionVerdict::Block {
                reason: match cause {
                    StallCause::BoundExhausted => "emission remedy did not converge within the step bound".to_owned(),
                    StallCause::Refused(refused) => {
                        format!("emission step refused: {refused:?}; {}", block_reason(&violations))
                    }
                    StallCause::Failed(failure) => format!("emission remedy step failed: {failure:?}"),
                },
            },
            EmissionPursuit::Refused(refusal) => EmissionVerdict::Block {
                reason: format!("emission proposal refused: {refusal}"),
            },
        }
    }

    /// Build the value-granular request. The whole read context is folded in as
    /// the call's *body* — argument leaves, not control deps — so an authority
    /// can endorse the tainted data in for a recipient (a control dep could only
    /// be released). Recipients (if any) sit under the recipient key.
    fn build_request(&mut self, tool: &str, args: &serde_json::Value) -> ToolRequest {
        let body: Vec<ArgumentTree<ValueId>> = self.context.iter().copied().map(ArgumentTree::Value).collect();
        // The exact JSON arguments become their own leaf — a model output
        // reading the whole context (same fold as the body, so no label
        // change) — making the canonical rendering carry the executed bytes.
        let args_leaf = self
            .trajectory
            .admit_model_output(
                OpaqueValue::new(args.to_string()),
                self.context.iter().copied().collect(),
                BTreeSet::new(),
            )
            .expect("context values are admitted");
        let mut fields = vec![
            (ArgumentName::new(ARGS_ARG), ArgumentTree::Value(args_leaf)),
            (ArgumentName::new(BODY_ARG), ArgumentTree::List(body)),
        ];
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
    conversation_readers: Option<BTreeSet<UserId>>,
}

impl BatonGateBuilder {
    /// Register an escalation authority. A mandated authority can declassify a
    /// boundary-crossing flow it vouches for (e.g. endorsing a send to a specific
    /// external recipient, or accepting an effect's first egress) instead of
    /// blocking. With none registered the gate is fully fail-closed.
    /// Who reads the conversation: registers the response-sink policy so the
    /// agent's outward final text is checked as an emission flow. Without
    /// this the emission check fails closed (no registered response policy).
    pub fn conversation_readers(mut self, readers: impl IntoIterator<Item = UserId>) -> Self {
        self.conversation_readers = Some(readers.into_iter().collect());
        self
    }

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
        if let Some(readers) = self.conversation_readers {
            engine = engine
                .with_response_policy(ResponsePolicy {
                    requires: Requirements {
                        audience: baton_core::AudienceRule::FromRecipients,
                        ..Requirements::default()
                    },
                    readers,
                })
                .expect("the gate registers its response policy before any evaluation");
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
        Audience, AudienceRule, Authority, AuthorityMandate, Authorization, Effect, Effects, Requirements, Ruling,
        ToolContract, ToolName, TrajectoryView, Trust, UserId, ValueLabel, Violation,
    };
    use serde_json::json;

    use super::*;

    const ALICE: &str = "alice@archestra.ai";
    const BOB: &str = "bob@archestra.ai";
    const AUDITOR: &str = "alex@finance-audit.com";

    /// A permitted check releases and returns the canonical execution; the
    /// helper asserts the exact shape — tool and argument bytes recovered
    /// from the checked tree — so a wrong-canonical release cannot pass.
    fn executed(verdict: GateVerdict, tool: &str, args: &serde_json::Value) {
        match verdict {
            GateVerdict::Execute {
                tool: canonical_tool,
                args: canonical_args,
            } => {
                assert_eq!(canonical_tool, tool);
                assert_eq!(&canonical_args, args);
            }
            GateVerdict::Block { reason } => panic!("expected Execute, got Block: {reason}"),
        }
    }

    fn allow(gate: &mut BatonGate, tool: &str, args: serde_json::Value) {
        executed(gate.check(tool, &args), tool, &args);
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

    fn approve(_: &Authorization, _: &[Violation], _: &TrajectoryView<'_>) -> Option<Ruling> {
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

    /// The final text is an emission flow: readable context emits; a gate
    /// with no declared conversation readers fails closed.
    #[test]
    fn final_text_is_checked_as_an_emission() {
        let mut gate = BatonGate::builder()
            .conversation_readers([UserId::new(ALICE), UserId::new(BOB)])
            .contract(read_contract("get_doc"))
            .build()
            .unwrap();
        gate.begin("summarize the doc");
        allow(&mut gate, "get_doc", json!({}));
        gate.commit("the internal doc").unwrap();
        // The summary derives from values readable by the conversation
        // readers, so the emission is allowed, and the returned bytes are
        // exactly the engine's rendering of the checked tree — the only
        // bytes the harness may send.
        match gate.check_emission("summary of the internal doc") {
            EmissionVerdict::Emit { rendered } => {
                assert_eq!(rendered, "\"summary of the internal doc\"");
            }
            EmissionVerdict::Block { reason } => panic!("expected Emit, got Block: {reason}"),
        }

        let mut unconfigured = BatonGate::builder().contract(read_contract("get_doc")).build().unwrap();
        unconfigured.begin("hi");
        assert!(matches!(
            unconfigured.check_emission("anything"),
            EmissionVerdict::Block { .. }
        ));
    }

    /// Release precedes execution: the may-effects are committed the moment
    /// `check` returns `Execute` — before any tool runs — and a failed tool
    /// still leaves them committed (a receipt closes, never undoes).
    #[test]
    fn check_releases_and_commits_effects_before_execution() {
        let mut gate = auditor_gate();
        gate.begin("send the invoices to the auditor");
        allow(&mut gate, "list_invoices", json!({}));
        gate.commit("invoice data").unwrap();
        allow(&mut gate, "send_email", json!({ "to": AUDITOR }));
        assert_eq!(gate.trajectory.past_effects(), &Effects::declared([Effect::Egress]));
        // The tool errored after release; committing the error result closes
        // the dispatch and the committed effects stay.
        gate.commit("{\"error\":\"smtp down\"}").unwrap();
        assert_eq!(gate.trajectory.past_effects(), &Effects::declared([Effect::Egress]));
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
        allow(&mut gate, "list_invoices", json!({}));
        gate.commit("<invoices>").unwrap();
        // Crosses the audience boundary and is the first egress; the finance
        // approver endorses the auditor in and accepts the egress.
        allow(&mut gate, "send_email", json!({ "to": AUDITOR }));
    }

    #[test]
    fn send_outside_the_mandate_blocks() {
        let mut gate = auditor_gate();
        gate.begin("email the report to a stranger");
        allow(&mut gate, "list_invoices", json!({}));
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
        allow(&mut gate, "list_invoices", json!({}));
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
        allow(&mut gate, "list_invoices", json!({}));
        gate.commit("<invoices>").unwrap();
        // The remediable walk reaches an external grant it cannot resolve
        // in-process and blocks, discarding the approval and freeing the slot.
        assert!(matches!(
            gate.check("send_email", &json!({ "to": AUDITOR })),
            GateVerdict::Block { .. }
        ));
        // A later downhill call must still be evaluable — not refused with
        // `ActionAlreadyPending` from a leaked pending action.
        allow(&mut gate, "list_invoices", json!({}));
    }

    #[test]
    fn mandated_send_converges_over_a_multi_value_context() {
        let mut gate = auditor_gate();
        gate.begin("read everything then email the auditor");
        // Several restricted reads: each becomes an audience-failing body leaf,
        // so the send peels one Endorse per leaf — the walk must converge.
        for _ in 0..4 {
            allow(&mut gate, "list_invoices", json!({}));
            gate.commit("<invoices>").unwrap();
        }
        allow(&mut gate, "send_email", json!({ "to": AUDITOR }));
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
        allow(&mut gate, "fetch_recording", json!({}));
        gate.commit("<transcript naming the customer>").unwrap();
        // Fail-closed: the internal recording cannot egress to the public.
        assert!(matches!(
            gate.check("open_issue", &json!({ "repo": "acme/app" })),
            GateVerdict::Block { .. }
        ));
    }
}
