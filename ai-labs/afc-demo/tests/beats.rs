//! Integration test: every numbered beat asserted by decision type + rule id (never by trace text),
//! plus JSONL validity, deny invariants, and the `afc check` acceptance criteria.

use afc_core::engine::{AllowVia, Decision, DecisionKind, Remedy};
use afc_core::label::{Readers, Subject};
use afc_core::lattice::FlowVerdict;

fn deny_parts(d: &Decision) -> (&str, &str, &[Remedy]) {
    match d {
        Decision::Deny {
            rule_id,
            reason,
            residual,
            ..
        } => (rule_id, reason, residual),
        other => panic!("expected Deny, got {other:?}"),
    }
}

fn run() -> afc_demo::Scenario {
    let dir = tempfile::tempdir().unwrap();
    let jsonl = dir.path().join("decisions.jsonl");
    afc_demo::run_scenario(&afc_demo::default_config_dir(), Some(jsonl))
        .expect("scenario runs")
}

#[test]
fn beat1_read_labels_owner_only() {
    let s = run();
    assert_eq!(
        s.beat1_read.label.readers,
        Readers::Known([Subject::User("X".into())].into())
    );
}

#[test]
fn beat2_write_leaks_and_is_denied_by_no_leak() {
    let s = run();
    let (rule, reason, residual) = deny_parts(&s.beat2_deny);
    assert_eq!(rule, "std.no_leak");
    assert!(!reason.is_empty());
    assert!(!residual.is_empty());
    // The residual points at the declassifier that would unblock beat 3.
    assert!(residual.contains(&Remedy::DeclassifyVia("san.redact".into())));
}

#[test]
fn beat3_declassify_then_write_allowed() {
    let s = run();
    assert!(s.beat3_declassified_ok);
    assert!(matches!(s.beat3_allow, Decision::Allow { .. }));
}

#[test]
fn beat4_tainted_consequential_escalates_then_human_approves() {
    let s = run();
    assert!(matches!(s.beat4_escalate, Decision::Escalate { .. }));
    assert!(s.beat4_llm_abstained, "llm must abstain on tainted context");
    match &s.beat4_final {
        Decision::Allow { via: Some(AllowVia::ApprovedBy(chain)), .. } => {
            assert_eq!(chain, "tainted_consequential");
        }
        other => panic!("expected Allow via approved chain, got {other:?}"),
    }
}

#[test]
fn beat5_region_dimension_denies_via_pure_lattice() {
    let s = run();
    // No custom region rule — std.no_leak fires on the dimension leak.
    let (rule, _, _) = deny_parts(&s.beat5_deny);
    assert_eq!(rule, "std.no_leak");
}

#[test]
fn beat6_unknown_egress_denied_by_on_unknown() {
    let s = run();
    let (rule, _, _) = deny_parts(&s.beat6_deny);
    assert_eq!(rule, "on_unknown.egress");
}

#[test]
fn beat7_injection_replay_fails_at_flow() {
    let s = run();
    // Persuasion succeeds, flow fails: readers leak wins.
    let (rule, _, _) = deny_parts(&s.beat7_deny);
    assert_eq!(rule, "std.no_leak");
    assert!(s.beat7_llm_abstains, "automated approval unavailable on taint");
    assert!(s.beat7_declass_refused, "robust precondition refuses tainted declassify");
}

#[test]
fn beat8_risk_tighten_blocks_and_hook_egress_denied() {
    let s = run();
    let (rule, _, _) = deny_parts(&s.beat8_risk_deny);
    assert_eq!(rule, "std.no_leak");
    assert!(matches!(s.beat8_hook_verdict, FlowVerdict::Leak { .. }));
}

#[test]
fn every_deny_has_reason_and_residual() {
    let s = run();
    for d in [&s.beat2_deny, &s.beat5_deny, &s.beat6_deny, &s.beat7_deny, &s.beat8_risk_deny] {
        let (_, reason, residual) = deny_parts(d);
        assert!(!reason.is_empty());
        assert!(!residual.is_empty());
    }
}

#[test]
fn decision_log_is_valid_jsonl() {
    let dir = tempfile::tempdir().unwrap();
    let jsonl = dir.path().join("decisions.jsonl");
    afc_demo::run_scenario(&afc_demo::default_config_dir(), Some(jsonl.clone())).unwrap();

    let records = afc_demo::suggest::read_log(&jsonl).expect("valid JSONL");
    assert!(!records.is_empty());
    for r in &records {
        assert!(!r.snapshot_hash.is_empty(), "every record pins the directory snapshot");
        if r.decision == DecisionKind::Deny {
            assert!(r.rule_id.is_some(), "a deny record names its rule");
        }
    }
    // The approved beat-4 escalation is recorded as an Allow with its chain id.
    assert!(records.iter().any(|r| r.decision == DecisionKind::Allow && r.chain_id.is_some()));
}

#[test]
fn check_passes_on_clean_config_and_reports_escalation_surface() {
    let inv = afc_demo::build_inventory(&afc_demo::default_config_dir()).unwrap();
    let report = afc_core::checker::check(&inv);
    assert!(!report.has_errors(), "clean config has no error findings: {:?}", report.findings);
    assert!(report.escalation_surface > 0, "a tainted read reaches a consequential sink");
    assert_eq!(report.assume_count, 0);
    assert!(report.unlabeled_count >= 1, "legacy.dump is unlabeled");
}

#[test]
fn check_rejects_typo_argcmp_path_with_rul_error() {
    let inv = afc_demo::build_inventory(&afc_demo::typo_config_dir()).unwrap();
    let report = afc_core::checker::check(&inv);
    assert!(report.has_errors());
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code.starts_with("RUL") && f.severity == afc_core::checker::Severity::Error),
        "expected a RUL-class error, got {:?}",
        report.findings
    );
}

#[test]
fn bootstrap_and_review_and_suggest() {
    // bootstrap: fixture proposals load with null provenance.
    let source = afc_demo::bootstrap::FixtureProposalSource::new(afc_demo::proposals_fixture());
    let proposals = {
        use afc_demo::bootstrap::ProposalSource;
        source.propose().unwrap()
    };
    assert!(proposals.iter().all(|p| p.reviewed_by.is_none()));

    // review: approve all except legacy.dump.
    let reviewed = afc_demo::bootstrap::review(&proposals, &["legacy.dump".to_string()]);
    let legacy = reviewed.iter().find(|p| p.tool == "legacy.dump").unwrap();
    assert!(legacy.reviewed_by.is_none());
    assert!(reviewed.iter().filter(|p| p.tool != "legacy.dump").all(|p| p.reviewed_by.is_some()));

    // suggest: the scenario's denies produce both canned patterns.
    let dir = tempfile::tempdir().unwrap();
    let jsonl = dir.path().join("decisions.jsonl");
    afc_demo::run_scenario(&afc_demo::default_config_dir(), Some(jsonl.clone())).unwrap();
    let records = afc_demo::suggest::read_log(&jsonl).unwrap();
    let suggestions = afc_demo::suggest::suggest(&records);
    assert!(suggestions.iter().any(|s| s.pattern == "repeated-deny-declassify"));
    assert!(suggestions.iter().any(|s| s.pattern == "unknown-tool-repeated-block"));
}
