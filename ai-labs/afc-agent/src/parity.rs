//! The demo human approver: a deterministic, data-driven stand-in for `human.oncall`.
//!
//! It approves iff the model's driving prompt length is odd (`prompt_len % 2 == 1`). This is
//! whimsy, not policy — it proves the approval chain reacts to real request data (threaded through
//! `ApprovalRequest::prompt_len`) rather than returning a canned yes. It lives in the agent, bound
//! programmatically to the `human.oncall` id the policy chain names, and never touches the policy
//! surface.

use afc_core::approver::{ApprovalRequest, Approver, ApproverId, Verdict};
use afc_core::rule::Predicate;

pub struct ParityApprover {
    id: ApproverId,
    scope: Predicate,
}

impl ParityApprover {
    pub fn new(id: impl Into<ApproverId>, scope: Predicate) -> Self {
        Self {
            id: id.into(),
            scope,
        }
    }
}

impl Approver for ParityApprover {
    fn id(&self) -> &str {
        &self.id
    }

    fn scope(&self) -> &Predicate {
        &self.scope
    }

    fn decide(&self, req: &ApprovalRequest) -> Verdict {
        if req.prompt_len % 2 == 1 {
            Verdict::Approve
        } else {
            Verdict::Deny {
                reason: format!("demo parity rule: prompt length {} is even", req.prompt_len),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(prompt_len: usize) -> ApprovalRequest {
        ApprovalRequest {
            tainted: true,
            clock: 0,
            prompt_len,
        }
    }

    #[test]
    fn odd_prompt_length_approves_even_denies() {
        let a = ParityApprover::new("human.oncall", Predicate::And(vec![]));
        assert!(matches!(a.decide(&req(7)), Verdict::Approve));
        assert!(matches!(a.decide(&req(8)), Verdict::Deny { .. }));
    }
}
