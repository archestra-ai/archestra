//! A concrete OpenRouter chat client.
//!
//! OpenRouter speaks the OpenAI-compatible `POST /chat/completions` contract, so
//! the request/response mapping here is the OpenAI tool-calling shape. Two things
//! the review flagged and this module handles deliberately:
//!
//! * `tool_calls[].function.arguments` is a **raw JSON string** — kept as
//!   [`ToolCall::arguments_raw`] and only parsed at dispatch, so a malformed or
//!   empty argument string becomes one bad tool result, never a failed decode of
//!   the whole completion.
//! * `finish_reason` is nullable and normalized by OpenRouter to
//!   `stop | length | tool_calls | content_filter | error` (plus a choice-level
//!   `error` object on HTTP-200 bodies). It is parsed into the typed
//!   [`FinishReason`] so a truncated or filtered completion is not mistaken for a
//!   clean stop.
//!
//! Refs: openrouter.ai/docs/api/reference/overview, .../errors-and-debugging,
//! .../guides/routing/auto-exacto.

use serde::Deserialize;

use crate::error::DojoError;

const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
/// Pinned for reproducibility — a benchmark wants deterministic sampling.
const TEMPERATURE: f64 = 0.0;

/// A tool advertised to the model: name, description, and a JSON Schema for its
/// arguments object.
#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// A tool call the model emitted. `arguments_raw` is the provider's raw JSON
/// string, parsed only at dispatch.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments_raw: String,
}

/// A message in the running conversation the client sends to the provider.
#[derive(Debug, Clone)]
pub enum ChatMessage {
    System(String),
    User(String),
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCall>,
        /// Opaque provider reasoning blocks (`reasoning_details`), replayed
        /// verbatim on continuation. Reasoning models (Anthropic thinking,
        /// o-series) can require their signed blocks back after a tool call.
        reasoning_details: Option<serde_json::Value>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

/// The normalized reason a completion stopped, derived from `finish_reason` plus
/// any choice-level `error`.
#[derive(Debug, Clone)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Error {
        code: Option<i64>,
        message: String,
    },
    /// A recognized-shape but non-standard reason string.
    Other(String),
    /// `finish_reason` was absent.
    Missing,
}

/// One provider turn: assistant text, any tool calls, and why it stopped.
#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish: FinishReason,
    /// Opaque `reasoning_details` from the provider, to be replayed on the next turn.
    pub reasoning_details: Option<serde_json::Value>,
}

/// A concrete OpenRouter client. Build with [`OpenRouter::new`] (inject the key)
/// or [`OpenRouter::from_env`] (read `OPENROUTER_API_KEY` from the process env).
#[derive(Clone)]
pub struct OpenRouter {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl OpenRouter {
    /// Explicit constructor — the caller supplies every input, which keeps the
    /// library free of any repository-specific key discovery.
    pub fn new(
        http: reqwest::Client,
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            http,
            base_url: base_url.into(),
            model: model.into(),
            api_key: api_key.into(),
        }
    }

    /// Convenience: a default client and base URL, given a key from any source.
    pub fn with_key(model: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self::new(reqwest::Client::new(), DEFAULT_BASE_URL, model, api_key)
    }

    /// Convenience: a default client + base URL, with the key read from the
    /// `OPENROUTER_API_KEY` process environment variable. (Any `.env` fallback is
    /// the binary's job, not the library's.)
    pub fn from_env(model: impl Into<String>) -> Result<Self, DojoError> {
        let api_key = std::env::var("OPENROUTER_API_KEY").map_err(|_| DojoError::MissingApiKey)?;
        Ok(Self::with_key(model, api_key))
    }

    /// One chat completion with the given messages and tool schemas.
    pub async fn complete(&self, messages: &[ChatMessage], tools: &[ToolSchema]) -> Result<ChatResponse, DojoError> {
        let body = build_request_body(&self.model, messages, tools);
        let resp = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<failed to read error body: {e}>"));
            return Err(DojoError::Provider {
                status: status.as_u16(),
                body,
            });
        }

        let wire: WireResponse = resp
            .json()
            .await
            .map_err(|e| DojoError::Decode { detail: e.to_string() })?;
        parse_response(wire)
    }
}

fn build_request_body(model: &str, messages: &[ChatMessage], tools: &[ToolSchema]) -> serde_json::Value {
    let wire_messages: Vec<serde_json::Value> = messages.iter().map(message_to_wire).collect();
    let mut body = serde_json::json!({
        "model": model,
        "messages": wire_messages,
        "temperature": TEMPERATURE,
    });
    // Only advertise tools (and thus tool_choice) when there are any — providers
    // reject `tool_choice` with an empty tool list.
    if !tools.is_empty() {
        let wire_tools: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": { "name": t.name, "description": t.description, "parameters": t.parameters },
                })
            })
            .collect();
        body["tools"] = serde_json::Value::Array(wire_tools);
        body["tool_choice"] = serde_json::Value::String("auto".to_owned());
    }
    body
}

fn message_to_wire(message: &ChatMessage) -> serde_json::Value {
    match message {
        ChatMessage::System(content) => serde_json::json!({ "role": "system", "content": content }),
        ChatMessage::User(content) => serde_json::json!({ "role": "user", "content": content }),
        ChatMessage::Tool { tool_call_id, content } => {
            serde_json::json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content })
        }
        ChatMessage::Assistant {
            text,
            tool_calls,
            reasoning_details,
        } => {
            let wire_calls: Vec<serde_json::Value> = tool_calls
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": c.arguments_raw },
                    })
                })
                .collect();
            let mut msg = serde_json::json!({ "role": "assistant", "content": text });
            if !wire_calls.is_empty() {
                msg["tool_calls"] = serde_json::Value::Array(wire_calls);
            }
            if let Some(reasoning) = reasoning_details {
                msg["reasoning_details"] = reasoning.clone();
            }
            msg
        }
    }
}

fn parse_response(wire: WireResponse) -> Result<ChatResponse, DojoError> {
    let choice = match wire.choices.into_iter().next() {
        Some(c) => c,
        // No choices but a top-level error is a provider error surfaced on a 200 body.
        None => {
            if let Some(err) = wire.error {
                return Ok(ChatResponse {
                    text: None,
                    tool_calls: Vec::new(),
                    finish: FinishReason::Error {
                        code: err.code,
                        message: err.message.unwrap_or_default(),
                    },
                    reasoning_details: None,
                });
            }
            return Err(DojoError::Decode {
                detail: "response had no choices".to_owned(),
            });
        }
    };

    let tool_calls = choice
        .message
        .tool_calls
        .unwrap_or_default()
        .into_iter()
        .map(|c| ToolCall {
            id: c.id.unwrap_or_default(),
            name: c.function.name.unwrap_or_default(),
            arguments_raw: c.function.arguments.unwrap_or_default(),
        })
        .collect();

    let finish = if let Some(err) = choice.error.or(wire.error) {
        FinishReason::Error {
            code: err.code,
            message: err.message.unwrap_or_default(),
        }
    } else {
        match choice.finish_reason.as_deref() {
            Some("stop") => FinishReason::Stop,
            Some("tool_calls") => FinishReason::ToolCalls,
            Some("length") => FinishReason::Length,
            Some("content_filter") => FinishReason::ContentFilter,
            Some("error") => FinishReason::Error {
                code: None,
                message: "provider reported finish_reason=error".to_owned(),
            },
            Some(other) => FinishReason::Other(other.to_owned()),
            None => FinishReason::Missing,
        }
    };

    Ok(ChatResponse {
        text: choice.message.content,
        tool_calls,
        finish,
        reasoning_details: choice.message.reasoning_details,
    })
}

// --- wire deserialization (private) ---

#[derive(Deserialize)]
struct WireResponse {
    #[serde(default)]
    choices: Vec<WireChoice>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Deserialize)]
struct WireChoice {
    // Optional so a choice-level error with no assistant `message` still decodes
    // into the graceful `FinishReason::Error` path instead of failing the whole body.
    #[serde(default)]
    message: WireMessage,
    #[serde(default)]
    finish_reason: Option<String>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Default, Deserialize)]
struct WireMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<WireToolCall>>,
    #[serde(default)]
    reasoning_details: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct WireToolCall {
    #[serde(default)]
    id: Option<String>,
    function: WireFunction,
}

#[derive(Deserialize)]
struct WireFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct WireError {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
}
