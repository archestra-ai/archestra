use std::path::Path;

use super::toml_util;
use super::types::Lane;

#[derive(Debug, thiserror::Error)]
#[error("lane config error: {0}")]
pub struct LaneConfigError(pub String);

impl From<toml_util::TomlError> for LaneConfigError {
    fn from(e: toml_util::TomlError) -> Self {
        Self(e.to_string())
    }
}

const ALLOWED_PROVIDERS: &[&str] = &["anthropic", "openai", "gemini", "openrouter"];

pub fn load_lanes(path: &Path, select: Option<&str>) -> Result<Vec<Lane>, LaneConfigError> {
    let ctx = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let data = toml_util::parse_toml_file(path)?;
    let rows = toml_util::rows(&data, "lane", &ctx)?;
    if rows.is_empty() {
        return Err(LaneConfigError(format!("{ctx}: no [[lane]] defined")));
    }

    // Preserve TOML declaration order: the unfiltered selection and the "first lane per provider is
    // primary" rule both depend on it (matches Python's insertion-ordered dict in run.py:_load_lanes).
    let mut catalog: Vec<Lane> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        let name = toml_util::req_str(&row, "name", &format!("{ctx}: lane"))?;
        if !toml_util::is_slug(&name) {
            return Err(LaneConfigError(format!(
                "{ctx}: lane name {name:?} must be a slug ([a-z0-9][a-z0-9-]*)"
            )));
        }
        if !seen.insert(name.clone()) {
            return Err(LaneConfigError(format!(
                "{ctx}: duplicate lane name {name:?}"
            )));
        }
        let row_ctx = format!("{ctx}: lane {name:?}");
        let provider = toml_util::req_str(&row, "provider", &row_ctx)?;
        if !ALLOWED_PROVIDERS.contains(&provider.as_str()) {
            return Err(LaneConfigError(format!(
                "{row_ctx}: unsupported provider {provider:?}; expected one of {ALLOWED_PROVIDERS:?}"
            )));
        }
        catalog.push(Lane {
            name,
            provider,
            model: toml_util::req_str(&row, "model", &row_ctx)?,
            base_url: toml_util::opt_str(&row, "base_url", &row_ctx)?,
            api_key_env: toml_util::opt_str(&row, "api_key_env", &row_ctx)?,
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
                return Err(LaneConfigError(format!(
                    "unknown lane(s) {unknown:?}; choose from {available:?}"
                )));
            }
            // return the requested lanes in the order the caller asked for (matches Python)
            let by_name: std::collections::HashMap<&str, &Lane> =
                catalog.iter().map(|l| (l.name.as_str(), l)).collect();
            Ok(names
                .into_iter()
                .map(|n| by_name[n.as_str()].clone())
                .collect())
        }
    }
}

fn split_names(value: Option<&str>) -> Option<Vec<String>> {
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

    fn write_lanes(body: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("lanes.toml"), body).unwrap();
        dir
    }

    #[test]
    fn unfiltered_preserves_toml_order() {
        let dir = write_lanes(LANES);
        let lanes = load_lanes(&dir.path().join("lanes.toml"), None).unwrap();
        let names: Vec<_> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["gemini", "or-a", "anthropic", "or-b"]);
    }

    #[test]
    fn filtered_keeps_requested_order() {
        let dir = write_lanes(LANES);
        let lanes = load_lanes(&dir.path().join("lanes.toml"), Some("or-b,gemini")).unwrap();
        let names: Vec<_> = lanes.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["or-b", "gemini"]);
    }

    #[test]
    fn first_lane_per_provider_is_first_in_file_order() {
        // mirrors run.py:_resolve_lanes — the first openrouter lane in declaration order is "or-a".
        let dir = write_lanes(LANES);
        let lanes = load_lanes(&dir.path().join("lanes.toml"), None).unwrap();
        let first_openrouter = lanes
            .iter()
            .find(|l| l.provider == "openrouter")
            .map(|l| l.name.as_str());
        assert_eq!(first_openrouter, Some("or-a"));
    }

    #[test]
    fn duplicate_lane_name_rejected() {
        let dir = write_lanes(
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
        );
        let err = load_lanes(&dir.path().join("lanes.toml"), None).unwrap_err();
        assert!(err.to_string().contains("duplicate lane name"));
    }
}
