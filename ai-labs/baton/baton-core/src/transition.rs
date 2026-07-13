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
use crate::audit::{TransitionFailure, WaiverKind};
use crate::contract::Unprovable;
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
use crate::request::PendingAction;
use crate::revision::ValueId;
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

/// A registered authority's competence: the largest elevation it may grant,
/// trajectory-independent. Endorse dimensions are *bounded* (a [`KnownTrust`]
/// ceiling, an audience it may vouch); every other elevation is a boolean
/// capability. A mandate never names trajectory-local ids — an engine-global
/// registration cannot speak of one conversation's values or effects.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AuthorityMandate {
    /// Endorse flow trust up to (at most) this level.
    pub trust: Option<KnownTrust>,
    /// Vouch (at most) these readers into a flow audience.
    pub audience: Option<BTreeSet<UserId>>,
    /// Competent to waive an already-committed prior effect for one check.
    pub waive_prior_effects: bool,
    /// Competent to stand in for a user confirmation.
    pub confirms: bool,
    /// Competent to acknowledge unprovable facts.
    pub acknowledge_unknown: bool,
    /// Competent to release a control dependency for one flow.
    pub may_release_control: bool,
}

impl AuthorityMandate {
    /// The identity mandate: competent for nothing but the empty ask.
    pub fn none() -> Self {
        Self::default()
    }

    /// Is this mandate competent for `grant`? Endorse dimensions compare by
    /// their order (trust by [`KnownTrust`], audience by set inclusion); every
    /// other elevation by boolean implication. An elevation the grant does not
    /// ask for is not required of the mandate.
    #[must_use]
    pub fn covers(&self, grant: &ProposedGrant) -> bool {
        match grant {
            ProposedGrant::Waive { waiver, acknowledged } => {
                let trust_ok = match waiver.trust {
                    None => true,
                    Some(need) => matches!(self.trust, Some(ceiling) if ceiling >= need),
                };
                let audience_ok = match &waiver.audience {
                    None => true,
                    Some(need) => matches!(&self.audience, Some(vouchable) if need.is_subset(vouchable)),
                };
                let effects_ok = waiver.prior_effects.is_none() || self.waive_prior_effects;
                let confirms_ok = !waiver.confirms || self.confirms;
                let control_ok = waiver.control_release.is_empty() || self.may_release_control;
                // A lift that also clears acknowledge-only facts needs the
                // explicit acknowledge capability — the lift dims alone must
                // not let an authority acknowledge an unknown it cannot vouch.
                let acknowledge_ok = acknowledged.is_empty() || self.acknowledge_unknown;
                trust_ok && audience_ok && effects_ok && confirms_ok && control_ok && acknowledge_ok
            }
            ProposedGrant::Acknowledge { .. } => self.acknowledge_unknown,
        }
    }
}

/// A check-transient loosening applied to one flow: it lifts exactly its
/// populated dimensions for a single sink check and changes no stored state.
/// Proposal data, not a capability — authority comes from routing to a
/// competent mandate plus the fail-closed recheck.
///
/// Trust and audience live here *for now*: today's endorsement is a transient
/// whole-flow lift. A later pass relocates them to a durable relabel; the
/// remaining dimensions (prior effects, confirmation, control release) are
/// transient by nature.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TransientWaiver {
    /// Attest that flow trust is at least this.
    pub trust: Option<KnownTrust>,
    /// Vouch exactly these readers into the flow audience.
    pub audience: Option<BTreeSet<UserId>>,
    /// Treat these already-present effects as waived for this check.
    pub prior_effects: Option<BTreeSet<Effect>>,
    /// Stand in for a user confirmation.
    pub confirms: bool,
    /// Exclude exactly these control dependencies from the flow label for this
    /// check — the explicit, audited, least-privilege release of a
    /// control-dependence taint. Empty releases nothing; releasing one dep never
    /// releases another.
    pub control_release: BTreeSet<ValueId>,
}

impl TransientWaiver {
    /// The identity waiver: loosens nothing. Its lift dimensions are covered by
    /// every mandate; acknowledging any facts it clears still requires the
    /// authority's explicit `acknowledge_unknown` competence.
    pub fn empty() -> Self {
        Self::default()
    }

    /// The audit kinds of every populated dimension; empty waiver →
    /// `Acknowledgment`.
    pub fn kinds(&self) -> BTreeSet<WaiverKind> {
        let mut kinds = BTreeSet::new();
        if self.trust.is_some() {
            kinds.insert(WaiverKind::Trust);
        }
        if self.audience.is_some() {
            kinds.insert(WaiverKind::Audience);
        }
        if self.prior_effects.is_some() {
            kinds.insert(WaiverKind::Effects);
        }
        if self.confirms {
            kinds.insert(WaiverKind::Confirmation);
        }
        if !self.control_release.is_empty() {
            kinds.insert(WaiverKind::ControlRelease);
        }
        if kinds.is_empty() {
            kinds.insert(WaiverKind::Acknowledgment);
        }
        kinds
    }
}

impl fmt::Display for TransientWaiver {
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

/// The typed elevation an authority rules on — it carries *what* is being
/// asked, so a mandate can judge competence and a ruling function can inspect
/// the operation. Endorse (durable relabel) and Accept (effect acquisition)
/// join later passes; today an authority rules on a transient waiver or an
/// acknowledgment of unprovable facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ProposedGrant {
    /// Grant a check-transient loosening, plus any acknowledge-only facts the
    /// lift also clears on the recheck. Those facts need `acknowledge_unknown`
    /// competence: a lift dimension must not launder an unknown the authority
    /// cannot vouch for.
    Waive {
        waiver: TransientWaiver,
        acknowledged: Vec<Unprovable>,
    },
    /// Acknowledge unprovable facts. Routes on the explicit
    /// `acknowledge_unknown` capability, not on covering an empty ask.
    Acknowledge { facts: Vec<Unprovable> },
}

/// Registration was refused: an entry with that identity already exists.
/// Registries are the policy boundary; a silent replace could weaken policy
/// unnoticed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("`{id}` is already registered")]
pub struct DuplicateRegistration {
    pub id: String,
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
    fn mandate_coverage_bounds_endorse_dims_and_gates_capabilities() {
        let broad = AuthorityMandate {
            trust: Some(KnownTrust::Trusted),
            audience: Some(std::collections::BTreeSet::from([
                UserId::new("bob"),
                UserId::new("charlie"),
            ])),
            confirms: true,
            may_release_control: true,
            ..AuthorityMandate::none()
        };
        let narrow = AuthorityMandate {
            audience: Some(std::collections::BTreeSet::from([UserId::new("bob")])),
            may_release_control: true,
            ..AuthorityMandate::none()
        };
        let waive = |waiver| ProposedGrant::Waive {
            waiver,
            acknowledged: Vec::new(),
        };
        let big_ask = waive(TransientWaiver {
            trust: Some(KnownTrust::Trusted),
            audience: Some(std::collections::BTreeSet::from([
                UserId::new("bob"),
                UserId::new("charlie"),
            ])),
            confirms: true,
            control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
            ..TransientWaiver::empty()
        });
        let small_ask = waive(TransientWaiver {
            audience: Some(std::collections::BTreeSet::from([UserId::new("bob")])),
            control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
            ..TransientWaiver::empty()
        });
        assert!(broad.covers(&big_ask));
        // The narrow mandate cannot vouch charlie, raise trust, or confirm.
        assert!(!narrow.covers(&big_ask));
        assert!(broad.covers(&small_ask));
        assert!(narrow.covers(&small_ask));
        // Every mandate covers the empty waive's lift dimensions.
        assert!(narrow.covers(&waive(TransientWaiver::empty())));
        assert!(AuthorityMandate::none().covers(&waive(TransientWaiver::empty())));
        // Acknowledging unprovable facts routes on the explicit capability.
        let ack = ProposedGrant::Acknowledge { facts: Vec::new() };
        assert!(!broad.covers(&ack));
        let acknowledger = AuthorityMandate {
            acknowledge_unknown: true,
            ..AuthorityMandate::none()
        };
        assert!(acknowledger.covers(&ack));
        // A lift that also clears an acknowledge-only fact needs the acknowledge
        // capability, even when its lift dimensions alone are covered.
        let waive_and_ack = ProposedGrant::Waive {
            waiver: TransientWaiver {
                control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
                ..TransientWaiver::empty()
            },
            acknowledged: vec![Unprovable::EffectsUnknown],
        };
        assert!(!broad.covers(&waive_and_ack));
        assert!(
            AuthorityMandate {
                acknowledge_unknown: true,
                may_release_control: true,
                ..AuthorityMandate::none()
            }
            .covers(&waive_and_ack)
        );
    }

    #[test]
    fn empty_waiver_audits_as_acknowledgment() {
        assert_eq!(
            TransientWaiver::empty().kinds(),
            std::collections::BTreeSet::from([WaiverKind::Acknowledgment])
        );
        let control = TransientWaiver {
            control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
            ..TransientWaiver::empty()
        };
        assert_eq!(
            control.kinds(),
            std::collections::BTreeSet::from([WaiverKind::ControlRelease])
        );
    }
}
