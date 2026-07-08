//! Turns, labeled turns, and the trajectory that only accepts the latter.

use crate::ToolName;
use crate::dimension::UserId;
use crate::engine::Permit;
use crate::label::Label;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    User(UserId),
    Assistant,
    Tool(ToolName),
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
/// [`Turn`], and tool results additionally require a [`Permit`], so a result
/// can never enter the trajectory wearing a label the policy did not produce.
#[derive(Debug, Default)]
pub struct Trajectory {
    turns: Vec<LabeledTurn>,
}

impl Trajectory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, turn: LabeledTurn) {
        self.turns.push(turn);
    }

    /// Append a tool result under the label the engine granted for it.
    pub fn record_result(&mut self, permit: Permit, content: impl Into<String>) {
        let (tool, label) = permit.into_parts();
        self.push(LabeledTurn {
            label,
            turn: Turn {
                actor: Actor::Tool(tool),
                content: content.into(),
            },
        });
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
        trajectory.push(LabeledTurn {
            label: Label {
                audience: Audience::readers([UserId::new("alice"), UserId::new("bob")]),
                trust: Trust::Trusted,
                ..Label::identity()
            },
            turn: Turn {
                actor: Actor::User(UserId::new("alice")),
                content: "summarize the doc".to_owned(),
            },
        });
        trajectory.push(LabeledTurn {
            label: Label {
                audience: Audience::Public,
                trust: Trust::Suspicious,
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
            turn: Turn {
                actor: Actor::Tool(ToolName::new("web.fetch")),
                content: "<html>...</html>".to_owned(),
            },
        });

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
