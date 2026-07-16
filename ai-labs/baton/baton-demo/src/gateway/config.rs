//! Gateway config → a policy engine plus the simulated tools it mediates.
//! Two files: the tool catalog (this crate's own sims dialect) and the policy
//! (contracts + authorities, parsed by `baton-contracts` — the one canonical
//! dialect). Both are parsed strictly (`deny_unknown_fields`): a typo in a
//! config file must fail loudly, never silently weaken it.
//!
//! The policy's `[trajectory]` section (`Contracts::trajectory_label`) is
//! ignored: the gateway session has no user turns — every admitted value is
//! model output over the session context.
//!
//! The canonical dialect can also declare inline `rule = "allow"` authorities
//! (the old gateway dialect could not). They work, with one wrinkle: the
//! session soft-blocks first and resolves inline rulings only during the
//! escalation's remedy walk — so a call an allow authority fully covers still
//! round-trips through `baton__escalate`, which then executes without
//! prompting the human. The checked-in scenario uses only the escalate
//! authority.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use baton_contracts::{Contracts, ContractsError};
use baton_core::{AudienceRule, ContractRefused, PolicyEngine, RegistrationRefused, RegistryFrozen, ToolName, UserId};
use serde::Deserialize;

/// The escalation tool the gateway itself serves; a scenario tool cannot
/// shadow it, and the policy cannot contract it.
pub const ESCALATE_TOOL: &str = "baton__escalate";
/// The reserved MCP tool the agent's final answer must flow through: the
/// gateway checks it at the engine's emission sink and returns only the
/// permitted rendering. Reserved on the same terms as `ESCALATE_TOOL`.
pub const RESPOND_TOOL: &str = "baton__respond";

/// Which of the two config files an error came from — startup messages name
/// the offending file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFile {
    /// The tool-catalog file (`--config`).
    Tools,
    /// The policy file (`--policy`).
    Policy,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error(transparent)]
    Contracts(#[from] ContractsError),
    #[error(transparent)]
    ContractRefused(#[from] ContractRefused),
    #[error(transparent)]
    RegistrationRefused(#[from] RegistrationRefused),
    #[error(transparent)]
    RegistryFrozen(#[from] RegistryFrozen),
    #[error("duplicate tool `{0}`")]
    DuplicateTool(String),
    #[error("tool name `{ESCALATE_TOOL}` and `{RESPOND_TOOL}` are reserved for the gateway's own tools")]
    ReservedToolName,
    #[error("the policy contracts `{ESCALATE_TOOL}`, which is reserved for the gateway's escalation tool")]
    ReservedContractName,
    #[error("the policy contracts `{0}`, which no simulated tool serves")]
    ContractWithoutTool(String),
    #[error("tool `{tool}`: the contract's `$.args.{arg}` audience names an argument the tool does not declare")]
    UnknownRecipientsArg { tool: String, arg: String },
    #[error("tool `{tool}`: {problem}")]
    BadResultTemplate { tool: String, problem: String },
}

impl ConfigError {
    /// Attribute the error to the config file it came from.
    pub fn source_file(&self) -> ConfigFile {
        match self {
            // `RegistryFrozen` reaches here only from the response policy,
            // which the tool-catalog file declares.
            Self::Parse(_)
            | Self::DuplicateTool(_)
            | Self::ReservedToolName
            | Self::RegistryFrozen(_)
            | Self::BadResultTemplate { .. } => ConfigFile::Tools,
            Self::Contracts(_)
            | Self::ContractRefused(_)
            | Self::RegistrationRefused(_)
            | Self::ReservedContractName
            | Self::ContractWithoutTool(_)
            | Self::UnknownRecipientsArg { .. } => ConfigFile::Policy,
        }
    }
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
    /// `$.args.<arg>` audience) — used for narration and approval prompts.
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

/// The parsed gateway config: the engine (contracts + authorities, fixed
/// before the first evaluation) and the simulated tools, keyed by name.
pub struct GatewayConfig {
    pub engine: PolicyEngine,
    pub tools: BTreeMap<ToolName, ToolSim>,
}

impl GatewayConfig {
    /// Build from the two config files: `tools` is the simulated-tool catalog,
    /// `policy` the contracts + authorities in the `baton-contracts` dialect.
    /// The two join by tool name: a tool without a contract is served but
    /// unregistered (calling it is unprovable and routes through the authority
    /// chain like any unknown); a contract without a tool is a config error.
    pub fn from_toml(tools: &str, policy: &str) -> Result<Self, ConfigError> {
        let raw = RawConfig::deserialize(toml::Deserializer::new(tools))?;
        let policy = Contracts::from_toml(policy)?;
        raw.build(policy)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default, rename = "tool")]
    tools: Vec<ToolConfig>,
    /// Who reads the conversation. When present the engine registers the
    /// response-sink policy, and the agent's final answer is checked as an
    /// emission flow through `baton__respond`. Absent, the emission check
    /// fails closed (no registered response policy).
    ///
    /// This lives with the tool catalog rather than the policy file because
    /// the canonical `baton-contracts` dialect models tool contracts and
    /// authorities; the response sink is neither.
    #[serde(default)]
    response: Option<ResponseConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseConfig {
    readers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolConfig {
    name: String,
    description: String,
    result: String,
    #[serde(default, rename = "arg")]
    args: Vec<ArgSpec>,
}

impl RawConfig {
    fn build(self, policy: Contracts) -> Result<GatewayConfig, ConfigError> {
        let mut engine = PolicyEngine::new();
        let mut tools = BTreeMap::new();

        for tool in self.tools {
            if tool.name == ESCALATE_TOOL || tool.name == RESPOND_TOOL {
                return Err(ConfigError::ReservedToolName);
            }
            let name = ToolName::new(&tool.name);
            let sim = ToolSim {
                name: name.clone(),
                description: tool.description,
                recipients_arg: policy.recipients_args.get(&name).cloned(),
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

        // Join the policy to the catalog. The reserved-name check runs first
        // so a contracted `baton__escalate` reports as reserved, not as a
        // contract without a tool.
        for contract in &policy.contracts {
            if contract.name.as_str() == ESCALATE_TOOL || contract.name.as_str() == RESPOND_TOOL {
                return Err(ConfigError::ReservedContractName);
            }
            let Some(sim) = tools.get(&contract.name) else {
                return Err(ConfigError::ContractWithoutTool(contract.name.as_str().to_owned()));
            };
            // baton-contracts validates only the `$.args.<arg>` path syntax;
            // whether the argument exists is catalog knowledge. Without this
            // check a typo would load fine and then fail every call at the
            // engine as undeclared recipients — a load-time config bug
            // surfacing as a runtime block.
            if let Some(arg) = policy.recipients_args.get(&contract.name)
                && !sim.declared_args().contains(arg.as_str())
            {
                return Err(ConfigError::UnknownRecipientsArg {
                    tool: contract.name.as_str().to_owned(),
                    arg: arg.clone(),
                });
            }
        }

        for contract in policy.contracts {
            engine.register(contract)?;
        }
        for authority in policy.authorities {
            engine.register_authority(authority)?;
        }

        // The response sink: the agent's final answer is checked against this
        // audience, and only the permitted rendering is delivered.
        if let Some(response) = &self.response {
            engine = engine.with_response_policy(baton_core::ResponsePolicy {
                requires: baton_core::Requirements {
                    audience: AudienceRule::FromRecipients,
                    ..baton_core::Requirements::default()
                },
                readers: response.readers.iter().map(UserId::new).collect(),
            })?;
        }

        Ok(GatewayConfig { engine, tools })
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
