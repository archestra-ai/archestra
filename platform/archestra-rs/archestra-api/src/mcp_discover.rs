use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiscoverInput {
    agent_id: String,
    version: String,
    revision: String,
    supported_versions: Vec<String>,
    capabilities: serde_json::Map<String, Value>,
    ttl_ms: u32,
    instructions: Option<String>,
}

pub(crate) async fn discover(Json(input): Json<DiscoverInput>) -> Json<Value> {
    let server_info = json!({
        "name": format!("archestra-agent-{}", input.agent_id),
        "version": input.version,
    });
    let mut result = json!({
        "resultType": "complete",
        "supportedVersions": input.supported_versions,
        "protocolVersions": input.supported_versions,
        "protocolVersion": input.revision,
        "serverInfo": server_info,
        "capabilities": input.capabilities,
        "ttlMs": input.ttl_ms,
        "cacheScope": "private",
        "_meta": { "io.modelcontextprotocol/serverInfo": server_info },
    });
    if let Some(instructions) = input.instructions {
        result["instructions"] = Value::String(instructions);
    }
    Json(result)
}
