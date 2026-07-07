//! Approvers and approval chains.
//!
//! An approver can only ever *narrow* what happens: its verdict is re-checked against its scope by the
//! engine ([`RuleEngine::finalize_escalation`](crate::engine::RuleEngine::finalize_escalation)), and an
//! approval never widens the sink ceiling. This module decides; the engine enforces.

use std::cell::Cell;
use std::collections::BTreeMap;

use crate::rule::Predicate;

pub type ApproverId = String;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Verdict {
    Approve,
    Deny {
        reason: String,
    },
    /// Decline to rule — the chain moves to the next approver.
    Abstain,
}

/// What an approver observes about the pending call.
pub struct ApprovalRequest {
    /// Whether the value being acted on is tainted. Drives `requires_clean_context` abstention.
    pub tainted: bool,
    /// The injected clock reading, so time-based approvers stay pure/deterministic.
    pub clock: u64,
    /// Length of the model's driving prompt for this call — what a length-sensitive approver
    /// observes (e.g. a parity approver that gates on `prompt_len % 2`).
    pub prompt_len: usize,
}

pub trait Approver {
    fn id(&self) -> &str;
    /// The predicate bounding what this approver may authorize. Re-checked by the engine after approval.
    fn scope(&self) -> &Predicate;
    fn decide(&self, req: &ApprovalRequest) -> Verdict;
}

/// A naive spend-down budget.
#[derive(Debug)]
pub struct Budget {
    remaining: Cell<u32>,
}

impl Budget {
    pub fn new(n: u32) -> Self {
        Budget {
            remaining: Cell::new(n),
        }
    }
    fn try_spend(&self) -> bool {
        let r = self.remaining.get();
        if r == 0 {
            return false;
        }
        self.remaining.set(r - 1);
        true
    }
}

/// A human approver. In the demo, `auto_approve` stands in for a real prompt.
pub struct HumanApprover {
    id: ApproverId,
    scope: Predicate,
    auto_approve: bool,
}

impl HumanApprover {
    pub fn new(id: impl Into<ApproverId>, scope: Predicate, auto_approve: bool) -> Self {
        HumanApprover {
            id: id.into(),
            scope,
            auto_approve,
        }
    }
}

impl Approver for HumanApprover {
    fn id(&self) -> &str {
        &self.id
    }
    fn scope(&self) -> &Predicate {
        &self.scope
    }
    fn decide(&self, _req: &ApprovalRequest) -> Verdict {
        if self.auto_approve {
            Verdict::Approve
        } else {
            Verdict::Deny {
                reason: "human declined".to_string(),
            }
        }
    }
}

/// An LLM approver with a spend budget and a clean-context requirement.
pub struct LlmApprover {
    id: ApproverId,
    pub pin: String,
    scope: Predicate,
    budget: Budget,
    requires_clean_context: bool,
}

impl LlmApprover {
    pub fn new(
        id: impl Into<ApproverId>,
        pin: impl Into<String>,
        scope: Predicate,
        budget: Budget,
        requires_clean_context: bool,
    ) -> Self {
        LlmApprover {
            id: id.into(),
            pin: pin.into(),
            scope,
            budget,
            requires_clean_context,
        }
    }
}

impl Approver for LlmApprover {
    fn id(&self) -> &str {
        &self.id
    }
    fn scope(&self) -> &Predicate {
        &self.scope
    }
    fn decide(&self, req: &ApprovalRequest) -> Verdict {
        // WHY abstain rather than deny: a tainted context can contain adversarial instructions, so an
        // LLM that requires a clean context must not reason about this call at all — it steps aside and
        // lets a human (or another approver) decide.
        if self.requires_clean_context && req.tainted {
            return Verdict::Abstain;
        }
        if !self.budget.try_spend() {
            return Verdict::Abstain;
        }
        Verdict::Approve
    }
}

/// An external approver that is a pure function of the injected clock: approves only during EU
/// business hours. Demonstrates the `External{on_timeout}` shape without any real network.
pub struct EuBusinessHours {
    id: ApproverId,
    scope: Predicate,
    open_hour: u64,
    close_hour: u64,
    on_timeout: Verdict,
}

impl EuBusinessHours {
    pub fn new(
        id: impl Into<ApproverId>,
        scope: Predicate,
        open_hour: u64,
        close_hour: u64,
        on_timeout: Verdict,
    ) -> Self {
        EuBusinessHours {
            id: id.into(),
            scope,
            open_hour,
            close_hour,
            on_timeout,
        }
    }
}

impl Approver for EuBusinessHours {
    fn id(&self) -> &str {
        &self.id
    }
    fn scope(&self) -> &Predicate {
        &self.scope
    }
    fn decide(&self, req: &ApprovalRequest) -> Verdict {
        let hour = req.clock % 24;
        if hour >= self.open_hour && hour < self.close_hour {
            Verdict::Approve
        } else {
            self.on_timeout.clone()
        }
    }
}

/// A set of approvers addressable by id.
#[derive(Default)]
pub struct ApproverRegistry {
    approvers: BTreeMap<ApproverId, Box<dyn Approver>>,
}

impl ApproverRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register(&mut self, approver: Box<dyn Approver>) {
        self.approvers.insert(approver.id().to_string(), approver);
    }
    pub fn get(&self, id: &str) -> Option<&dyn Approver> {
        self.approvers.get(id).map(|b| b.as_ref())
    }
}

/// The result of running an approval chain.
pub enum ChainOutcome {
    Approved {
        approver: ApproverId,
        scope: Predicate,
    },
    Rejected {
        approver: ApproverId,
        reason: String,
    },
    /// Every approver abstained (or was missing) — no one authorized the call.
    Exhausted,
}

/// Run a chain in order: the first `Approve` or `Deny` decides; abstentions fall through.
pub fn run_chain(
    chain: &[ApproverId],
    registry: &ApproverRegistry,
    req: &ApprovalRequest,
) -> ChainOutcome {
    for id in chain {
        let Some(approver) = registry.get(id) else {
            continue;
        };
        match approver.decide(req) {
            Verdict::Approve => {
                return ChainOutcome::Approved {
                    approver: id.clone(),
                    scope: approver.scope().clone(),
                };
            }
            Verdict::Deny { reason } => {
                return ChainOutcome::Rejected {
                    approver: id.clone(),
                    reason,
                };
            }
            Verdict::Abstain => continue,
        }
    }
    ChainOutcome::Exhausted
}
