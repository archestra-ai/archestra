//! Live AFC agent: a real MCP tool server + an OpenRouter LLM loop with the AFC engine governing
//! every model-requested tool call. Unlike the scripted `afc-demo` scenario, the model decides what
//! to call; AFC decides whether it may.

pub mod actor;
pub mod catalog;
pub mod governance;
pub mod governed_tool;
pub mod mcp_client;
pub mod parity;
