//! Shared proptest strategies for the algebra law tests.
//!
//! The domains are deliberately small and bounded — a four-name user pool, the
//! two-variant effect set, and every `Unknown`/`Public`/`Some(empty)` corner —
//! so generated inputs actually exercise intersections, subsets, and the
//! `Unknown` positions the laws hinge on, and so a counterexample shrinks to
//! something legible.

use std::collections::BTreeSet;

use proptest::prelude::*;

use crate::dimension::{Audience, Effect, Effects, Trust, UserId};
use crate::value::ValueLabel;

const USERS: &[&str] = &["alice", "bob", "charlie", "dave"];

pub(crate) fn arb_user() -> impl Strategy<Value = UserId> {
    prop::sample::select(USERS).prop_map(UserId::new)
}

pub(crate) fn arb_users() -> impl Strategy<Value = BTreeSet<UserId>> {
    prop::collection::btree_set(arb_user(), 0..=USERS.len())
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

pub(crate) fn arb_value_label() -> impl Strategy<Value = ValueLabel> {
    (arb_audience(), arb_trust()).prop_map(|(audience, trust)| ValueLabel { audience, trust })
}
