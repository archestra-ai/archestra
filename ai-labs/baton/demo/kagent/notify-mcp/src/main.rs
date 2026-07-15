//! `notify-mcp`: the kagent demo's webhook tools, exposed as an MCP server.
//!
//! Two tools, deliberately split by destination so the policy can label them
//! differently:
//!
//! - `notify(message)` — POST the message to the one internal ops hook this
//!   server is configured with. The destination is fixed here, so the policy
//!   can declare the sink's audience statically: the people who read the hook.
//! - `http_post(url, message)` — POST the message to an arbitrary URL. Nobody
//!   can bound who reads an arbitrary URL, so the policy declares this sink
//!   public — only a publicly readable flow may use it.
//!
//! No policy lives here — baton-proxy decides whether a call may run; this
//! server just delivers what it is handed.

use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;
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
use tokio::net::TcpListener;

const NOTIFY_TOOL: &str = "notify";
const HTTP_POST_TOOL: &str = "http_post";

#[derive(Parser)]
#[command(about = "Webhook MCP server for the kagent demo")]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "NOTIFY_MCP_ADDR", default_value = "0.0.0.0:8731")]
    addr: String,
    /// The internal ops hook `notify` delivers to.
    #[arg(long, env = "OPS_HOOK_URL", default_value = "http://ops-hook.shop/notify")]
    hook_url: String,
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

    let hook_url = args.hook_url.clone();
    let config = StreamableHttpServerConfig::default();
    let service: StreamableHttpService<Webhooks, LocalSessionManager> = StreamableHttpService::new(
        move || {
            Ok(Webhooks {
                hook_url: hook_url.clone(),
            })
        },
        Default::default(),
        config,
    );
    let router = axum::Router::new().nest_service("/mcp", service);

    eprintln!(
        "notify-mcp listening at http://{local}/mcp (ops hook: {})",
        args.hook_url
    );
    axum::serve(listener, router).await?;
    Ok(())
}

#[derive(Clone)]
struct Webhooks {
    hook_url: String,
}

impl ServerHandler for Webhooks {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("notify-mcp", env!("CARGO_PKG_VERSION")))
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, McpError>> + rmcp::service::MaybeSendFuture + '_
    {
        let notify = Tool::new(
            NOTIFY_TOOL,
            "Send a short status message to the internal ops hook. Pass the `message` text; it is POSTed to the \
             hook as plain text.",
            message_schema(),
        );
        let http_post = Tool::new(
            HTTP_POST_TOOL,
            "POST a text `message` to an arbitrary `url` — an external webhook, for example.",
            url_message_schema(),
        );
        std::future::ready(Ok(ListToolsResult::with_all_items(vec![notify, http_post])))
    }

    #[allow(clippy::manual_async_fn)] // the trait's return type must be spelled out (MaybeSendFuture)
    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, McpError>> + rmcp::service::MaybeSendFuture + '_ {
        async move {
            let args = request.arguments.unwrap_or_default();
            let message = string_arg(&args, "message").unwrap_or_default();
            let url = match request.name.as_ref() {
                NOTIFY_TOOL => self.hook_url.clone(),
                HTTP_POST_TOOL => match string_arg(&args, "url") {
                    Some(url) => url,
                    None => return Ok(CallToolResult::error(vec![Content::text("missing required `url`")])),
                },
                other => {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "unknown tool `{other}`"
                    ))]));
                }
            };
            match deliver(&url, &message).await {
                Ok(status) => Ok(CallToolResult::success(vec![Content::text(format!(
                    "delivered to {url}: HTTP {status}"
                ))])),
                Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
                    "delivery to {url} failed: {e}"
                ))])),
            }
        }
    }
}

async fn deliver(url: &str, message: &str) -> Result<u16, reqwest::Error> {
    let response = reqwest::Client::new()
        .post(url)
        .header("content-type", "text/plain")
        .timeout(Duration::from_secs(10))
        .body(message.to_string())
        .send()
        .await?;
    Ok(response.status().as_u16())
}

fn message_schema() -> Map<String, Value> {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "message": { "type": "string", "description": "The status message to send." }
        },
        "required": ["message"]
    });
    schema.as_object().cloned().unwrap_or_default()
}

fn url_message_schema() -> Map<String, Value> {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "url": { "type": "string", "description": "The URL to POST to." },
            "message": { "type": "string", "description": "The message to send." }
        },
        "required": ["url", "message"]
    });
    schema.as_object().cloned().unwrap_or_default()
}

fn string_arg(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}
