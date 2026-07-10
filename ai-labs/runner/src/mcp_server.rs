use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use jsonschema::{Draft, Validator};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::Value as JsonValue;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const TOOL_NAME: &str = "submit_result";

#[derive(Debug, Clone)]
pub struct SubmissionAccepted {
    pub payload_bytes: Vec<u8>,
    pub attempts: usize,
}

#[derive(Debug, Clone)]
pub struct SubmissionFormatFailed {
    pub attempts: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Submission {
    Accepted(SubmissionAccepted),
    FormatFailed(SubmissionFormatFailed),
    None,
}

struct TaskContext {
    task_key: String,
    validator: Validator,
    /// The per-task `result` schema (hidden from the published tool, which is task-agnostic). Kept so a
    /// rejection can hand the model the exact schema once its first submission has failed.
    result_schema: JsonValue,
    max_attempts: usize,
    accepting: bool,
    attempts: usize,
    accepted: Option<Vec<u8>>,
    failed: bool,
    errors: Vec<String>,
}

#[derive(Clone)]
pub struct BenchmarkMcp {
    base_url: String,
    cancel: CancellationToken,
    ctx: Arc<Mutex<Option<TaskContext>>>,
    server_name: String,
}

impl BenchmarkMcp {
    pub async fn start(server_name: impl Into<String>) -> Result<Self, McpServerError> {
        let server_name = server_name.into();
        let addr: SocketAddr = "127.0.0.1:0"
            .parse()
            .map_err(|e| McpServerError::Bind(format!("{e}")))?;
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| McpServerError::Bind(e.to_string()))?;
        let actual_addr = listener.local_addr().map_err(|e| McpServerError::Bind(e.to_string()))?;
        let base_url = format!("http://{actual_addr}/mcp");
        let cancel = CancellationToken::new();

        let this = Self {
            base_url,
            cancel: cancel.clone(),
            ctx: Arc::new(Mutex::new(None)),
            server_name,
        };

        let handler = BenchmarkMcpHandler {
            ctx: this.ctx.clone(),
            server_name: this.server_name.clone(),
        };

        let config = StreamableHttpServerConfig::default()
            .with_stateful_mode(false)
            .with_json_response(true)
            .with_sse_keep_alive(None)
            .with_cancellation_token(cancel.child_token());

        let service: StreamableHttpService<BenchmarkMcpHandler, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), config);

        let router = Router::new().nest_service("/mcp", service);

        tokio::spawn({
            let cancel = cancel.child_token();
            async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move { cancel.cancelled_owned().await })
                    .await;
            }
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        Ok(this)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The name this server registered under. The model-visible submit tool is `<name>__submit_result`,
    /// so the name is deliberately lane-agnostic — it must not leak which lane/model is running.
    pub fn name(&self) -> &str {
        &self.server_name
    }

    pub async fn begin_task(
        &self,
        task_key: impl Into<String>,
        schema: &JsonValue,
        max_attempts: usize,
    ) -> Result<(), McpServerError> {
        if max_attempts < 1 {
            return Err(McpServerError::Config("max_attempts must be >= 1".to_string()));
        }
        let validator = Validator::options()
            .with_draft(Draft::Draft202012)
            .build(schema)
            .map_err(|e| McpServerError::Schema(format!("{e}")))?;
        // The published submit-tool schema forbids the empty object (`minProperties: 1`) so that
        // schema-literal models cannot satisfy it with `{}`. Keep grading in sync: reject a task whose
        // result_schema would itself accept `{}`, otherwise the two layers diverge (a submission the
        // model is blocked from sending could pass grading).
        if validator.is_valid(&JsonValue::Object(serde_json::Map::new())) {
            return Err(McpServerError::Schema(
                "result_schema must not accept an empty object; the submit tool requires a non-empty result"
                    .to_string(),
            ));
        }
        *self.ctx.lock().await = Some(TaskContext {
            task_key: task_key.into(),
            validator,
            result_schema: schema.clone(),
            max_attempts,
            accepting: false,
            attempts: 0,
            accepted: None,
            failed: false,
            errors: Vec::new(),
        });
        Ok(())
    }

    fn tool_input_schema(schema: &JsonValue) -> serde_json::Map<String, JsonValue> {
        let mut properties = serde_json::Map::new();
        properties.insert("result".to_string(), schema.clone());
        let mut map = serde_json::Map::new();
        map.insert("type".to_string(), JsonValue::String("object".to_string()));
        map.insert("properties".to_string(), JsonValue::Object(properties));
        map.insert(
            "required".to_string(),
            JsonValue::Array(vec![JsonValue::String("result".to_string())]),
        );
        map
    }

    pub async fn allow_submission(&self, task_key: &str) {
        let mut guard = self.ctx.lock().await;
        if let Some(ctx) = guard.as_mut()
            && ctx.task_key == task_key
        {
            ctx.accepting = true;
        }
    }

    pub async fn take_submission(&self, task_key: &str) -> Submission {
        let mut guard = self.ctx.lock().await;
        // Only consume the context when the requested key matches; a stray/wrong-key take must not
        // drop the active task's captured submission.
        match guard.as_ref() {
            Some(ctx) if ctx.task_key == task_key => {}
            Some(ctx) => {
                tracing::warn!(
                    requested = task_key,
                    active = ctx.task_key,
                    "take_submission for a non-active task; ignoring"
                );
                return Submission::None;
            }
            None => return Submission::None,
        }
        let ctx = guard.take().expect("ctx present and key matched above");
        if let Some(bytes) = ctx.accepted {
            return Submission::Accepted(SubmissionAccepted {
                payload_bytes: bytes,
                attempts: ctx.attempts,
            });
        }
        if ctx.failed {
            return Submission::FormatFailed(SubmissionFormatFailed {
                attempts: ctx.attempts,
                errors: ctx.errors,
            });
        }
        Submission::None
    }

    /// Whether the active task has already captured a submission (accepted or format-rejected),
    /// without consuming the context the way `take_submission` does. Lets the runner distinguish a
    /// genuine "stopped without submitting" from a task that already reached the submit tool.
    pub async fn has_submission(&self, task_key: &str) -> bool {
        let guard = self.ctx.lock().await;
        matches!(
            guard.as_ref(),
            Some(ctx) if ctx.task_key == task_key && (ctx.accepted.is_some() || ctx.failed)
        )
    }

    pub async fn stop(&self) {
        self.cancel.cancel();
    }
}

#[derive(Debug, thiserror::Error, Clone)]
pub enum McpServerError {
    #[error("bind error: {0}")]
    Bind(String),
    #[error("config error: {0}")]
    Config(String),
    #[error("schema error: {0}")]
    Schema(String),
}

#[derive(Clone)]
struct BenchmarkMcpHandler {
    ctx: Arc<Mutex<Option<TaskContext>>>,
    server_name: String,
}

impl ServerHandler for BenchmarkMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(self.server_name.clone(), env!("CARGO_PKG_VERSION")))
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        // `result` is a free-form object whose required fields differ per task and are described in
        // the task prose. The schema is snapshotted to the backend DB at MCP install time (before any
        // task is active), so it must be task-agnostic. `minProperties: 1` forbids the empty object:
        // schema-literal models (e.g. kimi-for-coding) fill tool arguments from the JSON schema rather
        // than the prose, and a bare `{"type":"object"}` makes them submit `{}`; requiring a non-empty
        // object forces them to emit the answer fields.
        let result_schema = serde_json::json!({
            "type": "object",
            "additionalProperties": true,
            "minProperties": 1
        });
        let tool = rmcp::model::Tool::new(
            TOOL_NAME,
            "Submit your final answer. Pass it as the `result` argument: a single JSON object matching the format described in your task instructions. Field values must use native JSON types exactly as described -- a number is 123, not \"123\"; a boolean is true, not \"true\". Do not write a file -- call this tool. If the format is wrong you will get a description of the problem (including the exact JSON Schema your result must match); fix it and call this tool again.",
            BenchmarkMcp::tool_input_schema(&result_schema),
        );
        std::future::ready(Ok(ListToolsResult::with_all_items(vec![tool])))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + rmcp::service::MaybeSendFuture + '_ {
        let ctx = self.ctx.clone();
        async move {
            let mut guard = ctx.lock().await;
            let Some(task_ctx) = guard.as_mut() else {
                return Ok(text_result("No task is active; this submission was ignored."));
            };
            if !task_ctx.accepting {
                return Ok(text_result(
                    "This task has more steps to complete. Keep following the instructions and call submit_result only when the final step asks you to hand in your answer.",
                ));
            }
            if task_ctx.accepted.is_some() {
                return Ok(text_result(
                    "A result was already accepted for this task; ignoring this submission.",
                ));
            }
            if task_ctx.failed {
                return Ok(text_result(
                    "The format-correction budget for this task is exhausted; this submission was ignored.",
                ));
            }

            task_ctx.attempts += 1;
            let args = match request.arguments {
                Some(args) => args,
                None => {
                    let errors = vec!["- at (root): missing `result` argument".to_string()];
                    return Ok(reject(task_ctx, errors));
                }
            };

            let result = args.get("result").cloned().unwrap_or(JsonValue::Null);
            if !result.is_object() {
                let errors = vec!["- at (root): `result` must be a JSON object".to_string()];
                return Ok(reject(task_ctx, errors));
            }

            let errors = schema_errors(&task_ctx.validator, &result);
            if errors.is_empty() {
                task_ctx.accepted = Some(canonical_bytes(&result));
                return Ok(text_result("Result accepted. The format is valid; you are done."));
            }

            Ok(reject(task_ctx, errors))
        }
    }
}

/// Build the response for a rejected submission, centralizing the terminal-vs-retryable decision so
/// every rejection path is consistent. When the correction budget is exhausted the task is marked
/// failed and the schema is withheld (a retry is impossible); otherwise the model gets a retryable
/// rejection that reveals the per-task schema.
fn reject(task_ctx: &mut TaskContext, errors: Vec<String>) -> CallToolResult {
    if task_ctx.attempts >= task_ctx.max_attempts {
        task_ctx.failed = true;
        task_ctx.errors = errors.clone();
        return text_result(format!(
            "Result rejected: the format is still invalid after {} attempts and the correction budget is exhausted. Problems:\n{}",
            task_ctx.attempts,
            errors.join("\n")
        ));
    }
    text_result(retryable_rejection(&errors, &task_ctx.result_schema))
}

/// A retryable format rejection. Once a submission has failed, the model has earned the exact
/// per-task `result` schema (the published tool keeps it hidden, being task-agnostic) so a capable
/// model can correct its types — this hands over the rules, it does not coerce a wrong answer.
fn retryable_rejection(errors: &[String], result_schema: &JsonValue) -> String {
    let schema = serde_json::to_string_pretty(result_schema).unwrap_or_else(|_| result_schema.to_string());
    format!(
        "Your result does not match the required format. Fix these problems and call submit_result again:\n{}\n\nThe `result` argument must match this JSON Schema:\n{}",
        errors.join("\n"),
        schema
    )
}

fn text_result(text: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(text)])
}

fn schema_errors(validator: &Validator, result: &JsonValue) -> Vec<String> {
    let mut errors = Vec::new();
    for error in validator.iter_errors(result) {
        let location = error.instance_path.as_str().trim_start_matches('/');
        let location = if location.is_empty() {
            "(root)".to_string()
        } else {
            location.to_string()
        };
        errors.push(format!("- at `{}`: {}", location, explain(&error)));
    }
    errors.sort();
    errors
}

fn explain(error: &jsonschema::ValidationError) -> String {
    if !matches!(error.kind, jsonschema::error::ValidationErrorKind::Type { .. }) {
        return error.to_string();
    }
    let expected_str = match &error.kind {
        jsonschema::error::ValidationErrorKind::Type {
            kind: jsonschema::error::TypeKind::Single(pt),
        } => pt.to_string(),
        jsonschema::error::ValidationErrorKind::Type {
            kind: jsonschema::error::TypeKind::Multiple(bits),
        } => {
            let names: Vec<String> = (*bits).into_iter().map(|pt| pt.to_string()).collect();
            names.join(" or ")
        }
        _ => "unknown".to_string(),
    };
    let received = json_type_name(&error.instance);
    format!(
        "expected a JSON {expected_str}, but received a {received}: {}. Send a bare JSON {expected_str}, not a {received}.",
        serde_json::to_string(&error.instance).unwrap_or_default()
    )
}

fn json_type_name(value: &JsonValue) -> &'static str {
    // Every JSON number (int or float) collapses to "number" so the agent-facing self-correction hint
    // names types the way JSON Schema does, not the way serde distinguishes them.
    match value {
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
        JsonValue::Null => "null",
    }
}

fn canonical_bytes(result: &JsonValue) -> Vec<u8> {
    let sorted = sort_json_value(result.clone());
    serde_json::to_string(&sorted).unwrap_or_default().into_bytes()
}

fn sort_json_value(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(mut map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            for key in keys {
                if let Some(v) = map.remove(&key) {
                    sorted.insert(key, sort_json_value(v));
                }
            }
            JsonValue::Object(sorted)
        }
        JsonValue::Array(arr) => JsonValue::Array(arr.into_iter().map(sort_json_value).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_errors_type_mismatch() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "answer": {"type": "string"}
            },
            "required": ["answer"]
        });
        let validator = Validator::options()
            .with_draft(Draft::Draft202012)
            .build(&schema)
            .unwrap();
        let errors = schema_errors(&validator, &serde_json::json!({"answer": 42}));
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("expected a JSON string"));
        // every JSON number is reported as "number" (matches the Python harness), not "integer".
        assert!(errors[0].contains("received a number"), "{}", errors[0]);
    }

    fn ctx_for(schema: JsonValue, attempts: usize, max_attempts: usize) -> TaskContext {
        let validator = Validator::options()
            .with_draft(Draft::Draft202012)
            .build(&schema)
            .unwrap();
        TaskContext {
            task_key: "t".to_string(),
            validator,
            result_schema: schema,
            max_attempts,
            accepting: true,
            attempts,
            accepted: None,
            failed: false,
            errors: Vec::new(),
        }
    }

    fn result_text(r: &CallToolResult) -> String {
        serde_json::to_string(r).unwrap()
    }

    #[test]
    fn test_reject_reveals_schema_only_while_retryable() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"btc_sol_ratio": {"type": "number"}},
            "required": ["btc_sol_ratio"]
        });
        let errors = vec!["- at `btc_sol_ratio`: expected a JSON number".to_string()];

        // Retryable (attempts < max): hand the model the real per-task schema so it can fix its types.
        let mut retry = ctx_for(schema.clone(), 1, 3);
        let msg = result_text(&reject(&mut retry, errors.clone()));
        assert!(msg.contains("expected a JSON number"), "{msg}");
        assert!(msg.contains("must match this JSON Schema"), "{msg}");
        assert!(msg.contains("btc_sol_ratio") && msg.contains("number"), "{msg}");
        assert!(!retry.failed);

        // Terminal (budget exhausted): no schema (retry is impossible) and the task is marked failed.
        let mut done = ctx_for(schema, 3, 3);
        let msg = result_text(&reject(&mut done, errors));
        assert!(msg.contains("correction budget is exhausted"), "{msg}");
        assert!(!msg.contains("must match this JSON Schema"), "{msg}");
        assert!(done.failed);
    }

    #[tokio::test]
    async fn test_take_submission_wrong_key_preserves_context() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": false
        });
        let mcp = BenchmarkMcp::start("benchmark-take-test").await.unwrap();
        mcp.begin_task("rollout-1", &schema, 3).await.unwrap();
        mcp.allow_submission("rollout-1").await;
        {
            // simulate an accepted submission by driving the validator path directly
            let mut guard = mcp.ctx.lock().await;
            let ctx = guard.as_mut().unwrap();
            ctx.accepted = Some(canonical_bytes(&serde_json::json!({"answer": "ok"})));
        }
        // a take with the wrong key must NOT consume the captured submission
        assert!(matches!(mcp.take_submission("other-rollout").await, Submission::None));
        // the correct key still returns it
        match mcp.take_submission("rollout-1").await {
            Submission::Accepted(a) => {
                assert_eq!(a.payload_bytes, br#"{"answer":"ok"}"#.to_vec());
            }
            other => panic!("expected Accepted, got {other:?}"),
        }
        mcp.stop().await;
    }

    #[test]
    fn test_tool_input_schema_forbids_empty_result() {
        // The published `result` argument must reject the empty object so schema-literal models cannot
        // satisfy it with `{}`; the required fields themselves come from the task prose.
        let schema = serde_json::json!({
            "type": "object",
            "additionalProperties": true,
            "minProperties": 1
        });
        let input = BenchmarkMcp::tool_input_schema(&schema);
        assert_eq!(input["properties"]["result"]["minProperties"], 1);

        let validator = Validator::options()
            .with_draft(Draft::Draft202012)
            .build(&schema)
            .unwrap();
        assert!(validator.validate(&serde_json::json!({})).is_err());
        assert!(validator.validate(&serde_json::json!({"median_salary": 84712})).is_ok());
    }

    #[tokio::test]
    async fn test_begin_task_rejects_empty_admitting_schema() {
        // A schema that would accept `{}` must be rejected up front, keeping grading in sync with the
        // published `minProperties: 1` tool schema.
        let mcp = BenchmarkMcp::start("benchmark-empty-test").await.unwrap();
        let err = mcp
            .begin_task("rollout-1", &serde_json::json!({"type": "object"}), 3)
            .await
            .unwrap_err();
        assert!(matches!(err, McpServerError::Schema(_)));
        // A schema requiring a field is accepted.
        mcp.begin_task(
            "rollout-1",
            &serde_json::json!({
                "type": "object",
                "required": ["answer"],
                "properties": {"answer": {"type": "string"}}
            }),
            3,
        )
        .await
        .unwrap();
        mcp.stop().await;
    }
}
