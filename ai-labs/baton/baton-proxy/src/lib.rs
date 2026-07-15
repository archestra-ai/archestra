//! baton-proxy: put baton's policy engine between an agent and the world, at
//! either of two enforcement points.
//!
//! **Inference layer** (`config`, `replay`, `rewrite`, `wire`; `bin/proxy.rs`):
//! the proxy sits between an agent harness and an OpenAI-compatible LLM. On
//! every `/v1/chat/completions` response it rebuilds a baton [`Trajectory`] from
//! the request `messages`, evaluates each returned tool call against a
//! [`baton_core::PolicyEngine`], and rewrites the response when a call fails
//! its contract: the offending message is replaced with a stop explanation, so
//! the blocked call never reaches the harness and is never executed.
//! No authorities are registered — a flow the contracts cannot prove is
//! blocked, fail closed. The prototype's human-approval flow (`approval`,
//! `bin/approver.rs`, `bin/demo_agent.rs`) predates current baton-core's
//! authority model and is parked behind the `demo` cargo feature.
//!
//! **Tool layer** ([`gateway`]; `bin/gateway.rs`): an MCP server mimicking an
//! Archestra-style gateway. It owns a live trajectory per session, soft-blocks
//! breaches as tool results, escalates to a human through the authority model
//! (External authority + MCP elicitation), and dispatches the exact canonical
//! request the engine checked — the authority-model successor to the parked
//! inference-layer approval flow.
//!
//! Nothing here is cryptographic: authenticity rests on the harness only
//! recording tool results that real MCP servers returned. See `README.md`.
//!
//! [`Trajectory`]: baton_core::Trajectory

#[cfg(feature = "demo")]
pub mod approval;
pub mod config;
pub mod gateway;
pub mod replay;
pub mod rewrite;
pub mod wire;

pub use config::{ConfigError, Policy};
pub use replay::{CallOutcome, ReplayError, Session};
pub use rewrite::{TurnDecision, rewrite_response};
