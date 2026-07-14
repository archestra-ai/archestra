//! Drive one requested flow to a settled outcome: evaluate, then walk the
//! engine's first remedy plan step by step until the flow permits, blocks
//! terminally, needs an external ruling, or stalls.
//!
//! This is the common consumer loop, centralized. It encodes exactly one
//! policy — **the first enumerated plan, one step at a time** — so callers
//! wanting a different plan choice (shortest, least-authority) or an
//! auto-approval loop keep driving [`PolicyEngine::mint_step`] /
//! [`PolicyEngine::apply_step`] themselves.
//!
//! Two-phase dispatch is untouched: a permitted pursuit hands back the
//! [`ExecutionToken`], and only [`crate::turn::Trajectory::release`] renders
//! the canonical request and commits effects.

use tracing::debug;

use super::PolicyEngine;
use super::capability::{Blocked, Decision, ExecutionToken, StepOutcome, StepRefused, TerminalBlock};
use crate::approval::PendingApproval;
use crate::audit::TransitionFailure;
use crate::contract::Violation;
use crate::request::ToolRequest;
use crate::turn::Trajectory;

/// How a pursuit settled. A stalled pursuit leaves no pending action behind;
/// a `NeedsApproval` pursuit deliberately keeps the slot — the held
/// [`PendingApproval`] re-enters through [`PolicyEngine::apply_approval`],
/// which requires that same action.
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a dropped Pursuit loses the execution token or the pending approval"]
pub enum Pursuit {
    /// The flow is authorized; release the token to dispatch.
    Permitted(ExecutionToken),
    /// Nothing can clear the flow. The engine cleared this request's pending
    /// slot — except `ActionAlreadyPending`, which refuses while another
    /// action (or this one's released dispatch) is still in flight, precisely
    /// without touching it.
    Terminal(TerminalBlock),
    /// A step routed to an external authority; the pending action is kept so
    /// the ruling can re-enter.
    NeedsApproval(PendingApproval),
    /// The walk could not settle the flow; the pending action was abandoned
    /// so the trajectory is free for the next proposal.
    Stalled {
        /// The violations of the round that stalled.
        violations: Vec<Violation>,
        cause: StallCause,
    },
}

/// Why a pursuit stalled.
#[derive(Debug, PartialEq, Eq)]
pub enum StallCause {
    /// `max_steps` remedy steps were applied without settling.
    BoundExhausted,
    /// A step could not be minted or applied against the current state.
    Refused(StepRefused),
    /// A step's transition failed (audited; no state changed beyond the record).
    Failed(TransitionFailure),
}

impl PolicyEngine {
    /// Evaluate `request` and walk the first remedy plan until the flow
    /// permits, blocks terminally, defers to an external authority, or
    /// stalls — applying at most `max_steps` steps. The bound is checked
    /// before each step, never after: a permit produced by the final
    /// allowed step is still returned.
    pub fn pursue(&self, trajectory: &mut Trajectory, request: ToolRequest, max_steps: usize) -> Pursuit {
        let mut decision = self.evaluate(trajectory, request);
        let mut steps = 0;
        loop {
            let (violations, plans) = match decision {
                Decision::Permitted(token) => return Pursuit::Permitted(token),
                Decision::Blocked(Blocked::Terminal(block)) => return Pursuit::Terminal(block),
                Decision::Blocked(Blocked::Remediable { violations, plans }) => (violations, plans),
            };
            if steps >= max_steps {
                debug!(steps, "pursuit stalled: step bound exhausted");
                trajectory.abandon_pending();
                return Pursuit::Stalled {
                    violations,
                    cause: StallCause::BoundExhausted,
                };
            }
            steps += 1;
            let plan = plans.first().id;
            let capability = match self.mint_step(trajectory, plan, 0) {
                Ok(capability) => capability,
                Err(refused) => {
                    debug!(%plan, "pursuit stalled: step refused at mint");
                    trajectory.abandon_pending();
                    return Pursuit::Stalled {
                        violations,
                        cause: StallCause::Refused(refused),
                    };
                }
            };
            match self.apply_step(trajectory, capability) {
                Ok(StepOutcome::Advanced(next)) => decision = next,
                Ok(StepOutcome::NeedsApproval(pending)) => return Pursuit::NeedsApproval(pending),
                Ok(StepOutcome::Failed(failure)) => {
                    debug!(%plan, "pursuit stalled: transition failed");
                    trajectory.abandon_pending();
                    return Pursuit::Stalled {
                        violations,
                        cause: StallCause::Failed(failure),
                    };
                }
                Err(refused) => {
                    debug!(%plan, "pursuit stalled: step refused at apply");
                    trajectory.abandon_pending();
                    return Pursuit::Stalled {
                        violations,
                        cause: StallCause::Refused(refused),
                    };
                }
            }
        }
    }
}
