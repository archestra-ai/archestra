//! The engine: it evaluates compiled rules over a resolved call site and records an audit trail.
//!
//! The engine holds no policy judgments of its own. `check_call` matches every rule, then merges the
//! matched outcomes mechanically: **forbid-wins, then escalate, else allow** — order-independent. What
//! counts as a leak, a taint, or an unknown lives entirely in the compiled [`Rule`]s.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::directory::DirectorySnapshot;
use crate::label::{DimRegistry, Label};
use crate::lattice::Lattice;
use crate::rule::{ArgValue, EvalCtx, Outcome, Predicate, Principal, Rule, RuleId, ToolId};
use crate::value::{Chunk, Labeled, ModelInput, label_completion};

pub type ChainId = String;
pub type DeclassId = String;
pub type ApproverId = String;

/// A remedy that could unblock a denied call.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Remedy {
    DeclassifyVia(DeclassId),
    RequestApproval(ChainId),
    NarrowArgs(String),
}

/// Why an `Allow` was granted beyond the plain no-rule-matched case.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum AllowVia {
    DeclassifiedBy(DeclassId),
    ApprovedBy(ChainId),
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Decision {
    Allow {
        id: u64,
        via: Option<AllowVia>,
    },
    Deny {
        id: u64,
        rule_id: RuleId,
        reason: String,
        residual: Vec<Remedy>,
    },
    Escalate {
        id: u64,
        chain: Vec<ApproverId>,
    },
}

impl Decision {
    pub fn id(&self) -> u64 {
        match self {
            Decision::Allow { id, .. }
            | Decision::Deny { id, .. }
            | Decision::Escalate { id, .. } => *id,
        }
    }
}

/// A fully-resolved call ready for checking. The caller (the tool layer) has already combined the
/// argument labels into `value` and resolved the tool's `sink` ceiling (including any `from_args`
/// fields) — sink resolution is data plumbing, not a judgment, so it lives outside the engine.
pub struct CallSite {
    pub tool: ToolId,
    pub effects: BTreeSet<crate::rule::Effect>,
    pub value: Labeled<Chunk>,
    pub sink: Label,
    pub args: BTreeMap<String, ArgValue>,
    pub principal: Principal,
    /// Set when `value` was produced by a declassifier, so an `Allow` can record the audit link.
    pub declassified_by: Option<DeclassId>,
}

impl CallSite {
    /// A call site with no prior declassification.
    pub fn new(
        tool: ToolId,
        effects: BTreeSet<crate::rule::Effect>,
        value: Labeled<Chunk>,
        sink: Label,
        args: BTreeMap<String, ArgValue>,
        principal: Principal,
    ) -> Self {
        CallSite {
            tool,
            effects,
            value,
            sink,
            args,
            principal,
            declassified_by: None,
        }
    }
}

/// How a tool's result is labeled, for tiers 1 and 3 of `label_result`.
#[derive(Clone, Default)]
pub struct ResultLabelSpec {
    /// Tier 1: label metadata carried by the tool result itself.
    pub meta: Option<Label>,
    /// Tier 3: a static fallback label declared for the tool.
    pub static_label: Option<Label>,
}

/// Tier 2: a dynamic resolver (e.g. an ACL lookup) that labels a result from its arguments.
pub trait ResultResolver {
    fn resolve(&self, tool: &ToolId, args: &BTreeMap<String, ArgValue>) -> Option<Label>;
}

/// A monotonic clock. Injected so audit timestamps (and the business-hours approver) are deterministic.
pub trait Clock {
    fn now(&self) -> u64;
}

/// A deterministic clock that advances one tick per read.
#[derive(Default)]
pub struct CounterClock {
    tick: std::cell::Cell<u64>,
}

impl Clock for CounterClock {
    fn now(&self) -> u64 {
        let t = self.tick.get();
        self.tick.set(t + 1);
        t
    }
}

/// The full audit entry for one decision.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub seq: u64,
    pub timestamp: u64,
    pub tool: ToolId,
    pub decision: DecisionKind,
    pub rule_id: Option<RuleId>,
    pub chain_id: Option<ChainId>,
    pub approver: Option<ApproverId>,
    pub label_in: Label,
    pub label_out: Label,
    pub snapshot_hash: String,
    /// Ids of `warn` rules that matched — advisory, they do not change the verdict.
    #[serde(default)]
    pub warnings: Vec<RuleId>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum DecisionKind {
    Allow,
    Deny,
    Escalate,
}

pub trait Engine {
    fn check_call(&mut self, call: &CallSite) -> Decision;
    fn label_result(
        &self,
        tool: &ToolId,
        args: &BTreeMap<String, ArgValue>,
        raw: Chunk,
    ) -> Labeled<Chunk>;
    fn label_completion(&self, inputs: &[ModelInput], out: Chunk) -> Labeled<Chunk>;
    fn audit(&self) -> &[DecisionRecord];
}

/// The concrete engine.
pub struct RuleEngine {
    rules: Vec<Rule>,
    dims: DimRegistry,
    dir: DirectorySnapshot,
    result_labels: BTreeMap<ToolId, ResultLabelSpec>,
    resolver: Option<Box<dyn ResultResolver>>,
    /// Remedy suggestions offered on every deny — the declassifiers and chains that *could* unblock.
    remedy_declassifiers: Vec<DeclassId>,
    remedy_chains: Vec<ChainId>,
    clock: Box<dyn Clock>,
    jsonl: Option<PathBuf>,
    log: Vec<DecisionRecord>,
    next_id: u64,
    /// Escalations awaiting approval: id → a fingerprint of the call that raised it.
    /// `finalize_escalation` consumes the entry only if the presented call matches the fingerprint,
    /// so an approval is bound to *that* call — it cannot be replayed or spent on a different call.
    pending_escalations: BTreeMap<u64, String>,
}

impl RuleEngine {
    pub fn new(rules: Vec<Rule>, dims: DimRegistry, dir: DirectorySnapshot) -> Self {
        RuleEngine {
            rules,
            dims,
            dir,
            result_labels: BTreeMap::new(),
            resolver: None,
            remedy_declassifiers: Vec::new(),
            remedy_chains: Vec::new(),
            clock: Box::new(CounterClock::default()),
            jsonl: None,
            log: Vec::new(),
            next_id: 0,
            pending_escalations: BTreeMap::new(),
        }
    }

    pub fn with_result_labels(mut self, labels: BTreeMap<ToolId, ResultLabelSpec>) -> Self {
        self.result_labels = labels;
        self
    }

    pub fn with_resolver(mut self, resolver: Box<dyn ResultResolver>) -> Self {
        self.resolver = Some(resolver);
        self
    }

    pub fn with_remedies(mut self, declassifiers: Vec<DeclassId>, chains: Vec<ChainId>) -> Self {
        self.remedy_declassifiers = declassifiers;
        self.remedy_chains = chains;
        self
    }

    pub fn with_clock(mut self, clock: Box<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn with_jsonl(mut self, path: PathBuf) -> Self {
        self.jsonl = Some(path);
        self
    }

    pub fn directory(&self) -> &DirectorySnapshot {
        &self.dir
    }

    pub fn dims(&self) -> &DimRegistry {
        &self.dims
    }

    fn lattice(&self) -> Lattice<'_> {
        Lattice::new(&self.dir, &self.dims)
    }

    fn residual(&self) -> Vec<Remedy> {
        // Every deny offers at least one remedy: the registered declassifiers, the chains, and a
        // NarrowArgs fallback so `residual` is never empty (an acceptance invariant).
        let mut remedies: Vec<Remedy> = self
            .remedy_declassifiers
            .iter()
            .cloned()
            .map(Remedy::DeclassifyVia)
            .collect();
        remedies.extend(
            self.remedy_chains
                .iter()
                .cloned()
                .map(Remedy::RequestApproval),
        );
        remedies.push(Remedy::NarrowArgs(
            "narrow the audience, region, or arguments so the value fits the sink".to_string(),
        ));
        remedies
    }

    /// Re-check an escalation after its approver chain has produced an approval.
    ///
    /// WHY the re-check: an approval authorizes *only* what its scope predicate covers, and it may
    /// never widen the sink ceiling. So we re-evaluate the scope against the same call and re-run the
    /// forbid pass; a `Forbid` that fires anyway still wins over the approval.
    ///
    /// `escalation_id` binds this approval to a *specific* prior `Escalate` decision: the escalation
    /// must still be pending AND the presented call must match the fingerprint of the call that raised
    /// it (same tool, args, sink, value label). It is consumed one-shot, so an approval cannot be
    /// replayed or spent on a different call.
    pub fn finalize_escalation(
        &mut self,
        call: &CallSite,
        chain_id: ChainId,
        escalation_id: u64,
        approver: ApproverId,
        scope: &Predicate,
    ) -> Decision {
        let id = self.take_id();
        // The approval must match the exact call that raised the escalation — same tool, args, sink,
        // and value label. This prevents approval *substitution*: spending an approval granted for one
        // call on a different in-scope call.
        let fingerprint_now = call_fingerprint(call);
        match self.pending_escalations.get(&escalation_id) {
            None => {
                let decision = Decision::Deny {
                    id,
                    rule_id: "engine.no_pending_escalation".to_string(),
                    reason: format!(
                        "escalation {escalation_id} is not pending (already discharged or never raised)"
                    ),
                    residual: self.residual(),
                };
                self.record(call, &decision, Some(chain_id), Some(approver), Vec::new());
                return decision;
            }
            Some(fingerprint) if *fingerprint != fingerprint_now => {
                // Leave the escalation pending: the legitimate approval for its own call is unspent.
                let decision = Decision::Deny {
                    id,
                    rule_id: "engine.approval_call_mismatch".to_string(),
                    reason: format!(
                        "approval for escalation {escalation_id} does not match the call it was raised on"
                    ),
                    residual: self.residual(),
                };
                self.record(call, &decision, Some(chain_id), Some(approver), Vec::new());
                return decision;
            }
            Some(_) => {
                self.pending_escalations.remove(&escalation_id);
            }
        }
        let within_scope = {
            let lattice = self.lattice();
            let ctx = ctx_for(call, lattice);
            scope.eval(&ctx) && self.matching_forbids(&ctx).is_empty()
        };
        let decision = if within_scope {
            Decision::Allow {
                id,
                via: Some(AllowVia::ApprovedBy(chain_id.clone())),
            }
        } else {
            Decision::Deny {
                id,
                rule_id: "engine.approval_out_of_scope".to_string(),
                reason: format!(
                    "approval by {approver} does not cover this call (scope re-check or forbid pass failed)"
                ),
                residual: self.residual(),
            }
        };
        self.record(call, &decision, Some(chain_id), Some(approver), Vec::new());
        decision
    }

    /// Finalize an escalation whose approver chain did NOT approve — an approver returned `Deny`
    /// (`Rejected`) or every approver abstained (`Exhausted`). Symmetric to
    /// [`RuleEngine::finalize_escalation`]: it consumes the same one-shot pending escalation (verifying
    /// the call fingerprint, so a rejection cannot be spent on a different call) and records an audited
    /// `Deny`. Without it a rejected chain would leave a dangling pending escalation with no decision.
    ///
    /// `approver` is `Some` for a `Rejected` outcome and `None` for `Exhausted`.
    pub fn finalize_rejection(
        &mut self,
        call: &CallSite,
        chain_id: ChainId,
        escalation_id: u64,
        approver: Option<ApproverId>,
        reason: String,
    ) -> Decision {
        let id = self.take_id();
        let fingerprint_now = call_fingerprint(call);
        match self.pending_escalations.get(&escalation_id) {
            None => {
                let decision = Decision::Deny {
                    id,
                    rule_id: "engine.no_pending_escalation".to_string(),
                    reason: format!(
                        "escalation {escalation_id} is not pending (already discharged or never raised)"
                    ),
                    residual: self.residual(),
                };
                self.record(call, &decision, Some(chain_id), approver, Vec::new());
                return decision;
            }
            Some(fingerprint) if *fingerprint != fingerprint_now => {
                // Leave the escalation pending: the legitimate outcome for its own call is unspent.
                let decision = Decision::Deny {
                    id,
                    rule_id: "engine.rejection_call_mismatch".to_string(),
                    reason: format!(
                        "rejection for escalation {escalation_id} does not match the call it was raised on"
                    ),
                    residual: self.residual(),
                };
                self.record(call, &decision, Some(chain_id), approver, Vec::new());
                return decision;
            }
            Some(_) => {
                self.pending_escalations.remove(&escalation_id);
            }
        }
        let decision = Decision::Deny {
            id,
            rule_id: "chain.rejected".to_string(),
            reason: match &approver {
                Some(a) => format!("escalation {escalation_id} rejected by {a}: {reason}"),
                None => format!("escalation {escalation_id} exhausted: {reason}"),
            },
            residual: self.residual(),
        };
        self.record(call, &decision, Some(chain_id), approver, Vec::new());
        decision
    }

    fn matching_forbids(&self, ctx: &EvalCtx) -> Vec<&Rule> {
        self.rules
            .iter()
            .filter(|r| matches!(r.then, Outcome::Forbid) && r.when.eval(ctx))
            .collect()
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn record(
        &mut self,
        call: &CallSite,
        decision: &Decision,
        chain_id: Option<ChainId>,
        approver: Option<ApproverId>,
        warnings: Vec<RuleId>,
    ) {
        let (kind, rule_id) = match decision {
            Decision::Allow { .. } => (DecisionKind::Allow, None),
            Decision::Deny { rule_id, .. } => (DecisionKind::Deny, Some(rule_id.clone())),
            Decision::Escalate { .. } => (DecisionKind::Escalate, None),
        };
        let record = DecisionRecord {
            seq: decision.id(),
            timestamp: self.clock.now(),
            tool: call.tool.clone(),
            decision: kind,
            rule_id,
            chain_id,
            approver,
            label_in: call.value.label.clone(),
            label_out: call.sink.clone(),
            snapshot_hash: self.dir.hash(),
            warnings,
        };
        if let Some(path) = &self.jsonl {
            append_jsonl(path, &record);
        }
        self.log.push(record);
    }
}

impl Engine for RuleEngine {
    fn check_call(&mut self, call: &CallSite) -> Decision {
        let id = self.take_id();
        let (mut forbids, mut escalates, mut warns): (Vec<&Rule>, Vec<&Rule>, Vec<&Rule>) =
            (Vec::new(), Vec::new(), Vec::new());
        {
            let lattice = self.lattice();
            let ctx = ctx_for(call, lattice);
            for rule in &self.rules {
                if rule.when.eval(&ctx) {
                    match &rule.then {
                        Outcome::Forbid => forbids.push(rule),
                        Outcome::Escalate(_) => escalates.push(rule),
                        Outcome::Warn => warns.push(rule),
                    }
                }
            }
        }
        // Warn rules do not change the verdict, but they are recorded so an authored `warn` guard is
        // never silently inert.
        let warnings: Vec<RuleId> = warns.iter().map(|r| r.id.clone()).collect();

        let decision = if !forbids.is_empty() {
            // forbid-wins, order-independent: sort by id so the recorded rule_id is deterministic.
            forbids.sort_by(|a, b| a.id.cmp(&b.id));
            let all_ids: Vec<&str> = forbids.iter().map(|r| r.id.as_str()).collect();
            Decision::Deny {
                id,
                rule_id: forbids[0].id.clone(),
                reason: format!("forbidden by {}", all_ids.join(", ")),
                residual: self.residual(),
            }
        } else if !escalates.is_empty() {
            // Union the approver chains, order-independent across rules (sorted by rule id) but
            // preserving each chain's internal order — the order approvers are consulted matters.
            escalates.sort_by(|a, b| a.id.cmp(&b.id));
            let mut chain: Vec<ApproverId> = Vec::new();
            for rule in &escalates {
                if let Outcome::Escalate(approvers) = &rule.then {
                    for approver in approvers {
                        if !chain.contains(approver) {
                            chain.push(approver.clone());
                        }
                    }
                }
            }
            self.pending_escalations.insert(id, call_fingerprint(call));
            Decision::Escalate { id, chain }
        } else {
            // A call may carry a prior declassification; stamp the audit link when it is allowed.
            let via = call.declassified_by.clone().map(AllowVia::DeclassifiedBy);
            Decision::Allow { id, via }
        };

        self.record(call, &decision, None, None, warnings);
        decision
    }

    fn label_result(
        &self,
        tool: &ToolId,
        args: &BTreeMap<String, ArgValue>,
        raw: Chunk,
    ) -> Labeled<Chunk> {
        // tier1 meta → tier2 resolver → tier3 static → tier4 Unknown.
        let label = self
            .result_labels
            .get(tool)
            .and_then(|spec| spec.meta.clone())
            .or_else(|| self.resolver.as_ref().and_then(|r| r.resolve(tool, args)))
            .or_else(|| {
                self.result_labels
                    .get(tool)
                    .and_then(|spec| spec.static_label.clone())
            })
            .unwrap_or_else(Label::unknown);
        Labeled::new(raw, label)
    }

    fn label_completion(&self, inputs: &[ModelInput], out: Chunk) -> Labeled<Chunk> {
        label_completion(inputs, out, &self.lattice())
    }

    fn audit(&self) -> &[DecisionRecord] {
        &self.log
    }
}

/// Build the evaluation context for a call site under a lattice.
fn ctx_for<'a>(call: &'a CallSite, lattice: Lattice<'a>) -> EvalCtx<'a> {
    EvalCtx {
        tool: &call.tool,
        effects: &call.effects,
        value: &call.value.label,
        sink: &call.sink,
        principal: &call.principal,
        args: &call.args,
        lattice,
    }
}

/// A stable identity for a call: its tool, args, sink, and value label. Used to bind an approval to
/// the exact call that was escalated. (The value's content is excluded — the label is what governs.)
fn call_fingerprint(call: &CallSite) -> String {
    serde_json::to_string(&(&call.tool, &call.args, &call.sink, &call.value.label))
        .expect("call components are serializable")
}

/// Best-effort audit append. A verdict must never depend on audit I/O succeeding, so a failure here
/// is reported to stderr and the decision still stands — it is surfaced, never silently swallowed.
fn append_jsonl(path: &PathBuf, record: &DecisionRecord) {
    let line = serde_json::to_string(record).expect("decision record is serializable");
    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(e) = result {
        eprintln!("afc: failed to append decision to {}: {e}", path.display());
    }
}
