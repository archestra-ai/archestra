//! The approval record: the string the approver returns and the proxy harvests.
//!
//! An approval is not a signed token — it is a plain tool result the human's
//! console produced. The proxy trusts it because the harness only records
//! results real MCP servers returned (see the crate-level trust model). The
//! record binds exactly two policy-relevant facts: which tool was ruled on, and
//! which recipients the human saw and admitted (or refused). baton polices
//! *audience*, so those recipients — not the message body — are what the grant
//! covers.
//!
//! The wire form is a verdict word followed by a JSON object —
//! `GRANTED {"tool":"send_email","recipients":["a@x.com"]}` — so a recipient or
//! tool string can never inject a delimiter and shift which field is read (a
//! space/`=`-delimited form could be laundered by a crafted recipient).

use std::collections::BTreeSet;
use std::fmt;

use baton_core::{Grant, ToolName, UserId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Granted,
    Denied,
}

/// A human ruling recovered from an approval tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub verdict: Verdict,
    pub tool: ToolName,
    /// The recipients the human was shown and ruled on.
    pub recipients: BTreeSet<UserId>,
}

/// The JSON payload carried after the verdict word. Structured so recipient and
/// tool strings stay quoted values — no delimiter injection.
#[derive(Serialize, Deserialize)]
struct Payload {
    tool: String,
    recipients: Vec<String>,
}

impl ApprovalRecord {
    pub fn new(verdict: Verdict, tool: ToolName, recipients: BTreeSet<UserId>) -> Self {
        Self {
            verdict,
            tool,
            recipients,
        }
    }

    /// Read this record as the audience grant it stands for: admit exactly the
    /// ruled-on recipients. Used by the approval authority's `covers` check.
    pub fn grant(&self) -> Grant {
        Grant {
            audience: Some(self.recipients.clone()),
            ..Grant::empty()
        }
    }

    /// Parse the machine-readable first line of an approval tool result:
    /// `GRANTED <json>` / `DENIED <json>`, where `<json>` is
    /// `{"tool":…,"recipients":[…]}`. Following lines are human prose and
    /// ignored. Returns `None` for anything that does not match — an unparseable
    /// result is treated as no approval at all (fail closed).
    pub fn parse(content: &str) -> Option<Self> {
        let line = content.lines().next()?.trim();
        let (word, json) = line.split_once(' ')?;
        let verdict = match word {
            "GRANTED" => Verdict::Granted,
            "DENIED" => Verdict::Denied,
            _ => return None,
        };
        let payload: Payload = serde_json::from_str(json).ok()?;
        Some(Self {
            verdict,
            tool: ToolName::new(payload.tool),
            recipients: payload.recipients.into_iter().map(UserId::new).collect(),
        })
    }
}

/// Render a ruling as the tool result the approver returns: a machine-readable
/// first line the proxy parses, then a sentence the model reads.
impl fmt::Display for ApprovalRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (word, prose) = match self.verdict {
            Verdict::Granted => ("GRANTED", "Approved. Retry the original tool call now, unchanged."),
            Verdict::Denied => (
                "DENIED",
                "Denied. Do not retry this call; choose another approach or stop.",
            ),
        };
        let payload = Payload {
            tool: self.tool.as_str().to_string(),
            recipients: self.recipients.iter().map(|r| r.as_str().to_string()).collect(),
        };
        let json = serde_json::to_string(&payload).map_err(|_| fmt::Error)?;
        writeln!(f, "{word} {json}")?;
        write!(f, "{prose}")
    }
}
