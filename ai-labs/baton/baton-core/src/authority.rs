//! Authorities: who may loosen the policy, and how loosening is recorded.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::contract::{ToolRequest, Violation};
use crate::label::{Grant, Label};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ruling {
    /// Approve the flow: the engine applies the minted grant, rechecks it
    /// closed, and records the declassification *for this flow only*. The
    /// stored context is never loosened, so an identical later flow escalates
    /// again.
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
    /// Route `needed` to the first member whose declared mandate covers it and
    /// return that member's name together with its ruling — from a **single
    /// traversal**, so the audited name is exactly the member that ruled, with
    /// no reliance on a routing/attribution call agreeing with a separate
    /// adjudication call. `None` means no member's mandate covers `needed`, and
    /// in that case no member is consulted — an uncovered flow blocks without
    /// consulting anyone.
    ///
    /// A member is consulted only after its own mandate covers `needed`, so
    /// coverage stays decidable from declared data before any (possibly
    /// expensive) judgement runs. The empty grant is covered by all
    /// (acknowledgment competence is universal). `needed` is the grant the
    /// engine will apply on `Approve`; `violations` is the full set found for
    /// the flow (under [`crate::engine::UnknownPolicy::AllowWithAudit`],
    /// policy-audited unprovables are included for context even though the
    /// policy audits them through rather than blocking on them).
    fn rule(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)>;
}

/// Static composition: consult members left to right, first covering member
/// decides. `rule` is first-success `or_else`, so both the name and the ruling
/// come from the same member in one traversal — attribution is consistent by
/// construction, even for a stateful member. First-success `or_else` is
/// associative, so `(a, (b, c))` and `((a, b), c)` route identically — nesting
/// shape does not matter. A non-covering member returns `None` before its
/// judgement runs, so it is never consulted.
impl<A: Authority, B: Authority> Authority for (A, B) {
    fn rule(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        self.0
            .rule(needed, request, context, violations)
            .or_else(|| self.1.rule(needed, request, context, violations))
    }
}
