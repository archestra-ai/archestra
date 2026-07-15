//! Contracts TOML → baton-core ToolContracts. Parsed strictly
//! (`deny_unknown_fields`, the baton-check discipline). The prototype's
//! `unknown_policy`/`taint_policy` knobs are gone on purpose: unknown-handling
//! is authority registration in current baton-core. This crate translates
//! declared tool contracts and declared authorities (inline `allow` only —
//! the narrow competence a policy may grant itself in TOML).

use std::collections::{BTreeSet, HashMap};

use baton_core::{
    ArgumentName, ArgumentSchema, AttentionRule, Audience, AudienceRule, Authority, AuthorityMandate, Effect, Effects,
    KnownTrust, ProposedGrant, Requirements, Ruling, ToolContract, ToolName, TrajectoryView, Trust, UserId, ValueLabel,
    Violation,
};
// Only referenced from the test module's assertions on `Authority::mode`
// (via `use super::*;`); a plain non-test build never names it.
#[cfg(test)]
use baton_core::AuthorityMode;
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
    #[error("unknown authority rule `{0}` (only \"allow\" is supported)")]
    AuthorityRule(String),
    #[error("authority `{0}` has no competence (acknowledge_unknown must be true)")]
    AuthorityImpotent(String),
    #[error("authority name may not be empty")]
    EmptyAuthorityName,
    #[error("duplicate authority `{0}`")]
    DuplicateAuthority(String),
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
    /// Authorities declared inline in the policy TOML (`[[authority]]`).
    pub authorities: Vec<Authority>,
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
    #[serde(default)]
    authority: Vec<AuthoritySpec>,
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
            let name = ToolName::new(&spec.name);
            let mut arguments = ArgumentSchema::opaque();
            let requires = match spec.requires {
                None => None,
                Some(requires_spec) => {
                    let (sink_audience, recipients_arg) = match &requires_spec.audience {
                        Some(audience) => audience.build(&spec.name)?,
                        None => (AudienceRule::Unrestricted, None),
                    };
                    if let Some(arg) = &recipients_arg {
                        recipients_args.insert(name.clone(), arg.clone());
                        arguments = ArgumentSchema::with_recipients(ArgumentName::new(arg));
                    }
                    Some(requires_spec.build(sink_audience))
                }
            };
            contracts.push(ToolContract {
                name,
                requires,
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

        let mut authorities = Vec::new();
        let mut seen_authorities = BTreeSet::new();
        for spec in self.authority {
            if !seen_authorities.insert(spec.name.clone()) {
                return Err(ContractsError::DuplicateAuthority(spec.name));
            }
            authorities.push(spec.build()?);
        }

        Ok(Contracts {
            user_id: UserId::new(&self.user.id),
            user_label,
            contracts,
            recipients_args,
            authorities,
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
    requires: Option<RequiresSpec>,
}

/// How information returned by this tool call is labeled and how the call
/// modifies the trajectory. Omitted fields are UNKNOWN (fail closed at any
/// guarded sink downstream) — except `effects`, which defaults to none:
/// unknown proposed effects would grow the surface on every call and, with
/// no Accept authority, block every registered tool unconditionally.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputSpec {
    #[serde(default = "unknown_trust")]
    trust: TrustSpec,
    #[serde(default = "unknown_audience")]
    audience: AudienceSpec,
    #[serde(default)]
    effects: Vec<EffectSpec>,
}

impl Default for OutputSpec {
    fn default() -> Self {
        Self {
            trust: unknown_trust(),
            audience: unknown_audience(),
            effects: Vec::new(),
        }
    }
}

fn unknown_trust() -> TrustSpec {
    TrustSpec::Unknown
}

fn unknown_audience() -> AudienceSpec {
    AudienceSpec::Keyword("unknown".to_string())
}

/// What the current trajectory must satisfy to allow the call.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiresSpec {
    #[serde(default)]
    trust: Option<KnownTrustSpec>,
    /// The sink's audience: who a call exposes the flow to — `"public"`,
    /// a reader list, or `"$.args.<argument>"`. The flow's audience must
    /// cover it. Absent means the tool exposes no one — no check.
    #[serde(default)]
    audience: Option<AudienceRuleSpec>,
    #[serde(default)]
    attention: AttentionRuleSpec,
    #[serde(default)]
    forbid_prior_effects: Vec<EffectSpec>,
}

impl RequiresSpec {
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthoritySpec {
    name: String,
    rule: String,
    acknowledge_unknown: bool,
}

/// The one inline ruling TOML can declare: approve everything routed here.
/// Competence is bounded by the mandate, not the ruling — with only
/// `acknowledge_unknown`, this can clear unprovable facts and nothing else.
fn allow_ruling(_grant: &ProposedGrant, violations: &[Violation], _view: &TrajectoryView<'_>) -> Option<Ruling> {
    let facts = violations
        .iter()
        .map(Violation::to_string)
        .collect::<Vec<_>>()
        .join("; ");
    Some(Ruling::Approve {
        reason: format!("allowed by policy rule: {facts}"),
    })
}

impl AuthoritySpec {
    fn build(&self) -> Result<Authority, ContractsError> {
        if self.name.is_empty() {
            return Err(ContractsError::EmptyAuthorityName);
        }
        if self.rule != "allow" {
            return Err(ContractsError::AuthorityRule(self.rule.clone()));
        }
        if !self.acknowledge_unknown {
            return Err(ContractsError::AuthorityImpotent(self.name.clone()));
        }
        Ok(Authority::inline(
            &self.name,
            AuthorityMandate::none().acknowledge_unknown(),
            allow_ruling,
        ))
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
        output = { trust = "suspicious", audience = ["operator"] }
        requires = {}

        [[tool]]
        name = "k8s_delete_resource"
        output = { trust = "trusted", audience = ["operator"], effects = ["mutation"] }
        requires = { trust = "trusted", attention = "explicit_confirmation" }

        [[tool]]
        name = "http_post"
        requires = { trust = "trusted", audience = "$.args.url" }

        [[tool]]
        name = "create_issue"
        requires = { audience = "public" }

        [[tool]]
        name = "send_report"
        requires = { audience = ["ops-hook", "operator"] }

        [[tool]]
        name = "bare"
    "#;

    #[test]
    fn parses_demo_contracts() {
        let c = Contracts::from_toml(DEMO).unwrap();
        assert_eq!(c.user_id.as_str(), "operator");
        assert_eq!(c.contracts.len(), 6);

        let logs = c
            .contracts
            .iter()
            .find(|t| t.name.as_str() == "k8s_get_pod_logs")
            .unwrap();
        assert_eq!(logs.output_label.trust, Trust::SUSPICIOUS);
        assert_eq!(logs.output_label.audience, Audience::readers([UserId::new("operator")]));
        let logs_requires = logs.requires.as_ref().unwrap();
        assert!(logs_requires.trust.is_none());
        assert_eq!(logs_requires.audience, AudienceRule::Unrestricted);
        assert_eq!(logs.effects, Effects::none());

        let del = c
            .contracts
            .iter()
            .find(|t| t.name.as_str() == "k8s_delete_resource")
            .unwrap();
        assert_eq!(del.requires.as_ref().unwrap().trust, Some(KnownTrust::Trusted));
        assert_eq!(
            del.requires.as_ref().unwrap().attention,
            AttentionRule::ExplicitConfirmation
        );
        assert_eq!(del.effects, Effects::declared([Effect::Mutation]));

        let post = c.contracts.iter().find(|t| t.name.as_str() == "http_post").unwrap();
        assert_eq!(post.requires.as_ref().unwrap().audience, AudienceRule::FromRecipients);
        assert_eq!(c.recipients_args.get(&post.name).map(String::as_str), Some("url"));

        let issue = c.contracts.iter().find(|t| t.name.as_str() == "create_issue").unwrap();
        assert_eq!(issue.requires.as_ref().unwrap().audience, AudienceRule::Public);
        assert!(!c.recipients_args.contains_key(&issue.name));

        let report = c.contracts.iter().find(|t| t.name.as_str() == "send_report").unwrap();
        assert_eq!(
            report.requires.as_ref().unwrap().audience,
            AudienceRule::Readers(BTreeSet::from([UserId::new("ops-hook"), UserId::new("operator")]))
        );
    }

    #[test]
    fn omitted_output_defaults_to_unknown_label_and_no_effects() {
        let c = Contracts::from_toml(DEMO).unwrap();
        let bare = c.contracts.iter().find(|t| t.name.as_str() == "bare").unwrap();
        assert_eq!(bare.output_label.trust, Trust::UNKNOWN);
        assert_eq!(bare.output_label.audience, Audience::UNKNOWN);
        assert_eq!(bare.effects, Effects::none());
        assert_eq!(bare.requires, None);
    }

    #[test]
    fn partially_written_output_defaults_missing_fields_to_unknown() {
        let c = Contracts::from_toml(
            r#"
            [[tool]]
            name = "reader"
            output = { trust = "trusted" }
            "#,
        )
        .unwrap();
        let reader = c.contracts.iter().find(|t| t.name.as_str() == "reader").unwrap();
        assert_eq!(reader.output_label.trust, Trust::TRUSTED);
        assert_eq!(reader.output_label.audience, Audience::UNKNOWN);
    }

    #[test]
    fn user_defaults_stay_trusted_and_public() {
        let c = Contracts::from_toml("").unwrap();
        assert_eq!(c.user_id.as_str(), "user");
        assert_eq!(c.user_label.trust, Trust::TRUSTED);
        assert_eq!(c.user_label.audience, Audience::PUBLIC);
        assert!(c.contracts.is_empty());
    }

    #[test]
    fn top_level_audience_key_is_rejected() {
        let text = r#"
            [[tool]]
            name = "send"
            audience = "public"
        "#;
        assert!(matches!(Contracts::from_toml(text), Err(ContractsError::Parse(_))));
    }

    #[test]
    fn sink_audience_rejects_unknown_keyword() {
        let text = r#"
            [[tool]]
            name = "send"
            requires = { audience = "recipients_within_context" }
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
                requires = {{ audience = "{path}" }}
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
            requires = { audience = [] }
        "#;
        assert!(matches!(
            Contracts::from_toml(text),
            Err(ContractsError::EmptyAudience(_))
        ));
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
    fn unknown_policy_field_is_rejected() {
        // The prototype's knob must NOT silently parse.
        let text = r#"unknown_policy = "deny""#;
        assert!(Contracts::from_toml(text).is_err());
    }

    #[test]
    fn absent_requires_is_unknown_requirements() {
        let c = Contracts::from_toml(
            r#"
            [[tool]]
            name = "mystery"
            output = { trust = "trusted", audience = "public" }
            "#,
        )
        .unwrap();
        let t = c.contracts.iter().find(|t| t.name.as_str() == "mystery").unwrap();
        assert_eq!(t.requires, None);
    }

    #[test]
    fn empty_requires_is_considered_and_ungated() {
        let c = Contracts::from_toml(
            r#"
            [[tool]]
            name = "open"
            requires = {}
            "#,
        )
        .unwrap();
        let t = c.contracts.iter().find(|t| t.name.as_str() == "open").unwrap();
        assert_eq!(t.requires, Some(Requirements::default()));
    }

    #[test]
    fn allow_authority_parses_with_acknowledge_mandate() {
        let c = Contracts::from_toml(
            r#"
            [[authority]]
            name = "default-allow"
            rule = "allow"
            acknowledge_unknown = true
            "#,
        )
        .unwrap();
        assert_eq!(c.authorities.len(), 1);
        assert_eq!(c.authorities[0].name.as_str(), "default-allow");
        assert!(c.authorities[0].mandate.acknowledge_unknown);
        assert!(matches!(c.authorities[0].mode, AuthorityMode::Inline(_)));
    }

    #[test]
    fn authority_rejects_unknown_rule_false_flag_and_duplicates() {
        assert!(matches!(
            Contracts::from_toml("[[authority]]\nname = \"a\"\nrule = \"deny\"\nacknowledge_unknown = true"),
            Err(ContractsError::AuthorityRule(_))
        ));
        assert!(matches!(
            Contracts::from_toml("[[authority]]\nname = \"a\"\nrule = \"allow\"\nacknowledge_unknown = false"),
            Err(ContractsError::AuthorityImpotent(_))
        ));
        assert!(matches!(
            Contracts::from_toml("[[authority]]\nname = \"\"\nrule = \"allow\"\nacknowledge_unknown = true"),
            Err(ContractsError::EmptyAuthorityName)
        ));
        let dup = "[[authority]]\nname = \"a\"\nrule = \"allow\"\nacknowledge_unknown = true\n\
                   [[authority]]\nname = \"a\"\nrule = \"allow\"\nacknowledge_unknown = true";
        assert!(matches!(
            Contracts::from_toml(dup),
            Err(ContractsError::DuplicateAuthority(_))
        ));
    }
}
