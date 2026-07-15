//! baton-demo: the ad-hoc demo harnesses for the baton prototype, kept out of
//! the shared workspace so the parked approval flow cannot break the build.
//!
//! - [`gateway`] (default): the tool-layer MCP gateway demo — it serves a
//!   scenario's tools, soft-blocks policy breaches as tool results, escalates
//!   to a human through MCP elicitation, and dispatches the exact canonical
//!   request the engine checked. Built and tested. See `README.md`.
//! - [`approval`] (feature `approver`, **parked**): the earlier
//!   inference-layer human-approval flow. It compiles, but does not run
//!   end-to-end — the flow needs the approval-rewriting `baton-proxy` behavior
//!   that no longer exists (the proxy now blocks fail-closed). It returns once
//!   ported to External authorities. See `APPROVER.md`.

pub mod gateway;

#[cfg(feature = "approver")]
pub mod approval;
