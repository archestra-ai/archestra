use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    agent_id: String,
    agent_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResult {
    content: [TextContent; 1],
    structured_content: Identity,
    is_error: bool,
}

#[derive(Serialize)]
struct TextContent {
    r#type: &'static str,
    text: String,
}

pub(crate) async fn execute(Json(identity): Json<Identity>) -> Json<ToolResult> {
    Json(ToolResult {
        content: [TextContent {
            r#type: "text",
            text: format!(
                "Agent Name: {}\nAgent ID: {}",
                identity.agent_name, identity.agent_id
            ),
        }],
        structured_content: identity,
        is_error: false,
    })
}
