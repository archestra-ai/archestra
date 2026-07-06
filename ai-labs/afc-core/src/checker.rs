//! The static checker (`afc check`).
//!
//! Given an [`Inventory`] — tool schemas, compiled rules, declassifiers, chains — it reports the ways
//! the policy is broken or under-specified. It reuses the very same rule evaluation the engine runs at
//! call time, so "is this leak path gated?" is answered by the real semantics, not a parallel model.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::directory::DirectorySnapshot;
use crate::engine::{ChainId, DeclassId};
use crate::label::{DimRegistry, Label};
use crate::lattice::{FlowClass, Lattice};
use crate::rule::{
    ArgType, Effect, EvalCtx, Outcome, Predicate, Principal, Rule, ToolId,
};

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub message: String,
}

/// A tool as the checker sees it.
pub struct ToolEntry {
    pub id: ToolId,
    pub effects: BTreeSet<Effect>,
    pub fields: BTreeMap<String, ArgType>,
    /// False for a tool with no annotation — an `UnlabeledTool` / Unknown tool.
    pub labeled: bool,
    /// Representative label a read tool yields (for leak-path reachability).
    pub produces: Option<Label>,
    /// Representative sink ceiling a write/egress tool imposes.
    pub sink: Option<Label>,
}

pub struct DeclassEntry {
    pub id: DeclassId,
    pub relabel: Label,
    pub robust: bool,
}

pub struct ChainEntry {
    pub id: ChainId,
    pub effect: Effect,
}

pub struct Inventory {
    pub tools: Vec<ToolEntry>,
    pub rules: Vec<Rule>,
    pub dims: DimRegistry,
    pub declassifiers: Vec<DeclassEntry>,
    pub chains: Vec<ChainEntry>,
    /// Active `Assume` overrides (ids), reported as a count.
    pub assumptions: Vec<String>,
    pub dir: DirectorySnapshot,
    pub principal: Principal,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct CheckReport {
    pub rule_count: usize,
    pub tool_count: usize,
    pub unlabeled_count: usize,
    pub assume_count: usize,
    /// Reachable leak paths that are gated by an escalation chain (the human-review surface).
    pub escalation_surface: usize,
    pub findings: Vec<Finding>,
}

impl CheckReport {
    pub fn has_errors(&self) -> bool {
        self.findings.iter().any(|f| f.severity == Severity::Error)
    }
}

pub fn check(inv: &Inventory) -> CheckReport {
    let mut findings = Vec::new();
    let tool_ids: BTreeSet<&ToolId> = inv.tools.iter().map(|t| &t.id).collect();

    check_rule_types(inv, &tool_ids, &mut findings);
    check_declassifiers(inv, &mut findings);

    let unlabeled_count = inv.tools.iter().filter(|t| !t.labeled).count();
    for tool in inv.tools.iter().filter(|t| !t.labeled) {
        findings.push(Finding {
            code: "TOOL-UNLABELED".to_string(),
            severity: Severity::Warn,
            message: format!(
                "tool `{}` has no annotation; its results are Unknown and egress is default-denied",
                tool.id
            ),
        });
    }

    check_leak_paths(inv, &mut findings);
    let escalation_surface = count_escalation_surface(inv);

    CheckReport {
        rule_count: inv.rules.len(),
        tool_count: inv.tools.len(),
        unlabeled_count,
        assume_count: inv.assumptions.len(),
        escalation_surface,
        findings,
    }
}

fn check_rule_types(
    inv: &Inventory,
    tool_ids: &BTreeSet<&ToolId>,
    findings: &mut Vec<Finding>,
) {
    for rule in &inv.rules {
        let mut tools_in_rule = BTreeSet::new();
        collect_tool_is(&rule.when, &mut tools_in_rule);

        // DeadRule: a rule pinned to a tool that does not exist can never match.
        for t in &tools_in_rule {
            if !tool_ids.contains(t) {
                findings.push(Finding {
                    code: "RUL-DEAD".to_string(),
                    severity: Severity::Warn,
                    message: format!("rule `{}` references unknown tool `{t}`", rule.id),
                });
            }
        }

        check_predicate_types(rule, &rule.when, inv, &tools_in_rule, findings);
    }
}

fn check_predicate_types(
    rule: &Rule,
    pred: &Predicate,
    inv: &Inventory,
    tools_in_rule: &BTreeSet<ToolId>,
    findings: &mut Vec<Finding>,
) {
    match pred {
        Predicate::ArgCmp(path, _, _) => {
            // The arg path must exist (with a matching type) in a tool this rule is scoped to. If the
            // rule names no tool, it must exist in *some* tool.
            let candidates: Vec<&ToolEntry> = if tools_in_rule.is_empty() {
                inv.tools.iter().collect()
            } else {
                inv.tools
                    .iter()
                    .filter(|t| tools_in_rule.contains(&t.id))
                    .collect()
            };
            let matches = candidates
                .iter()
                .any(|t| t.fields.get(&path.field) == Some(&path.ty));
            if !matches {
                findings.push(Finding {
                    code: "RUL-ARGCMP-PATH".to_string(),
                    severity: Severity::Error,
                    message: format!(
                        "rule `{}` compares argument `{}` ({:?}) which is not present with that type in {}",
                        rule.id,
                        path.field,
                        path.ty,
                        describe_tool_scope(tools_in_rule),
                    ),
                });
            }
        }
        Predicate::DimCmp { dim, .. } => {
            if !inv.dims.contains(dim) {
                findings.push(Finding {
                    code: "RUL-UNKNOWN-DIM".to_string(),
                    severity: Severity::Error,
                    message: format!("rule `{}` references undeclared dimension `{dim}`", rule.id),
                });
            }
        }
        Predicate::And(ps) | Predicate::Or(ps) => {
            for p in ps {
                check_predicate_types(rule, p, inv, tools_in_rule, findings);
            }
        }
        Predicate::Not(p) => check_predicate_types(rule, p, inv, tools_in_rule, findings),
        _ => {}
    }
}

fn check_declassifiers(inv: &Inventory, findings: &mut Vec<Finding>) {
    for d in &inv.declassifiers {
        // Robust declassification: a declassifier that does not require Clean integrity is illegal.
        // (In compiled IR `robust` is always true; the surface compiler is what can produce false.)
        if !d.robust {
            findings.push(Finding {
                code: "DCL-ROBUST".to_string(),
                severity: Severity::Error,
                message: format!(
                    "declassifier `{}` violates robust declassification: it must require integrity == Clean",
                    d.id
                ),
            });
        }
    }
}

/// The human-escalation surface: reachable paths that end in an escalation. A tainted-capable read
/// feeding a consequential sink triggers `std.no_tainted_consequential`, so each such pair is a place
/// a human may be asked to approve. This is the "reachable paths ending in Escalate" estimate.
fn count_escalation_surface(inv: &Inventory) -> usize {
    let tainted_reads = inv.tools.iter().filter(|t| {
        t.effects.contains(&Effect::Read)
            && t.produces.as_ref().is_some_and(|l| {
                matches!(l.integrity, crate::label::Integrity::Tainted | crate::label::Integrity::Unknown)
            })
    });
    let consequential_sinks = inv
        .tools
        .iter()
        .filter(|t| t.effects.contains(&Effect::Consequential))
        .count();
    tainted_reads.count() * consequential_sinks
}

/// Enumerate read→sink representative pairs and report any flow that neither succeeds, nor is denied
/// by a rule, nor is bridged by a declassifier.
fn check_leak_paths(inv: &Inventory, findings: &mut Vec<Finding>) {
    let lattice = Lattice::new(&inv.dir, &inv.dims);

    let reads: Vec<&ToolEntry> = inv
        .tools
        .iter()
        .filter(|t| t.effects.contains(&Effect::Read) && t.produces.is_some())
        .collect();
    let sinks: Vec<&ToolEntry> = inv
        .tools
        .iter()
        .filter(|t| {
            (t.effects.contains(&Effect::Write)
                || t.effects.contains(&Effect::Egress)
                || t.effects.contains(&Effect::Consequential))
                && t.sink.is_some()
        })
        .collect();

    for read in &reads {
        let produces = read.produces.as_ref().expect("filtered to produces.is_some");
        for sink in &sinks {
            let sink_label = sink.sink.as_ref().expect("filtered to sink.is_some");
            if lattice.flows_to(produces, sink_label).class() == FlowClass::Ok {
                continue; // no leak — nothing to gate.
            }
            if let Gate::Ungated = gate_for(inv, read, sink, produces, sink_label, &lattice) {
                findings.push(Finding {
                    code: "FLOW-UNGATED".to_string(),
                    severity: Severity::Error,
                    message: format!(
                        "ungated leak path: `{}` output can reach `{}` sink with no rule, chain, or declassifier covering it",
                        read.id, sink.id
                    ),
                });
            }
        }
    }
}

enum Gate {
    Forbidden,
    Escalated,
    Declassifiable,
    Ungated,
}

fn gate_for(
    inv: &Inventory,
    _read: &ToolEntry,
    sink: &ToolEntry,
    produces: &Label,
    sink_label: &Label,
    lattice: &Lattice,
) -> Gate {
    // Does a rule fire on the representative call? Reuse the engine's own predicate evaluation.
    let args = BTreeMap::new();
    let ctx = EvalCtx {
        tool: &sink.id,
        effects: &sink.effects,
        value: produces,
        sink: sink_label,
        principal: &inv.principal,
        args: &args,
        lattice: *lattice,
    };
    let mut escalated = false;
    for rule in &inv.rules {
        if rule.when.eval(&ctx) {
            match rule.then {
                Outcome::Forbid => return Gate::Forbidden,
                Outcome::Escalate(_) => escalated = true,
                Outcome::Warn => {}
            }
        }
    }
    // A chain registered for this sink's effect also gates the path (escalation surface).
    let chain_covers = inv
        .chains
        .iter()
        .any(|c| sink.effects.contains(&c.effect));
    if escalated || chain_covers {
        return Gate::Escalated;
    }
    // A declassifier bridges the leak if its relabeled output flows to the sink.
    if inv
        .declassifiers
        .iter()
        .any(|d| lattice.flows_to(&d.relabel, sink_label).class() == FlowClass::Ok)
    {
        return Gate::Declassifiable;
    }
    Gate::Ungated
}

fn collect_tool_is(pred: &Predicate, out: &mut BTreeSet<ToolId>) {
    match pred {
        Predicate::ToolIs(t) => {
            out.insert(t.clone());
        }
        Predicate::And(ps) | Predicate::Or(ps) => {
            for p in ps {
                collect_tool_is(p, out);
            }
        }
        Predicate::Not(p) => collect_tool_is(p, out),
        _ => {}
    }
}

fn describe_tool_scope(tools: &BTreeSet<ToolId>) -> String {
    if tools.is_empty() {
        "any tool".to_string()
    } else {
        format!(
            "tool(s) {}",
            tools.iter().cloned().collect::<Vec<_>>().join(", ")
        )
    }
}

/// A rule that is never satisfiable by construction (contradictory) — reported as `DeadRule`.
/// Kept as a helper for callers that build rules programmatically and want an early check.
pub fn is_trivially_dead(rule: &Rule, tool_ids: &BTreeSet<&ToolId>) -> bool {
    let mut tools = BTreeSet::new();
    collect_tool_is(&rule.when, &mut tools);
    tools.iter().any(|t| !tool_ids.contains(t))
}
