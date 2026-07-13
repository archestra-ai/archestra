//! The approval record: the string the approver returns and the proxy harvests.
//!
//! An approval is not a signed token — it is a plain tool result the human's
//! console produced. The proxy trusts it because the harness only records
//! results real MCP servers returned (see the crate-level trust model). The
//! record binds exactly two policy-relevant facts: which tool was ruled on, and
//! which recipients the human saw and admitted (or refused). baton polices
//! *audience*, so those recipients — not the message body — are what the grant
//! covers.

use std::collections::BTreeSet;
use std::fmt;

use baton_core::{Grant, ToolName, UserId};

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

    /// Parse the machine-readable first line of an approval tool result. The
    /// grammar is `GRANTED tool=<tool> recipients=<id,id,...>` (or `DENIED`);
    /// any following lines are human prose and ignored. Returns `None` for
    /// anything that does not match — an unparseable result is treated as no
    /// approval at all (fail closed).
    pub fn parse(content: &str) -> Option<Self> {
        let line = content.lines().next()?.trim();
        let mut tokens = line.split_whitespace();
        let verdict = match tokens.next()? {
            "GRANTED" => Verdict::Granted,
            "DENIED" => Verdict::Denied,
            _ => return None,
        };
        let mut tool = None;
        let mut recipients = None;
        for token in tokens {
            if let Some(v) = token.strip_prefix("tool=") {
                tool = Some(ToolName::new(v));
            } else if let Some(v) = token.strip_prefix("recipients=") {
                recipients = Some(parse_recipients(v));
            }
        }
        Some(Self {
            verdict,
            tool: tool?,
            recipients: recipients?,
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
        writeln!(
            f,
            "{word} tool={} recipients={}",
            self.tool,
            render_recipients(&self.recipients)
        )?;
        write!(f, "{prose}")
    }
}

fn render_recipients(recipients: &BTreeSet<UserId>) -> String {
    recipients.iter().map(UserId::as_str).collect::<Vec<_>>().join(",")
}

fn parse_recipients(raw: &str) -> BTreeSet<UserId> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(UserId::new)
        .collect()
}
