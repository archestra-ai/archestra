//! Lane registry. The analyzer reuses the benchmark's `lanes.toml` so each phase is chosen by lane
//! name (`--map kimi`) instead of restating provider/model/base_url/api_key_env on the CLI. The
//! schema mirrors what the benchmark runner reads, so the two stay in lockstep.

use std::collections::BTreeMap;
use std::path::Path;

use eyre::{Context, Result, bail, eyre};
use nitpicker_agent::prelude::LLMProvider;
use serde::Deserialize;

use crate::analyze::{ProviderKind, to_provider};

/// One `[[lane]]` entry: a named (provider, model) endpoint with its own optional key/base_url.
#[derive(Debug, Clone, Deserialize)]
pub struct Lane {
    pub name: String,
    pub provider: ProviderKind,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
}

impl Lane {
    /// Resolve this lane's endpoint into the provider the LLM client is built from.
    pub fn provider(&self) -> Result<LLMProvider> {
        to_provider(self.provider, self.base_url.clone(), self.api_key_env.clone())
    }
}

#[derive(Debug, Deserialize)]
struct LanesFile {
    #[serde(default)]
    lane: Vec<Lane>,
}

/// All lanes from a `lanes.toml`, indexed by name for `--map`/`--reduce` resolution.
#[derive(Debug)]
pub struct Lanes(BTreeMap<String, Lane>);

impl Lanes {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .wrap_err_with(|| format!("reading lanes file at {}", path.display()))?;
        Self::parse(&content).wrap_err_with(|| format!("parsing lanes file at {}", path.display()))
    }

    fn parse(content: &str) -> Result<Self> {
        let parsed: LanesFile = toml::from_str(content)?;
        if parsed.lane.is_empty() {
            bail!("no [[lane]] entries defined");
        }
        let mut lanes = BTreeMap::new();
        for lane in parsed.lane {
            if let Some(dup) = lanes.insert(lane.name.clone(), lane) {
                bail!("duplicate lane name `{}`", dup.name);
            }
        }
        Ok(Self(lanes))
    }

    /// Look up a lane by name, listing the known names when it is missing so a typo is actionable.
    pub fn get(&self, name: &str) -> Result<&Lane> {
        self.0.get(name).ok_or_else(|| {
            let known = self.0.keys().cloned().collect::<Vec<_>>().join(", ");
            eyre!("unknown lane `{name}`; known lanes: {known}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
        [[lane]]
        name = "minimax"
        provider = "openrouter"
        model = "minimax/minimax-m3"

        [[lane]]
        name = "kimi"
        provider = "anthropic"
        model = "kimi-for-coding"
        base_url = "https://api.kimi.com/coding/"
        api_key_env = "KIMI_API_KEY"
    "#;

    #[test]
    fn parses_lane_fields_including_optionals() {
        let lanes = Lanes::parse(SAMPLE).unwrap();

        let minimax = lanes.get("minimax").unwrap();
        assert_eq!(minimax.provider, ProviderKind::Openrouter);
        assert_eq!(minimax.model, "minimax/minimax-m3");
        assert!(minimax.base_url.is_none());

        let kimi = lanes.get("kimi").unwrap();
        assert_eq!(kimi.provider, ProviderKind::Anthropic);
        assert_eq!(kimi.base_url.as_deref(), Some("https://api.kimi.com/coding/"));
        assert_eq!(kimi.api_key_env.as_deref(), Some("KIMI_API_KEY"));
    }

    #[test]
    fn unknown_lane_lists_known_names() {
        let lanes = Lanes::parse(SAMPLE).unwrap();
        let err = lanes.get("nope").unwrap_err().to_string();
        assert!(err.contains("unknown lane `nope`"));
        assert!(err.contains("kimi"));
    }

    #[test]
    fn duplicate_lane_name_is_an_error() {
        let dup = r#"
            [[lane]]
            name = "x"
            provider = "anthropic"
            model = "a"
            [[lane]]
            name = "x"
            provider = "openai"
            model = "b"
        "#;
        let err = Lanes::parse(dup).unwrap_err().to_string();
        assert!(err.contains("duplicate lane name `x`"));
    }

    #[test]
    fn empty_lanes_file_is_an_error() {
        let err = Lanes::parse("").unwrap_err().to_string();
        assert!(err.contains("no [[lane]] entries"));
    }
}
