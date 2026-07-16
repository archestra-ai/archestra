//! The tool-layer gateway (`bin/gateway.rs`): an MCP server that mimics an
//! Archestra-style gateway over baton-core. It serves a scenario's (simulated)
//! tools, checks every `tools/call` against the policy engine, soft-blocks
//! calls that need authority escalation — the block comes back as a tool
//! result the model can act on — and, once a human approves via MCP
//! elicitation, dispatches the exact canonical request the engine checked.
//! See README.md.

pub mod config;
pub mod narrate;
pub mod session;

pub use config::{ConfigError, ConfigFile, ESCALATE_TOOL, GatewayConfig, RESPOND_TOOL, ToolSim};
pub use session::{Outcome, Session};
