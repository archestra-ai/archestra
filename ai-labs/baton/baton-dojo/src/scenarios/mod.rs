//! The benchmark's authored cases, one scenario per file.
//!
//! Each `pub fn` returns one scored [`Case`](crate::suite::Case); the suite runner
//! ([`crate::suite`]) selects and runs them.

mod auditor_email;
mod recording_bug_filing;

pub use auditor_email::auditor_email;
pub use recording_bug_filing::recording_bug_filing;

use crate::tool::ToolError;

/// Internal readers shared by the audience-based cases.
pub(super) const ALICE: &str = "alice@archestra.ai";
pub(super) const BOB: &str = "bob@archestra.ai";

/// Pull a required string argument out of a tool call's JSON.
pub(super) fn str_arg(args: &serde_json::Value, tool: &str, key: &str) -> Result<String, ToolError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| ToolError::BadArgs {
            tool: tool.to_owned(),
            detail: format!("missing `{key}`"),
        })
}
