//! Registered transitions: the typed vocabulary of remedies.
//!
//! Registration is an operator trust decision, not content correctness (see
//! design note §5). The engine can enforce that the selected transformer was
//! registered, that source identity and label match its declared
//! precondition, that the result wears the declared output label, and that
//! undeclared state was not changed. It cannot enforce that PII was actually
//! removed or that an LLM ignored an injection — implementation robustness
//! belongs to the harness.
//!
//! Everything here is *pure declaration and validation*: nothing in this
//! module changes trajectory state. Application — minting a linear step
//! capability, running the transformer, admitting the derived value —
//! belongs to the engine's plan machinery.

use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::ToolName;
use crate::audit::{AdjudicatorName, TransitionFailure, WaiverKind};
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
use crate::request::PendingAction;
use crate::value::{OpaqueValue, StoredValue, TransformerRef, ValueLabel};

/// A registered transformer's input predicate: which source values it
/// declares itself applicable to. `None` on a dimension means "any".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LabelPredicate {
    pub trust: Option<Trust>,
    pub audience: Option<Audience>,
}

impl LabelPredicate {
    pub fn any() -> Self {
        Self::default()
    }

    pub fn matches(&self, label: &ValueLabel) -> bool {
        let trust_ok = match &self.trust {
            None => true,
            Some(required) => label.trust == *required,
        };
        let audience_ok = match &self.audience {
            None => true,
            Some(required) => label.audience == *required,
        };
        trust_ok && audience_ok
    }
}

/// The serializable declaration of a value transformer: identity, input
/// predicate, and the exact output label its derivations wear. The runtime
/// callable lives separately in the registry ([`RegisteredTransformer`]) —
/// plan and audit data never embed code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TransformerDescriptor {
    pub transformer: TransformerRef,
    pub precondition: LabelPredicate,
    pub output: ValueLabel,
}

/// A transformer implementation reported an error. The transition fails and
/// is audited; no derived value is created.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TransformerError {
    pub message: String,
}

/// The trusted in-process implementation of a registered transformer. A
/// plain function pointer: no captures, no `Box<dyn>`, trivially `Copy` —
/// the registry stays inspectable and the descriptor stays serializable.
pub type TransformerFn = fn(&OpaqueValue) -> Result<OpaqueValue, TransformerError>;

/// One transformer registry entry: the declaration plus its callable.
#[derive(Debug, Clone)]
pub struct RegisteredTransformer {
    pub descriptor: TransformerDescriptor,
    pub run: TransformerFn,
}

impl RegisteredTransformer {
    /// Pure precondition check against a concrete source value. Identity was
    /// already fixed by the caller holding the `ValueId`; this validates the
    /// declared label predicate.
    pub fn accepts(&self, source: &StoredValue) -> Result<(), TransitionFailure> {
        if self.descriptor.precondition.matches(source.label()) {
            Ok(())
        } else {
            Err(TransitionFailure::PreconditionMismatch)
        }
    }
}

/// A registered action transition: an explicit tool-identity mapping with
/// declared replacement effects (e.g. network fetch → cache-only fetch).
/// Arguments and control dependencies are never touched — unchanged
/// arguments retain their identities by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionTransition {
    pub id: TransformerRef,
    pub from_tool: ToolName,
    pub to_tool: ToolName,
    /// The constrained action's proposed effects. Verified narrower, never
    /// inferred: see [`ActionTransition::narrows`].
    pub effects: Effects,
}

impl ActionTransition {
    /// Structural capability relation: the transition applies only to a
    /// pending action of its declared source tool, and its replacement
    /// effects must be *verifiably* no broader — a declared set may narrow a
    /// declared superset or replace `Unknown` (constraining an unbounded
    /// action is the point of sandboxing), but nothing may widen to
    /// `Unknown` or add effects.
    pub fn narrows(&self, pending: &PendingAction) -> Result<(), TransitionFailure> {
        if pending.current().tool != self.from_tool {
            return Err(TransitionFailure::PreconditionMismatch);
        }
        if effects_narrow(pending.proposed_effects(), &self.effects) {
            Ok(())
        } else {
            Err(TransitionFailure::PreconditionMismatch)
        }
    }
}

/// Is `new` verifiably no broader than `old`?
fn effects_narrow(old: &Effects, new: &Effects) -> bool {
    match (old.declared_set(), new.declared_set()) {
        // Constraining an unknown-effect action to anything declared is the
        // sandbox case.
        (None, Some(_)) => true,
        (Some(old_set), Some(new_set)) => new_set.is_subset(&old_set),
        // Never widen to Unknown.
        (_, None) => false,
    }
}

/// An adjudicator-granted loosening of one flow's checks. Typed per
/// dimension; each populated dimension is one [`WaiverKind`] in the audit
/// record. Proposal data, not a capability — authority comes from the
/// engine's competence routing plus the fail-closed recheck.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WaiverDelta {
    /// Attest that flow trust is at least this.
    pub trust: Option<KnownTrust>,
    /// Vouch exactly these readers into the flow audience.
    pub audience: Option<BTreeSet<UserId>>,
    /// Treat these already-present effects as waived for this check.
    pub effects: Option<BTreeSet<Effect>>,
    /// Stand in for a user confirmation.
    pub confirms: bool,
    /// Exclude the control dependencies from the flow label for this check —
    /// the explicit, audited release of a control-dependence taint.
    pub control_release: bool,
}

impl WaiverDelta {
    /// The identity waiver: loosens nothing. Covered by every mandate, so an
    /// acknowledgment-only waiver is competently handled by any adjudicator.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Does this delta, read as a *mandate*, cover `need`? A partial order:
    /// trust by the [`KnownTrust`] order, audience/effects by set inclusion,
    /// booleans by implication. An absent need asks nothing of that
    /// dimension.
    #[must_use]
    pub fn covers(&self, need: &Self) -> bool {
        let trust_ok = match need.trust {
            None => true,
            Some(n) => matches!(self.trust, Some(m) if m >= n),
        };
        let audience_ok = match &need.audience {
            None => true,
            Some(n) => matches!(&self.audience, Some(m) if n.is_subset(m)),
        };
        let effects_ok = match &need.effects {
            None => true,
            Some(n) => matches!(&self.effects, Some(m) if n.is_subset(m)),
        };
        let confirms_ok = !need.confirms || self.confirms;
        let control_ok = !need.control_release || self.control_release;
        trust_ok && audience_ok && effects_ok && confirms_ok && control_ok
    }

    /// The audit kinds of every populated dimension; empty delta →
    /// `Acknowledgment`.
    pub fn kinds(&self) -> BTreeSet<WaiverKind> {
        let mut kinds = BTreeSet::new();
        if self.trust.is_some() {
            kinds.insert(WaiverKind::Trust);
        }
        if self.audience.is_some() {
            kinds.insert(WaiverKind::Audience);
        }
        if self.effects.is_some() {
            kinds.insert(WaiverKind::Effects);
        }
        if self.confirms {
            kinds.insert(WaiverKind::Confirmation);
        }
        if self.control_release {
            kinds.insert(WaiverKind::ControlRelease);
        }
        if kinds.is_empty() {
            kinds.insert(WaiverKind::Acknowledgment);
        }
        kinds
    }
}

impl fmt::Display for WaiverDelta {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, kind) in self.kinds().into_iter().enumerate() {
            if i > 0 {
                write!(f, "+")?;
            }
            write!(f, "{kind}")?;
        }
        Ok(())
    }
}

/// Registration was refused: an entry with that identity already exists.
/// Registries are the policy boundary; a silent replace could weaken policy
/// unnoticed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("`{id}` is already registered")]
pub struct DuplicateRegistration {
    pub id: String,
}

/// The external adjudicator registry entry: metadata only. `evaluate` may
/// plan an `ApplyWaiver` step for one, but never invokes the human, webhook,
/// or judge model itself — adjudication re-enters through
/// [`crate::engine::PolicyEngine::apply_approval`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Adjudicator {
    pub name: AdjudicatorName,
    /// The largest delta this adjudicator is competent to grant.
    pub mandate: WaiverDelta,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::request::{ArgumentTree, ToolRequest};
    use crate::revision::ActionId;
    use crate::revision::ValueId;

    fn pending(tool: &str, effects: Effects) -> PendingAction {
        PendingAction::proposed(
            ActionId::new(0),
            ToolRequest::new(
                ToolName::new(tool),
                ArgumentTree::Object(BTreeMap::new()),
                std::collections::BTreeSet::from([ValueId::new(0)]),
            ),
            effects,
        )
    }

    #[test]
    fn narrowing_accepts_subset_and_unknown_confinement() {
        let sandbox = ActionTransition {
            id: TransformerRef {
                id: "sandbox".into(),
                version: 1,
            },
            from_tool: ToolName::new("shell.run"),
            to_tool: ToolName::new("shell.run.sandboxed"),
            effects: Effects::declared([Effect::Mutation]),
        };

        // Declared superset narrows to a subset.
        assert_eq!(
            sandbox.narrows(&pending(
                "shell.run",
                Effects::declared([Effect::Mutation, Effect::Egress])
            )),
            Ok(())
        );
        // Confining an unknown-effect action is the sandbox case.
        assert_eq!(sandbox.narrows(&pending("shell.run", Effects::UNKNOWN)), Ok(()));
    }

    #[test]
    fn narrowing_rejects_widening_and_wrong_tool() {
        let widen = ActionTransition {
            id: TransformerRef {
                id: "widen".into(),
                version: 1,
            },
            from_tool: ToolName::new("shell.run"),
            to_tool: ToolName::new("shell.run"),
            effects: Effects::declared([Effect::Mutation, Effect::Egress]),
        };
        assert_eq!(
            widen.narrows(&pending("shell.run", Effects::declared([Effect::Mutation]))),
            Err(TransitionFailure::PreconditionMismatch)
        );

        let to_unknown = ActionTransition {
            id: TransformerRef {
                id: "to-unknown".into(),
                version: 1,
            },
            from_tool: ToolName::new("shell.run"),
            to_tool: ToolName::new("shell.run"),
            effects: Effects::UNKNOWN,
        };
        assert_eq!(
            to_unknown.narrows(&pending("shell.run", Effects::declared([Effect::Mutation]))),
            Err(TransitionFailure::PreconditionMismatch)
        );

        let wrong_tool = ActionTransition {
            id: TransformerRef {
                id: "wrong".into(),
                version: 1,
            },
            from_tool: ToolName::new("web.fetch"),
            to_tool: ToolName::new("web.fetch.cached"),
            effects: Effects::none(),
        };
        assert_eq!(
            wrong_tool.narrows(&pending("shell.run", Effects::UNKNOWN)),
            Err(TransitionFailure::PreconditionMismatch)
        );
    }

    #[test]
    fn predicate_gates_transformer_applicability() {
        let redact = LabelPredicate {
            trust: Some(Trust::SUSPICIOUS),
            audience: None,
        };
        assert!(redact.matches(&ValueLabel {
            audience: Audience::PUBLIC,
            trust: Trust::SUSPICIOUS,
        }));
        assert!(!redact.matches(&ValueLabel::identity()));
        assert!(LabelPredicate::any().matches(&ValueLabel::unknown()));
    }

    #[test]
    fn waiver_mandate_coverage_is_a_partial_order() {
        let broad = WaiverDelta {
            trust: Some(KnownTrust::Trusted),
            audience: Some(std::collections::BTreeSet::from([
                UserId::new("bob"),
                UserId::new("charlie"),
            ])),
            effects: None,
            confirms: true,
            control_release: true,
        };
        let narrow = WaiverDelta {
            audience: Some(std::collections::BTreeSet::from([UserId::new("bob")])),
            control_release: true,
            ..WaiverDelta::empty()
        };
        assert!(broad.covers(&narrow));
        assert!(!narrow.covers(&broad));
        // The empty delta is covered by everything.
        assert!(narrow.covers(&WaiverDelta::empty()));
    }

    #[test]
    fn empty_delta_audits_as_acknowledgment() {
        assert_eq!(
            WaiverDelta::empty().kinds(),
            std::collections::BTreeSet::from([WaiverKind::Acknowledgment])
        );
        let control = WaiverDelta {
            control_release: true,
            ..WaiverDelta::empty()
        };
        assert_eq!(
            control.kinds(),
            std::collections::BTreeSet::from([WaiverKind::ControlRelease])
        );
    }
}
