//! Shared proptest strategies for the algebra law tests.
//!
//! The domains are deliberately small and bounded — a four-name user pool, the
//! two-variant effect set, and every `Unknown`/`Public`/`None`/`Some(empty)`
//! corner — so generated inputs actually exercise intersections, subsets, and
//! the `Unknown` positions the laws hinge on, and so a counterexample shrinks
//! to something legible.

use std::collections::BTreeSet;

use proptest::prelude::*;

use crate::ToolName;
use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
use crate::label::{AuditEntry, Grant, Label};

const USERS: &[&str] = &["alice", "bob", "charlie", "dave"];
const TOOLS: &[&str] = &["a.tool", "b.tool"];

pub(crate) fn arb_user() -> impl Strategy<Value = UserId> {
    prop::sample::select(USERS).prop_map(UserId::new)
}

pub(crate) fn arb_users() -> impl Strategy<Value = BTreeSet<UserId>> {
    prop::collection::btree_set(arb_user(), 0..=USERS.len())
}

pub(crate) fn arb_known_trust() -> impl Strategy<Value = KnownTrust> {
    prop_oneof![Just(KnownTrust::Suspicious), Just(KnownTrust::Trusted)]
}

pub(crate) fn arb_audience() -> impl Strategy<Value = Audience> {
    prop_oneof![
        Just(Audience::PUBLIC),
        arb_users().prop_map(Audience::readers),
        Just(Audience::UNKNOWN),
    ]
}

pub(crate) fn arb_trust() -> impl Strategy<Value = Trust> {
    prop_oneof![Just(Trust::SUSPICIOUS), Just(Trust::TRUSTED), Just(Trust::UNKNOWN)]
}

pub(crate) fn arb_effect_set() -> impl Strategy<Value = BTreeSet<Effect>> {
    (any::<bool>(), any::<bool>()).prop_map(|(mutation, egress)| {
        let mut set = BTreeSet::new();
        if mutation {
            set.insert(Effect::Mutation);
        }
        if egress {
            set.insert(Effect::Egress);
        }
        set
    })
}

pub(crate) fn arb_effects() -> impl Strategy<Value = Effects> {
    prop_oneof![arb_effect_set().prop_map(Effects::declared), Just(Effects::UNKNOWN)]
}

fn arb_audit_entry() -> impl Strategy<Value = AuditEntry> {
    prop::sample::select(TOOLS).prop_map(|tool| AuditEntry::Acknowledged {
        tool: ToolName::new(tool),
        facts: Vec::new(),
        by: None,
    })
}

/// A label with a (possibly non-empty) audit log — for the full-monoid laws.
pub(crate) fn arb_label() -> impl Strategy<Value = Label> {
    (
        arb_audience(),
        arb_trust(),
        arb_effects(),
        prop::collection::vec(arb_audit_entry(), 0..3),
    )
        .prop_map(|(audience, trust, effects, audit)| Label {
            audience,
            trust,
            effects,
            audit,
        })
}

/// A label with an empty audit log — for the data-dimension laws
/// (commutativity, idempotence), which hold on the semilattice product but not
/// on the appending audit Writer log.
pub(crate) fn arb_label_no_audit() -> impl Strategy<Value = Label> {
    (arb_audience(), arb_trust(), arb_effects()).prop_map(|(audience, trust, effects)| Label {
        audience,
        trust,
        effects,
        audit: Vec::new(),
    })
}

pub(crate) fn arb_grant() -> impl Strategy<Value = Grant> {
    (
        prop::option::of(arb_known_trust()),
        prop::option::of(arb_users()),
        prop::option::of(arb_effect_set()),
        any::<bool>(),
    )
        .prop_map(|(trust, audience, effects, confirms)| Grant {
            trust,
            audience,
            effects,
            confirms,
        })
}
