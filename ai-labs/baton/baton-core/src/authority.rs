//! Authorities: who may loosen the policy, and how loosening is recorded.

use std::fmt;

use crate::contract::{ToolRequest, Violation};
use crate::label::{Grant, Label};

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
///
/// Composition is static: a tuple `(A, B)` of authorities is itself an
/// `Authority` (blanket impl below), so a panel is written
/// `PolicyEngine::new((human, admin), …)` with no `Box<dyn>`. Tuple order is
/// the static consultation preference — the first member whose mandate covers
/// the need decides.
pub trait Authority {
    /// The name of the member that would cover `needed`, or `None` if this
    /// authority cannot. This folds coverage and attribution into one pure,
    /// stable function so the engine both routes and names from the same
    /// answer; it must return the same result at routing time and at
    /// delegation time. The empty grant is covered by all (acknowledgment
    /// competence is universal), so a leaf returns `Some(self.name)` for it.
    fn grant_authority(&self, needed: &Grant) -> Option<AuthorityName>;

    /// Rule on an escalation the engine has already routed here. `needed` is
    /// the grant the engine will apply on `Approve`; `violations` is the full
    /// set found for the flow (under
    /// [`crate::engine::UnknownPolicy::AllowWithAudit`], policy-audited
    /// unprovables are included for context even though the policy audits
    /// them through rather than blocking on them).
    fn adjudicate(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Ruling;
}

/// Static composition: consult members left to right, first covering member
/// decides. `grant_authority` is first-success `or_else`; `adjudicate`
/// delegates to whichever member `grant_authority` selected. Because
/// `grant_authority` is pure and stable, the recorded name is exactly the
/// member that adjudicates. First-success `or_else` is associative, so
/// `(a, (b, c))` and `((a, b), c)` route identically — nesting shape does not
/// matter.
impl<A: Authority, B: Authority> Authority for (A, B) {
    fn grant_authority(&self, needed: &Grant) -> Option<AuthorityName> {
        self.0
            .grant_authority(needed)
            .or_else(|| self.1.grant_authority(needed))
    }

    fn adjudicate(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Ruling {
        // Sound because the engine calls `adjudicate` only after
        // `grant_authority(needed).is_some()`, so some member covers `needed`.
        if self.0.grant_authority(needed).is_some() {
            self.0.adjudicate(needed, request, context, violations)
        } else {
            self.1.adjudicate(needed, request, context, violations)
        }
    }
}
