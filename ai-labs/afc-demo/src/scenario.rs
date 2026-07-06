//! The scripted 8-beat scenario. Each beat exercises one part of the model and records a structured
//! outcome, so the integration test can assert by decision type + rule id rather than by trace text.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use afc_core::approver::{ApprovalRequest, ChainOutcome, Verdict, run_chain};
use afc_core::declassify::declassify;
use afc_core::engine::{CallSite, Decision, DecisionRecord, Engine};
use afc_core::hook::{Hook, apply_label_source};
use afc_core::label::{DimValue, Integrity, Label, Readers, Subject};
use afc_core::lattice::{FlowVerdict, Lattice};
use afc_core::rule::{ArgValue, Effect};
use afc_core::value::{Chunk, Labeled, ModelInput};

use crate::fixtures;
use crate::wiring::Runtime;

/// Structured results of the scenario — one field group per beat.
pub struct Scenario {
    pub beat1_read: Labeled<Chunk>,
    pub beat2_deny: Decision,
    pub beat3_declassified_ok: bool,
    pub beat3_allow: Decision,
    pub beat4_escalate: Decision,
    pub beat4_final: Decision,
    pub beat4_llm_abstained: bool,
    pub beat5_deny: Decision,
    pub beat6_deny: Decision,
    pub beat7_deny: Decision,
    pub beat7_llm_abstains: bool,
    pub beat7_declass_refused: bool,
    pub beat8_risk_deny: Decision,
    pub beat8_hook_verdict: FlowVerdict,
    pub audit: Vec<DecisionRecord>,
}

fn args(pairs: Vec<(&str, ArgValue)>) -> BTreeMap<String, ArgValue> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn labeled(content: &str, readers: Readers, integrity: Integrity, dims: BTreeMap<String, DimValue>) -> Labeled<Chunk> {
    Labeled::new(
        Chunk(content.into()),
        Label {
            readers,
            integrity,
            dims,
            provenance: vec![],
            provenance_truncated: false,
        },
    )
}

pub fn run(config_dir: &Path, jsonl: Option<PathBuf>) -> Result<Scenario, String> {
    let mut rt = Runtime::from_config(config_dir, jsonl)?;
    let principal = rt.principal.clone();

    // Beat 1: read doc A. The tier-2 resolver labels the result from doc A's ACL: readers {X}.
    let doc_a = rt.engine.label_result(
        &"drive.read_doc".to_string(),
        &args(vec![("doc", ArgValue::Str("A".into()))]),
        Chunk("contents of doc A".into()),
    );

    // Beat 2: summarize (inline) then write to doc B. The summary inherits {X}; doc B is team-wide,
    // so the write leaks — Deny(std.no_leak).
    let summary = rt.engine.label_completion(
        &[ModelInput::Inline(doc_a.clone())],
        Chunk("summary of A".into()),
    );
    let write_args = args(vec![
        ("doc", ArgValue::Str("B".into())),
        ("content", ArgValue::Str("summary".into())),
    ]);
    let (write_effects, write_sink) = rt.sink_and_effects("drive.write_doc", &write_args);
    let beat2_deny = rt.engine.check_call(&CallSite::new(
        "drive.write_doc".into(),
        write_effects.clone(),
        summary.clone(),
        write_sink.clone(),
        write_args.clone(),
        principal.clone(),
    ));

    // Beat 3: declassify the summary via the sanitizer, then the write to doc B is allowed and the
    // audit records the declassifier that unblocked it.
    let declassified = declassify(&summary, &rt.declassifiers["san.redact"]);
    let beat3_declassified_ok = declassified.is_ok();
    let beat3_value = declassified.unwrap_or_else(|_| summary.clone());
    let mut beat3_call = CallSite::new(
        "drive.write_doc".into(),
        write_effects,
        beat3_value,
        write_sink,
        write_args,
        principal.clone(),
    );
    beat3_call.declassified_by = Some("san.redact".to_string());
    let beat3_allow = rt.engine.check_call(&beat3_call);

    // Beat 4: fetch a web page (tainted), digest it, email the digest internally. Tainted +
    // consequential escalates; the llm abstains on the tainted context, the human approves, and the
    // scope re-check allows.
    let web = rt.engine.label_result(
        &"web.fetch".to_string(),
        &args(vec![("url", ArgValue::Str("http://news.example".into()))]),
        Chunk(fixtures::INJECTION.into()),
    );
    let digest = rt
        .engine
        .label_completion(&[ModelInput::Inline(web.clone())], Chunk("digest of page".into()));
    let email_internal_args = args(vec![
        ("to", ArgValue::Subject(Subject::User("X".into()))),
        ("body", ArgValue::Str("digest".into())),
    ]);
    let (email_effects, sink4) = rt.sink_and_effects("email.send", &email_internal_args);
    let call4 = CallSite::new(
        "email.send".into(),
        email_effects.clone(),
        digest,
        sink4,
        email_internal_args,
        principal.clone(),
    );
    let beat4_escalate = rt.engine.check_call(&call4);
    let request = ApprovalRequest {
        tainted: call4.value.label.integrity == Integrity::Tainted,
        clock: 10,
    };
    // Witness the abstention directly against the llm approver, rather than inferring it from which
    // approver ended up granting — the latter would pass even if the llm were absent from the chain.
    let beat4_llm_abstained = matches!(
        rt.approvers
            .get("llm.judge")
            .expect("llm.judge registered")
            .decide(&request),
        Verdict::Abstain
    );
    // Run the chain the ENGINE returned (order preserved), not the config's, so the engine output is
    // what is exercised.
    let engine_chain = match &beat4_escalate {
        Decision::Escalate { chain, .. } => chain.clone(),
        other => return Err(format!("beat 4 expected Escalate, got {other:?}")),
    };
    let beat4_final = match run_chain(&engine_chain, &rt.approvers, &request) {
        ChainOutcome::Approved { approver, scope, .. } => rt.engine.finalize_escalation(
            &call4,
            rt.tainted_chain.0.clone(),
            beat4_escalate.id(),
            approver,
            &scope,
        ),
        ChainOutcome::Rejected { reason, .. } => {
            return Err(format!("beat 4 unexpectedly rejected: {reason}"));
        }
        ChainOutcome::Exhausted => return Err("beat 4 chain exhausted".into()),
    };

    // Beat 5: export a US record with region=EU. The region dimension leaks — pure lattice, no
    // custom rule: Deny(std.no_leak).
    let record = labeled(
        "customer record",
        Readers::Known([Subject::User("X".into())].into()),
        Integrity::Clean,
        BTreeMap::from([("region".to_string(), DimValue::val("US"))]),
    );
    let export_args = args(vec![
        ("region", ArgValue::Str("EU".into())),
        ("record", ArgValue::Str("row-1".into())),
    ]);
    let (crm_effects, crm_sink) = rt.sink_and_effects("crm.export", &export_args);
    let beat5_deny = rt.engine.check_call(&CallSite::new(
        "crm.export".into(),
        crm_effects,
        record,
        crm_sink,
        export_args,
        principal.clone(),
    ));

    // Beat 6: an unlabeled tool's result is Unknown; egressing it hits on_unknown → Deny.
    let dump = rt.engine.label_result(
        &"legacy.dump".to_string(),
        &BTreeMap::new(),
        Chunk("opaque legacy blob".into()),
    );
    let email_dump_args = args(vec![
        ("to", ArgValue::Subject(Subject::User("X".into()))),
        ("body", ArgValue::Str("dump".into())),
    ]);
    let (_e, sink6) = rt.sink_and_effects("email.send", &email_dump_args);
    let beat6_deny = rt.engine.check_call(&CallSite::new(
        "email.send".into(),
        email_effects.clone(),
        dump,
        sink6,
        email_dump_args,
        principal.clone(),
    ));

    // Beat 7: injection replay. The model "complies" and tries to email doc A content to an outsider.
    // The content is tainted by the injection context. Readers leak → Deny(std.no_leak); the llm
    // abstains on taint; and declassification is refused by the robust precondition.
    let exfil_label = {
        let lattice = Lattice::new(&rt.dir, &rt.dims);
        lattice.meet(&doc_a.label, &web.label)
    };
    let exfil = Labeled::new(Chunk("doc A contents".into()), exfil_label);
    let evil_args = args(vec![
        ("to", ArgValue::Str("evil@x.com".into())),
        ("body", ArgValue::Str("doc A".into())),
    ]);
    let (_e2, sink7) = rt.sink_and_effects("email.send", &evil_args);
    let beat7_deny = rt.engine.check_call(&CallSite::new(
        "email.send".into(),
        email_effects,
        exfil.clone(),
        sink7,
        evil_args,
        principal.clone(),
    ));
    let beat7_llm_abstains = matches!(
        rt.approvers
            .get("llm.judge")
            .expect("llm.judge registered")
            .decide(&ApprovalRequest { tainted: true, clock: 10 }),
        Verdict::Abstain
    );
    let beat7_declass_refused = declassify(&exfil, &rt.declassifiers["san.redact"]).is_err();

    // Beat 8: FakeRiskBert tightens risk to high; a risk:low sink then rejects it. And an owner-only
    // value cannot be sent to an org-labeled hook.
    let lattice = Lattice::new(&rt.dir, &rt.dims);
    let base = labeled(
        "please wire the transfer",
        Readers::Known([Subject::Any].into()),
        Integrity::Clean,
        BTreeMap::from([("risk".to_string(), DimValue::val("low"))]),
    );
    let tightened_label = apply_label_source(&rt.risk_bert, &base.label, &base.value, &lattice);
    let tightened = Labeled::new(base.value.clone(), tightened_label);
    let low_risk_sink = Label {
        readers: Readers::Known([Subject::Any].into()),
        integrity: Integrity::Clean,
        dims: BTreeMap::from([("risk".to_string(), DimValue::val("low"))]),
        provenance: vec![],
        provenance_truncated: false,
    };
    let beat8_risk_deny = rt.engine.check_call(&CallSite::new(
        "email.send".into(),
        [Effect::Egress].into(),
        tightened,
        low_risk_sink,
        BTreeMap::new(),
        principal.clone(),
    ));
    let org_hook = Hook::new(
        "audit.hook",
        Label {
            readers: Readers::Known([Subject::Org("acme".into())].into()),
            integrity: Integrity::Clean,
            dims: BTreeMap::new(),
            provenance: vec![],
            provenance_truncated: false,
        },
    );
    let owner_value = labeled(
        "owner-only secret",
        Readers::Known([Subject::User("X".into())].into()),
        Integrity::Clean,
        BTreeMap::new(),
    );
    let beat8_hook_verdict = org_hook.accepts(&owner_value, &lattice);

    let audit = rt.engine.audit().to_vec();

    Ok(Scenario {
        beat1_read: doc_a,
        beat2_deny,
        beat3_declassified_ok,
        beat3_allow,
        beat4_escalate,
        beat4_final,
        beat4_llm_abstained,
        beat5_deny,
        beat6_deny,
        beat7_deny,
        beat7_llm_abstains,
        beat7_declass_refused,
        beat8_risk_deny,
        beat8_hook_verdict,
        audit,
    })
}
