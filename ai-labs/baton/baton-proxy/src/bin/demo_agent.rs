//! `baton-demo-agent`: a rig-core agent that plays the "external harness".
//!
//! Its LLM client points at `baton-proxy`, and it registers three tools —
//! `invoices_list`, `send_email`, and `baton__request_approval`. The agent is
//! asked to email a finance summary to an external auditor. The proxy blocks the
//! out-of-audience send by rewriting it into an approval call; rig executes that
//! (this binary prompts you y/n); on approval the model retries the send and the
//! proxy lets it through. Built only under `--features demo`.
//!
//! Requires a real model via OpenRouter (`OPENROUTER_API_KEY`) and a running
//! `baton-proxy` (see the crate README).

use std::collections::BTreeSet;
use std::convert::Infallible;

use baton_core::{ToolName, UserId};
use baton_proxy::approval::{ApprovalRecord, Verdict};
use clap::Parser;
use rig_core::client::CompletionClient;
use rig_core::completion::{Prompt, ToolDefinition};
use rig_core::providers::openai;
use rig_core::tool::Tool;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const DEFAULT_TASK: &str = "Summarize this quarter's invoices and email the summary to our external \
     auditor at alex@finance-audit.com.";

const PREAMBLE: &str = "You are a finance assistant with tools to read invoices and send email. \
     When you send email, some recipients may be outside the data's audience; if so, a tool result \
     will come back from `baton__request_approval`. If that result begins with GRANTED, immediately \
     retry the send you intended, unchanged. If it begins with DENIED, do not send — explain why to \
     the user. Complete the user's request in as few steps as possible.";

#[derive(Parser)]
#[command(about = "Demo agent that drives baton-proxy through the approval flow")]
struct Args {
    /// The proxy's base URL (rig posts `{url}/chat/completions`).
    #[arg(long, env = "BATON_PROXY_URL", default_value = "http://127.0.0.1:8730/v1")]
    proxy_url: String,
    /// OpenRouter model id.
    #[arg(long, env = "BATON_DEMO_MODEL", default_value = "openai/gpt-4o-mini")]
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

    let client = openai::CompletionsClient::builder()
        .api_key(api_key)
        .base_url(&args.proxy_url)
        .build()?;
    let agent = client
        .agent(&args.model)
        .preamble(PREAMBLE)
        .tool(InvoicesList)
        .tool(SendEmail)
        .tool(RequestApproval)
        .build();

    println!("task: {}\n", args.task);
    let answer = agent.prompt(args.task.as_str()).max_turns(12).await?;
    println!("\nagent: {answer}");
    Ok(())
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

struct RequestApproval;

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
        let recipients: BTreeSet<UserId> = args.recipients.iter().map(UserId::new).collect();
        let verdict = prompt_human(&args.tool, &recipients, &args.reason).await;
        let record = ApprovalRecord::new(verdict, ToolName::new(&args.tool), recipients);
        Ok(record.to_string())
    }
}

async fn prompt_human(tool: &str, recipients: &BTreeSet<UserId>, reason: &str) -> Verdict {
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
    if stdout.write_all(card.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
        return Verdict::Denied;
    }

    let mut line = String::new();
    let mut reader = BufReader::new(tokio::io::stdin());
    match reader.read_line(&mut line).await {
        Ok(n) if n > 0 => {
            let answer = line.trim().to_ascii_lowercase();
            if answer == "y" || answer == "yes" {
                Verdict::Granted
            } else {
                Verdict::Denied
            }
        }
        _ => Verdict::Denied,
    }
}
