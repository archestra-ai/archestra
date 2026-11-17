//! A hosted policy's tool contracts read without serving them: the direction an edit
//! moves each tool's calls, and the verdict the contracts alone give one call. Also the
//! structured fields a recorded decision carries beside its feedback. Nothing here opens
//! a store, reads a secret or consults anything.

use appa_runtime::contracts::{
    self, ChangeKind, ContractCall, Direction, HostedContracts, ToolContractDiff,
};
use appa_runtime_api::{DecisionGap, DecisionLabel, DecisionNarrowing, WireDecision};
use napi_derive::napi;

use crate::errors::{BindingFailure, Failure, failure, invalid_input, panicked};
use crate::policy;

/// One difference. Only a `trust_floor`, `includes`, `prior`, `no_prior`, `attention` or
/// `contract` change ever moves in a direction other than `unknown`.
#[napi(object)]
pub struct PolicyContractChange {
    #[napi(
        ts_type = "'contract' | 'trust_floor' | 'includes' | 'prior' | 'no_prior' | 'attention' | 'delta' | 'forwards' | 'emits' | 'parameters' | 'tags' | 'description' | 'annotator' | 'argument_predicates' | 'selection' | 'provider_run' | 'trust_chain' | 'authorities' | 'sanitizers' | 'audience' | 'deployment' | 'bindings' | 'recorder'"
    )]
    pub kind: String,
    #[napi(ts_type = "'tighten' | 'loosen' | 'mixed' | 'unknown'")]
    pub direction: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// One tool name whose contracts differ. The `*` entry holds the wildcard contract and
/// every policy-wide difference; an `unknown` there leaves every tool's direction unknown.
#[napi(object)]
pub struct ToolPolicyContractDiff {
    pub tool: String,
    #[napi(ts_type = "'tighten' | 'loosen' | 'mixed' | 'unknown'")]
    pub direction: String,
    pub changes: Vec<PolicyContractChange>,
    pub annotator_changed: bool,
    pub argument_predicates: bool,
}

/// A label as decisions record it: the trust rank's name, and the audience as union
/// clauses in the policy's audience-list grammar. No clause is public.
#[napi(object)]
#[derive(Clone)]
pub struct ContractLabel {
    pub trust: String,
    pub audience: Vec<Vec<String>>,
}

#[napi(object)]
pub struct ContractNarrowing {
    pub from: ContractLabel,
    pub to: ContractLabel,
}

/// One requirement a call missed.
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum ContractGap {
    TrustFloor {
        required: String,
        actual: String,
    },
    /// The readers the audience must include and does not.
    Includes {
        required: Vec<String>,
    },
    /// An effect the trajectory must have committed and has not.
    Prior {
        effect: String,
    },
    /// An effect the trajectory must not have committed and has.
    NoPrior {
        effect: String,
    },
    Attention {
        mark: String,
    },
}

#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum ContractVerdict {
    /// No requirement is missed. A narrowing alone is not a denial.
    Allow,
    Deny {
        gaps: Vec<ContractGap>,
    },
    /// An Annotator produces the contract per call, and the floor beside it is met.
    NeedsAnnotator {
        annotator: String,
    },
    /// An audience comparison needs these audiences' members from their source.
    NeedsMembership {
        audiences: Vec<String>,
    },
    /// The policy refuses the call before any check: no contract covers the tool, or
    /// the arguments do not fit its parameters.
    Refused {
        detail: String,
    },
}

#[napi(object)]
pub struct ContractCallInput {
    /// The canonical tool, as `canonicalOpenappaTool` spells it.
    pub tool: String,
    /// The call's arguments as JSON text.
    pub arguments: String,
    pub label: ContractLabel,
    /// The effects the trajectory had committed; absent is none.
    pub effects: Option<Vec<String>>,
}

/// The structured fields of a recorded decision. Each is absent where the decision does
/// not record it, as every decision recorded before these fields existed: absent is
/// unknown, never "no gaps".
#[napi(object)]
pub struct DecisionDetail {
    pub label: Option<ContractLabel>,
    pub gaps: Option<Vec<ContractGap>>,
    pub narrowing: Option<ContractNarrowing>,
}

/// Compares two host-composed policy documents' tool contracts: each tool whose contracts
/// differ, and which way the change moves its calls. A direction other than `unknown`
/// holds by construction; argument predicates, Annotator routing, bindings and anything
/// else not modelled are `unknown`. A document that does not compile is refused.
#[napi(js_name = "diffOpenappaPolicyContracts")]
pub async fn diff_openappa_policy_contracts(
    before: String,
    after: String,
) -> napi::Result<Vec<ToolPolicyContractDiff>> {
    blocking("OpenAPPA policy contract diff failed", move || {
        let (before, after) = (compiled(&before)?, compiled(&after)?);
        Ok(before.diff(&after).into_iter().map(tool_diff).collect())
    })
    .await
}

/// The verdict a host-composed policy's contracts alone give one call at a label:
/// deterministic in the document and the call, with no trajectory, remedy or consult.
#[napi(js_name = "checkOpenappaContract")]
pub async fn check_openappa_contract(
    policy: String,
    call: ContractCallInput,
) -> napi::Result<ContractVerdict> {
    blocking("OpenAPPA contract check failed", move || {
        let call = ContractCall {
            tool: call.tool,
            arguments: call.arguments,
            label: decision_label(call.label),
            effects: call.effects.unwrap_or_default(),
        };
        compiled(&policy)?
            .check(&call)
            .map(verdict)
            .map_err(invalid_input)
    })
    .await
}

/// Reads the structured fields of a decision as `dispatchHook` returned it.
#[napi(js_name = "readOpenappaDecisionDetail")]
pub fn read_openappa_decision_detail(decision: String) -> napi::Result<DecisionDetail> {
    let decision: WireDecision = serde_json::from_str(&decision).map_err(invalid_input)?;
    Ok(DecisionDetail {
        label: decision.label.map(contract_label),
        gaps: decision
            .gaps
            .map(|gaps| gaps.into_iter().map(gap).collect()),
        narrowing: decision.narrowing.map(narrowing),
    })
}

async fn blocking<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> napi::Result<T> + Send + 'static,
) -> napi::Result<T> {
    tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).map_err(|_| panicked(what))?
    })
    .await
    .map_err(panicked)?
}

fn compiled(document: &str) -> napi::Result<HostedContracts> {
    HostedContracts::compile(document, policy::defaults(), crate::adapter::adapter())
        .map_err(|error| failure(Failure::Binding(BindingFailure::PolicyRefused), error))
}

fn tool_diff(diff: ToolContractDiff) -> ToolPolicyContractDiff {
    ToolPolicyContractDiff {
        tool: diff.tool,
        direction: direction(diff.direction),
        changes: diff
            .changes
            .into_iter()
            .map(|change| PolicyContractChange {
                kind: change_kind(change.kind),
                direction: direction(change.direction),
                before: change.before,
                after: change.after,
            })
            .collect(),
        annotator_changed: diff.annotator_changed,
        argument_predicates: diff.argument_predicates,
    }
}

fn direction(direction: Direction) -> String {
    match direction {
        Direction::Tighten => "tighten",
        Direction::Loosen => "loosen",
        Direction::Mixed => "mixed",
        Direction::Unknown => "unknown",
    }
    .to_string()
}

fn change_kind(kind: ChangeKind) -> String {
    match kind {
        ChangeKind::Contract => "contract",
        ChangeKind::TrustFloor => "trust_floor",
        ChangeKind::Includes => "includes",
        ChangeKind::Prior => "prior",
        ChangeKind::NoPrior => "no_prior",
        ChangeKind::Attention => "attention",
        ChangeKind::Delta => "delta",
        ChangeKind::Forwards => "forwards",
        ChangeKind::Emits => "emits",
        ChangeKind::Parameters => "parameters",
        ChangeKind::Tags => "tags",
        ChangeKind::Description => "description",
        ChangeKind::Annotator => "annotator",
        ChangeKind::ArgumentPredicates => "argument_predicates",
        ChangeKind::Selection => "selection",
        ChangeKind::ProviderRun => "provider_run",
        ChangeKind::TrustChain => "trust_chain",
        ChangeKind::Authorities => "authorities",
        ChangeKind::Sanitizers => "sanitizers",
        ChangeKind::Audience => "audience",
        ChangeKind::Deployment => "deployment",
        ChangeKind::Bindings => "bindings",
        ChangeKind::Recorder => "recorder",
    }
    .to_string()
}

fn verdict(verdict: contracts::ContractVerdict) -> ContractVerdict {
    match verdict {
        contracts::ContractVerdict::Allow => ContractVerdict::Allow,
        contracts::ContractVerdict::Deny { gaps } => ContractVerdict::Deny {
            gaps: gaps.into_iter().map(gap).collect(),
        },
        contracts::ContractVerdict::NeedsAnnotator { annotator } => {
            ContractVerdict::NeedsAnnotator { annotator }
        }
        contracts::ContractVerdict::NeedsMembership { audiences } => {
            ContractVerdict::NeedsMembership { audiences }
        }
        contracts::ContractVerdict::Refused { detail } => ContractVerdict::Refused { detail },
    }
}

fn gap(gap: DecisionGap) -> ContractGap {
    match gap {
        DecisionGap::TrustFloor { required, actual } => {
            ContractGap::TrustFloor { required, actual }
        }
        DecisionGap::Includes { required } => ContractGap::Includes { required },
        DecisionGap::Prior { effect } => ContractGap::Prior { effect },
        DecisionGap::NoPrior { effect } => ContractGap::NoPrior { effect },
        DecisionGap::Attention { mark } => ContractGap::Attention { mark },
    }
}

fn contract_label(label: DecisionLabel) -> ContractLabel {
    ContractLabel {
        trust: label.trust,
        audience: label.audience,
    }
}

fn decision_label(label: ContractLabel) -> DecisionLabel {
    DecisionLabel {
        trust: label.trust,
        audience: label.audience,
    }
}

fn narrowing(narrowing: DecisionNarrowing) -> ContractNarrowing {
    ContractNarrowing {
        from: contract_label(narrowing.from),
        to: contract_label(narrowing.to),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: &str = r#"
[policy]
version = 2
trust_chain = ["untrusted", "trusted"]

[[policy.tool]]
name = "mcp/shell/run"
requires = { trust = "trusted" }
delta = {}
"#;

    fn checked(trust: &str) -> ContractVerdict {
        let call = ContractCall {
            tool: "mcp/shell/run".to_string(),
            arguments: "{}".to_string(),
            label: DecisionLabel {
                trust: trust.to_string(),
                audience: Vec::new(),
            },
            effects: Vec::new(),
        };
        verdict(compiled(POLICY).unwrap().check(&call).unwrap())
    }

    #[test]
    fn a_lowered_floor_loosens_the_tool_it_gates() {
        let lowered = POLICY.replace(
            "requires = { trust = \"trusted\" }",
            "requires = { trust = \"untrusted\" }",
        );
        let diff: Vec<ToolPolicyContractDiff> = compiled(POLICY)
            .unwrap()
            .diff(&compiled(&lowered).unwrap())
            .into_iter()
            .map(tool_diff)
            .collect();
        let [tool] = diff.as_slice() else {
            panic!("one tool differs");
        };
        assert_eq!(tool.tool, "mcp/shell/run");
        assert_eq!(tool.direction, "loosen");
        let [change] = tool.changes.as_slice() else {
            panic!("one change");
        };
        assert_eq!(change.kind, "trust_floor");
        assert_eq!(
            (change.before.as_deref(), change.after.as_deref()),
            (Some("trusted"), Some("untrusted"))
        );
    }

    #[test]
    fn the_contract_alone_allows_a_met_floor_and_names_a_missed_one() {
        assert!(matches!(checked("trusted"), ContractVerdict::Allow));
        let ContractVerdict::Deny { gaps } = checked("untrusted") else {
            panic!("a missed floor denies");
        };
        assert!(matches!(
            gaps.as_slice(),
            [ContractGap::TrustFloor { required, actual }]
                if required == "trusted" && actual == "untrusted"
        ));
    }

    #[test]
    fn a_document_that_does_not_compile_is_refused_as_policy() {
        let Err(error) = compiled("[policy]\nversion = 2\n[[policy.tool]]\n") else {
            panic!("a tool without a name does not compile");
        };
        let code: serde_json::Value = serde_json::from_str(&error.reason).unwrap();
        assert_eq!(code["code"], "policy_refused");
    }

    #[test]
    fn a_recorded_decision_reads_its_structured_fields_and_an_older_one_reads_none() {
        let older = read_openappa_decision_detail(
            r#"{"protocol":1,"decision":"deny_call","feedback":"blocked"}"#.to_string(),
        )
        .unwrap();
        assert!(older.label.is_none() && older.gaps.is_none() && older.narrowing.is_none());

        let decision = appa_runtime_api::HookDecision::DenyCall {
            feedback: "blocked".to_string(),
            offers: Vec::new(),
            review: Vec::new(),
            gaps: vec![DecisionGap::Attention {
                mark: "release-review".to_string(),
            }],
            narrowing: None,
        };
        let audience = vec![vec!["alice@example.com".to_string()]];
        let recorded = crate::session::labelled_wire(
            &decision,
            Some(DecisionLabel {
                trust: "trusted".to_string(),
                audience: audience.clone(),
            }),
        )
        .unwrap();
        let detail = read_openappa_decision_detail(recorded.to_string()).unwrap();
        assert!(matches!(
            detail.gaps.as_deref(),
            Some([ContractGap::Attention { mark }]) if mark == "release-review"
        ));
        let label = detail.label.expect("the label is recorded");
        assert_eq!(
            (label.trust.as_str(), label.audience),
            ("trusted", audience)
        );
        assert!(detail.narrowing.is_none());
    }
}
