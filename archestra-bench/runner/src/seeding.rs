use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::time::sleep;
use tracing::info;

use crate::client::{CatalogCreate, EvalClient, LlmKeyCreate};
use crate::config::types::Mcp;

#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub model_id: String,
    pub api_key_id: String,
}

#[derive(Debug, Clone)]
pub struct RegisteredMcp {
    pub tools: Vec<HashMap<String, serde_json::Value>>,
}

/// A tool's agent-facing short name — the `"name"` field the model sees and the benchmark matches
/// against (e.g. `find_submit_tool`, `letter-count`). The MCP tool-surface lock stores exactly this
/// string, so the pin and the runtime agree by construction.
pub fn tool_name(tool: &HashMap<String, serde_json::Value>) -> Option<&str> {
    tool.get("name").and_then(|v| v.as_str())
}

#[derive(Debug, thiserror::Error)]
pub enum SeedingError {
    #[error("client error: {0}")]
    Client(#[from] crate::client::ClientError),
    #[error("models never synced after {timeout}s: {missing:?}; available: {available:?}")]
    ModelSyncTimeout {
        timeout: f64,
        missing: Vec<String>,
        available: Vec<String>,
    },
    #[error("no skills discovered in {location}")]
    NoSkillsDiscovered { location: String },
    #[error("MCP server {name} registered but exposed no tools")]
    McpNoTools { name: String },
    #[error("system exit: {0}")]
    SystemExit(String),
}

pub async fn ensure_provider_and_models(
    client: &EvalClient,
    provider: &str,
    api_key: &str,
    models: &[String],
    base_url: Option<&str>,
    key_name: Option<&str>,
    is_primary: bool,
    scope: &str,
    timeout_s: f64,
    interval_s: f64,
) -> Result<HashMap<String, ResolvedModel>, SeedingError> {
    let created = client
        .create_llm_key(&LlmKeyCreate {
            provider: provider.to_string(),
            scope: scope.to_string(),
            api_key: api_key.to_string(),
            name: Some(key_name.unwrap_or(&format!("bench-{provider}")).to_string()),
            base_url: base_url.map(|s| s.to_string()),
            is_primary: Some(is_primary),
        })
        .await?;
    let key_id = require_str(&created, "id", "POST /api/llm-provider-api-keys")?;

    let deadline = Instant::now() + Duration::from_secs_f64(timeout_s);
    let mut forced = false;
    loop {
        let rows = client.list_models().await?;
        let resolved = resolve_models(&rows, models, &key_id);
        let missing: Vec<String> = models
            .iter()
            .filter(|m| !resolved.contains_key(*m))
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(resolved);
        }
        let available: Vec<String> = rows
            .iter()
            .filter(|r| r.get("provider").and_then(|v| v.as_str()) == Some(provider))
            .filter_map(|r| {
                r.get("modelId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect();
        if !forced {
            info!(
                "forcing model sync; still missing {:?}; available: {:?}",
                missing, available
            );
            client.sync_models().await?;
            forced = true;
        }
        if Instant::now() >= deadline {
            return Err(SeedingError::ModelSyncTimeout {
                timeout: timeout_s,
                missing,
                available,
            });
        }
        sleep(Duration::from_secs_f64(interval_s)).await;
    }
}

fn resolve_models(
    rows: &[HashMap<String, serde_json::Value>],
    wanted: &[String],
    key_id: &str,
) -> HashMap<String, ResolvedModel> {
    let mut found = HashMap::new();
    for row in rows {
        let name = match row.get("modelId").and_then(|v| v.as_str()) {
            Some(n) if wanted.contains(&n.to_string()) => n.to_string(),
            _ => continue,
        };
        if !links_key(row, key_id) {
            continue;
        }
        if let Ok(model_id) = require_str(row, "id", "model row") {
            found.insert(
                name,
                ResolvedModel {
                    model_id,
                    api_key_id: key_id.to_string(),
                },
            );
        }
    }
    found
}

fn links_key(model: &HashMap<String, serde_json::Value>, key_id: &str) -> bool {
    model
        .get("apiKeys")
        .and_then(|v| v.as_array())
        .map(|keys| {
            keys.iter().any(|k| {
                k.as_object()
                    .and_then(|o| o.get("id"))
                    .and_then(|v| v.as_str())
                    == Some(key_id)
            })
        })
        .unwrap_or(false)
}

pub async fn seed_skill_ref(
    client: &EvalClient,
    repo: &str,
    path: Option<&str>,
    ref_: &str,
    cap: Option<usize>,
    scope: &str,
) -> Result<Vec<String>, SeedingError> {
    let discovered = client
        .discover_github_skills(repo, path, Some(ref_))
        .await?;
    let paths: Vec<String> = discovered
        .iter()
        .filter_map(|s| {
            s.get("skillPath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    if paths.is_empty() {
        let location = format!(
            "{}@{}{}",
            repo,
            ref_,
            path.map(|p| format!(" under {p:?}")).unwrap_or_default()
        );
        return Err(SeedingError::NoSkillsDiscovered { location });
    }
    let selected = match cap {
        Some(c) => {
            let capped: Vec<_> = paths.iter().take(c).cloned().collect();
            if paths.len() > c {
                info!(
                    "importing {} of {} skills from {}@{} (capped)",
                    c,
                    paths.len(),
                    repo,
                    ref_
                );
            }
            capped
        }
        None => paths.clone(),
    };
    client
        .import_github_skills(repo, &selected, scope, Some(ref_))
        .await?;
    info!("imported {} skills from {}@{}", selected.len(), repo, ref_);
    Ok(selected)
}

pub async fn register_remote_mcp(
    client: &EvalClient,
    name: &str,
    server_url: &str,
    scope: &str,
    agent_ids: Option<&[String]>,
) -> Result<RegisteredMcp, SeedingError> {
    let catalog = client
        .create_catalog_item(&CatalogCreate {
            name: name.to_string(),
            server_type: "remote".to_string(),
            scope: scope.to_string(),
            description: None,
            server_url: Some(server_url.to_string()),
        })
        .await?;
    let catalog_id = require_str(&catalog, "id", "POST /api/internal_mcp_catalog")?;
    let server = client
        .install_mcp(name, &catalog_id, scope, agent_ids)
        .await?;
    let server_id = require_str(&server, "id", "POST /api/mcp_server")?;
    let tools = client.list_mcp_server_tools(&server_id).await?;
    if tools.is_empty() {
        return Err(SeedingError::McpNoTools {
            name: name.to_string(),
        });
    }
    Ok(RegisteredMcp { tools })
}

pub async fn seed_mcp_fixtures(
    client: &EvalClient,
    mcps: &[Mcp],
    scope: &str,
    agent_ids: Option<&[String]>,
) -> Result<Vec<RegisteredMcp>, SeedingError> {
    let mut registered = Vec::new();
    for fixture in mcps {
        info!("seeding fixture MCP {}", fixture.name);
        registered.push(
            register_remote_mcp(client, &fixture.name, &fixture.server_url, scope, agent_ids)
                .await?,
        );
    }
    Ok(registered)
}

fn require_str(
    obj: &HashMap<String, serde_json::Value>,
    key: &str,
    ctx: &str,
) -> Result<String, SeedingError> {
    match obj.get(key) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        other => Err(SeedingError::SystemExit(format!(
            "{ctx}: expected string field {key:?}, got {other:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_models_filters_by_key() {
        let rows: Vec<HashMap<String, serde_json::Value>> = vec![
            serde_json::from_value(serde_json::json!({
                "id": "model-1",
                "modelId": "gpt-4",
                "provider": "openai",
                "apiKeys": [{"id": "key-a"}]
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "id": "model-2",
                "modelId": "gpt-4",
                "provider": "openai",
                "apiKeys": [{"id": "key-b"}]
            }))
            .unwrap(),
        ];
        let resolved = resolve_models(&rows, &["gpt-4".to_string()], "key-a");
        assert_eq!(resolved["gpt-4"].model_id, "model-1");
    }
}
