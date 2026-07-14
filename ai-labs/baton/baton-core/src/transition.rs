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
    /// Competent to acquire a new effect for one action — authorize a
    /// criterion-(1) surface growth. Distinct from waiving an *already-committed*
    /// prior effect (`waive_prior_effects`).
    pub acquire_effects: bool,
}

impl AuthorityMandate {
    /// The identity mandate: competent for nothing but the empty ask.
    /// Powers are granted one combinator at a time, so a mandate reads as
    /// exactly what it may do.
    pub fn none() -> Self {
        Self::default()
    }

    /// Competent to endorse flow trust up to `ceiling`.
    #[must_use]
    pub fn endorse_trust(mut self, ceiling: KnownTrust) -> Self {
        self.trust = Some(ceiling);
        self
    }

    /// Competent to vouch exactly `readers` into a flow audience.
    #[must_use]
    pub fn vouch_audience(mut self, readers: impl IntoIterator<Item = UserId>) -> Self {
        self.audience = Some(readers.into_iter().collect());
        self
    }

    /// Competent to waive an already-committed prior effect for one check.
    #[must_use]
    pub fn waive_prior_effects(mut self) -> Self {
        self.waive_prior_effects = true;
        self
    }

    /// Competent to stand in for a user confirmation.
    #[must_use]
    pub fn confirms(mut self) -> Self {
        self.confirms = true;
        self
    }

    /// Competent to acknowledge unprovable facts.
    #[must_use]
    pub fn acknowledge_unknown(mut self) -> Self {
        self.acknowledge_unknown = true;
        self
    }

    /// Competent to release a control dependency for one flow.
    #[must_use]
    pub fn release_control(mut self) -> Self {
        self.may_release_control = true;
        self
    }

    /// Competent to acquire a new effect for one action. A global capability:
    /// `covers` does not scope it to particular effects, so an acquirer may
    /// accept *any* surface growth its routing reaches, not just one kind.
    #[must_use]
    pub fn acquire_effects(mut self) -> Self {
        self.acquire_effects = true;
        self
    }

    /// Is this mandate competent for `grant`? Endorse dimensions compare by
    /// their order (trust by [`KnownTrust`], audience by set inclusion); every
    /// other elevation by boolean implication. An elevation the grant does not
    /// ask for is not required of the mandate.
    #[must_use]
    pub fn covers(&self, grant: &ProposedGrant) -> bool {
        match grant {
            ProposedGrant::Waive { waiver, acknowledged } => {
                let effects_ok = waiver.prior_effects.is_none() || self.waive_prior_effects;
                let confirms_ok = !waiver.confirms || self.confirms;
                let control_ok = waiver.control_release.is_empty() || self.may_release_control;
                // A lift that also clears acknowledge-only facts needs the
                // explicit acknowledge capability — the lift dims alone must
                // not let an authority acknowledge an unknown it cannot vouch.
                let acknowledge_ok = acknowledged.is_empty() || self.acknowledge_unknown;
                effects_ok && confirms_ok && control_ok && acknowledge_ok
            }
            ProposedGrant::Endorse { delta, .. } => delta.covered_by(self),
            ProposedGrant::Accept { .. } => self.acquire_effects,
            ProposedGrant::Acknowledge { .. } => self.acknowledge_unknown,
        }
    }
}

/// The confidentiality raise an Endorse grant asks an authority to vouch: a
/// trust attestation and/or an audience it admits. Unlike a [`TransientWaiver`]
/// this is not a check-transient lift — it is the durable ΔL minted onto a new
/// value (see [`ProposedGrant::Endorse`]). A mandate bounds it: the trust
/// ceiling and the admissible readers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct EndorseDelta {
    /// Raise the endorsed value's trust to at least this.
    pub trust: Option<KnownTrust>,
    /// Vouch exactly these readers into the endorsed value's audience.
    pub audience: Option<BTreeSet<UserId>>,
}

impl EndorseDelta {
    /// Does `mandate` bound at least this raise? Trust by [`KnownTrust`] order,
    /// audience by set inclusion.
    #[must_use]
    pub fn covered_by(&self, mandate: &AuthorityMandate) -> bool {
        let trust_ok = match self.trust {
            None => true,
            Some(need) => matches!(mandate.trust, Some(ceiling) if ceiling >= need),
        };
        let audience_ok = match &self.audience {
            None => true,
            Some(need) => matches!(&mandate.audience, Some(vouchable) if need.is_subset(vouchable)),
        };
        trust_ok && audience_ok
    }

    /// Raises nothing.
    pub fn is_empty(&self) -> bool {
        self.trust.is_none() && self.audience.is_none()
    }

    /// The label a value gets when this endorse is applied: its trust raised
    /// and its audience admitted by the vouched readers. Monotone — the lift
    /// helpers only raise a label, never lower it, so `combine` (the taint
    /// fold, which cannot improve a label) is deliberately not used.
    pub(crate) fn raise(&self, label: &ValueLabel) -> ValueLabel {
        ValueLabel {
            trust: match self.trust {
                Some(attested) => label.trust.raised_to(attested),
                None => label.trust,
            },
            audience: match &self.audience {
                Some(vouched) => label.audience.admitting(vouched),
                None => label.audience.clone(),
            },
        }
    }
}

impl fmt::Display for EndorseDelta {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.trust, &self.audience) {
            (Some(trust), Some(readers)) => write!(f, "trust>={trust}+audience+{}", readers.len()),
            (Some(trust), None) => write!(f, "trust>={trust}"),
            (None, Some(readers)) => write!(f, "audience+{}", readers.len()),
            (None, None) => write!(f, "nothing"),
        }
    }
}

/// A check-transient loosening applied to one flow: it lifts exactly its
/// populated dimensions for a single sink check and changes no stored state.
/// Proposal data, not a capability — authority comes from routing to a
/// competent mandate plus the fail-closed recheck.
///
/// Trust and audience are *not* here: raising a value's confidentiality label
/// is a durable relabel ([`ProposedGrant::Endorse`]), not a transient lift.
/// What remains is transient by nature — a prior-effect waiver, a
/// confirmation, a control-dependence release.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TransientWaiver {
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
/// the operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ProposedGrant {
    /// Durably raise a value's label by fiat (Endorse): mint a new value
    /// carrying the raised label and `source`'s bytes, substituted into the
    /// flow. Routes on the mandate bounding `delta`. Clears a criterion-(2)
    /// sink breach the way a registered sanitizer does, but justified by the
    /// authority rather than by the content.
    Endorse { source: ValueId, delta: EndorseDelta },
    /// Grant a check-transient loosening, plus any acknowledge-only facts the
    /// lift also clears on the recheck. Those facts need `acknowledge_unknown`
    /// competence: a lift dimension must not launder an unknown the authority
    /// cannot vouch for.
    Waive {
        waiver: TransientWaiver,
        acknowledged: Vec<Unprovable>,
    },
    /// Acquire a criterion-(1) surface growth on the pending action. Routes on
    /// the explicit `acquire_effects` capability. Authorizes the growth; the
    /// effect still commits to the monotone past at release, never early.
    Accept { effects: Effects },
    /// Acknowledge unprovable facts. Routes on the explicit
    /// `acknowledge_unknown` capability, not on covering an empty ask.
    Acknowledge { facts: Vec<Unprovable> },
}

impl fmt::Display for ProposedGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Endorse { source, delta } => write!(f, "endorse {source} ({delta})"),
            Self::Waive { waiver, .. } => write!(f, "waive {waiver}"),
            Self::Accept { effects } => write!(f, "accept {effects}"),
            Self::Acknowledge { .. } => write!(f, "acknowledgment"),
        }
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

    /// Each builder combinator grants exactly its named power: the mandate it
    /// builds covers the grant demanding that power and none of the grants
    /// demanding another (the full covers matrix is diagonal).
    #[test]
    fn combinators_grant_their_named_power_and_nothing_else() {
        let endorse = |delta| ProposedGrant::Endorse {
            source: ValueId::new(0),
            delta,
        };
        let waive = |waiver| ProposedGrant::Waive {
            waiver,
            acknowledged: Vec::new(),
        };
        let cases: Vec<(AuthorityMandate, ProposedGrant)> = vec![
            (
                AuthorityMandate::none().endorse_trust(KnownTrust::Trusted),
                endorse(EndorseDelta {
                    trust: Some(KnownTrust::Trusted),
                    audience: None,
                }),
            ),
            (
                AuthorityMandate::none().vouch_audience([UserId::new("bob")]),
                endorse(EndorseDelta {
                    trust: None,
                    audience: Some(std::collections::BTreeSet::from([UserId::new("bob")])),
                }),
            ),
            (
                AuthorityMandate::none().waive_prior_effects(),
                waive(TransientWaiver {
                    prior_effects: Some(std::collections::BTreeSet::from([Effect::Egress])),
                    ..TransientWaiver::empty()
                }),
            ),
            (
                AuthorityMandate::none().confirms(),
                waive(TransientWaiver {
                    confirms: true,
                    ..TransientWaiver::empty()
                }),
            ),
            (
                AuthorityMandate::none().release_control(),
                waive(TransientWaiver {
                    control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
                    ..TransientWaiver::empty()
                }),
            ),
            (
                AuthorityMandate::none().acknowledge_unknown(),
                ProposedGrant::Acknowledge {
                    facts: vec![Unprovable::EffectsUnknown],
                },
            ),
            (
                AuthorityMandate::none().acquire_effects(),
                ProposedGrant::Accept {
                    effects: Effects::declared([Effect::Egress]),
                },
            ),
        ];
        for (i, (mandate, _)) in cases.iter().enumerate() {
            for (j, (_, grant)) in cases.iter().enumerate() {
                assert_eq!(mandate.covers(grant), i == j, "mandate {i} vs grant {j}");
            }
        }
        // The identity mandate covers none of them, and a trust ceiling below
        // the asked raise does not cover it.
        for (_, grant) in &cases {
            assert!(!AuthorityMandate::none().covers(grant));
        }
        assert!(
            !AuthorityMandate::none()
                .endorse_trust(KnownTrust::Suspicious)
                .covers(&endorse(EndorseDelta {
                    trust: Some(KnownTrust::Trusted),
                    audience: None,
                }))
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
        // The endorse dims (trust/audience) are bounded on the Endorse grant.
        let endorse = |trust, audience| ProposedGrant::Endorse {
            source: ValueId::new(0),
            delta: EndorseDelta { trust, audience },
        };
        let big_endorse = endorse(
            Some(KnownTrust::Trusted),
            Some(std::collections::BTreeSet::from([
                UserId::new("bob"),
                UserId::new("charlie"),
            ])),
        );
        let small_endorse = endorse(None, Some(std::collections::BTreeSet::from([UserId::new("bob")])));
        assert!(broad.covers(&big_endorse));
        // The narrow mandate cannot vouch charlie or raise trust.
        assert!(!narrow.covers(&big_endorse));
        assert!(broad.covers(&small_endorse));
        assert!(narrow.covers(&small_endorse));

        // A transient waive is gated by its own (non-relabel) capabilities.
        let waive = |waiver| ProposedGrant::Waive {
            waiver,
            acknowledged: Vec::new(),
        };
        let confirm_and_release = waive(TransientWaiver {
            confirms: true,
            control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
            ..TransientWaiver::empty()
        });
        // broad may confirm and release; narrow may release but not confirm.
        assert!(broad.covers(&confirm_and_release));
        assert!(!narrow.covers(&confirm_and_release));
        assert!(narrow.covers(&waive(TransientWaiver {
            control_release: std::collections::BTreeSet::from([ValueId::new(0)]),
            ..TransientWaiver::empty()
        })));
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
