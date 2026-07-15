//! Gateway TOML → a policy engine plus the simulated tools it mediates.
//! Parsed strictly (`deny_unknown_fields`): a typo in a policy file must fail
//! loudly, never silently weaken it.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use baton_core::{
    ArgumentName, ArgumentSchema, Audience, AudienceRule, Authority, AuthorityMandate, DuplicateContract,
    DuplicateRegistration, Effect, Effects, KnownTrust, PolicyEngine, Requirements, ToolContract, ToolName, Trust,
    UserId, ValueLabel,
};
use serde::Deserialize;

/// The escalation tool the gateway itself serves; a scenario tool cannot
/// shadow it.
pub const ESCALATE_TOOL: &str = "baton__escalate";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error(transparent)]
    DuplicateContract(#[from] DuplicateContract),
    #[error(transparent)]
    DuplicateRegistration(#[from] DuplicateRegistration),
    #[error("duplicate tool `{0}`")]
    DuplicateTool(String),
    #[error("tool name `{ESCALATE_TOOL}` is reserved for the gateway's escalation tool")]
    ReservedToolName,
    #[error(
        "tool `{0}` requires recipients within context but declares no recipients_arg, so every call would be blocked"
    )]
    MissingRecipientsArg(String),
    #[error("tool `{tool}` recipients_arg `{arg}` is not a declared argument")]
    UnknownRecipientsArg { tool: String, arg: String },
    #[error("tool `{tool}`: {problem}")]
    BadResultTemplate { tool: String, problem: String },
}

/// One simulated tool: what the MCP client sees, and the canned result the
/// executor renders from the canonical request.
#[derive(Debug, Clone)]
pub struct ToolSim {
    pub name: ToolName,
    pub description: String,
    pub args: Vec<ArgSpec>,
    /// Result template; `{arg}` placeholders are filled from the canonical
    /// request at dispatch time.
    pub result: String,
    /// Which wire argument carries recipients (mirrors the contract's
    /// argument schema) — used for narration and approval prompts.
    pub recipients_arg: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArgSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

/// The parsed gateway policy: the engine (contracts + authorities, fixed
/// before the first evaluation) and the simulated tools, keyed by name.
pub struct GatewayConfig {
    pub engine: PolicyEngine,
    pub tools: BTreeMap<ToolName, ToolSim>,
}

impl GatewayConfig {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        RawConfig::deserialize(toml::Deserializer::new(text))?.build()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default, rename = "authority")]
    authorities: Vec<AuthorityConfig>,
    #[serde(default, rename = "tool")]
    tools: Vec<ToolConfig>,
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
struct ToolConfig {
    name: String,
    description: String,
    result: String,
    #[serde(default, rename = "arg")]
    args: Vec<ArgSpec>,
    /// A tool without a contract is served but unregistered: calling it is
    /// unprovable and routes through the authority chain like any unknown.
    #[serde(default)]
    contract: Option<ContractConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContractConfig {
    #[serde(default)]
    requires: RequiresConfig,
    #[serde(default)]
    recipients_arg: Option<String>,
    #[serde(default)]
    effects: Vec<EffectConfig>,
    #[serde(default)]
    output: OutputConfig,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiresConfig {
    #[serde(default)]
    trust: Option<KnownTrustConfig>,
    #[serde(default)]
    audience: Option<AudienceRuleConfig>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputConfig {
    #[serde(default)]
    audience: AudienceConfig,
    #[serde(default)]
    trust: TrustConfig,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AudienceRuleConfig {
    Unrestricted,
    RecipientsWithinContext,
}

impl AudienceRuleConfig {
    fn to_domain(self) -> AudienceRule {
        match self {
            Self::Unrestricted => AudienceRule::Unrestricted,
            Self::RecipientsWithinContext => AudienceRule::FromRecipients,
        }
    }
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

impl RawConfig {
    fn build(self) -> Result<GatewayConfig, ConfigError> {
        let mut engine = PolicyEngine::new();
        let mut tools = BTreeMap::new();

        for tool in self.tools {
            if tool.name == ESCALATE_TOOL {
                return Err(ConfigError::ReservedToolName);
            }
            let name = ToolName::new(&tool.name);
            if let Some(contract) = &tool.contract {
                engine.register(contract.to_contract(&tool)?)?;
            }
            let sim = ToolSim {
                name: name.clone(),
                description: tool.description,
                recipients_arg: tool.contract.as_ref().and_then(|c| c.recipients_arg.clone()),
                args: tool.args,
                result: tool.result,
            };
            sim.validate_template()
                .map_err(|problem| ConfigError::BadResultTemplate {
                    tool: tool.name.clone(),
                    problem,
                })?;
            if tools.insert(name, sim).is_some() {
                return Err(ConfigError::DuplicateTool(tool.name));
            }
        }

        for authority in &self.authorities {
            engine.register_authority(Authority::external(
                &authority.name,
                AuthorityMandate {
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
            ))?;
        }

        Ok(GatewayConfig { engine, tools })
    }
}

impl ContractConfig {
    fn to_contract(&self, tool: &ToolConfig) -> Result<ToolContract, ConfigError> {
        let audience = self
            .requires
            .audience
            .map(AudienceRuleConfig::to_domain)
            .unwrap_or_default();
        let arguments = match &self.recipients_arg {
            Some(arg) => {
                if !tool.args.iter().any(|spec| &spec.name == arg) {
                    return Err(ConfigError::UnknownRecipientsArg {
                        tool: tool.name.clone(),
                        arg: arg.clone(),
                    });
                }
                ArgumentSchema::with_recipients(ArgumentName::new(arg))
            }
            None if audience == AudienceRule::FromRecipients => {
                return Err(ConfigError::MissingRecipientsArg(tool.name.clone()));
            }
            None => ArgumentSchema::opaque(),
        };
        Ok(ToolContract {
            name: ToolName::new(&tool.name),
            requires: Some(Requirements {
                trust: self.requires.trust.map(KnownTrustConfig::to_domain),
                audience,
                ..Requirements::default()
            }),
            output_label: ValueLabel {
                audience: self.output.audience.to_domain(),
                trust: self.output.trust.to_domain(),
            },
            effects: Effects::declared(self.effects.iter().copied().map(EffectConfig::to_domain)),
            arguments,
        })
    }
}

impl ToolSim {
    /// The MCP `tools/list` input schema: every declared argument is a string;
    /// undeclared arguments are rejected at call time.
    pub fn input_schema(&self) -> serde_json::Map<String, serde_json::Value> {
        let properties: serde_json::Map<String, serde_json::Value> = self
            .args
            .iter()
            .map(|arg| {
                let mut spec = serde_json::Map::new();
                spec.insert("type".into(), "string".into());
                if !arg.description.is_empty() {
                    spec.insert("description".into(), arg.description.clone().into());
                }
                (arg.name.clone(), serde_json::Value::Object(spec))
            })
            .collect();
        let required: Vec<serde_json::Value> = self
            .args
            .iter()
            .filter(|arg| arg.required)
            .map(|arg| arg.name.clone().into())
            .collect();
        let mut schema = serde_json::Map::new();
        schema.insert("type".into(), "object".into());
        schema.insert("properties".into(), serde_json::Value::Object(properties));
        schema.insert("required".into(), serde_json::Value::Array(required));
        schema.insert("additionalProperties".into(), false.into());
        schema
    }

    /// A `BTreeSet` of declared argument names, for call-time validation.
    pub fn declared_args(&self) -> BTreeSet<&str> {
        self.args.iter().map(|arg| arg.name.as_str()).collect()
    }

    /// Static check at config load: every placeholder names a declared
    /// argument and every brace closes — a scenario typo must fail before any
    /// dispatch could cross the release boundary.
    pub fn validate_template(&self) -> Result<(), String> {
        let declared = self.declared_args();
        let mut rest = self.result.as_str();
        while let Some(open) = rest.find('{') {
            let Some(close) = rest[open..].find('}') else {
                return Err("unclosed placeholder in result template".to_owned());
            };
            let key = &rest[open + 1..open + close];
            if !declared.contains(key) {
                return Err(format!(
                    "result template references `{{{key}}}`, which is not a declared argument"
                ));
            }
            rest = &rest[open + close + 1..];
        }
        Ok(())
    }

    /// Fill the result template from the canonical argument map. Fails on a
    /// placeholder with no argument (a declared-but-omitted optional) — the
    /// dispatch then closes via `record_failure`, never a half-rendered result.
    pub fn render_result(&self, args: &BTreeMap<String, String>) -> Result<String, String> {
        let mut out = String::new();
        let mut rest = self.result.as_str();
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let Some(close) = rest[open..].find('}') else {
                return Err(format!("unclosed placeholder in result template of `{}`", self.name));
            };
            let key = &rest[open + 1..open + close];
            match args.get(key) {
                Some(value) => out.push_str(value),
                None => {
                    return Err(format!(
                        "result template of `{}` references `{{{key}}}`, which the call did not provide",
                        self.name
                    ));
                }
            }
            rest = &rest[open + close + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }
}
