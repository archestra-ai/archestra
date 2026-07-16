//! `baton-gateway`: the MCP server. Serves the scenario's tools from
//! `gateway.toml` under the policy in `gateway-policy.toml` (baton-contracts
//! dialect), mediates every `tools/call` through baton-core, soft-blocks
//! remediable breaches (the block is an ordinary tool result telling the model
//! how to escalate), and on `baton__escalate` asks the human through MCP
//! **elicitation** — so the approval prompt appears in the connected client's
//! own UI — then dispatches the exact canonical request the engine checked.
//!
//! ```text
//! cargo run --bin baton-gateway                # narration only
//! cargo run --bin baton-gateway -- -v          # + engine decision path (debug)
//! cargo run --bin baton-gateway -- -vv         # + label algebra (trace)
//! cargo run --bin baton-gateway -- --log decisions.jsonl
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use baton_demo::gateway::narrate::{DecisionLog, narrate};
use baton_demo::gateway::{ConfigFile, ESCALATE_TOOL, GatewayConfig, Outcome, RESPOND_TOOL, Session};
use clap::Parser;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, CreateElicitationRequestParams, ElicitationAction,
    ElicitationSchema, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{Peer, RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData as McpError, ServerHandler};
use tokio::net::TcpListener;

#[derive(Parser)]
#[command(about = "MCP gateway that mediates tool calls through baton-core")]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "BATON_GATEWAY_ADDR", default_value = "127.0.0.1:8732")]
    addr: String,
    /// The tool catalog: simulated tools, their arguments and result templates.
    #[arg(long, default_value_os_t = default_config_path())]
    config: PathBuf,
    /// The policy: tool contracts and authorities (baton-contracts dialect).
    #[arg(long, default_value_os_t = default_policy_path())]
    policy: PathBuf,
    /// Append one JSON line per decision to this file.
    #[arg(long)]
    log: Option<PathBuf>,
    /// -v for the engine decision path, -vv for the label algebra.
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,
}

fn default_config_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("gateway.toml")
}

fn default_policy_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("gateway-policy.toml")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let level = match args.verbose {
        0 => "warn",
        1 => "baton_core=debug",
        _ => "baton_core=trace",
    };
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(level))
        .with_writer(std::io::stderr)
        .init();

    let tools_text =
        std::fs::read_to_string(&args.config).map_err(|e| format!("reading {}: {e}", args.config.display()))?;
    let policy_text =
        std::fs::read_to_string(&args.policy).map_err(|e| format!("reading {}: {e}", args.policy.display()))?;
    let config = Arc::new(GatewayConfig::from_toml(&tools_text, &policy_text).map_err(|e| {
        let file = match e.source_file() {
            ConfigFile::Tools => &args.config,
            ConfigFile::Policy => &args.policy,
        };
        format!("{}: {e}", file.display())
    })?);
    let log = match &args.log {
        Some(path) => Some(Arc::new(DecisionLog::open(path)?)),
        None => None,
    };
    let audit = args.verbose > 0;

    let addr: SocketAddr = args.addr.parse()?;
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;

    // Stateful + SSE (the defaults): server-initiated elicitation needs a way
    // back to the client. One `Gateway` — one `Session`, one trajectory — per
    // MCP session, via the service factory.
    let service: StreamableHttpService<Gateway, LocalSessionManager> = StreamableHttpService::new(
        move || {
            eprintln!("· new MCP session (fresh trajectory)");
            Ok(Gateway::new(config.clone(), log.clone(), audit))
        },
        Default::default(),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);

    eprintln!("baton-gateway listening at http://{local}/mcp (approval via MCP elicitation)");
    axum::serve(listener, router).await?;
    Ok(())
}

struct Gateway {
    config: Arc<GatewayConfig>,
    log: Option<Arc<DecisionLog>>,
    session: Arc<tokio::sync::Mutex<Session>>,
    /// How many audit events have been narrated already (at `-v`).
    audit: Option<Arc<tokio::sync::Mutex<usize>>>,
}

impl Gateway {
    fn new(config: Arc<GatewayConfig>, log: Option<Arc<DecisionLog>>, audit: bool) -> Self {
        Self {
            session: Arc::new(tokio::sync::Mutex::new(Session::new(config.clone()))),
            config,
            log,
            audit: audit.then(|| Arc::new(tokio::sync::Mutex::new(0))),
        }
    }

    fn catalog(&self) -> Vec<Tool> {
        let mut tools: Vec<Tool> = self
            .config
            .tools
            .values()
            .map(|sim| Tool::new(sim.name.to_string(), sim.description.clone(), sim.input_schema()))
            .collect();
        tools.push(Tool::new(
            RESPOND_TOOL,
            "Deliver your final answer to the user. Every final answer MUST go through this tool: pass the full \
             text as `text`. The result is the exact text the user will see — if it says the response was \
             blocked, revise your answer to use only information the conversation readers may see.",
            respond_schema(),
        ));
        tools.push(Tool::new(
            ESCALATE_TOOL,
            "Ask a human operator to approve your most recent policy-blocked tool call. Call this only after a \
             tool result says the call was blocked but can be escalated. Pass a short `reason` explaining why the \
             blocked action is needed. If the result starts with GRANTED, the action was already executed — do not \
             re-issue it. If it starts with DENIED, do not retry; explain to the user.",
            escalate_schema(),
        ));
        tools
    }

    async fn narrate_audit(&self, session: &Session) {
        let Some(cursor) = &self.audit else { return };
        let mut seen = cursor.lock().await;
        for event in session.audit().skip(*seen) {
            eprintln!("\x1b[2m  audit: {event}\x1b[0m");
            *seen += 1;
        }
    }
}

impl ServerHandler for Gateway {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("baton-gateway", env!("CARGO_PKG_VERSION")))
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        std::future::ready(Ok(ListToolsResult::with_all_items(self.catalog())))
    }

    #[allow(clippy::manual_async_fn)] // the trait's return type must be spelled out (MaybeSendFuture)
    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + rmcp::service::MaybeSendFuture + '_ {
        async move {
            let args = request.arguments.unwrap_or_default();
            let mut session = self.session.lock().await;
            let outcome = match request.name.as_ref() {
                RESPOND_TOOL => match respond_text(&args) {
                    Ok(text) => session.respond(&text),
                    Err(reason) => Outcome::BadArguments {
                        tool: baton_core::ToolName::new(RESPOND_TOOL),
                        reason,
                    },
                },
                ESCALATE_TOOL => match escalate_reason(&args) {
                    Ok(reason) => {
                        let peer = context.peer.clone();
                        session
                            .escalate(&reason, move |message| {
                                let peer = peer.clone();
                                async move { elicit(&peer, message).await }
                            })
                            .await
                    }
                    Err(reason) => Outcome::BadArguments {
                        tool: baton_core::ToolName::new(ESCALATE_TOOL),
                        reason,
                    },
                },
                tool => session.call_tool(tool, &args),
            };
            narrate(&outcome);
            if let Some(log) = &self.log {
                log.record(&outcome);
            }
            self.narrate_audit(&session).await;
            Ok(render(outcome))
        }
    }
}

/// Enforce the advertised `baton__escalate` schema: `reason` (a string) is
/// required and the only argument.
fn escalate_reason(args: &serde_json::Map<String, serde_json::Value>) -> Result<String, String> {
    if let Some(unknown) = args.keys().find(|key| key.as_str() != "reason") {
        return Err(format!("undeclared argument `{unknown}`"));
    }
    match args.get("reason") {
        Some(serde_json::Value::String(reason)) => Ok(reason.clone()),
        Some(other) => Err(format!("argument `reason` must be a string, got {other}")),
        None => Err("missing required argument `reason`".to_owned()),
    }
}

/// How long an approval prompt may sit unanswered. The session is serialized
/// across the elicitation on purpose; the timeout bounds how long it can wedge.
const ELICITATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Ask the connected client's human through MCP elicitation. `Some(bool)` is a
/// human ruling (accept/decline); `None` means no ruling was obtained —
/// transport/support error, timeout, or a dismissed prompt — and the caller
/// fails closed without recording a human decision.
async fn elicit(peer: &Peer<RoleServer>, message: String) -> Option<bool> {
    let params = CreateElicitationRequestParams::FormElicitationParams {
        meta: None,
        message,
        // The accept/decline action carries the ruling; no form fields.
        requested_schema: ElicitationSchema::builder().build_unchecked(),
    };
    match tokio::time::timeout(ELICITATION_TIMEOUT, peer.create_elicitation(params)).await {
        Ok(Ok(result)) => match result.action {
            ElicitationAction::Accept => Some(true),
            ElicitationAction::Decline => Some(false),
            ElicitationAction::Cancel => None,
        },
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "elicitation failed; no ruling");
            None
        }
        Err(_) => {
            tracing::warn!("elicitation timed out; no ruling");
            None
        }
    }
}

/// Render a settled outcome as the MCP tool result. Policy decisions are
/// *successful* results — self-describing text the model acts on; only wire
/// and gateway failures are MCP-level errors.
fn render(outcome: Outcome) -> CallToolResult {
    let text = |s: String| vec![Content::text(s)];
    match outcome {
        Outcome::Executed { result, .. } => CallToolResult::success(text(result)),
        // The exact permitted bytes, undecorated: what the model relays is
        // what the engine emitted.
        Outcome::Responded { rendered } => CallToolResult::success(text(rendered)),
        Outcome::ResponseBlocked { reason, violations } => CallToolResult::success(text(format!(
            "⛔ RESPONSE BLOCKED by policy ({reason}) — this answer was NOT delivered.\n{}\nRevise your answer to \
             use only information the conversation readers may see, then call `{RESPOND_TOOL}` again.",
            bullet_violations(&violations),
        ))),
        Outcome::SoftBlocked { violations, .. } => CallToolResult::success(text(format!(
            "⛔ BLOCKED by policy — this call was NOT executed.\n{}\nThis block can be escalated: call \
             `{ESCALATE_TOOL}` with a short `reason` to ask a human operator for approval. If escalation is not \
             warranted, tell the user why the action was blocked instead.",
            bullet_violations(&violations),
        ))),
        Outcome::TerminalBlocked { reason, violations, .. } => CallToolResult::success(text(format!(
            "⛔ BLOCKED by policy (terminal: {reason}) — this call was NOT executed.\n{}\nThis cannot be escalated. \
             Do not retry; explain to the user why it could not be done.",
            bullet_violations(&violations),
        ))),
        Outcome::Granted { tool, result } => CallToolResult::success(text(format!(
            "GRANTED — the operator approved and `{tool}` was executed. Do not re-issue the call.\nResult: {result}"
        ))),
        Outcome::Denied { reason, .. } => CallToolResult::success(text(format!(
            "DENIED — the operator declined ({reason}). Do not retry; explain to the user why it could not be done."
        ))),
        Outcome::EscalationUnavailable { .. } => CallToolResult::error(text(
            "no ruling: the approval channel is unavailable (elicitation failed, timed out, or was dismissed). \
             Nothing was executed. The blocked call is still pending — you may escalate once more, or tell the \
             user approval could not be obtained."
                .to_owned(),
        )),
        Outcome::NothingPending => CallToolResult::success(text(
            "No blocked call is pending escalation. Call the tool you need first; escalate only after its result \
             says it was blocked."
                .to_owned(),
        )),
        Outcome::RemedyStalled { violations, cause, .. } => CallToolResult::error(text(format!(
            "The escalation could not settle ({cause:?}).\n{}",
            bullet_violations(&violations)
        ))),
        Outcome::ExecutorFailed { reason, .. } => {
            CallToolResult::error(text(format!("tool execution failed: {reason}")))
        }
        Outcome::BadArguments { reason, .. } => CallToolResult::error(text(format!("invalid arguments: {reason}"))),
        Outcome::UnknownTool { tool } => CallToolResult::error(text(format!("unknown tool `{tool}`"))),
        Outcome::Refused { reason, .. } => CallToolResult::error(text(format!("gateway refused the flow: {reason}"))),
    }
}

fn bullet_violations(violations: &[baton_core::Violation]) -> String {
    violations
        .iter()
        .map(|v| format!("  · {v}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn respond_schema() -> serde_json::Map<String, serde_json::Value> {
    serde_json::json!({
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "The full final answer to deliver to the user."}
        },
        "required": ["text"]
    })
    .as_object()
    .expect("schema is an object")
    .clone()
}

fn respond_text(args: &serde_json::Map<String, serde_json::Value>) -> Result<String, String> {
    match args.get("text").and_then(|v| v.as_str()) {
        Some(text) if !text.trim().is_empty() => Ok(text.to_owned()),
        _ => Err("`text` (non-empty string) is required".to_owned()),
    }
}

fn escalate_schema() -> serde_json::Map<String, serde_json::Value> {
    serde_json::json!({
        "type": "object",
        "properties": {
            "reason": { "type": "string", "description": "Why the blocked action is needed." }
        },
        "required": ["reason"],
        "additionalProperties": false
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}
