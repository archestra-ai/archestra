//! baton-proxy: block policy-violating tool calls at the inference layer.
//!
//! The proxy sits between an agent harness and an OpenAI-compatible LLM. On
//! every `/v1/chat/completions` response it rebuilds a baton [`Trajectory`] from
//! the request `messages`, evaluates each returned tool call against a
//! [`baton_core::PolicyEngine`], and rewrites the response when a call fails
//! its contract: the offending message is replaced with a stop explanation, so
//! the blocked call never reaches the harness and is never executed.
//!
//! No authorities are registered — a flow the contracts cannot prove is
//! blocked, fail closed. The prototype's human-approval flow (the
//! `baton-approver` / `baton-demo-agent` binaries) predates current baton-core's
//! authority model; it is parked in the `baton-demo` crate (behind its
//! `approver` feature) and returns as a port to External authorities
//! (`PendingApproval` + `apply_approval`). The tool-layer successor to that
//! flow — soft blocks, escalation, canonical dispatch — is the `baton-demo`
//! gateway.
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
