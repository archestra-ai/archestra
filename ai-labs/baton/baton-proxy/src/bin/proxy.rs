//! `baton-proxy`: an OpenAI chat-completions proxy that gates out-of-audience
//! tool calls on a human. Point a harness's `base_url` at it; register the
//! approval MCP server so the model can call `baton__request_approval`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
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
use clap::Parser;
use tokio::net::TcpListener;

/// Headers worth forwarding to OpenAI-compatible upstreams (esp. OpenRouter).
const FORWARD_HEADERS: &[&str] = &["http-referer", "x-title", "openai-organization"];

#[derive(Parser)]
#[command(about = "Inference-layer proxy that gates out-of-audience tool calls on a human")]
struct Args {
    /// Path to the policy file.
    #[arg(long, env = "BATON_PROXY_POLICY", default_value = "policy.toml")]
    policy: PathBuf,
    /// Address to listen on.
    #[arg(long, env = "BATON_PROXY_ADDR", default_value = "127.0.0.1:8730")]
    addr: String,
    /// Append one JSON line per evaluated tool-call turn to this file.
    #[arg(long, env = "BATON_PROXY_LOG")]
    log: Option<PathBuf>,
}

struct App {
    policy: Policy,
    client: reqwest::Client,
    log: Option<Mutex<std::fs::File>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
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

    let app = Arc::new(App {
        policy,
        client: reqwest::Client::new(),
        log,
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
    match serde_json::to_vec(&response) {
        Ok(out) => json_bytes(StatusCode::OK, out),
        Err(_) => json_bytes(out_status, bytes.to_vec()),
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
