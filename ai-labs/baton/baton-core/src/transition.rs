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

use serde::Serialize;

use crate::ToolName;
use crate::audit::TransitionFailure;
use crate::dimension::{Audience, Effects, KnownTrust, Trust, UserId};
use crate::request::PendingAction;
use crate::value::{OpaqueValue, TransformerRef, ValueLabel, ValueRef};

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
    pub fn accepts(&self, source: &ValueRef<'_>) -> Result<(), TransitionFailure> {
        if self.descriptor.precondition.matches(source.label()) {
            Ok(())
        } else {
            Err(TransitionFailure::ReductionRefused)
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
            return Err(TransitionFailure::ReductionRefused);
        }
        if effects_narrow(pending.proposed_effects(), &self.effects) {
            Ok(())
        } else {
            Err(TransitionFailure::ReductionRefused)
        }
    }
}

/// Is `new` verifiably no broader than `old`?
pub(crate) fn effects_narrow(old: &Effects, new: &Effects) -> bool {
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

    /// The typed competence relation: is this mandate competent for the
    /// asked authorization? Every atomic coordinate of the delta must be
    /// covered — a label raise by the trust ceiling and vouchable readers, a
    /// product lift by each of its named capabilities. Scope never broadens
    /// competence: what may be granted is the delta; where it applies is the
    /// grant's binding.
    #[must_use]
    pub fn authorizes(&self, ask: &crate::remedy::Authorization) -> bool {
        self.authorizes_delta(ask.delta())
    }

    fn authorizes_delta(&self, delta: &crate::remedy::AuthorizationDelta) -> bool {
        delta.coordinates().all(|coordinate| self.covers_coordinate(coordinate))
    }

    fn covers_coordinate(&self, coordinate: &crate::remedy::DeltaCoordinate) -> bool {
        use crate::remedy::DeltaCoordinate;
        match coordinate {
            DeltaCoordinate::RaiseLabel(raise) => {
                let trust_ok = match raise.trust {
                    None => true,
                    Some(need) => matches!(self.trust, Some(ceiling) if ceiling >= need),
                };
                let audience_ok = match &raise.audience {
                    None => true,
                    Some(need) => matches!(&self.audience, Some(vouchable) if need.is_subset(vouchable)),
                };
                trust_ok && audience_ok
            }
            DeltaCoordinate::AcquireEffects(_) => self.acquire_effects,
            DeltaCoordinate::ExceptPriorEffects(_) => self.waive_prior_effects,
            DeltaCoordinate::StandInConfirmation => self.confirms,
            DeltaCoordinate::ReleaseControl(_) => self.may_release_control,
            // The coordinate demands the explicit acknowledge capability even
            // over an empty fact list — the lift dims alone must not let an
            // authority acknowledge an unknown it cannot vouch.
            DeltaCoordinate::AcknowledgeUnknown(_) => self.acknowledge_unknown,
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
    use crate::contract::Unprovable;
    use crate::dimension::Effect;
    use crate::request::{ArgumentTree, ToolRequest};
    use crate::revision::ActionId;
    use crate::revision::ValueId;

    fn pending(tool: &str, effects: Effects) -> PendingAction {
        PendingAction::proposed(
            ActionId::new(0),
            crate::revision::FlowId::new(0),
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
            Err(TransitionFailure::ReductionRefused)
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
            Err(TransitionFailure::ReductionRefused)
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
            Err(TransitionFailure::ReductionRefused)
        );
    }

    /// The typed competence relation is diagonal over atomic coordinates:
    /// each builder combinator authorizes exactly the ask demanding its named
    /// power, and a product ask requires every coordinate covered.
    #[test]
    fn typed_competence_is_diagonal_and_products_need_every_coordinate() {
        use crate::remedy::{Authorization, AuthorizationDelta, AuthorizationScope, DeltaCoordinate, LabelRaise};
        use crate::revision::FlowId;

        let check_scope = AuthorizationScope::PolicyCheck { flow: FlowId::new(0) };
        // Competence is scope-independent, but construction is not: each ask
        // is built at the coordinate's own valid scope.
        let ask = |coordinate: DeltaCoordinate| {
            let scope = match &coordinate {
                DeltaCoordinate::RaiseLabel(_) => AuthorizationScope::DerivedValue {
                    source: ValueId::new(0),
                },
                DeltaCoordinate::AcquireEffects(_) => AuthorizationScope::PendingAction {
                    action: crate::revision::ActionId::new(0),
                },
                _ => AuthorizationScope::PolicyCheck { flow: FlowId::new(0) },
            };
            Authorization::new(AuthorizationDelta::single(coordinate), scope).unwrap()
        };
        let cases: Vec<(AuthorityMandate, Authorization)> = vec![
            (
                AuthorityMandate::none().endorse_trust(KnownTrust::Trusted),
                ask(DeltaCoordinate::RaiseLabel(LabelRaise {
                    trust: Some(KnownTrust::Trusted),
                    audience: None,
                })),
            ),
            (
                AuthorityMandate::none().vouch_audience([UserId::new("bob")]),
                ask(DeltaCoordinate::RaiseLabel(LabelRaise {
                    trust: None,
                    audience: Some(BTreeSet::from([UserId::new("bob")])),
                })),
            ),
            (
                AuthorityMandate::none().waive_prior_effects(),
                ask(DeltaCoordinate::ExceptPriorEffects(BTreeSet::from([Effect::Egress]))),
            ),
            (
                AuthorityMandate::none().confirms(),
                ask(DeltaCoordinate::StandInConfirmation),
            ),
            (
                AuthorityMandate::none().release_control(),
                ask(DeltaCoordinate::ReleaseControl(BTreeSet::from([ValueId::new(0)]))),
            ),
            (
                AuthorityMandate::none().acknowledge_unknown(),
                ask(DeltaCoordinate::AcknowledgeUnknown(vec![Unprovable::EffectsUnknown])),
            ),
            (
                AuthorityMandate::none().acquire_effects(),
                ask(DeltaCoordinate::AcquireEffects(Effects::declared([Effect::Egress]))),
            ),
        ];
        for (i, (mandate, _)) in cases.iter().enumerate() {
            for (j, (_, ask)) in cases.iter().enumerate() {
                assert_eq!(mandate.authorizes(ask), i == j, "mandate {i} vs ask {j}");
            }
        }
        for (_, ask) in &cases {
            assert!(!AuthorityMandate::none().authorizes(ask));
        }

        // A product ask requires one mandate competent for every coordinate:
        // release+confirm is covered only when both powers are present, and
        // an acknowledge coordinate riding along still demands its explicit
        // capability — even over an empty fact list.
        let release_and_confirm = Authorization::new(
            AuthorizationDelta::product(vec![
                DeltaCoordinate::ReleaseControl(BTreeSet::from([ValueId::new(0)])),
                DeltaCoordinate::StandInConfirmation,
            ])
            .expect("two coordinates"),
            check_scope.clone(),
        )
        .unwrap();
        assert!(
            AuthorityMandate::none()
                .release_control()
                .confirms()
                .authorizes(&release_and_confirm)
        );
        assert!(
            !AuthorityMandate::none()
                .release_control()
                .authorizes(&release_and_confirm)
        );
        assert!(!AuthorityMandate::none().confirms().authorizes(&release_and_confirm));

        let release_and_acknowledge = Authorization::new(
            AuthorizationDelta::product(vec![
                DeltaCoordinate::ReleaseControl(BTreeSet::from([ValueId::new(0)])),
                DeltaCoordinate::AcknowledgeUnknown(Vec::new()),
            ])
            .expect("two coordinates"),
            check_scope.clone(),
        )
        .unwrap();
        assert!(
            !AuthorityMandate::none()
                .release_control()
                .authorizes(&release_and_acknowledge)
        );
        assert!(
            AuthorityMandate::none()
                .release_control()
                .acknowledge_unknown()
                .authorizes(&release_and_acknowledge)
        );

        // A raise past the mandate's ceiling is not covered. (A raise at a
        // non-durable scope is unrepresentable — refused at construction,
        // covered by the remedy module's own tests — so scope cannot
        // broaden competence by construction.)
        let big_raise = Authorization::new(
            AuthorizationDelta::single(DeltaCoordinate::RaiseLabel(LabelRaise {
                trust: Some(KnownTrust::Trusted),
                audience: Some(BTreeSet::from([UserId::new("bob"), UserId::new("charlie")])),
            })),
            AuthorizationScope::DerivedValue {
                source: ValueId::new(0),
            },
        )
        .unwrap();
        let narrow = AuthorityMandate::none().vouch_audience([UserId::new("bob")]);
        assert!(!narrow.authorizes(&big_raise));
        let _ = check_scope;
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
}
