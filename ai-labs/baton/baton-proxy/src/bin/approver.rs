//! `baton-approver`: the human's console, exposed as an MCP tool.
//!
//! It exposes one tool, `baton__request_approval(tool, recipients, reason)`. On
//! a call it prints the request and asks the operator y/n (or rules
//! automatically under `--auto`), then returns the ruling as an
//! [`ApprovalRecord`] string the proxy harvests from the trajectory. It runs no
//! policy and keeps no state — it only asks a person.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use baton_core::{ToolName, UserId};
use baton_proxy::approval::{ApprovalRecord, Verdict};
use clap::{Parser, ValueEnum};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

const TOOL_NAME: &str = "baton__request_approval";

#[derive(Clone, Copy, Debug, ValueEnum)]
enum AutoMode {
    Approve,
    Deny,
}

#[derive(Parser)]
#[command(about = "Human-in-the-loop approval MCP server for baton-proxy")]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "BATON_APPROVER_ADDR", default_value = "127.0.0.1:8731")]
    addr: String,
    /// Rule automatically instead of prompting (for tests/demos).
    #[arg(long, value_enum)]
    auto: Option<AutoMode>,
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

    let handler = Approver {
        auto: args.auto,
        prompt: Arc::new(Mutex::new(())),
    };
    let config = StreamableHttpServerConfig::default()
        .with_stateful_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None);
    let service: StreamableHttpService<Approver, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), config);
    let router = Router::new().nest_service("/mcp", service);

    eprintln!("baton-approver listening at http://{local}/mcp");
    if let Some(auto) = args.auto {
        eprintln!("(auto mode: {auto:?})");
    }
    axum::serve(listener, router).await?;
    Ok(())
}

#[derive(Clone)]
struct Approver {
    auto: Option<AutoMode>,
    /// Serializes terminal prompts so concurrent approvals do not interleave.
    prompt: Arc<Mutex<()>>,
}

impl Approver {
    async fn decide(&self, tool: &ToolName, recipients: &BTreeSet<UserId>, reason: &str) -> Verdict {
        if let Some(auto) = self.auto {
            return match auto {
                AutoMode::Approve => Verdict::Granted,
                AutoMode::Deny => Verdict::Denied,
            };
        }
        let _guard = self.prompt.lock().await;
        prompt_human(tool, recipients, reason).await
    }
}

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

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + rmcp::service::MaybeSendFuture + '_ {
        let this = self.clone();
        async move {
            let args = request.arguments.unwrap_or_default();
            let tool = ToolName::new(string_arg(&args, "tool").unwrap_or_default());
            let recipients = recipients_arg(&args);
            let reason = string_arg(&args, "reason").unwrap_or_default();
            let verdict = this.decide(&tool, &recipients, &reason).await;
            let record = ApprovalRecord::new(verdict, tool, recipients);
            Ok(CallToolResult::success(vec![Content::text(record.to_string())]))
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

async fn prompt_human(tool: &ToolName, recipients: &BTreeSet<UserId>, reason: &str) -> Verdict {
    let recipients: Vec<&str> = recipients.iter().map(UserId::as_str).collect();
    let card = format!(
        "\n── approval request ──────────────────────────────\n\
         tool       {tool}\n\
         recipients {}\n\
         reason     {reason}\n\
         approve? [y/N] ",
        recipients.join(", "),
    );
    let mut stdout = tokio::io::stdout();
    let _ = stdout.write_all(card.as_bytes()).await;
    let _ = stdout.flush().await;

    let mut line = String::new();
    let mut reader = BufReader::new(tokio::io::stdin());
    match reader.read_line(&mut line).await {
        Ok(0) => Verdict::Denied, // EOF: fail closed
        Ok(_) => {
            let answer = line.trim().to_ascii_lowercase();
            if answer == "y" || answer == "yes" {
                Verdict::Granted
            } else {
                Verdict::Denied
            }
        }
        Err(_) => Verdict::Denied,
    }
}
