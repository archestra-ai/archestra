//! baton-proxy: gate out-of-audience tool calls on a human, at the inference layer.
//!
//! The proxy sits between an agent harness and an OpenAI-compatible LLM. On
//! every `/v1/chat/completions` response it rebuilds a baton [`Trajectory`] from
//! the request `messages`, evaluates each returned tool call against a
//! [`baton_core::PolicyEngine`], and rewrites the response when a call would
//! expose data outside its audience: the offending call is replaced with text
//! telling the model to call the approval MCP tool. The human's ruling comes
//! back as an ordinary tool result, so the approval evidence lives *in the
//! trajectory* and the (stateless) proxy re-derives it on the next request.
//!
//! Nothing here is cryptographic: authenticity rests on the harness only
//! recording tool results that real MCP servers returned, and the human seeing
//! every request before ruling. See `README.md` for the full trust model.
//!
//! [`Trajectory`]: baton_core::Trajectory

pub mod approval;
pub mod config;
pub mod replay;
pub mod rewrite;
pub mod wire;

pub use approval::{ApprovalRecord, Verdict};
pub use config::{ConfigError, Policy};
pub use replay::{CallOutcome, ReplayError, Session};
pub use rewrite::{TurnDecision, rewrite_response};
