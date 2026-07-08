//! Authorities: who may loosen the policy, and how loosening is recorded.

use std::fmt;

use crate::contract::{ToolRequest, Violation};
use crate::label::Label;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuthorityName(String);

impl AuthorityName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AuthorityName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The outcome of an escalation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ruling {
    /// Waive the presented violations *for this flow only*. Each waived
    /// violation becomes an audited declassification on the result label;
    /// the context itself is never loosened, so an identical later flow
    /// escalates again.
    Approve {
        reason: String,
    },
    Deny {
        reason: String,
    },
}

/// Anything that can adjudicate an escalation: a human in the loop, a judge
/// model, a dual-LLM check, a regex, a webhook...
pub trait Authority {
    fn name(&self) -> AuthorityName;

    /// `violations` is the full set found for the flow. Under
    /// [`crate::engine::UnknownPolicy::AllowWithAudit`], unprovable entries
    /// are included for context even though the policy audits them through
    /// rather than blocking on them.
    fn adjudicate(
        &self,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Ruling;
}
