//! The single error type for the crate.

use crate::tool::ToolError;

/// Everything that can go wrong driving an episode. Fail loud: no variant hides
/// a provider error or a policy rejection behind a default.
#[derive(Debug, thiserror::Error)]
pub enum DojoError {
    /// Building the provider client failed (e.g. no `OPENROUTER_API_KEY`).
    #[error("could not build the model client: {0}")]
    Client(String),

    /// The rig-core completion call failed (transport, provider error, or decode).
    /// Note: rig collapses non-2xx and in-band provider errors into one error, and
    /// a malformed tool-call argument surfaces here rather than as a recoverable
    /// per-call result — a deliberate trade of the rig-core migration.
    #[error("completion failed: {0}")]
    Completion(#[from] rig_core::completion::CompletionError),

    /// The provider returned a response we cannot act on (e.g. a tool call with no
    /// id, whose result could not be correlated back to the call).
    #[error("malformed provider response: {detail}")]
    Malformed { detail: String },

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
