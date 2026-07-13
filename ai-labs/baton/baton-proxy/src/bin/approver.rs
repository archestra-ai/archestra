//! `baton-approver`: the human's console, exposed as an MCP tool.
//!
//! It exposes one tool, `baton__request_approval(tool, recipients, reason)`. On
//! a call it asks the connected MCP client's user to approve, via MCP
//! **elicitation** — so the prompt appears in the client's own UI (Claude Code,
//! etc.), where the person actually is, rather than on this server's terminal.
//! Accept → `GRANTED`, decline/cancel/error → `DENIED`. It runs no policy; it
//! only asks a person, and returns the ruling as an [`ApprovalRecord`] string
//! the proxy harvests from the trajectory.

use std::collections::BTreeSet;
use std::net::SocketAddr;

use baton_core::{ToolName, UserId};
use baton_proxy::approval::{ApprovalRecord, Verdict};
use clap::Parser;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, CreateElicitationRequestParams, ElicitationAction,
    ElicitationSchema, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{Map, Value};
use tokio::net::TcpListener;

const TOOL_NAME: &str = "baton__request_approval";

#[derive(Parser)]
#[command(about = "Human-in-the-loop approval MCP server for baton-proxy")]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "BATON_APPROVER_ADDR", default_value = "127.0.0.1:8731")]
    addr: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
    let addr: SocketAddr = args.addr.parse()?;
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;

    // Defaults are stateful + SSE, which is what server-initiated elicitation
    // needs to reach the client and await its answer.
    let config = StreamableHttpServerConfig::default();
    let service: StreamableHttpService<Approver, LocalSessionManager> =
        StreamableHttpService::new(|| Ok(Approver), Default::default(), config);
    let router = axum::Router::new().nest_service("/mcp", service);

    eprintln!("baton-approver listening at http://{local}/mcp (approval via MCP elicitation)");
    axum::serve(listener, router).await?;
    Ok(())
}

#[derive(Clone)]
struct Approver;

impl ServerHandler for Approver {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("baton-approver", env!("CARGO_PKG_VERSION")))
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        let tool = Tool::new(
            TOOL_NAME,
            "Ask a person to approve sending data outside its current audience. Call this when a tool result tells \
             you to. Pass the `tool` you want to run, the `recipients` it would expose data to, and a short `reason`. \
             If the result starts with GRANTED, retry the original tool call unchanged; if it starts with DENIED, do \
             not retry.",
            input_schema(),
        );
        std::future::ready(Ok(ListToolsResult::with_all_items(vec![tool])))
    }

    #[allow(clippy::manual_async_fn)] // the trait's return type must be spelled out (MaybeSendFuture)
    fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + rmcp::service::MaybeSendFuture + '_ {
        async move {
            let args = request.arguments.unwrap_or_default();
            let tool = ToolName::new(string_arg(&args, "tool").unwrap_or_default());
            let recipients = recipients_arg(&args);
            let reason = string_arg(&args, "reason").unwrap_or_default();

            let verdict = elicit_verdict(&context, &tool, &recipients, &reason).await;
            let record = ApprovalRecord::new(verdict, tool, recipients);
            Ok(CallToolResult::success(vec![Content::text(record.to_string())]))
        }
    }
}

/// Ask the client's user to approve, via MCP elicitation. Accept → granted;
/// decline, cancel, or a transport/support error → denied (fail closed).
async fn elicit_verdict(
    context: &RequestContext<RoleServer>,
    tool: &ToolName,
    recipients: &BTreeSet<UserId>,
    reason: &str,
) -> Verdict {
    let recipients: Vec<&str> = recipients.iter().map(UserId::as_str).collect();
    let message = format!(
        "Approve `{tool}` sending outside its audience to {}?\n{reason}\nAccept to allow this send; decline to block it.",
        recipients.join(", "),
    );
    let params = CreateElicitationRequestParams::FormElicitationParams {
        meta: None,
        message,
        // The accept/decline action carries the y/n; no form fields are needed.
        requested_schema: ElicitationSchema::builder().build_unchecked(),
    };
    match context.peer.create_elicitation(params).await {
        Ok(result) if result.action == ElicitationAction::Accept => Verdict::Granted,
        Ok(_) => Verdict::Denied,
        Err(e) => {
            tracing::warn!(error = %e, "elicitation failed; denying");
            Verdict::Denied
        }
    }
}

fn input_schema() -> Map<String, Value> {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "tool": { "type": "string", "description": "The tool you want to run once approved." },
            "recipients": {
                "type": "array",
                "items": { "type": "string" },
                "description": "The recipients / readers the tool would expose data to."
            },
            "reason": { "type": "string", "description": "Why this send is needed." }
        },
        "required": ["tool", "recipients"]
    });
    schema.as_object().cloned().unwrap_or_default()
}

fn string_arg(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn recipients_arg(args: &Map<String, Value>) -> BTreeSet<UserId> {
    match args.get("recipients") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(UserId::new).collect(),
        Some(Value::String(s)) => BTreeSet::from([UserId::new(s)]),
        _ => BTreeSet::new(),
    }
}
