//! Declassification: the *only* sanctioned way to relax a label, and the robustness guarantee that
//! keeps it from being an exfiltration hole.

use crate::engine::{ApproverId, Decision, DeclassId, Remedy};
use crate::label::{Integrity, Label};
use crate::value::{Chunk, Labeled};

/// A witness that a declassifier requires `integrity == Clean`.
///
/// WHY a witness type: robust declassification means an adversary who *taints* content cannot launder
/// it through a declassifier. We make that unforgeable rather than checked — a [`DeclassRule`] has no
/// constructor that omits this field, so a declassifier that ignores integrity cannot be built at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CleanPrecondition;

pub type SanitizerFn = fn(&Chunk) -> Chunk;

/// Who is trusted to perform a declassification.
#[derive(Clone)]
pub enum DeclassAuthority {
    /// A pinned, deterministic transform (e.g. a redactor). `impl_pin` identifies the exact code.
    Sanitizer { impl_pin: String, f: SanitizerFn },
    Human,
    LlmJudge(ApproverId),
}

/// A declassification rule: an authority, the relaxed label it asserts, and the non-negotiable
/// clean-integrity precondition.
#[derive(Clone)]
pub struct DeclassRule {
    pub id: DeclassId,
    pub authority: DeclassAuthority,
    /// The label the authority asserts is safe for the declassified output.
    pub relabel: Label,
    /// Present by construction — robust declassification is a type-level guarantee.
    pub precondition: CleanPrecondition,
}

impl DeclassRule {
    pub fn new(id: impl Into<DeclassId>, authority: DeclassAuthority, relabel: Label) -> Self {
        DeclassRule {
            id: id.into(),
            authority,
            relabel,
            precondition: CleanPrecondition,
        }
    }
}

/// Attempt to declassify a value under a rule.
///
/// Robust precondition: tainted (or unknown-integrity) content is refused — the relabel would
/// otherwise let injected content escape at a relaxed level. On refusal the caller gets a `Deny`
/// explaining why, mirroring an engine decision.
pub fn declassify(v: &Labeled<Chunk>, rule: &DeclassRule) -> Result<Labeled<Chunk>, Decision> {
    // The presence of `rule.precondition` is what this check honors; it can never be absent.
    let CleanPrecondition = rule.precondition;
    if v.label.integrity != Integrity::Clean {
        return Err(Decision::Deny {
            id: u64::MAX,
            rule_id: "std.robust_declass".to_string(),
            reason: format!(
                "declassifier {} refuses non-clean content (integrity is {:?}, must be Clean)",
                rule.id, v.label.integrity
            ),
            residual: vec![Remedy::NarrowArgs(
                "sanitize or re-source the content so its integrity is Clean before declassifying"
                    .to_string(),
            )],
        });
    }
    let out = match &rule.authority {
        DeclassAuthority::Sanitizer { f, .. } => f(&v.value),
        // A human/LLM declassifier is an *authority* decision, not a pure transform: it must be routed
        // through the approver flow, which produces an audited verdict. Relabeling here without that
        // verdict would silently grant the relaxation, so this path is refused rather than faked.
        DeclassAuthority::Human | DeclassAuthority::LlmJudge(_) => {
            return Err(Decision::Deny {
                id: u64::MAX,
                rule_id: "std.declass_needs_authority".to_string(),
                reason: format!(
                    "declassifier {} requires a human/LLM authority verdict; route it through an approver",
                    rule.id
                ),
                residual: vec![Remedy::RequestApproval(rule.id.clone())],
            });
        }
    };
    Ok(Labeled::new(out, rule.relabel.clone()))
}
