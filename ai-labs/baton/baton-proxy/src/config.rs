//! `policy.toml`: tool contracts, the requesting user's identity/label, and the
//! engine's unknown/taint policies. Parsed strictly (`deny_unknown_fields`, the
//! baton-check discipline) into baton-core types.

use std::collections::{BTreeSet, HashMap};

use baton_core::{
    AttentionRule, Audience, AudienceRule, Effect, Effects, KnownTrust, Label, Requirements, TaintPolicy, ToolContract,
    ToolName, Trust, UnknownPolicy, UserId,
};
use serde::Deserialize;

/// The default MCP tool name the model calls to request approval. Configurable
/// because harnesses namespace MCP tools (`<server>__<tool>`).
pub const DEFAULT_APPROVAL_TOOL: &str = "baton__request_approval";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("unknown audience keyword `{0}` (use \"public\", \"unknown\", or a list of ids)")]
    AudienceKeyword(String),
    #[error("a [[tool]] is named `{0}`, which collides with the approval tool")]
    ApprovalToolCollision(String),
    #[error("duplicate contract for tool `{0}`")]
    DuplicateTool(String),
    #[error(
        "tool `{0}` requires recipients within context but declares no recipients_args, so every call would be blocked"
    )]
    MissingRecipientsArgs(String),
}

/// The runtime policy the proxy evaluates against. Built once at startup and
/// shared read-only across requests.
#[derive(Debug, Clone)]
pub struct Policy {
    pub upstream_base_url: String,
    pub approval_tool: ToolName,
    pub unknown_policy: UnknownPolicy,
    pub taint_policy: TaintPolicy,
    pub user_id: UserId,
    pub user_label: Label,
    /// Every registered contract, including the injected approval-tool contract.
    pub contracts: Vec<ToolContract>,
    /// Per-tool argument names that carry recipients (e.g. `to`, `cc`, `bcc`).
    pub recipients_args: HashMap<ToolName, Vec<String>>,
}

impl Policy {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        RawConfig::deserialize(toml::Deserializer::new(text))?.build()
    }

    /// Whether a tool has a registered contract. Tools without one are outside
    /// the policy's scope and pass through untouched (gradual adoption: annotate
    /// the risky tools, leave the rest).
    pub fn has_contract(&self, tool: &ToolName) -> bool {
        self.contracts.iter().any(|c| &c.name == tool)
    }
}

fn default_approval_tool() -> String {
    DEFAULT_APPROVAL_TOOL.to_string()
}

fn default_user_id() -> String {
    "user".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    upstream_base_url: String,
    #[serde(default = "default_approval_tool")]
    approval_tool: String,
    #[serde(default)]
    unknown_policy: UnknownPolicySpec,
    #[serde(default)]
    taint_policy: TaintPolicySpec,
    #[serde(default)]
    user: UserSpec,
    #[serde(default)]
    tool: Vec<ToolSpec>,
}

impl RawConfig {
    fn build(self) -> Result<Policy, ConfigError> {
        let approval_tool = ToolName::new(&self.approval_tool);
        let user_label = Label {
            audience: self.user.audience.to_audience()?,
            trust: self.user.trust.to_trust(),
            ..Label::identity()
        };

        let mut contracts = Vec::new();
        let mut recipients_args = HashMap::new();
        let mut seen = BTreeSet::new();
        for spec in self.tool {
            if spec.name == self.approval_tool {
                return Err(ConfigError::ApprovalToolCollision(spec.name));
            }
            if !seen.insert(spec.name.clone()) {
                return Err(ConfigError::DuplicateTool(spec.name));
            }
            if spec.requires.guards_recipients() && spec.recipients_args.is_empty() {
                return Err(ConfigError::MissingRecipientsArgs(spec.name));
            }
            let name = ToolName::new(&spec.name);
            if !spec.recipients_args.is_empty() {
                recipients_args.insert(name.clone(), spec.recipients_args.clone());
            }
            contracts.push(spec.into_contract(name)?);
        }

        // The approval tool is unguarded (any recipient, no trust bar) and its
        // results carry a clean label, so evaluating it never blocks — no
        // approval-of-approval recursion.
        contracts.push(ToolContract {
            name: approval_tool.clone(),
            requires: Requirements::default(),
            output_label: Label::identity(),
        });

        Ok(Policy {
            upstream_base_url: self.upstream_base_url,
            approval_tool,
            unknown_policy: self.unknown_policy.into(),
            taint_policy: self.taint_policy.into(),
            user_id: UserId::new(&self.user.id),
            user_label,
            contracts,
            recipients_args,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UnknownPolicySpec {
    #[default]
    Escalate,
    Deny,
    AllowWithAudit,
}

impl From<UnknownPolicySpec> for UnknownPolicy {
    fn from(spec: UnknownPolicySpec) -> Self {
        match spec {
            UnknownPolicySpec::Escalate => Self::Escalate,
            UnknownPolicySpec::Deny => Self::Deny,
            UnknownPolicySpec::AllowWithAudit => Self::AllowWithAudit,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaintPolicySpec {
    #[default]
    Allow,
    Escalate,
}

impl From<TaintPolicySpec> for TaintPolicy {
    fn from(spec: TaintPolicySpec) -> Self {
        match spec {
            TaintPolicySpec::Allow => Self::Allow,
            TaintPolicySpec::Escalate => Self::Escalate,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UserSpec {
    #[serde(default = "default_user_id")]
    id: String,
    #[serde(default)]
    audience: AudienceSpec,
    #[serde(default)]
    trust: TrustSpec,
}

impl Default for UserSpec {
    fn default() -> Self {
        Self {
            id: default_user_id(),
            audience: AudienceSpec::default(),
            trust: TrustSpec::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolSpec {
    name: String,
    #[serde(default)]
    output: OutputSpec,
    #[serde(default)]
    requires: RequiresSpec,
    #[serde(default)]
    recipients_args: Vec<String>,
}

impl ToolSpec {
    fn into_contract(self, name: ToolName) -> Result<ToolContract, ConfigError> {
        Ok(ToolContract {
            name,
            requires: self.requires.build()?,
            output_label: self.output.build()?,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputSpec {
    #[serde(default)]
    audience: AudienceSpec,
    #[serde(default)]
    trust: TrustSpec,
    #[serde(default)]
    effects: Vec<EffectSpec>,
}

impl OutputSpec {
    fn build(self) -> Result<Label, ConfigError> {
        let effects = self.effects.into_iter().map(EffectSpec::to_effect).collect::<Vec<_>>();
        Ok(Label {
            audience: self.audience.to_audience()?,
            trust: self.trust.to_trust(),
            effects: if effects.is_empty() {
                Effects::none()
            } else {
                Effects::declared(effects)
            },
            ..Label::identity()
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiresSpec {
    #[serde(default)]
    trust: Option<KnownTrustSpec>,
    #[serde(default)]
    audience: AudienceRuleSpec,
    #[serde(default)]
    attention: AttentionRuleSpec,
    #[serde(default)]
    forbid_prior_effects: Vec<EffectSpec>,
}

impl RequiresSpec {
    /// Whether this tool guards its recipients against the context audience — the
    /// rule that needs `recipients_args` to know who a call exposes to.
    fn guards_recipients(&self) -> bool {
        matches!(self.audience, AudienceRuleSpec::RecipientsWithinContext)
    }

    fn build(self) -> Result<Requirements, ConfigError> {
        Ok(Requirements {
            trust: self.trust.map(KnownTrustSpec::into_known_trust),
            audience: self.audience.into(),
            attention: self.attention.into(),
            forbid_prior_effects: self
                .forbid_prior_effects
                .into_iter()
                .map(EffectSpec::to_effect)
                .collect(),
        })
    }
}

/// Audience as `"public"`, `"unknown"`, or a list of user ids.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AudienceSpec {
    Keyword(String),
    Readers(Vec<String>),
}

impl Default for AudienceSpec {
    fn default() -> Self {
        Self::Keyword("public".to_string())
    }
}

impl AudienceSpec {
    fn to_audience(&self) -> Result<Audience, ConfigError> {
        match self {
            Self::Keyword(k) if k == "public" => Ok(Audience::PUBLIC),
            Self::Keyword(k) if k == "unknown" => Ok(Audience::UNKNOWN),
            Self::Keyword(k) => Err(ConfigError::AudienceKeyword(k.clone())),
            Self::Readers(ids) => Ok(Audience::readers(ids.iter().map(UserId::new))),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TrustSpec {
    #[default]
    Trusted,
    Suspicious,
    Unknown,
}

impl TrustSpec {
    fn to_trust(&self) -> Trust {
        match self {
            Self::Trusted => Trust::TRUSTED,
            Self::Suspicious => Trust::SUSPICIOUS,
            Self::Unknown => Trust::UNKNOWN,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum KnownTrustSpec {
    Trusted,
    Suspicious,
}

impl KnownTrustSpec {
    fn into_known_trust(self) -> KnownTrust {
        match self {
            Self::Trusted => KnownTrust::Trusted,
            Self::Suspicious => KnownTrust::Suspicious,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AudienceRuleSpec {
    #[default]
    Unrestricted,
    RecipientsWithinContext,
}

impl From<AudienceRuleSpec> for AudienceRule {
    fn from(spec: AudienceRuleSpec) -> Self {
        match spec {
            AudienceRuleSpec::Unrestricted => Self::Unrestricted,
            AudienceRuleSpec::RecipientsWithinContext => Self::RecipientsWithinContext,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AttentionRuleSpec {
    #[default]
    NotRequired,
    ExplicitConfirmation,
}

impl From<AttentionRuleSpec> for AttentionRule {
    fn from(spec: AttentionRuleSpec) -> Self {
        match spec {
            AttentionRuleSpec::NotRequired => Self::NotRequired,
            AttentionRuleSpec::ExplicitConfirmation => Self::ExplicitConfirmation,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EffectSpec {
    Egress,
    Mutation,
}

impl EffectSpec {
    fn to_effect(self) -> Effect {
        match self {
            Self::Egress => Effect::Egress,
            Self::Mutation => Effect::Mutation,
        }
    }
}
