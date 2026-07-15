//! Console narration and the JSONL decision log — the gateway's devex layer.
//! One compact colored line per decision on stderr (baton-core's own
//! reasoning streams there too, at `-v`/`-vv`); one JSON object per decision
//! in the optional `--log` file: `ts_ms`, `tool`, `recipients`, `outcome`,
//! `reason`.

use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use baton_core::UserId;
use serde::Serialize;

use crate::gateway::session::Outcome;

const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const MAGENTA: &str = "\x1b[35m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";

/// Narrate one settled outcome to stderr.
pub fn narrate(outcome: &Outcome) {
    match outcome {
        Outcome::Executed { tool, result } => {
            eprintln!("{GREEN}✓ {tool} → permitted{RESET} {DIM}{}{RESET}", first_line(result));
        }
        Outcome::Responded { rendered } => {
            eprintln!(
                "{GREEN}✓ response → emitted{RESET} {DIM}{}{RESET}",
                first_line(rendered)
            );
        }
        Outcome::ResponseBlocked { reason, violations } => {
            eprintln!("{RED}✗ response → blocked{RESET} ({reason})");
            for violation in violations {
                eprintln!("{RED}  · {violation}{RESET}");
            }
        }
        Outcome::SoftBlocked {
            tool,
            violations,
            recipients,
        } => {
            eprintln!(
                "{YELLOW}⚠ {tool} → soft block{RESET} (recipients: {})",
                render_recipients(recipients)
            );
            for violation in violations {
                eprintln!("{YELLOW}  · {violation}{RESET}");
            }
        }
        Outcome::TerminalBlocked {
            tool,
            reason,
            violations,
        } => {
            eprintln!("{RED}✗ {tool} → terminal block{RESET} ({reason})");
            for violation in violations {
                eprintln!("{RED}  · {violation}{RESET}");
            }
        }
        Outcome::Granted { tool, result } => {
            eprintln!(
                "{MAGENTA}✋ {tool} → approved by human → dispatched canonical request{RESET} {DIM}{}{RESET}",
                first_line(result)
            );
        }
        Outcome::Denied { tool, reason } => {
            eprintln!("{MAGENTA}✋ {tool} → denied by human{RESET} ({reason})");
        }
        Outcome::EscalationUnavailable { tool } => {
            eprintln!("{YELLOW}⚠ {tool} → approval channel unavailable{RESET} (no ruling; fail closed, still pending)");
        }
        Outcome::NothingPending => {
            eprintln!("{DIM}· escalation with nothing pending{RESET}");
        }
        Outcome::RemedyStalled { tool, cause, .. } => {
            eprintln!("{RED}✗ {tool} → remedy stalled{RESET} ({cause:?})");
        }
        Outcome::ExecutorFailed { tool, reason } => {
            eprintln!("{RED}✗ {tool} → executor failed{RESET} ({reason})");
        }
        Outcome::BadArguments { tool, reason } => {
            eprintln!("{RED}✗ {tool} → bad arguments{RESET} ({reason})");
        }
        Outcome::UnknownTool { tool } => {
            eprintln!("{RED}✗ {tool} → unknown tool{RESET}");
        }
        Outcome::Refused { tool, reason } => {
            eprintln!("{RED}✗ {tool} → capability refused{RESET} ({reason})");
        }
    }
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    match line.chars().count() > 80 {
        true => format!("{}…", line.chars().take(79).collect::<String>()),
        false => line.to_owned(),
    }
}

fn render_recipients(recipients: &BTreeSet<UserId>) -> String {
    match recipients.is_empty() {
        true => "none declared".to_owned(),
        false => recipients
            .iter()
            .map(|r| r.as_str().to_owned())
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// Append-only JSONL decision log.
pub struct DecisionLog {
    file: Mutex<File>,
}

#[derive(Serialize)]
struct Entry<'a> {
    ts_ms: u128,
    tool: &'a str,
    recipients: Vec<&'a str>,
    outcome: &'static str,
    reason: String,
}

impl DecisionLog {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self { file: Mutex::new(file) })
    }

    pub fn record(&self, outcome: &Outcome) {
        let empty = BTreeSet::new();
        let (tool, recipients, kind, reason) = match outcome {
            Outcome::Executed { tool, .. } => (tool.to_string(), &empty, "permitted", String::new()),
            Outcome::Responded { .. } => ("baton__respond".to_owned(), &empty, "responded", String::new()),
            Outcome::ResponseBlocked { reason, .. } => {
                ("baton__respond".to_owned(), &empty, "response_blocked", reason.clone())
            }
            Outcome::SoftBlocked {
                tool,
                violations,
                recipients,
            } => (tool.to_string(), recipients, "soft_blocked", join(violations)),
            Outcome::TerminalBlocked { tool, reason, .. } => (tool.to_string(), &empty, "terminal", reason.to_string()),
            Outcome::Granted { tool, .. } => (tool.to_string(), &empty, "granted", String::new()),
            Outcome::Denied { tool, reason } => (tool.to_string(), &empty, "denied", reason.clone()),
            Outcome::EscalationUnavailable { tool } => {
                (tool.to_string(), &empty, "escalation_unavailable", String::new())
            }
            Outcome::NothingPending => ("baton__escalate".to_owned(), &empty, "nothing_pending", String::new()),
            Outcome::RemedyStalled { tool, cause, .. } => (tool.to_string(), &empty, "stalled", format!("{cause:?}")),
            Outcome::ExecutorFailed { tool, reason } => (tool.to_string(), &empty, "executor_failed", reason.clone()),
            Outcome::BadArguments { tool, reason } => (tool.to_string(), &empty, "bad_arguments", reason.clone()),
            Outcome::UnknownTool { tool } => (tool.clone(), &empty, "unknown_tool", String::new()),
            Outcome::Refused { tool, reason } => (tool.to_string(), &empty, "refused", reason.clone()),
        };
        let entry = Entry {
            ts_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default(),
            tool: &tool,
            recipients: recipients.iter().map(UserId::as_str).collect(),
            outcome: kind,
            reason,
        };
        if let Ok(line) = serde_json::to_string(&entry)
            && let Ok(mut file) = self.file.lock()
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn join(violations: &[baton_core::Violation]) -> String {
    violations.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("; ")
}
