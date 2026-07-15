//! Contracts TOML → baton-core ToolContracts. Parsed strictly
//! (`deny_unknown_fields`, the baton-check discipline). The prototype's
//! `unknown_policy`/`taint_policy` knobs are gone on purpose: unknown-handling
//! is authority registration in current baton-core, and this crate does not
//! register authorities — it only translates declared tool contracts.

use std::collections::{BTreeSet, HashMap};

use baton_core::{
    ArgumentName, ArgumentSchema, AttentionRule, Audience, AudienceRule, Effect, Effects, KnownTrust, Requirements,
    ToolContract, ToolName, Trust, UserId, ValueLabel,
};
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum ContractsError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("unknown audience keyword `{0}` (use \"public\", \"unknown\", or a list of ids)")]
    AudienceKeyword(String),
    #[error("duplicate contract for tool `{0}`")]
    DuplicateTool(String),
    #[error("invalid sink audience `{0}` (use \"public\", a list of reader ids, or \"$.args.<argument>\")")]
    AudienceRule(String),
    #[error("sink audience path `{0}` must name one top-level argument (no nested paths)")]
    AudienceRulePath(String),
    #[error("tool `{0}` declares an empty audience reader list")]
    EmptyAudience(String),
}

/// The parsed policy document: who the requesting user is, and the contracts
/// to register. Built once at startup and shared read-only across requests.
#[derive(Debug, Clone)]
pub struct Contracts {
    pub user_id: UserId,
    pub user_label: ValueLabel,
    pub contracts: Vec<ToolContract>,
    /// Per-tool wire argument that carries recipients (e.g. `to`, `url`).
    pub recipients_args: HashMap<ToolName, String>,
}

impl Contracts {
    pub fn from_toml(text: &str) -> Result<Self, ContractsError> {
        RawConfig::deserialize(toml::Deserializer::new(text))?.build()
    }

    /// Whether a tool has a registered contract. Tools without one are outside
    /// the policy's scope and pass through untouched (gradual adoption:
    /// annotate the risky tools, leave the rest).
    pub fn has_contract(&self, tool: &ToolName) -> bool {
        self.contracts.iter().any(|c| &c.name == tool)
    }
}

fn default_user_id() -> String {
    "user".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    user: UserSpec,
    #[serde(default)]
    tool: Vec<ToolSpec>,
}

impl RawConfig {
    fn build(self) -> Result<Contracts, ContractsError> {
        let user_label = ValueLabel {
            audience: self.user.audience.to_audience()?,
            trust: self.user.trust.to_trust(),
        };

        let mut contracts = Vec::new();
        let mut recipients_args = HashMap::new();
        let mut seen = BTreeSet::new();
        for spec in self.tool {
            if !seen.insert(spec.name.clone()) {
                return Err(ContractsError::DuplicateTool(spec.name));
            }
            let (sink_audience, recipients_arg) = match &spec.audience {
                Some(audience) => audience.build(&spec.name)?,
                None => (AudienceRule::Unrestricted, None),
            };
            let name = ToolName::new(&spec.name);
            let arguments = match &recipients_arg {
                Some(arg) => {
                    recipients_args.insert(name.clone(), arg.clone());
                    ArgumentSchema::with_recipients(ArgumentName::new(arg))
                }
                None => ArgumentSchema::opaque(),
            };
            contracts.push(ToolContract {
                name,
                requires: spec.requires.build(sink_audience),
                output_label: ValueLabel {
                    audience: spec.output.audience.to_audience()?,
                    trust: spec.output.trust.to_trust(),
                },
                effects: if spec.output.effects.is_empty() {
                    Effects::none()
                } else {
                    Effects::declared(spec.output.effects.iter().copied().map(EffectSpec::to_effect))
                },
                arguments,
            });
        }

        Ok(Contracts {
            user_id: UserId::new(&self.user.id),
            user_label,
            contracts,
            recipients_args,
        })
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
    /// The sink's audience: who a call exposes the flow to. Absent means the
    /// tool exposes no one beyond the conversation — no audience check.
    #[serde(default)]
    audience: Option<AudienceRuleSpec>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiresSpec {
    #[serde(default)]
    trust: Option<KnownTrustSpec>,
    #[serde(default)]
    attention: AttentionRuleSpec,
    #[serde(default)]
    forbid_prior_effects: Vec<EffectSpec>,
}

impl RequiresSpec {
    /// The sink audience is declared at the tool level (`audience = …`), not
    /// under `requires` — it is a fact about the sink, folded in here.
    fn build(self, audience: AudienceRule) -> Requirements {
        Requirements {
            trust: self.trust.map(KnownTrustSpec::into_known_trust),
            audience,
            attention: self.attention.into(),
            forbid_prior_effects: self
                .forbid_prior_effects
                .into_iter()
                .map(EffectSpec::to_effect)
                .collect(),
        }
    }
}

/// The path prefix marking a dynamic sink audience: the named top-level call
/// argument carries the recipients.
const ARGS_PATH_PREFIX: &str = "$.args.";

/// Sink audience as `"public"`, a list of reader ids, or `"$.args.<key>"`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AudienceRuleSpec {
    Keyword(String),
    Readers(Vec<String>),
}

impl AudienceRuleSpec {
    /// The engine-side declaration plus, for the dynamic form, the wire
    /// argument the proxy must extract recipients from.
    fn build(&self, tool: &str) -> Result<(AudienceRule, Option<String>), ContractsError> {
        match self {
            Self::Keyword(k) if k == "public" => Ok((AudienceRule::Public, None)),
            Self::Keyword(k) if k.starts_with(ARGS_PATH_PREFIX) => {
                let key = &k[ARGS_PATH_PREFIX.len()..];
                if key.is_empty() || key.contains('.') {
                    return Err(ContractsError::AudienceRulePath(k.clone()));
                }
                Ok((AudienceRule::FromRecipients, Some(key.to_string())))
            }
            Self::Keyword(k) => Err(ContractsError::AudienceRule(k.clone())),
            Self::Readers(ids) if ids.is_empty() => Err(ContractsError::EmptyAudience(tool.to_string())),
            Self::Readers(ids) => Ok((AudienceRule::Readers(ids.iter().map(UserId::new).collect()), None)),
        }
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
    fn to_audience(&self) -> Result<Audience, ContractsError> {
        match self {
            Self::Keyword(k) if k == "public" => Ok(Audience::PUBLIC),
            Self::Keyword(k) if k == "unknown" => Ok(Audience::UNKNOWN),
            Self::Keyword(k) => Err(ContractsError::AudienceKeyword(k.clone())),
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

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = r#"
        [user]
        id = "operator"

        [[tool]]
        name = "k8s_get_pod_logs"
        output = { trust = "suspicious" }

        [[tool]]
        name = "k8s_delete_resource"
        requires = { trust = "trusted", attention = "explicit_confirmation" }
        output = { effects = ["mutation"] }

        [[tool]]
        name = "http_post"
        requires = { trust = "trusted" }
        audience = "$.args.url"
        output = { effects = ["egress"] }

        [[tool]]
        name = "create_issue"
        audience = "public"

        [[tool]]
        name = "send_report"
        audience = ["ops-hook", "operator"]
    "#;

    #[test]
    fn parses_demo_contracts() {
        let c = Contracts::from_toml(DEMO).unwrap();
        assert_eq!(c.user_id.as_str(), "operator");
        assert_eq!(c.contracts.len(), 5);

        let logs = c
            .contracts
            .iter()
            .find(|t| t.name.as_str() == "k8s_get_pod_logs")
            .unwrap();
        assert_eq!(logs.output_label.trust, Trust::SUSPICIOUS);
        assert!(logs.requires.trust.is_none());
        assert_eq!(logs.requires.audience, AudienceRule::Unrestricted);
        assert_eq!(logs.effects, Effects::none());

        let del = c
            .contracts
            .iter()
            .find(|t| t.name.as_str() == "k8s_delete_resource")
            .unwrap();
        assert_eq!(del.requires.trust, Some(KnownTrust::Trusted));
        assert_eq!(del.requires.attention, AttentionRule::ExplicitConfirmation);
        assert_eq!(del.effects, Effects::declared([Effect::Mutation]));

        let post = c.contracts.iter().find(|t| t.name.as_str() == "http_post").unwrap();
        assert_eq!(post.requires.audience, AudienceRule::FromRecipients);
        assert_eq!(c.recipients_args.get(&post.name).map(String::as_str), Some("url"));

        let issue = c.contracts.iter().find(|t| t.name.as_str() == "create_issue").unwrap();
        assert_eq!(issue.requires.audience, AudienceRule::Public);
        assert!(!c.recipients_args.contains_key(&issue.name));

        let report = c.contracts.iter().find(|t| t.name.as_str() == "send_report").unwrap();
        assert_eq!(
            report.requires.audience,
            AudienceRule::Readers(BTreeSet::from([UserId::new("ops-hook"), UserId::new("operator")]))
        );
        assert!(!c.recipients_args.contains_key(&report.name));
    }

    #[test]
    fn sink_audience_rejects_unknown_keyword() {
        let text = r#"
            [[tool]]
            name = "send"
            audience = "recipients_within_context"
        "#;
        assert!(matches!(
            Contracts::from_toml(text),
            Err(ContractsError::AudienceRule(_))
        ));
    }

    #[test]
    fn sink_audience_rejects_nested_or_empty_path() {
        for path in ["$.args.", "$.args.params.repo"] {
            let text = format!(
                r#"
                [[tool]]
                name = "send"
                audience = "{path}"
                "#
            );
            assert!(matches!(
                Contracts::from_toml(&text),
                Err(ContractsError::AudienceRulePath(_))
            ));
        }
    }

    #[test]
    fn sink_audience_rejects_empty_reader_list() {
        let text = r#"
            [[tool]]
            name = "send"
            audience = []
        "#;
        assert!(matches!(
            Contracts::from_toml(text),
            Err(ContractsError::EmptyAudience(_))
        ));
    }

    #[test]
    fn removed_recipients_arg_field_is_rejected() {
        let text = r#"
            [[tool]]
            name = "send"
            audience = "$.args.url"
            recipients_arg = "url"
        "#;
        assert!(matches!(Contracts::from_toml(text), Err(ContractsError::Parse(_))));
    }

    #[test]
    fn duplicate_tool_is_an_error() {
        let text = r#"
            [[tool]]
            name = "a"
            [[tool]]
            name = "a"
        "#;
        assert!(matches!(
            Contracts::from_toml(text),
            Err(ContractsError::DuplicateTool(_))
        ));
    }

    #[test]
    fn requires_audience_field_is_rejected() {
        // The sink audience moved to the tool level; the old `requires`
        // placement must not silently parse.
        let text = r#"
            [[tool]]
            name = "send"
            requires = { audience = "public" }
        "#;
        assert!(matches!(Contracts::from_toml(text), Err(ContractsError::Parse(_))));
    }

    #[test]
    fn unknown_policy_field_is_rejected() {
        // The prototype's knob must NOT silently parse.
        let text = r#"unknown_policy = "deny""#;
        assert!(Contracts::from_toml(text).is_err());
    }

    #[test]
    fn empty_document_yields_default_user_and_no_contracts() {
        let c = Contracts::from_toml("").unwrap();
        assert_eq!(c.user_id.as_str(), "user");
        assert_eq!(c.user_label, ValueLabel::identity());
        assert!(c.contracts.is_empty());
    }
}
