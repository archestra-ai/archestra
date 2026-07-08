//! Turns, labeled turns, and the trajectory that only accepts the latter.

use crate::ToolName;
use crate::dimension::UserId;
use crate::engine::{Permit, StalePermit};
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

/// An append-only sequence of labeled turns. There is no way to append a bare
/// [`Turn`], and a tool-result turn requires consuming a [`Permit`] minted for
/// the trajectory's current head, so a result cannot enter wearing a label
/// the policy did not produce, be recorded twice, or be recorded into a
/// context the policy never evaluated.
#[derive(Debug, Default)]
pub struct Trajectory {
    turns: Vec<LabeledTurn>,
}

impl Trajectory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a user or assistant message under its label.
    ///
    /// Labels are trusted input from the embedding harness. In particular, a
    /// confirmation (`Attention::High`) belongs on user turns only: the
    /// engine rejects it in tool contracts, and the harness must not stamp
    /// it on assistant turns — an assistant is not the user.
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
    /// permit is consumed either way; if the trajectory moved past the head
    /// the permit was minted for, the result is rejected and the flow must be
    /// re-evaluated against the new context.
    pub fn record_result(
        &mut self,
        permit: Permit,
        content: impl Into<String>,
    ) -> Result<(), StalePermit> {
        let (tool, label, basis) = permit.into_parts();
        if basis != self.turns.len() {
            return Err(StalePermit {
                granted_at: basis,
                current_len: self.turns.len(),
            });
        }
        self.turns.push(LabeledTurn {
            label,
            turn: Turn {
                actor: Actor::Tool(tool),
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
        trajectory.push_message(
            Label {
                audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
                trust: Trust::Trusted,
                ..Label::identity()
            },
            Speaker::User(UserId::new("alice")),
            "summarize the doc",
        );
        trajectory.push_message(
            Label {
                audience: Audience::Public,
                trust: Trust::Suspicious,
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
        assert_eq!(context.trust, Trust::Suspicious);
        assert_eq!(context.effects, Effects::declared([Effect::Egress]));
        assert_eq!(context.attention, Attention::Regular);
    }

    #[test]
    fn empty_trajectory_context_is_identity() {
        assert_eq!(Trajectory::new().context_label(), Label::identity());
    }
}
