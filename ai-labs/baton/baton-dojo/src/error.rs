//! The single error type for the crate.

use crate::tool::ToolError;

/// Everything that can go wrong driving an episode. Fail loud: no variant hides
/// a provider error or a policy rejection behind a default.
#[derive(Debug, thiserror::Error)]
pub enum DojoError {
    /// `OPENROUTER_API_KEY` was neither in the environment nor resolvable.
    #[error("OPENROUTER_API_KEY is not set (set it in the environment or ai-labs/.env)")]
    MissingApiKey,

    /// The HTTP request to the provider failed at the transport layer.
    #[error("http transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// The provider returned a non-2xx status.
    #[error("provider returned status {status}: {body}")]
    Provider { status: u16, body: String },

    /// A provider response could not be decoded into the expected shape.
    #[error("could not decode provider response: {detail}")]
    Decode { detail: String },

    /// Two tools were declared with the same name.
    #[error("duplicate tool name: {0}")]
    DuplicateTool(String),

    /// A baton contract this slice cannot honour was supplied (e.g. one that
    /// requires an explicit user confirmation, for which there is no turn API yet).
    #[error("unsupported baton contract: {detail}")]
    UnsupportedContract { detail: String },

    /// Two baton contracts were declared for the same tool.
    #[error("duplicate baton contract for tool: {tool}")]
    DuplicateContract { tool: String },

    /// The policy engine rejected a permit while folding a tool result into the
    /// trajectory (a linearity/freshness violation — a programming error).
    #[error("baton policy rejected a permit: {detail}")]
    Policy { detail: String },

    /// A tool failed to execute.
    #[error(transparent)]
    Tool(#[from] ToolError),
}
