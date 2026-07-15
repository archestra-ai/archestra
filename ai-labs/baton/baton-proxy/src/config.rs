//! Proxy runtime config: the upstream base URL plus the embedded contracts
//! document (see `baton-contracts` for the `[contracts.*]` schema). The
//! prototype's `unknown_policy`/`taint_policy`/`approval_tool` fields are gone:
//! unknown-handling is authority registration in current baton-core. Only
//! inline `allow` authorities may be declared; `escalate` (external)
//! authorities are rejected at load — the proxy has no human channel to serve
//! them, so a silently-registered one could never rule: every call routed to
//! it would block at runtime with a confusing "needs approval" dead end
//! instead of the config failing at startup. Flows no declared authority
//! covers fail closed.

use baton_contracts::{Contracts, ContractsError};
use baton_core::AuthorityMode;
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error(transparent)]
    Contracts(#[from] ContractsError),
    #[error(
        "authority `{0}` has rule = \"escalate\", which the proxy cannot serve (no human channel); use rule = \"allow\" or remove it"
    )]
    EscalateAuthority(String),
}

/// The runtime policy the proxy evaluates against. Built once at startup and
/// shared read-only across requests.
#[derive(Debug, Clone)]
pub struct Policy {
    pub upstream_base_url: String,
    pub contracts: Contracts,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProxyConfig {
    upstream_base_url: String,
    #[serde(default)]
    contracts: toml::Table,
}

impl Policy {
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        let raw = RawProxyConfig::deserialize(toml::Deserializer::new(text))?;
        let contracts = Contracts::from_toml(&raw.contracts.to_string())?;
        if let Some(external) = contracts
            .authorities
            .iter()
            .find(|a| matches!(a.mode, AuthorityMode::External))
        {
            return Err(ConfigError::EscalateAuthority(external.name.as_str().to_string()));
        }
        Ok(Self {
            upstream_base_url: raw.upstream_base_url,
            contracts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_contracts_under_their_own_table() {
        let p = Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream.invalid"

            [contracts.user]
            id = "operator"

            [[contracts.tool]]
            name = "get_logs"
            output = { trust = "suspicious" }
            "#,
        )
        .unwrap();
        assert_eq!(p.upstream_base_url, "http://upstream.invalid");
        assert_eq!(p.contracts.user_id.as_str(), "operator");
        assert_eq!(p.contracts.contracts.len(), 1);
    }

    #[test]
    fn prototype_policy_knobs_are_rejected() {
        assert!(Policy::from_toml(r#"upstream_base_url = "x""#).is_ok());
        assert!(Policy::from_toml("upstream_base_url = \"x\"\nunknown_policy = \"deny\"").is_err());
    }

    #[test]
    fn escalate_authority_is_rejected_at_load() {
        let text = r#"
            upstream_base_url = "http://upstream.invalid"

            [[contracts.authority]]
            name = "human-in-the-loop"
            rule = "escalate"
            acquire_effects = true
        "#;
        assert!(matches!(
            Policy::from_toml(text),
            Err(ConfigError::EscalateAuthority(name)) if name == "human-in-the-loop"
        ));
    }

    #[test]
    fn allow_authority_still_loads() {
        let p = Policy::from_toml(
            r#"
            upstream_base_url = "http://upstream.invalid"

            [[contracts.authority]]
            name = "default-allow"
            rule = "allow"
            acknowledge_unknown = true
            "#,
        )
        .unwrap();
        assert_eq!(p.contracts.authorities.len(), 1);
    }
}
