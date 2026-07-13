//! Minimal OpenAI chat-completions wire types.
//!
//! We model only what the proxy reads or rewrites; every other field rides
//! through untouched via `#[serde(flatten)]` on the response types, and request
//! bodies are forwarded upstream as their original bytes (these types only
//! *view* the request for replay).

use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_function_kind() -> String {
    "function".to_string()
}

/// One `tool_calls[]` entry (request or response). Round-trips unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_function_kind")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded argument object, per the OpenAI spec (a *string*, not an
    /// object). A value that does not parse as a JSON object is a terminal
    /// block for that call — see [`crate::replay`].
    pub arguments: String,
}

/// A message as it appears in the request `messages` array. Deserialize-only:
/// the proxy replays these, it does not re-emit them.
#[derive(Debug, Clone, Deserialize)]
pub struct RequestMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

/// The subset of a request the proxy inspects. Unknown fields are ignored
/// (the full body is forwarded upstream verbatim).
#[derive(Debug, Clone, Deserialize)]
pub struct RequestView {
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub messages: Vec<RequestMessage>,
}

/// A chat-completions response. Only `choices` is modeled; everything else
/// (`id`, `usage`, `model`, ...) rides through `extra`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Choice {
    pub message: ResponseMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Best-effort plain text of a message `content` field: a bare string, or the
/// concatenation of the `text` parts of a content-part array. Anything else is
/// empty (the proxy needs text only for human-facing turns, which it skips in
/// replay anyway).
pub fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}
