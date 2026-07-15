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
use baton_proxy::approval::{ApprovalRecord, Verdict};
use clap::Parser;
use rig_core::client::CompletionClient;
use rig_core::completion::{Prompt, ToolDefinition};
use rig_core::providers::openai;
use rig_core::tool::Tool;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::{Peer, RoleClient};
use rmcp::transport::StreamableHttpClientTransport;
use serde::Deserialize;
use serde_json::json;

#[path = "../demo_support.rs"]
mod demo_support;
use demo_support::{ElicitingClient, clean_key, key_from_env_file};

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
    let approver = ElicitingClient::new("baton-demo-agent")
        .serve(transport)
        .await
        .map_err(|e| {
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
                let record = ApprovalRecord::new(
                    Verdict::Denied,
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
