//! Lane registry shared by the benchmark runner and the trajectory analyzer. A lane is a named
//! `(provider, model)` endpoint with its own optional key/base_url. Defining it once here keeps the
//! two consumers from drifting — they previously parsed the same `lanes.toml` through two independent
//! `Lane`/`Provider` types that had to be kept "in lockstep" by hand.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::slug;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LaneError(pub String);

/// The provider an LLM key is seeded under / a lane's endpoint is built from. The set is closed:
/// an unknown value in `lanes.toml` is a loud config error, not a silently-passed string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
    Gemini,
    Openrouter,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::Gemini => "gemini",
            Provider::Openrouter => "openrouter",
        }
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Provider {
    type Err = LaneError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "anthropic" => Ok(Provider::Anthropic),
            "openai" => Ok(Provider::Openai),
            "gemini" => Ok(Provider::Gemini),
            "openrouter" => Ok(Provider::Openrouter),
            other => Err(LaneError(format!(
                "unknown provider {other:?}; expected one of [anthropic, openai, gemini, openrouter]"
            ))),
        }
    }
}

/// One `[[lane]]` entry.
#[derive(Debug, Clone)]
pub struct Lane {
    pub name: String,
    pub provider: Provider,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_env: Option<String>,
}

impl Lane {
    /// Filesystem-safe handle for this lane's agent / log / artifact dir.
    pub fn slug(&self) -> String {
        slug(&self.name)
    }

    /// Env var holding this lane's key, defaulting to `<PROVIDER>_API_KEY`.
    pub fn key_env(&self) -> String {
        self.api_key_env
            .clone()
            .unwrap_or_else(|| format!("{}_API_KEY", self.provider.as_str().to_uppercase()))
    }
}

/// A lane name is a slug: `[A-Za-z0-9][A-Za-z0-9-]*`.
pub fn is_slug(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Debug, Deserialize)]
struct RawLanesFile {
    #[serde(default)]
    lane: Vec<RawLane>,
}

#[derive(Debug, Deserialize)]
struct RawLane {
    name: String,
    provider: String,
    model: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
}

/// Load `[[lane]]` entries from a `lanes.toml`. With `select = Some("a,b")`, return exactly those
/// lanes in the requested order; with `None`, return every lane in TOML declaration order (which the
/// "first lane per provider is primary" rule depends on). Names are slug-validated and de-duplicated;
/// a bad provider is reported with its lane name in scope.
pub fn load_lanes(path: &Path, select: Option<&str>) -> Result<Vec<Lane>, LaneError> {
    let ctx = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let content = std::fs::read_to_string(path).map_err(|e| LaneError(format!("{ctx}: {e}")))?;
    let parsed: RawLanesFile =
        toml::from_str(&content).map_err(|e| LaneError(format!("{ctx}: {e}")))?;
    if parsed.lane.is_empty() {
        return Err(LaneError(format!("{ctx}: no [[lane]] defined")));
    }

    let mut catalog: Vec<Lane> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in parsed.lane {
        if !is_slug(&raw.name) {
            return Err(LaneError(format!(
                "{ctx}: lane name {:?} must be a slug ([A-Za-z0-9][A-Za-z0-9-]*)",
                raw.name
            )));
        }
        if !seen.insert(raw.name.clone()) {
            return Err(LaneError(format!(
                "{ctx}: duplicate lane name {:?}",
                raw.name
            )));
        }
        let provider = Provider::from_str(&raw.provider)
            .map_err(|e| LaneError(format!("{ctx}: lane {:?}: {e}", raw.name)))?;
        catalog.push(Lane {
            name: raw.name,
            provider,
            model: raw.model,
            base_url: raw.base_url,
            api_key_env: raw.api_key_env,
        });
    }

    match split_names(select) {
        None => Ok(catalog),
        Some(names) => {
            let unknown: Vec<String> = names
                .iter()
                .filter(|n| !seen.contains(*n))
                .cloned()
                .collect();
            if !unknown.is_empty() {
                let mut available: Vec<String> = catalog.iter().map(|l| l.name.clone()).collect();
                available.sort();
                return Err(LaneError(format!(
                    "unknown lane(s) {unknown:?}; choose from {available:?}"
                )));
            }
            // One model = one lane = one handle: a repeated name in the selection would otherwise be
            // silently dropped or break the runner's one-rollout-per-model scheduling invariant.
            let mut requested: HashSet<&str> = HashSet::new();
            if let Some(dup) = names.iter().find(|n| !requested.insert(n.as_str())) {
                return Err(LaneError(format!(
                    "duplicate lane {dup:?} in --lanes selection"
                )));
            }
            let by_name: HashMap<&str, &Lane> =
                catalog.iter().map(|l| (l.name.as_str(), l)).collect();
            Ok(names
                .into_iter()
                .map(|n| by_name[n.as_str()].clone())
                .collect())
        }
    }
}

/// Look up a lane by name, listing the known names when it is missing so a typo is actionable.
pub fn find_lane<'a>(lanes: &'a [Lane], name: &str) -> Result<&'a Lane, LaneError> {
    lanes.iter().find(|l| l.name == name).ok_or_else(|| {
        let known = lanes
            .iter()
            .map(|l| l.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        LaneError(format!("unknown lane `{name}`; known lanes: {known}"))
    })
}

pub fn split_names(value: Option<&str>) -> Option<Vec<String>> {
    let value = value?;
    let parts: Vec<String> = value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() { None } else { Some(parts) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANES: &str = r#"
[[lane]]
name = "gemini"
provider = "gemini"
model = "g1"

[[lane]]
name = "or-a"
provider = "openrouter"
model = "a"

[[lane]]
name = "anthropic"
provider = "anthropic"
model = "claude"

[[lane]]
name = "or-b"
provider = "openrouter"
model = "b"
"#;

    fn write(body: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lanes.toml"), body).unwrap();
        dir
    }

    fn load(body: &str, select: Option<&str>) -> Result<Vec<Lane>, LaneError> {
        let dir = write(body);
        load_lanes(&dir.path().join("lanes.toml"), select)
    }

    #[test]
    fn split_names_trims_and_drops_empties() {
        assert_eq!(split_names(None), None);
        assert_eq!(split_names(Some("")), None);
        assert_eq!(
            split_names(Some("a, b")),
            Some(vec!["a".to_string(), "b".to_string()])
        );
    }

    #[test]
    fn provider_roundtrips_through_str() {
        for p in [
            Provider::Anthropic,
            Provider::Openai,
            Provider::Gemini,
            Provider::Openrouter,
        ] {
            assert_eq!(Provider::from_str(p.as_str()).unwrap(), p);
        }
        assert!(Provider::from_str("nope").is_err());
    }

    #[test]
    fn provider_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(Provider::Anthropic).unwrap(),
            serde_json::json!("anthropic")
        );
    }

    #[test]
    fn unfiltered_preserves_toml_order() {
        let lanes = load(LANES, None).unwrap();
        let names: Vec<_> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["gemini", "or-a", "anthropic", "or-b"]);
    }

    #[test]
    fn filtered_keeps_requested_order() {
        let lanes = load(LANES, Some("or-b,gemini")).unwrap();
        let names: Vec<_> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["or-b", "gemini"]);
    }

    #[test]
    fn first_lane_per_provider_is_first_in_file_order() {
        let lanes = load(LANES, None).unwrap();
        let first_or = lanes
            .iter()
            .find(|l| l.provider == Provider::Openrouter)
            .map(|l| l.name.as_str());
        assert_eq!(first_or, Some("or-a"));
    }

    #[test]
    fn parses_optional_fields() {
        let lanes = load(
            r#"
[[lane]]
name = "kimi"
provider = "anthropic"
model = "kimi-for-coding"
base_url = "https://api.kimi.com/coding/"
api_key_env = "KIMI_API_KEY"
"#,
            None,
        )
        .unwrap();
        let kimi = &lanes[0];
        assert_eq!(kimi.provider, Provider::Anthropic);
        assert_eq!(
            kimi.base_url.as_deref(),
            Some("https://api.kimi.com/coding/")
        );
        assert_eq!(kimi.key_env(), "KIMI_API_KEY");
    }

    #[test]
    fn key_env_defaults_to_provider() {
        let lanes = load(
            r#"
[[lane]]
name = "or"
provider = "openrouter"
model = "m"
"#,
            None,
        )
        .unwrap();
        assert_eq!(lanes[0].key_env(), "OPENROUTER_API_KEY");
    }

    #[test]
    fn unknown_provider_names_the_lane() {
        let err = load(
            r#"
[[lane]]
name = "x"
provider = "bedrock"
model = "m"
"#,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("lane \"x\""), "{err}");
        assert!(err.contains("unknown provider"), "{err}");
    }

    #[test]
    fn duplicate_lane_in_selection_rejected() {
        let err = load(LANES, Some("or-a,or-a")).unwrap_err().to_string();
        assert!(err.contains("duplicate lane"));
    }

    #[test]
    fn duplicate_lane_name_rejected() {
        let err = load(
            r#"
[[lane]]
name = "dup"
provider = "gemini"
model = "g1"
[[lane]]
name = "dup"
provider = "openai"
model = "o1"
"#,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("duplicate lane name"));
    }

    #[test]
    fn empty_lanes_file_is_an_error() {
        let err = load("", None).unwrap_err().to_string();
        assert!(err.contains("no [[lane]] defined"));
    }

    #[test]
    fn find_lane_lists_known_on_miss() {
        let lanes = load(LANES, None).unwrap();
        let err = find_lane(&lanes, "nope").unwrap_err().to_string();
        assert!(err.contains("unknown lane `nope`"));
        assert!(err.contains("gemini"));
    }
}
