//! Turns, labeled turns, and the trajectory that only accepts the latter.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::ToolName;
use crate::dimension::{Attention, UserId};
use crate::engine::{Permit, RejectedPermit};
use crate::label::Label;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User(UserId),
    Assistant,
    Tool(ToolName),
}

/// Who may author a message turn. Tool results are deliberately absent:
/// they enter a trajectory only through [`Trajectory::record_result`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Speaker {
    User(UserId),
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub actor: Actor,
    pub content: String,
}

/// Turns never walk alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabeledTurn {
    pub label: Label,
    pub turn: Turn,
}

/// Identity of one trajectory instance, unique within the process; permits
/// are bound to it so an authorization cannot cross trajectories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrajectoryId(u64);

impl TrajectoryId {
    fn next() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

impl fmt::Display for TrajectoryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "trajectory#{}", self.0)
    }
}

/// A message turn the trajectory refuses to hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidTurn {
    /// Only the user can confirm a tool ([`Attention::High`]); an assistant
    /// turn carrying one would let model output arm a confirmation gate.
    ConfirmationFromAssistant { tool: ToolName },
}

impl fmt::Display for InvalidTurn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConfirmationFromAssistant { tool } => write!(
                f,
                "assistant turn carries a confirmation for `{tool}`; only the user can confirm"
            ),
        }
    }
}

impl std::error::Error for InvalidTurn {}

/// An append-only sequence of labeled turns. There is no way to append a bare
/// [`Turn`], and a tool-result turn requires consuming a [`Permit`] minted for
/// this trajectory's current head, so a result cannot enter wearing a label
/// the policy did not produce, be recorded twice, or be recorded into a
/// context the policy never evaluated.
#[derive(Debug)]
pub struct Trajectory {
    id: TrajectoryId,
    turns: Vec<LabeledTurn>,
}

impl Default for Trajectory {
    fn default() -> Self {
        Self::new()
    }
}

impl Trajectory {
    pub fn new() -> Self {
        Self {
            id: TrajectoryId::next(),
            turns: Vec::new(),
        }
    }

    pub fn id(&self) -> TrajectoryId {
        self.id
    }

    /// Append a user or assistant message under its label.
    ///
    /// Labels are trusted input from the embedding harness, with one vetted
    /// exception: a confirmation (`Attention::High`) belongs on user turns
    /// only, so it is rejected here on assistant turns, as it is in tool
    /// contracts by [`crate::engine::PolicyEngine::register`]. A `High` in a
    /// folded context therefore always originates from a user turn.
    pub fn push_message(
        &mut self,
        label: Label,
        speaker: Speaker,
        content: impl Into<String>,
    ) -> Result<(), InvalidTurn> {
        if let (Speaker::Assistant, Attention::High(tool)) = (&speaker, &label.attention) {
            return Err(InvalidTurn::ConfirmationFromAssistant { tool: tool.clone() });
        }
        let actor = match speaker {
            Speaker::User(user) => Actor::User(user),
            Speaker::Assistant => Actor::Assistant,
        };
        self.turns.push(LabeledTurn {
            label,
            turn: Turn {
                actor,
                content: content.into(),
            },
        });
        Ok(())
    }

    /// Append a tool result under the label the engine granted for it. The
    /// permit is consumed either way; if it was minted for another trajectory
    /// or the trajectory moved past the head it was minted for, the result is
    /// rejected and the flow must be re-evaluated against the real context.
    pub fn record_result(
        &mut self,
        permit: Permit,
        content: impl Into<String>,
    ) -> Result<(), RejectedPermit> {
        let (request, label, trajectory, basis) = permit.into_parts();
        if trajectory != self.id {
            return Err(RejectedPermit::ForeignTrajectory {
                minted_for: trajectory,
                this: self.id,
            });
        }
        if basis != self.turns.len() {
            return Err(RejectedPermit::Stale {
                granted_at: basis,
                current_len: self.turns.len(),
            });
        }
        self.turns.push(LabeledTurn {
            label,
            turn: Turn {
                actor: Actor::Tool(request.tool),
                content: content.into(),
            },
        });
        Ok(())
    }

    pub fn turns(&self) -> &[LabeledTurn] {
        &self.turns
    }

    /// The folded label of everything currently in context.
    pub fn context_label(&self) -> Label {
        Label::fold(self.turns.iter().map(|t| t.label.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Attention, Audience, Effect, Effects, Trust};

    #[test]
    fn context_label_folds_all_turns() {
        let mut trajectory = Trajectory::new();
        trajectory
            .push_message(
                Label {
                    audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
                    trust: Trust::Trusted,
                    ..Label::identity()
                },
                Speaker::User(UserId::new("alice")),
                "summarize the doc",
            )
            .expect("valid turn");
        trajectory
            .push_message(
                Label {
                    audience: Audience::Public,
                    trust: Trust::Suspicious,
                    effects: Effects::declared([Effect::Egress]),
                    ..Label::identity()
                },
                Speaker::Assistant,
                "pasting what the page says: ...",
            )
            .expect("valid turn");

        let context = trajectory.context_label();
        assert_eq!(
            context.audience,
            Audience::readers([UserId::new("alice"), UserId::new("bob")])
        );
        assert_eq!(context.trust, Trust::Suspicious);
        assert_eq!(context.effects, Effects::declared([Effect::Egress]));
        assert_eq!(context.attention, Attention::Regular);
    }

    #[test]
    fn empty_trajectory_context_is_identity() {
        assert_eq!(Trajectory::new().context_label(), Label::identity());
    }

    #[test]
    fn assistant_turns_cannot_carry_confirmations() {
        let mut trajectory = Trajectory::new();
        let confirmation = Label {
            attention: Attention::High(ToolName::new("db.drop")),
            ..Label::identity()
        };

        let err = trajectory
            .push_message(confirmation.clone(), Speaker::Assistant, "sure, dropping!")
            .expect_err("model output must not arm a confirmation gate");
        assert_eq!(
            err,
            InvalidTurn::ConfirmationFromAssistant {
                tool: ToolName::new("db.drop"),
            }
        );
        assert!(trajectory.turns().is_empty());

        trajectory
            .push_message(
                confirmation,
                Speaker::User(UserId::new("alice")),
                "yes, drop it",
            )
            .expect("the user may confirm");
        assert_eq!(trajectory.turns().len(), 1);
    }
}
