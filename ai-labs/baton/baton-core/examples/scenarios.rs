//! Runs declarative policy-engine pipelines from TOML.
//!
//! ```text
//! cargo run --example scenarios
//! cargo run --example scenarios -- path/to/scenarios.toml
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, Audience, AudienceRule, Authority, AuthorityMandate, AuthorityMode,
    AuthorityName, BlockReason, Blocked, Decision, DuplicateContract, DuplicateRegistration, Effect, Effects,
    KnownTrust, LabelPredicate, OpaqueValue, PolicyEngine, RegisteredTransformer, RejectedToken, Requirements, Ruling,
    Speaker, StepOutcome, StepRefused, ToolContract, ToolName, ToolRequest, Trajectory, TransformerDescriptor,
    TransformerError, TransformerRef, Trust, UnknownValue, UserId, ValueId, ValueLabel,
};
use clap::Parser;
use serde::Deserialize;
use thiserror::Error;

const MAX_REMEDY_STEPS: usize = 32;

#[derive(Debug, Parser)]
struct Args {
    #[arg(default_value_os_t = default_scenarios_path())]
    file: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScenarioFile {
    scenario: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    name: String,
    input: InputConfig,
    tools: Vec<ToolConfig>,
    #[serde(default)]
    authorities: Vec<AuthorityConfig>,
    #[serde(default)]
    sanitizers: Vec<SanitizerConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputConfig {
    body: String,
    audience: AudienceConfig,
    trust: TrustConfig,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolConfig {
    name: String,
    recipient: String,
    result: String,
    #[serde(default)]
    requires_trust: Option<KnownTrustConfig>,
    #[serde(default)]
    requires_audience: bool,
    #[serde(default)]
    output_audience: AudienceConfig,
    #[serde(default)]
    output_trust: TrustConfig,
    #[serde(default)]
    effects: Vec<EffectConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorityConfig {
    name: String,
    #[serde(default)]
    trust: Option<KnownTrustConfig>,
    #[serde(default)]
    audience: Option<Vec<String>>,
    #[serde(default)]
    waive_prior_effects: bool,
    #[serde(default)]
    confirms: bool,
    #[serde(default)]
    acknowledge_unknown: bool,
    #[serde(default)]
    may_release_control: bool,
    #[serde(default)]
    acquire_effects: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SanitizerConfig {
    name: String,
    #[serde(default = "default_transformer_version")]
    version: u32,
    #[serde(default)]
    input_audience: Option<AudienceConfig>,
    #[serde(default)]
    input_trust: Option<TrustConfig>,
    output_audience: AudienceConfig,
    output_trust: TrustConfig,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AudienceConfig {
    Readers(Vec<String>),
    Named(AudienceName),
}

impl Default for AudienceConfig {
    fn default() -> Self {
        Self::Named(AudienceName::Public)
    }
}

impl AudienceConfig {
    fn to_domain(&self) -> Audience {
        match self {
            Self::Readers(readers) => Audience::readers(readers.iter().map(UserId::new)),
            Self::Named(AudienceName::Public) => Audience::PUBLIC,
            Self::Named(AudienceName::Unknown) => Audience::UNKNOWN,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AudienceName {
    Public,
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TrustConfig {
    Suspicious,
    #[default]
    Trusted,
    Unknown,
}

impl TrustConfig {
    fn to_domain(self) -> Trust {
        match self {
            Self::Suspicious => Trust::SUSPICIOUS,
            Self::Trusted => Trust::TRUSTED,
            Self::Unknown => Trust::UNKNOWN,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum KnownTrustConfig {
    Suspicious,
    Trusted,
}

impl KnownTrustConfig {
    fn to_domain(self) -> KnownTrust {
        match self {
            Self::Suspicious => KnownTrust::Suspicious,
            Self::Trusted => KnownTrust::Trusted,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EffectConfig {
    Mutation,
    Egress,
}

impl EffectConfig {
    fn to_domain(self) -> Effect {
        match self {
            Self::Mutation => Effect::Mutation,
            Self::Egress => Effect::Egress,
        }
    }
}

#[derive(Debug, Error)]
enum ScenarioError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
    #[error(transparent)]
    DuplicateContract(#[from] DuplicateContract),
    #[error(transparent)]
    DuplicateRegistration(#[from] DuplicateRegistration),
    #[error(transparent)]
    StepRefused(#[from] StepRefused),
    #[error(transparent)]
    RejectedToken(#[from] RejectedToken),
    #[error(transparent)]
    UnknownValue(#[from] UnknownValue),
    #[error("scenario `{scenario}` tool `{tool}` blocked: {reason}")]
    Terminal {
        scenario: String,
        tool: String,
        reason: BlockReason,
    },
    #[error("scenario `{scenario}` tool `{tool}` transition failed: {failure}")]
    TransitionFailed {
        scenario: String,
        tool: String,
        failure: baton_core::TransitionFailure,
    },
    #[error("scenario `{scenario}` tool `{tool}` exceeded {MAX_REMEDY_STEPS} remedy steps")]
    RemedyLimit { scenario: String, tool: String },
}

fn main() -> Result<(), ScenarioError> {
    let args = Args::parse();
    let source = std::fs::read_to_string(args.file)?;
    let scenarios: ScenarioFile = toml::from_str(&source)?;

    for scenario in &scenarios.scenario {
        run_scenario(scenario)?;
    }
    Ok(())
}

fn default_scenarios_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/scenarios.toml")
}

fn default_transformer_version() -> u32 {
    1
}

fn sanitize_content(_: &OpaqueValue) -> Result<OpaqueValue, TransformerError> {
    Ok(OpaqueValue::new("[sanitized content]"))
}

fn run_scenario(scenario: &Scenario) -> Result<(), ScenarioError> {
    println!("\n=== {} ===", scenario.name);
    let engine = build_engine(scenario)?;
    let mut trajectory = Trajectory::new();
    let mut payload = trajectory.ingress(
        Speaker::user(UserId::new("scenario-user")),
        ValueLabel {
            audience: scenario.input.audience.to_domain(),
            trust: scenario.input.trust.to_domain(),
        },
        OpaqueValue::new(&scenario.input.body),
    );
    println!("input {payload}: {}", trajectory.value(payload)?.label());

    for tool in &scenario.tools {
        payload = run_tool(&engine, &mut trajectory, scenario, tool, payload)?;
        println!("output {payload}: {}", trajectory.value(payload)?.label());
    }

    println!("audit:");
    for event in trajectory.state().audit() {
        println!("  - {event}");
    }
    Ok(())
}

fn build_engine(scenario: &Scenario) -> Result<PolicyEngine, ScenarioError> {
    let mut engine = PolicyEngine::new();
    for tool in &scenario.tools {
        engine.register(ToolContract {
            name: ToolName::new(&tool.name),
            requires: Requirements {
                trust: tool.requires_trust.map(KnownTrustConfig::to_domain),
                audience: match tool.requires_audience {
                    true => AudienceRule::RecipientsWithinContext,
                    false => AudienceRule::Unrestricted,
                },
                ..Requirements::default()
            },
            output_label: ValueLabel {
                audience: tool.output_audience.to_domain(),
                trust: tool.output_trust.to_domain(),
            },
            effects: Effects::declared(tool.effects.iter().copied().map(EffectConfig::to_domain)),
            arguments: ArgumentSchema::with_recipients(ArgumentName::new("to")),
        })?;
    }
    for authority in &scenario.authorities {
        engine.register_authority(Authority {
            name: AuthorityName::new(&authority.name),
            mandate: AuthorityMandate {
                trust: authority.trust.map(KnownTrustConfig::to_domain),
                audience: authority
                    .audience
                    .as_ref()
                    .map(|readers| readers.iter().map(UserId::new).collect()),
                waive_prior_effects: authority.waive_prior_effects,
                confirms: authority.confirms,
                acknowledge_unknown: authority.acknowledge_unknown,
                may_release_control: authority.may_release_control,
                acquire_effects: authority.acquire_effects,
            },
            mode: AuthorityMode::External,
        })?;
    }
    for sanitizer in &scenario.sanitizers {
        engine.register_transformer(RegisteredTransformer {
            descriptor: TransformerDescriptor {
                transformer: TransformerRef {
                    id: sanitizer.name.clone(),
                    version: sanitizer.version,
                },
                precondition: LabelPredicate {
                    trust: sanitizer.input_trust.map(TrustConfig::to_domain),
                    audience: sanitizer.input_audience.as_ref().map(AudienceConfig::to_domain),
                },
                output: ValueLabel {
                    audience: sanitizer.output_audience.to_domain(),
                    trust: sanitizer.output_trust.to_domain(),
                },
            },
            run: sanitize_content,
        })?;
    }
    Ok(engine)
}

fn run_tool(
    engine: &PolicyEngine,
    trajectory: &mut Trajectory,
    scenario: &Scenario,
    tool: &ToolConfig,
    payload: ValueId,
) -> Result<ValueId, ScenarioError> {
    println!("call {} -> {}", tool.name, tool.recipient);
    let recipient = trajectory.ingress(
        Speaker::user(UserId::new("scenario-user")),
        ValueLabel::identity(),
        OpaqueValue::new(&tool.recipient),
    );
    let request = ToolRequest::new(
        ToolName::new(&tool.name),
        ArgumentTree::Object(BTreeMap::from([
            (ArgumentName::new("to"), ArgumentTree::Value(recipient)),
            (ArgumentName::new("body"), ArgumentTree::Value(payload)),
        ])),
        BTreeSet::new(),
    );
    let mut decision = engine.evaluate(trajectory, request);

    for _ in 0..MAX_REMEDY_STEPS {
        match decision {
            Decision::Permitted(token) => {
                let (canonical, receipt) = trajectory.release(token)?;
                println!("  dispatch: {}", canonical.rendered);
                return Ok(trajectory.record_output(receipt, OpaqueValue::new(&tool.result))?);
            }
            Decision::Blocked(Blocked::Terminal(block)) => {
                for violation in block.violations {
                    println!("  blocked: {violation}");
                }
                return Err(ScenarioError::Terminal {
                    scenario: scenario.name.clone(),
                    tool: tool.name.clone(),
                    reason: block.reason,
                });
            }
            Decision::Blocked(Blocked::Remediable { violations, plans }) => {
                for violation in violations {
                    println!("  remedy for: {violation}");
                }
                let plan = plans
                    .iter()
                    .min_by_key(|candidate| (candidate.steps.len(), candidate.exit_kind()))
                    .expect("remediable decisions carry at least one plan");
                println!("  apply: {:?}", plan.steps.first().kind);
                let capability = engine.mint_step(trajectory, plan.id, 0)?;
                decision = match engine.apply_step(trajectory, capability)? {
                    StepOutcome::Advanced(next) => next,
                    StepOutcome::NeedsApproval(pending) => {
                        println!("  approve: {pending}");
                        engine.apply_approval(
                            trajectory,
                            pending,
                            Ruling::Approve {
                                reason: "approved by scenario runner".to_owned(),
                            },
                        )?
                    }
                    StepOutcome::Failed(failure) => {
                        return Err(ScenarioError::TransitionFailed {
                            scenario: scenario.name.clone(),
                            tool: tool.name.clone(),
                            failure,
                        });
                    }
                };
            }
        }
    }

    Err(ScenarioError::RemedyLimit {
        scenario: scenario.name.clone(),
        tool: tool.name.clone(),
    })
}
