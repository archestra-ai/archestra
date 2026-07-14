//! `baton-demo-agent`: a rig-core agent that drives the whole real system.
//!
//! Its LLM client points at `baton-proxy`, and it registers three tools —
//! `invoices_list`, `send_email`, and `baton__request_approval`. The approval
//! tool is **not** a local stub: it is a real MCP client call to the running
//! `baton-approver` server, so this binary plays the part a client like Claude
//! Code would. When the approver elicits, this binary's elicitation handler
//! prompts you y/n on the terminal — the stand-in for the client's own UI.
//!
//! End to end: the proxy rewrites the out-of-audience send into a
//! `baton__request_approval` call; rig runs that tool, which calls the approver
//! over MCP; the approver elicits; you answer here; on accept the approver
//! returns GRANTED and the model retries the send, which the proxy now permits.
//!
//! Built only under `--features demo`. Needs `baton-proxy` and `baton-approver`
//! running, and a model via OpenRouter (`OPENROUTER_API_KEY`).

use std::collections::BTreeSet;
use std::convert::Infallible;

use baton_core::UserId;
use clap::Parser;
use rig_core::client::CompletionClient;
use rig_core::completion::{Prompt, ToolDefinition};
use rig_core::providers::openai;
use rig_core::tool::Tool;
use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientInfo, CreateElicitationRequestParams, CreateElicitationResult,
    ElicitationAction, Implementation,
};
use rmcp::service::{Peer, RequestContext, RoleClient};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientHandler, ServiceExt};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const DEFAULT_TASK: &str = "Summarize this quarter's invoices and email the summary to our external \
     auditor at alex@finance-audit.com.";

const PREAMBLE: &str = "You are a finance assistant with tools to read invoices and send email. To \
     send mail, call `send_email` directly — do NOT call any approval tool yourself; the platform \
     requests any needed approval automatically. If a tool result says a send was GRANTED and asks \
     you to retry, retry that `send_email` unchanged. If a result says DENIED, do not retry — \
     explain to the user why it could not be done.";

#[derive(Parser)]
#[command(about = "Demo agent that drives baton-proxy + baton-approver through the approval flow")]
struct Args {
    /// The proxy's base URL (rig posts `{url}/chat/completions`).
    #[arg(long, env = "BATON_PROXY_URL", default_value = "http://127.0.0.1:8730/v1")]
    proxy_url: String,
    /// The approver's MCP endpoint.
    #[arg(long, env = "BATON_APPROVER_URL", default_value = "http://127.0.0.1:8731/mcp")]
    approver_url: String,
    /// OpenRouter model id.
    #[arg(long, env = "BATON_DEMO_MODEL", default_value = "anthropic/claude-sonnet-5")]
    model: String,
    /// OpenRouter API key. Falls back to $OPENROUTER_API_KEY, then to
    /// `ai-labs/.env`.
    #[arg(long, env = "OPENROUTER_API_KEY")]
    api_key: Option<String>,
    /// The task to give the agent.
    #[arg(long, default_value = DEFAULT_TASK)]
    task: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let api_key = args
        .api_key
        .map(|k| clean_key(&k))
        .filter(|k| !k.is_empty())
        .or_else(key_from_env_file)
        .ok_or("no OpenRouter API key: pass --api-key, set OPENROUTER_API_KEY, or add it to ai-labs/.env")?;

    // Connect to the approver as an MCP client. The elicitation handler is this
    // binary standing in for a client's approval UI.
    let transport = StreamableHttpClientTransport::from_uri(args.approver_url.clone());
    let approver = ElicitingClient.serve(transport).await.map_err(|e| {
        format!(
            "connecting to baton-approver at {}: {e} (is it running?)",
            args.approver_url
        )
    })?;
    let peer = approver.peer().clone();

    let client = openai::CompletionsClient::builder()
        .api_key(api_key)
        .base_url(&args.proxy_url)
        .build()?;
    let agent = client
        .agent(&args.model)
        .preamble(PREAMBLE)
        .tool(InvoicesList)
        .tool(SendEmail)
        .tool(RequestApproval { approver: peer })
        .build();

    println!("task: {}\n", args.task);
    let answer = agent.prompt(args.task.as_str()).max_turns(12).await?;
    println!("\nagent: {answer}");

    approver.cancel().await?;
    Ok(())
}

/// The MCP client half: it exposes elicitation support and answers an
/// elicitation by prompting the operator on the terminal.
#[derive(Clone)]
struct ElicitingClient;

impl ClientHandler for ElicitingClient {
    fn get_info(&self) -> ClientInfo {
        // These params are #[non_exhaustive]; build from Default and set fields.
        let mut info = ClientInfo::default();
        info.capabilities = ClientCapabilities::builder().enable_elicitation().build();
        info.client_info = Implementation::new("baton-demo-agent", env!("CARGO_PKG_VERSION"));
        info
    }

    async fn create_elicitation(
        &self,
        request: CreateElicitationRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<CreateElicitationResult, rmcp::ErrorData> {
        let message = match request {
            CreateElicitationRequestParams::FormElicitationParams { message, .. } => message,
            CreateElicitationRequestParams::UrlElicitationParams { message, .. } => message,
        };
        let action = if prompt_yes(&message).await {
            ElicitationAction::Accept
        } else {
            ElicitationAction::Decline
        };
        Ok(CreateElicitationResult::new(action))
    }
}

async fn prompt_yes(message: &str) -> bool {
    let card = format!("\n── approval request ──────────────────────────────\n{message}\napprove? [y/N] ");
    let mut stdout = tokio::io::stdout();
    if stdout.write_all(card.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
        return false;
    }
    let mut line = String::new();
    let mut reader = BufReader::new(tokio::io::stdin());
    match reader.read_line(&mut line).await {
        Ok(n) if n > 0 => matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"),
        _ => false,
    }
}

#[derive(Deserialize)]
struct Empty {}

struct InvoicesList;

impl Tool for InvoicesList {
    const NAME: &'static str = "invoices_list";
    type Error = Infallible;
    type Args = Empty;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "List this quarter's invoices (readable only by the finance team).".to_string(),
            parameters: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _args: Empty) -> Result<String, Infallible> {
        println!("[tool] invoices_list");
        Ok(
            "Q2 invoices: 47 invoices totaling $1,248,000. Largest: Acme Corp $310k, Globex $180k, \
            Initech $95k. All paid except Initech (net-30, due next week)."
                .to_string(),
        )
    }
}

#[derive(Deserialize)]
struct SendEmailArgs {
    to: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    body: String,
}

struct SendEmail;

impl Tool for SendEmail {
    const NAME: &'static str = "send_email";
    type Error = Infallible;
    type Args = SendEmailArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Send an email. `to` is the recipient address.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient email address." },
                    "subject": { "type": "string" },
                    "body": { "type": "string" }
                },
                "required": ["to"]
            }),
        }
    }

    async fn call(&self, args: SendEmailArgs) -> Result<String, Infallible> {
        let preview: String = args.body.chars().take(60).collect();
        println!(
            "[tool] send_email to {} — subject: {} — body: {preview}",
            args.to, args.subject
        );
        Ok(format!("Email sent to {}.", args.to))
    }
}

#[derive(Deserialize)]
struct ApprovalArgs {
    tool: String,
    #[serde(default)]
    recipients: Vec<String>,
    #[serde(default)]
    reason: String,
}

/// The approval tool — a thin proxy to the real `baton-approver` MCP server.
struct RequestApproval {
    approver: Peer<RoleClient>,
}

impl Tool for RequestApproval {
    const NAME: &'static str = "baton__request_approval";
    type Error = Infallible;
    type Args = ApprovalArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Ask a person to approve sending data outside its audience.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tool": { "type": "string" },
                    "recipients": { "type": "array", "items": { "type": "string" } },
                    "reason": { "type": "string" }
                },
                "required": ["tool", "recipients"]
            }),
        }
    }

    async fn call(&self, args: ApprovalArgs) -> Result<String, Infallible> {
        let recipients: Vec<&str> = args.recipients.iter().map(String::as_str).collect();
        println!(
            "[tool] baton__request_approval → asking baton-approver about {}",
            recipients.join(", ")
        );
        let mut params = CallToolRequestParams::default();
        params.name = Self::NAME.into();
        params.arguments = json!({ "tool": args.tool, "recipients": args.recipients, "reason": args.reason })
            .as_object()
            .cloned();
        // Fail closed to a parseable DENIED if the approver is unreachable.
        let result = match self.approver.call_tool(params).await {
            Ok(result) => result,
            Err(e) => {
                let recipients = args.recipients.iter().map(|r| r.as_str()).collect::<BTreeSet<_>>();
                let record = baton_proxy::ApprovalRecord::new(
                    baton_proxy::Verdict::Denied,
                    baton_core::ToolName::new(&args.tool),
                    recipients.into_iter().map(UserId::new).collect(),
                );
                eprintln!("[approver unreachable: {e}]");
                return Ok(record.to_string());
            }
        };
        let text = result
            .content
            .iter()
            .find_map(|c| c.as_text().map(|t| t.text.clone()))
            .unwrap_or_default();
        Ok(text)
    }
}

/// Strip surrounding whitespace and a single pair of matching quotes — the shape
/// a value takes in a `.env` file (`KEY="sk-…"`).
fn clean_key(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(t);
    let t = t.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).unwrap_or(t);
    t.to_string()
}

/// Read `OPENROUTER_API_KEY` from `ai-labs/.env` (two levels up from this crate),
/// the same file the AgentDojo harness uses. Returns `None` if absent.
fn key_from_env_file() -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        if let Some(value) = line.strip_prefix("OPENROUTER_API_KEY=") {
            let key = clean_key(value);
            if !key.is_empty() {
                return Some(key);
            }
        }
    }
    None
}
