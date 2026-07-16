//! baton-demo: the ad-hoc demo harness for the baton prototype, kept out of
//! the shared workspace so its heavy demo deps stay out of the workspace build.
//!
//! [`gateway`] is the tool-layer MCP gateway demo — it serves a scenario's
//! tools, soft-blocks policy breaches as tool results, escalates to a human
//! through MCP elicitation, and dispatches the exact canonical request the
//! engine checked. See `README.md`.

pub mod gateway;
