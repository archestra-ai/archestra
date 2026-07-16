//! baton-proxy: block policy-violating tool calls at the inference layer.
//!
//! The proxy sits between an agent harness and an OpenAI-compatible LLM. On
//! every `/v1/chat/completions` response it rebuilds a baton [`Trajectory`] from
//! the request `messages`, evaluates each returned tool call against a
//! [`baton_core::PolicyEngine`], and rewrites the response when a call fails
//! its contract: the offending message is replaced with a stop explanation, so
//! the blocked call never reaches the harness and is never executed.
//!
//! Only inline `allow` authorities declared in the policy TOML are registered;
//! `escalate` (external) authorities are rejected at load — the proxy has no
//! human channel. A flow no declared authority covers is blocked, fail
//! closed. Human-in-the-loop approval lives on the tool layer instead — soft
//! blocks, escalation, canonical dispatch — in the `baton-demo` gateway; an
//! inference-layer approval flow would be a port to External authorities
//! (`PendingApproval` + `apply_approval`).
//!
//! Nothing here is cryptographic: authenticity rests on the harness only
//! recording tool results that real MCP servers returned. See `README.md`.
//!
//! [`Trajectory`]: baton_core::Trajectory

pub mod config;
pub mod replay;
pub mod rewrite;
pub mod wire;

pub use config::{ConfigError, Policy};
pub use replay::{CallOutcome, ReplayError, Session};
pub use rewrite::{TurnDecision, rewrite_response};
