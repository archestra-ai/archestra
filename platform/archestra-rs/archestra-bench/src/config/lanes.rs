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

    let mut catalog: std::collections::HashMap<String, Lane> = std::collections::HashMap::new();
    for row in rows {
        let name = toml_util::req_str(&row, "name", &format!("{ctx}: lane"))?;
        if !toml_util::is_slug(&name) {
            return Err(LaneConfigError(format!(
                "{ctx}: lane name {name:?} must be a slug ([a-z0-9][a-z0-9-]*)"
            )));
        }
        if catalog.contains_key(&name) {
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
        catalog.insert(
            name.clone(),
            Lane {
                name,
                provider,
                model: toml_util::req_str(&row, "model", &row_ctx)?,
                base_url: toml_util::opt_str(&row, "base_url", &row_ctx)?,
                api_key_env: toml_util::opt_str(&row, "api_key_env", &row_ctx)?,
            },
        );
    }

    let names = split_names(select);
    match names {
        None => Ok(catalog.into_values().collect()),
        Some(names) => {
            let mut unknown = Vec::new();
            for name in &names {
                if !catalog.contains_key(name) {
                    unknown.push(name.clone());
                }
            }
            if !unknown.is_empty() {
                let available: Vec<_> = catalog.keys().cloned().collect();
                return Err(LaneConfigError(format!(
                    "unknown lane(s) {unknown:?}; choose from {available:?}"
                )));
            }
            Ok(names
                .into_iter()
                .filter_map(|n| catalog.remove(&n))
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
