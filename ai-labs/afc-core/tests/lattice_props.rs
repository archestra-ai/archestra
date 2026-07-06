//! Property tests for the lattice laws and the tighten-only guarantee.

use std::collections::{BTreeMap, BTreeSet};

use afc_core::directory::DirectorySnapshot;
use afc_core::label::{
    DimDecl, DimRegistry, DimValue, Integrity, Label, Readers, SourceRef, Subject,
};
use afc_core::lattice::{FlowClass, Lattice};
use proptest::collection;
use proptest::option;
use proptest::prelude::*;

fn dim_registry() -> DimRegistry {
    let mut m = BTreeMap::new();
    m.insert(
        "region".to_string(),
        DimDecl {
            compat: afc_core::label::DimCompat::Exact,
            order: vec![],
        },
    );
    m.insert(
        "risk".to_string(),
        DimDecl {
            // low is least restrictive; meet takes the max, flow ok iff value <= sink_max.
            compat: afc_core::label::DimCompat::AtMost,
            order: vec!["low".to_string(), "high".to_string()],
        },
    );
    DimRegistry(m)
}

// A directory with no groups: expand(User) == User, so `meet` is idempotent structurally.
fn directory() -> DirectorySnapshot {
    DirectorySnapshot::default()
}

fn readers_strategy() -> impl Strategy<Value = Readers> {
    prop_oneof![
        collection::btree_set(
            prop_oneof![Just("a"), Just("b"), Just("c")].prop_map(|s| Subject::User(s.to_string())),
            0..4,
        )
        .prop_map(Readers::Known),
        Just(Readers::Unknown),
    ]
}

fn integrity_strategy() -> impl Strategy<Value = Integrity> {
    prop_oneof![
        Just(Integrity::Clean),
        Just(Integrity::Tainted),
        Just(Integrity::Unknown),
    ]
}

fn dims_strategy() -> impl Strategy<Value = BTreeMap<String, DimValue>> {
    (
        option::of(prop_oneof![Just("US"), Just("EU")]),
        option::of(prop_oneof![Just("low"), Just("high")]),
    )
        .prop_map(|(region, risk)| {
            let mut m = BTreeMap::new();
            if let Some(r) = region {
                m.insert("region".to_string(), DimValue::val(r));
            }
            if let Some(k) = risk {
                m.insert("risk".to_string(), DimValue::val(k));
            }
            m
        })
}

fn provenance_strategy() -> impl Strategy<Value = Vec<SourceRef>> {
    // A canonical (sorted, deduped) provenance under the cap, matching what `meet` produces.
    collection::btree_set(
        prop_oneof![Just("s1"), Just("s2"), Just("s3")].prop_map(|s| SourceRef(s.to_string())),
        0..4,
    )
    .prop_map(|set| set.into_iter().collect())
}

fn label_strategy() -> impl Strategy<Value = Label> {
    (
        readers_strategy(),
        integrity_strategy(),
        dims_strategy(),
        provenance_strategy(),
    )
        .prop_map(|(readers, integrity, dims, provenance)| Label {
            readers,
            integrity,
            dims,
            provenance,
            provenance_truncated: false,
        })
}

proptest! {
    #[test]
    fn meet_is_commutative(a in label_strategy(), b in label_strategy()) {
        let dir = directory();
        let dims = dim_registry();
        let lat = Lattice::new(&dir, &dims);
        prop_assert_eq!(lat.meet(&a, &b), lat.meet(&b, &a));
    }

    #[test]
    fn meet_is_associative(a in label_strategy(), b in label_strategy(), c in label_strategy()) {
        let dir = directory();
        let dims = dim_registry();
        let lat = Lattice::new(&dir, &dims);
        prop_assert_eq!(lat.meet(&lat.meet(&a, &b), &c), lat.meet(&a, &lat.meet(&b, &c)));
    }

    #[test]
    fn meet_is_idempotent(a in label_strategy()) {
        let dir = directory();
        let dims = dim_registry();
        let lat = Lattice::new(&dir, &dims);
        prop_assert_eq!(lat.meet(&a, &a), a);
    }

    // Tightening can never open a flow: if `a` alone did not flow to `sink`, neither does meet(a, x).
    // Equivalently, an Ok flow after meet implies an Ok flow before — the precise monotonicity claim.
    #[test]
    fn meet_never_opens_a_flow(
        a in label_strategy(),
        x in label_strategy(),
        sink in label_strategy(),
    ) {
        let dir = directory();
        let dims = dim_registry();
        let lat = Lattice::new(&dir, &dims);
        let met = lat.meet(&a, &x);
        if lat.flows_to(&met, &sink).class() == FlowClass::Ok {
            prop_assert_eq!(lat.flows_to(&a, &sink).class(), FlowClass::Ok);
        }
    }

    // Label sources cannot loosen: whatever a hint is, meet(base, hint) flows nowhere base could not.
    // This is the runtime witness of the type-level tighten-only guarantee in `hook::apply_label_source`.
    #[test]
    fn label_source_meet_cannot_loosen(
        base in label_strategy(),
        hint in label_strategy(),
        sink in label_strategy(),
    ) {
        let dir = directory();
        let dims = dim_registry();
        let lat = Lattice::new(&dir, &dims);
        let tightened = lat.meet(&base, &hint);
        if lat.flows_to(&tightened, &sink).class() == FlowClass::Ok {
            prop_assert_eq!(lat.flows_to(&base, &sink).class(), FlowClass::Ok);
        }
    }
}

// Silence the unused-import warning when a Subject-only helper is not exercised in a given build.
#[allow(dead_code)]
fn _touch(_: BTreeSet<Subject>) {}
