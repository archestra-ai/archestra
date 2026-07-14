//! `baton-proxy`: an OpenAI chat-completions proxy that gates out-of-audience
//! tool calls on a human. Point a harness's `base_url` at it; register the
//! approval MCP server so the model can call `baton__request_approval`.

use std::fs::OpenOptions;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use baton_proxy::wire::{ChatResponse, RequestView};
use baton_proxy::{Policy, Session, TurnDecision, rewrite_response};
use clap::{Args as ClapArgs, Parser, Subcommand};
use serde_json::Value;
use tokio::net::TcpListener;

/// Headers worth forwarding to OpenAI-compatible upstreams (esp. OpenRouter).
const FORWARD_HEADERS: &[&str] = &["http-referer", "x-title", "openai-organization"];

#[derive(Parser)]
#[command(about = "Inference-layer proxy that gates out-of-audience tool calls on a human")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: ServeArgs,
}

#[derive(Subcommand)]
enum Command {
    /// Pretty-print a wire log or trajectory log (defaults to the newest
    /// wire-logs/model-wire-*.jsonl), highlighting the turns baton rewrote.
    Render { file: Option<PathBuf> },
}

#[derive(ClapArgs)]
struct ServeArgs {
    /// Path to the policy file.
    #[arg(long, env = "BATON_PROXY_POLICY", default_value = "policy.toml")]
    policy: PathBuf,
    /// Address to listen on.
    #[arg(long, env = "BATON_PROXY_ADDR", default_value = "127.0.0.1:8730")]
    addr: String,
    /// Append one JSON line per evaluated tool-call turn to this file.
    #[arg(long, env = "BATON_PROXY_LOG")]
    log: Option<PathBuf>,
    /// Directory for the raw model-wire log: one timestamped file per run, one
    /// JSON line per turn (request, raw model response, returned response).
    #[arg(long, env = "BATON_PROXY_WIRE_DIR")]
    wire_log_dir: Option<PathBuf>,
}

struct App {
    policy: Policy,
    client: reqwest::Client,
    log: Option<Mutex<std::fs::File>>,
    wire: Option<Mutex<std::fs::File>>,
    wire_turn: AtomicU64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let args = match cli.command {
        Some(Command::Render { file }) => return render_log(file.as_deref()),
        None => cli.serve,
    };

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let text =
        std::fs::read_to_string(&args.policy).map_err(|e| format!("reading policy {}: {e}", args.policy.display()))?;
    let policy = Policy::from_toml(&text)?;
    tracing::info!(upstream = %policy.upstream_base_url, tools = policy.contracts.len(), "loaded policy");

    let log = match &args.log {
        Some(path) => {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| format!("opening log {}: {e}", path.display()))?;
            tracing::info!(path = %path.display(), "writing trajectory log");
            Some(Mutex::new(file))
        }
        None => None,
    };

    let wire = match &args.wire_log_dir {
        Some(dir) => {
            std::fs::create_dir_all(dir).map_err(|e| format!("creating wire-log dir {}: {e}", dir.display()))?;
            let name = format!("model-wire-{}.jsonl", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
            let path = dir.join(name);
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("opening wire log {}: {e}", path.display()))?;
            tracing::info!(path = %path.display(), "writing raw model-wire log");
            Some(Mutex::new(file))
        }
        None => None,
    };

    let app = Arc::new(App {
        policy,
        client: reqwest::Client::new(),
        log,
        wire,
        wire_turn: AtomicU64::new(1),
    });
    let router = Router::new()
        .route("/v1/chat/completions", post(handler))
        .route("/chat/completions", post(handler))
        .with_state(app);

    let listener = TcpListener::bind(&args.addr).await?;
    tracing::info!(addr = %listener.local_addr()?, "baton-proxy listening");
    axum::serve(listener, router).await?;
    Ok(())
}

async fn handler(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let view: RequestView = match serde_json::from_slice(&body) {
        Ok(view) => view,
        Err(e) => {
            return error(
                StatusCode::BAD_REQUEST,
                format!("invalid chat-completions request: {e}"),
            );
        }
    };
    if view.stream {
        return error(
            StatusCode::BAD_REQUEST,
            "streaming (stream:true) is not supported by baton-proxy; set stream:false".to_string(),
        );
    }

    // Capture the request body for the wire log before it is moved upstream.
    let request_json: Option<serde_json::Value> = app.wire.as_ref().and_then(|_| serde_json::from_slice(&body).ok());

    // Forward upstream, preserving auth and provider headers.
    let url = format!(
        "{}/chat/completions",
        app.policy.upstream_base_url.trim_end_matches('/')
    );
    let mut request = app
        .client
        .post(&url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        request = request.header(header::AUTHORIZATION, auth);
    }
    for name in FORWARD_HEADERS {
        if let Some(value) = headers.get(*name) {
            request = request.header(*name, value);
        }
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(e) => return error(StatusCode::BAD_GATEWAY, format!("upstream request failed: {e}")),
    };
    let status = upstream.status();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("reading upstream response failed: {e}"),
            );
        }
    };
    let out_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    // A non-2xx upstream error is passed through verbatim — there is no tool call
    // to gate.
    if !status.is_success() {
        return json_bytes(out_status, bytes.to_vec());
    }
    // A successful response the proxy cannot parse cannot be inspected — fail
    // closed rather than pass through possibly-unchecked tool calls.
    let mut response: ChatResponse = match serde_json::from_slice(&bytes) {
        Ok(response) => response,
        Err(e) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("upstream returned a response baton-proxy could not inspect: {e}"),
            );
        }
    };

    let session = match Session::build(&app.policy, &view.messages) {
        Ok(session) => session,
        Err(e) => return error(StatusCode::CONFLICT, format!("policy replay failed: {e}")),
    };
    let decisions = rewrite_response(&session, &mut response);
    let rewritten = decisions.iter().filter(|d| d.rewritten()).count();
    if rewritten > 0 {
        tracing::info!(rewritten, "withheld tool call(s) pending approval or blocked");
    }
    log_turns(&app, &session.context_audience(), &decisions);
    log_wire(&app, request_json, &bytes, &response);
    match serde_json::to_vec(&response) {
        Ok(out) => json_bytes(StatusCode::OK, out),
        Err(_) => json_bytes(out_status, bytes.to_vec()),
    }
}

/// Append one JSON line for this turn to the raw model-wire log: the request the
/// harness sent, the raw response the model returned, and the response the proxy
/// returned (rewritten when a call was gated). Best-effort.
fn log_wire(app: &App, request: Option<serde_json::Value>, raw_response: &[u8], returned: &ChatResponse) {
    let Some(wire) = &app.wire else {
        return;
    };
    let turn = app.wire_turn.fetch_add(1, Ordering::Relaxed);
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let model_response: serde_json::Value = serde_json::from_slice(raw_response).unwrap_or(serde_json::Value::Null);
    let entry = serde_json::json!({
        "turn": turn,
        "ts_ms": ts_ms,
        "request": request,
        "model_response": model_response,
        "returned_response": returned,
    });
    let mut line = entry.to_string();
    line.push('\n');
    if let Ok(mut file) = wire.lock()
        && let Err(e) = file.write_all(line.as_bytes())
    {
        tracing::warn!(error = %e, "failed to write model-wire log");
    }
}

/// Append one JSON line per evaluated tool-call turn to the log file, if one is
/// configured. Best-effort — a log write failure never blocks a response.
fn log_turns(app: &App, context_audience: &str, decisions: &[TurnDecision]) {
    let Some(log) = &app.log else {
        return;
    };
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut lines = String::new();
    for decision in decisions {
        let entry = serde_json::json!({
            "ts_ms": ts_ms,
            "context_audience": context_audience,
            "tool": decision.tool,
            "outcome": decision.outcome,
            "recipients": decision.recipients,
            "reason": decision.reason,
        });
        lines.push_str(&entry.to_string());
        lines.push('\n');
    }
    if lines.is_empty() {
        return;
    }
    if let Ok(mut file) = log.lock()
        && let Err(e) = file.write_all(lines.as_bytes())
    {
        tracing::warn!(error = %e, "failed to write trajectory log");
    }
}

fn json_bytes(status: StatusCode, body: Vec<u8>) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

fn error(status: StatusCode, message: String) -> Response {
    tracing::warn!(%status, message, "returning error");
    let body = serde_json::json!({ "error": { "message": message, "type": "baton_proxy_error" } });
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

// ---- `render` subcommand: pretty-print a log ----------------------------------

/// Pretty-print a wire log (per-turn request / model / proxy, rewritten turns
/// flagged) or a trajectory decision log. Auto-detects which.
fn render_log(file: Option<&Path>) -> Result<(), Box<dyn std::error::Error>> {
    let path = match file {
        Some(p) => p.to_path_buf(),
        None => newest_wire_log().ok_or("no file given and no wire-logs/model-wire-*.jsonl found")?,
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let rows: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let p = Paint {
        on: std::io::stdout().is_terminal(),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("log");
    let is_wire = rows.first().is_some_and(|r| r.get("returned_response").is_some());
    let kind = if is_wire { "turns" } else { "decisions" };
    println!("{}", p.dim(&format!("── {name} · {} {kind} ──", rows.len())));
    println!();
    if is_wire {
        for row in &rows {
            render_turn(row, &p);
        }
    } else {
        for (i, row) in rows.iter().enumerate() {
            render_decision(i + 1, row, &p);
        }
    }
    Ok(())
}

fn newest_wire_log() -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir("wire-logs").ok()?.flatten() {
        let named = entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with("model-wire-") && n.ends_with(".jsonl"));
        if !named {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified())
            && best.as_ref().is_none_or(|(t, _)| modified > *t)
        {
            best = Some((modified, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

fn render_turn(row: &Value, p: &Paint) {
    let turn = row.get("turn").and_then(Value::as_u64).unwrap_or(0);
    println!("{}", p.cyan(&format!("─── turn {turn} {}", "─".repeat(44))));
    let msgs = row
        .pointer("/request/messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    println!(
        "  {} {} msgs · last: {}",
        p.dim("context in"),
        msgs.len(),
        last_ctx(&msgs)
    );
    let model = response_lines(row.get("model_response"));
    let proxy = response_lines(row.get("returned_response"));
    for (is_call, s) in &model {
        let label = if *is_call { "model wants" } else { "model says " };
        println!("  {} {s}", p.dim(label));
    }
    if model != proxy {
        for (_, s) in &proxy {
            println!(
                "  {} {}  {}",
                p.dim("proxy sends"),
                p.yellow(s),
                p.wrap("⟵ REWRITTEN by baton", "1;33")
            );
        }
    } else {
        println!("  {} {}", p.dim("proxy      "), p.green("unchanged — passed through"));
    }
    println!();
}

fn render_decision(i: usize, row: &Value, p: &Paint) {
    let tool = row.get("tool").and_then(Value::as_str).unwrap_or("");
    let recipients: Vec<&str> = row
        .get("recipients")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let tool = if recipients.is_empty() {
        tool.to_string()
    } else {
        format!("{tool} → {}", recipients.join(", "))
    };
    let outcome = row.get("outcome").and_then(Value::as_str).unwrap_or("");
    let colored = match outcome {
        "permitted" => p.green(outcome),
        "needs_approval" => p.yellow(outcome),
        "terminal" => p.red(outcome),
        _ => outcome.to_string(),
    };
    println!("  {i}. {tool:44} {colored}");
    if let Some(reason) = row.get("reason").and_then(Value::as_str) {
        println!("     {}", p.dim(reason));
    }
}

fn last_ctx(msgs: &[Value]) -> String {
    let Some(m) = msgs.last() else {
        return String::new();
    };
    let role = m.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "tool" {
        return format!(
            "tool-result: {}",
            truncate(&m.get("content").map(value_text).unwrap_or_default(), 70)
        );
    }
    if let Some(calls) = m.get("tool_calls").and_then(Value::as_array) {
        let names: Vec<&str> = calls
            .iter()
            .filter_map(|c| c.pointer("/function/name").and_then(Value::as_str))
            .collect();
        return format!("{role}: →{}", names.join(", "));
    }
    format!(
        "{role}: {}",
        truncate(&m.get("content").map(value_text).unwrap_or_default(), 70)
    )
}

fn response_lines(resp: Option<&Value>) -> Vec<(bool, String)> {
    let Some(msg) = resp.and_then(|r| r.pointer("/choices/0/message")) else {
        return Vec::new();
    };
    if let Some(calls) = msg.get("tool_calls").and_then(Value::as_array) {
        return calls.iter().map(|c| (true, call_str(c))).collect();
    }
    vec![(
        false,
        msg.get("content")
            .map(value_text)
            .unwrap_or_default()
            .trim()
            .to_string(),
    )]
}

fn call_str(tc: &Value) -> String {
    let name = tc.pointer("/function/name").and_then(Value::as_str).unwrap_or("?");
    let raw = tc.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("");
    let args = serde_json::from_str::<Value>(raw)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| raw.to_string());
    format!("{name}  {}", truncate(&args, 100))
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max).collect::<String>())
    } else {
        flat
    }
}

struct Paint {
    on: bool,
}

impl Paint {
    fn wrap(&self, s: &str, code: &str) -> String {
        if self.on {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
    fn dim(&self, s: &str) -> String {
        self.wrap(s, "2")
    }
    fn cyan(&self, s: &str) -> String {
        self.wrap(s, "36")
    }
    fn green(&self, s: &str) -> String {
        self.wrap(s, "32")
    }
    fn yellow(&self, s: &str) -> String {
        self.wrap(s, "33")
    }
    fn red(&self, s: &str) -> String {
        self.wrap(s, "31")
    }
}
