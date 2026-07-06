//! Targeted unit tests for lattice, propagation, declassification, and engine merge semantics.

use std::collections::{BTreeMap, BTreeSet};

use afc_core::declassify::{DeclassAuthority, DeclassRule, declassify};
use afc_core::directory::DirectorySnapshot;
use afc_core::engine::{CallSite, Decision, Engine, ResultLabelSpec, RuleEngine};
use afc_core::label::{
    DimCompat, DimDecl, DimRegistry, DimValue, Integrity, Label, PROVENANCE_CAP, Readers, Subject,
};
use afc_core::lattice::{FlowVerdict, Lattice};
use afc_core::rule::{Effect, Outcome, Predicate, Principal, Rule, RuleOrigin};
use afc_core::value::{Chunk, Labeled, ModelInput, ValueId};

fn dims() -> DimRegistry {
    let mut m = BTreeMap::new();
    m.insert("region".to_string(), DimDecl { compat: DimCompat::Exact, order: vec![] });
    m.insert(
        "risk".to_string(),
        DimDecl { compat: DimCompat::AtMost, order: vec!["low".to_string(), "high".to_string()] },
    );
    DimRegistry(m)
}

fn owner_only(user: &str) -> Label {
    Label {
        readers: Readers::users([user.to_string()]),
        integrity: Integrity::Clean,
        dims: BTreeMap::new(),
        provenance: vec![],
        provenance_truncated: false,
    }
}

#[test]
fn flows_to_respects_reader_direction() {
    // Team snapshot: X, Y in team:eng.
    let dir = DirectorySnapshot::builder()
        .user_in_team("X", "eng")
        .user_in_team("Y", "eng")
        .build();
    let dims = dims();
    let lat = Lattice::new(&dir, &dims);

    let owner = owner_only("X");
    let team = Label {
        readers: Readers::Known(BTreeSet::from([Subject::Team("eng".to_string())])),
        ..owner_only("X")
    };

    // Owner-only value cannot flow to a team-wide sink: everyone on the team is not an allowed reader.
    assert!(matches!(lat.flows_to(&owner, &team), FlowVerdict::Leak { .. }));
    // A team-wide value can flow to an owner-only sink: the owner is already a team member.
    assert_eq!(lat.flows_to(&team, &owner), FlowVerdict::Ok);
}

#[test]
fn unknown_readers_need_policy() {
    let dir = DirectorySnapshot::default();
    let dims = dims();
    let lat = Lattice::new(&dir, &dims);
    let unknown = Label { readers: Readers::Unknown, ..owner_only("X") };
    assert!(matches!(
        lat.flows_to(&unknown, &owner_only("X")),
        FlowVerdict::NeedsPolicy { .. }
    ));
}

#[test]
fn dim_exact_and_at_most() {
    let dir = DirectorySnapshot::default();
    let dims = dims();
    let lat = Lattice::new(&dir, &dims);

    let us = owner_only("X").with_dim("region", DimValue::val("US"));
    let eu_sink = Label::public().with_dim("region", DimValue::val("EU"));
    // Exact mismatch is a leak on the region dimension.
    assert_eq!(lat.flows_to(&us, &eu_sink), FlowVerdict::Leak { dim: "region".into() });

    let low = owner_only("X").with_dim("risk", DimValue::val("low"));
    let high = owner_only("X").with_dim("risk", DimValue::val("high"));
    let low_sink = Label::public().with_dim("risk", DimValue::val("low"));
    // at_most: low <= low ok, high </= low leaks.
    assert_eq!(lat.flows_to(&low, &low_sink), FlowVerdict::Ok);
    assert_eq!(lat.flows_to(&high, &low_sink), FlowVerdict::Leak { dim: "risk".into() });
    // meet of low and high on an at_most dim is the max (high).
    let met = lat.meet(&low, &high);
    assert_eq!(met.dims.get("risk"), Some(&DimValue::val("high")));
}

#[test]
fn integrity_meet_taint_dominates_unknown() {
    let dir = DirectorySnapshot::default();
    let dims = dims();
    let lat = Lattice::new(&dir, &dims);
    let tainted = Label { integrity: Integrity::Tainted, ..owner_only("X") };
    let unknown = Label { integrity: Integrity::Unknown, ..owner_only("X") };
    assert_eq!(lat.meet(&tainted, &unknown).integrity, Integrity::Tainted);
}

#[test]
fn provenance_caps_and_flags_truncation() {
    let mut label = Label::public();
    for i in 0..(PROVENANCE_CAP + 5) {
        label = label.with_source(format!("src-{i:03}"));
    }
    assert_eq!(label.provenance.len(), PROVENANCE_CAP);
    assert!(label.provenance_truncated);
}

#[test]
fn declassify_refuses_tainted() {
    let sanitizer = DeclassRule::new(
        "san.redact",
        DeclassAuthority::Sanitizer {
            impl_pin: "redact@1".to_string(),
            f: |c| Chunk(format!("[redacted]{}", c.0)),
        },
        Label::public(),
    );
    let tainted = Labeled::new(
        Chunk("evil".to_string()),
        Label { integrity: Integrity::Tainted, ..owner_only("X") },
    );
    // Robust precondition: tainted content cannot be laundered through a declassifier.
    assert!(matches!(declassify(&tainted, &sanitizer), Err(Decision::Deny { .. })));

    let clean = Labeled::new(Chunk("ok".to_string()), owner_only("X"));
    assert!(declassify(&clean, &sanitizer).is_ok());
}

#[test]
fn label_completion_uses_inline_only() {
    let dir = DirectorySnapshot::default();
    let dims = dims();
    let lat = Lattice::new(&dir, &dims);
    let inline = ModelInput::Inline(Labeled::new(Chunk("a".into()), owner_only("X")));
    // A ref does not contribute to the completion label (its content never entered context).
    let reference = ModelInput::Ref(ValueId("v1".into()));
    let completed = afc_core::value::label_completion(&[inline, reference], Chunk("out".into()), &lat);
    assert_eq!(completed.label.readers, Readers::users(["X".to_string()]));
}

#[test]
fn engine_forbid_wins_over_escalate() {
    let dir = DirectorySnapshot::default();
    let rules = vec![
        Rule {
            id: "r.escalate".to_string(),
            when: Predicate::HasEffect(Effect::Egress),
            then: Outcome::Escalate(vec!["human".to_string()]),
            origin: RuleOrigin::Org,
        },
        Rule {
            id: "r.forbid".to_string(),
            when: Predicate::HasEffect(Effect::Egress),
            then: Outcome::Forbid,
            origin: RuleOrigin::Stdlib,
        },
    ];
    let mut engine = RuleEngine::new(rules, dims(), dir)
        .with_remedies(vec!["san.redact".to_string()], vec![]);

    let call = CallSite::new(
        "email.send".to_string(),
        BTreeSet::from([Effect::Egress]),
        Labeled::new(Chunk("x".into()), owner_only("X")),
        Label::public(),
        BTreeMap::new(),
        Principal { subject: Subject::User("X".into()), dims: BTreeMap::new() },
    );
    match engine.check_call(&call) {
        Decision::Deny { rule_id, residual, reason, .. } => {
            assert_eq!(rule_id, "r.forbid");
            assert!(!residual.is_empty(), "every deny must carry a remedy");
            assert!(!reason.is_empty());
        }
        other => panic!("expected forbid-wins Deny, got {other:?}"),
    }
}

#[test]
fn declassify_human_authority_is_refused_without_a_verdict() {
    // A human/LLM declassifier is an authority decision, not a pure transform — declassify must not
    // silently relabel clean content; it refuses and points at the approval remedy.
    let human = DeclassRule::new("dc.human", DeclassAuthority::Human, Label::public());
    let clean = Labeled::new(Chunk("secret".into()), owner_only("X"));
    assert!(matches!(declassify(&clean, &human), Err(Decision::Deny { .. })));
}

#[test]
fn escalation_approval_is_one_shot() {
    let dir = DirectorySnapshot::default();
    let rules = vec![Rule {
        id: "r.escalate".to_string(),
        when: Predicate::HasEffect(Effect::Egress),
        then: Outcome::Escalate(vec!["human".to_string()]),
        origin: RuleOrigin::Org,
    }];
    let mut engine = RuleEngine::new(rules, dims(), dir);
    let call = CallSite::new(
        "email.send".to_string(),
        BTreeSet::from([Effect::Egress]),
        Labeled::new(Chunk("x".into()), Label::public()),
        Label::public(),
        BTreeMap::new(),
        Principal { subject: Subject::User("X".into()), dims: BTreeMap::new() },
    );
    let escalate_id = engine.check_call(&call).id();
    let always = Predicate::And(vec![]);
    // First discharge of that escalation succeeds.
    assert!(matches!(
        engine.finalize_escalation(&call, "c".into(), escalate_id, "human".into(), &always),
        Decision::Allow { .. }
    ));
    // Replaying the same approval is refused — the escalation is no longer pending.
    match engine.finalize_escalation(&call, "c".into(), escalate_id, "human".into(), &always) {
        Decision::Deny { rule_id, .. } => assert_eq!(rule_id, "engine.no_pending_escalation"),
        other => panic!("expected replay to be denied, got {other:?}"),
    }
}

#[test]
fn approval_cannot_be_spent_on_a_different_call() {
    let dir = DirectorySnapshot::default();
    let rules = vec![Rule {
        id: "r.escalate".to_string(),
        when: Predicate::HasEffect(Effect::Egress),
        then: Outcome::Escalate(vec!["human".to_string()]),
        origin: RuleOrigin::Org,
    }];
    let mut engine = RuleEngine::new(rules, dims(), dir);
    let principal = Principal { subject: Subject::User("X".into()), dims: BTreeMap::new() };
    let mk = |to: &str| {
        CallSite::new(
            "email.send".to_string(),
            BTreeSet::from([Effect::Egress]),
            Labeled::new(Chunk("x".into()), Label::public()),
            Label::public(),
            BTreeMap::from([("to".to_string(), afc_core::rule::ArgValue::Str(to.into()))]),
            principal.clone(),
        )
    };
    let call_a = mk("X");
    let call_b = mk("Y");
    let escalate_id = engine.check_call(&call_a).id();
    let always = Predicate::And(vec![]);

    // The approval for call A cannot be spent on the different call B, even though B is in scope.
    match engine.finalize_escalation(&call_b, "c".into(), escalate_id, "human".into(), &always) {
        Decision::Deny { rule_id, .. } => assert_eq!(rule_id, "engine.approval_call_mismatch"),
        other => panic!("expected call-mismatch Deny, got {other:?}"),
    }
    // The escalation is still pending, so the legitimate approval for call A succeeds.
    assert!(matches!(
        engine.finalize_escalation(&call_a, "c".into(), escalate_id, "human".into(), &always),
        Decision::Allow { .. }
    ));
}

#[test]
fn warn_rules_are_recorded_not_silently_dropped() {
    let dir = DirectorySnapshot::default();
    let rules = vec![Rule {
        id: "r.warn".to_string(),
        when: Predicate::HasEffect(Effect::Egress),
        then: Outcome::Warn,
        origin: RuleOrigin::Org,
    }];
    let mut engine = RuleEngine::new(rules, dims(), dir);
    let call = CallSite::new(
        "email.send".to_string(),
        BTreeSet::from([Effect::Egress]),
        Labeled::new(Chunk("x".into()), Label::public()),
        Label::public(),
        BTreeMap::new(),
        Principal { subject: Subject::User("X".into()), dims: BTreeMap::new() },
    );
    // A warn rule does not change the verdict...
    assert!(matches!(engine.check_call(&call), Decision::Allow { .. }));
    // ...but it is recorded in the audit trail.
    assert_eq!(engine.audit().last().unwrap().warnings, vec!["r.warn".to_string()]);
}

#[test]
fn label_result_tier_fallthrough_to_unknown() {
    let dir = DirectorySnapshot::default();
    let engine = RuleEngine::new(vec![], dims(), dir).with_result_labels(BTreeMap::from([(
        "drive.read".to_string(),
        ResultLabelSpec { meta: None, static_label: Some(owner_only("X")) },
    )]));
    // Annotated tool → tier3 static label.
    let labeled = engine.label_result(&"drive.read".to_string(), &BTreeMap::new(), Chunk("d".into()));
    assert_eq!(labeled.label.readers, Readers::users(["X".to_string()]));
    // Unannotated tool → tier4 Unknown.
    let unknown = engine.label_result(&"legacy.dump".to_string(), &BTreeMap::new(), Chunk("d".into()));
    assert_eq!(unknown.label.readers, Readers::Unknown);
}

#[test]
fn checker_flags_argcmp_literal_type_mismatch() {
    use afc_core::checker::{Inventory, ToolEntry, check, Severity};
    use afc_core::rule::{ArgType, ArgValue, CmpOp, TypedPath, ValueExpr};

    let tool = ToolEntry {
        id: "crm.export".to_string(),
        effects: BTreeSet::from([Effect::Egress]),
        fields: BTreeMap::from([("region".to_string(), ArgType::Str)]),
        labeled: true,
        produces: None,
        sink: None,
    };
    // Path is Str, but the compared literal is an Int — the guard can never match.
    let rule = Rule {
        id: "org.mismatch".to_string(),
        when: Predicate::And(vec![
            Predicate::ToolIs("crm.export".to_string()),
            Predicate::ArgCmp(
                TypedPath { field: "region".to_string(), ty: ArgType::Str },
                CmpOp::Eq,
                ValueExpr::Lit(ArgValue::Int(0)),
            ),
        ]),
        then: Outcome::Forbid,
        origin: RuleOrigin::Org,
    };
    let inv = Inventory {
        tools: vec![tool],
        rules: vec![rule],
        dims: dims(),
        declassifiers: vec![],
        chains: vec![],
        assumptions: vec![],
        dir: DirectorySnapshot::default(),
        principal: Principal { subject: Subject::User("X".into()), dims: BTreeMap::new() },
    };
    let report = check(&inv);
    assert!(report.findings.iter().any(|f| f.code == "RUL-ARGCMP-TYPE" && f.severity == Severity::Error));
}
