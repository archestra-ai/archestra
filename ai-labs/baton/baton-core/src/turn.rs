//! Turns, labeled turns, and the trajectory that only accepts the latter.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tracing::debug;

use crate::ToolName;
use crate::dimension::UserId;
use crate::engine::{Permit, RejectedPermit};
use crate::label::Label;

/// A user's contribution to a turn: who spoke, and whether they explicitly
/// confirmed one named tool. The `confirms` field is structural, not a label:
/// only user turns carry it, so "only the user confirms" holds by construction
/// rather than by a runtime check — an assistant or tool actor has no such
/// field to forge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserTurn {
    pub id: UserId,
    pub confirms: Option<ToolName>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User(UserTurn),
    Assistant,
    Tool(ToolName),
}

/// Who may author a message turn. Tool results are deliberately absent:
/// they enter a trajectory only through [`Trajectory::record_result`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Speaker {
    User(UserTurn),
    Assistant,
}

impl Speaker {
    pub fn user(id: UserId) -> Self {
        Self::User(UserTurn { id, confirms: None })
    }

    /// A user message that explicitly confirms one named tool. The
    /// confirmation is valid only while this is the newest turn — see
    /// [`Trajectory::pending_confirmation`].
    pub fn confirming(id: UserId, tool: ToolName) -> Self {
        Self::User(UserTurn {
            id,
            confirms: Some(tool),
        })
    }
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
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

    /// Append a user or assistant message under its label. Labels are
    /// trusted input from the embedding harness.
    pub fn push_message(&mut self, label: Label, speaker: Speaker, content: impl Into<String>) {
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
    }

    /// Append a tool result under the label the engine granted for it. The
    /// permit is consumed either way; if it was minted for another trajectory
    /// or the trajectory moved past the head it was minted for, the result is
    /// rejected and the flow must be re-evaluated against the real context.
    pub fn record_result(&mut self, permit: Permit, content: impl Into<String>) -> Result<(), RejectedPermit> {
        let (request, label, trajectory, basis) = permit.into_parts();
        if trajectory != self.id {
            debug!(minted_for = %trajectory, this = %self.id, "record_result: rejected (foreign trajectory)");
            return Err(RejectedPermit::ForeignTrajectory {
                minted_for: trajectory,
                this: self.id,
            });
        }
        if basis != self.turns.len() {
            debug!(
                granted_at = basis,
                current_len = self.turns.len(),
                "record_result: rejected (stale permit)"
            );
            return Err(RejectedPermit::Stale {
                granted_at: basis,
                current_len: self.turns.len(),
            });
        }
        debug!(tool = %request.tool, basis, "record_result: recorded tool result");
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

    /// The user confirmation currently in force, if any: the newest turn's,
    /// and only if that turn is a user turn. "A confirmation authorizes the
    /// immediately following action, never a later one" is structural — any
    /// appended turn ends it.
    pub fn pending_confirmation(&self) -> Option<&ToolName> {
        match self.turns.last() {
            Some(LabeledTurn {
                turn:
                    Turn {
                        actor:
                            Actor::User(UserTurn {
                                confirms: Some(tool), ..
                            }),
                        ..
                    },
                ..
            }) => Some(tool),
            _ => None,
        }
    }

    /// The folded label of everything currently in context.
    pub fn context_label(&self) -> Label {
        Label::fold(self.turns.iter().map(|t| t.label.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dimension::{Audience, Effect, Effects, Trust};

    #[test]
    fn context_label_folds_all_turns() {
        let mut trajectory = Trajectory::new();
        trajectory.push_message(
            Label {
                audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
                trust: Trust::TRUSTED,
                ..Label::identity()
            },
            Speaker::user(UserId::new("alice")),
            "summarize the doc",
        );
        trajectory.push_message(
            Label {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
            Speaker::Assistant,
            "pasting what the page says: ...",
        );

        let context = trajectory.context_label();
        assert_eq!(
            context.audience,
            Audience::readers([UserId::new("alice"), UserId::new("bob")])
        );
        assert_eq!(context.trust, Trust::SUSPICIOUS);
        assert_eq!(context.effects, Effects::declared([Effect::Egress]));
    }

    #[test]
    fn empty_trajectory_context_is_identity() {
        assert_eq!(Trajectory::new().context_label(), Label::identity());
    }

    #[test]
    fn a_confirmation_lasts_exactly_one_turn() {
        let mut trajectory = Trajectory::new();
        assert_eq!(trajectory.pending_confirmation(), None);

        trajectory.push_message(
            Label::identity(),
            Speaker::confirming(UserId::new("alice"), ToolName::new("db.drop")),
            "yes, drop it",
        );
        assert_eq!(trajectory.pending_confirmation(), Some(&ToolName::new("db.drop")));

        trajectory.push_message(
            Label::identity(),
            Speaker::user(UserId::new("alice")),
            "unrelated chatter",
        );
        assert_eq!(trajectory.pending_confirmation(), None);
    }
}
