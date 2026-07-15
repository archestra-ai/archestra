//! Shared plumbing for the demo agents (`bin/demo_agent.rs`,
//! `bin/gateway_agent.rs`): the terminal-prompting MCP elicitation handler and
//! OpenRouter key resolution.
//!
//! Deliberately NOT part of the `baton_demo` library — demo scaffolding must
//! not sit in its API. Each demo bin includes this file directly with
//! `#[path = "../demo_support.rs"] mod demo_support;`.

use rmcp::ClientHandler;
use rmcp::model::{
    ClientCapabilities, ClientInfo, CreateElicitationRequestParams, CreateElicitationResult, ElicitationAction,
    Implementation,
};
use rmcp::service::{RequestContext, RoleClient};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// The MCP client half: it exposes elicitation support and answers an
/// elicitation by prompting the operator on the terminal — the stand-in for
/// the approval UI a client like Claude Code would render.
#[derive(Clone)]
pub struct ElicitingClient {
    client_name: &'static str,
}

impl ElicitingClient {
    pub fn new(client_name: &'static str) -> Self {
        Self { client_name }
    }
}

impl ClientHandler for ElicitingClient {
    fn get_info(&self) -> ClientInfo {
        // These params are #[non_exhaustive]; build from Default and set fields.
        let mut info = ClientInfo::default();
        info.capabilities = ClientCapabilities::builder().enable_elicitation().build();
        info.client_info = Implementation::new(self.client_name, env!("CARGO_PKG_VERSION"));
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

pub async fn prompt_yes(message: &str) -> bool {
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

/// Strip surrounding whitespace and a single pair of matching quotes — the shape
/// a value takes in a `.env` file (`KEY="sk-…"`).
pub fn clean_key(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(t);
    let t = t.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).unwrap_or(t);
    t.to_string()
}

/// Read `OPENROUTER_API_KEY` from `ai-labs/.env` (two levels up from this crate),
/// the same file the AgentDojo harness uses. Returns `None` if absent.
pub fn key_from_env_file() -> Option<String> {
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
