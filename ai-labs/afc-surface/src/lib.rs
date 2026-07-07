//! # afc-surface
//!
//! The authoring surface: YAML config → afc-core IR. This crate is where policy is *written*; the
//! kernel stays judgment-free by having every rule — including the stdlib `std.no_leak` and
//! `std.no_tainted_consequential` — emitted here rather than baked into the engine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::de::DeserializeOwned;

use afc_core::label::{DimDecl, DimRegistry, DimValue, Integrity, Label, Readers, Subject};
use afc_core::rule::{
    ArgType, ArgValue, CmpOp, Effect, Outcome, Predicate, Rule, RuleOrigin, TypedPath, ValueExpr,
};

pub mod config;
pub mod error;

pub use error::SurfaceError;

use config::*;

/// Everything the demo/CLI need to stand up an engine, plus the compiled rule set.
pub struct CompiledPolicy {
    pub dims: DimRegistry,
    pub rules: Vec<Rule>,
    pub tools: Vec<ToolSpec>,
    pub declassifiers: Vec<DeclassSpec>,
    pub chains: Vec<ChainSpec>,
    pub approvers: Vec<ApproverSpec>,
    pub label_sources: Vec<LabelSourceSpec>,
    pub on_unknown: OnUnknownSpec,
}

pub struct ToolSpec {
    pub id: String,
    pub effects: BTreeSet<Effect>,
    pub fields: BTreeMap<String, ArgType>,
    pub result: ResultTier,
    pub sink: Option<SinkSpec>,
    pub labeled: bool,
}

/// The result-labeling tier declared for a tool (tiers 1/2/3; absence is tier 4 Unknown).
pub enum ResultTier {
    Resolver,
    Static(Label),
    Unknown,
}

pub struct SinkSpec {
    pub readers: SinkReaders,
    pub dims: BTreeMap<String, SinkDim>,
}

pub enum SinkReaders {
    Public,
    Principal,
    FromArgAcl(String),
    FromArgRecipient(String),
}

pub enum SinkDim {
    Static(DimValue),
    FromArg(String),
}

pub struct DeclassSpec {
    pub id: String,
    pub authority: DeclassAuthoritySpec,
    pub relabel: Label,
    pub robust: bool,
}

pub enum DeclassAuthoritySpec {
    Sanitizer { impl_pin: String },
    Human,
    LlmJudge { approver: String },
}

pub struct ChainSpec {
    pub id: String,
    pub effect: Effect,
    pub label_class: String,
    pub approvers: Vec<String>,
}

pub enum ApproverSpec {
    Human {
        id: String,
        scope: Predicate,
        auto_approve: bool,
    },
    Llm {
        id: String,
        pin: String,
        scope: Predicate,
        budget: u32,
        requires_clean_context: bool,
    },
    EuBusinessHours {
        id: String,
        scope: Predicate,
        open: u64,
        close: u64,
    },
}

pub struct LabelSourceSpec {
    pub id: String,
    pub keywords: Vec<String>,
}

pub struct OnUnknownSpec {
    pub forbid: bool,
    pub assumptions: Vec<(String, Label)>,
}

/// The parsed (but not yet compiled) policy document — one section per top-level key. `assume` and
/// `guards` default to empty; the other sections are required.
#[derive(Debug, serde::Deserialize)]
pub struct SurfaceConfig {
    pub dimensions: BTreeMap<String, DimensionCfg>,
    pub tools: BTreeMap<String, ToolCfg>,
    pub declassifiers: BTreeMap<String, DeclassCfg>,
    pub chains: BTreeMap<String, ChainCfg>,
    pub on_unknown: OnUnknownCfg,
    #[serde(default)]
    pub assume: BTreeMap<String, LabelCfg>,
    pub label_sources: BTreeMap<String, LabelSourceCfg>,
    pub approvers: BTreeMap<String, ApproverCfg>,
    #[serde(default)]
    pub guards: BTreeMap<String, GuardCfg>,
}

/// Load and compile a policy file in one step.
pub fn compile_file(path: &Path) -> Result<CompiledPolicy, SurfaceError> {
    compile(read_yaml(path)?)
}

/// Compile parsed config into afc-core IR + specs.
pub fn compile(cfg: SurfaceConfig) -> Result<CompiledPolicy, SurfaceError> {
    let dims = compile_dims(&cfg.dimensions);
    let tools = compile_tools(&cfg.tools, &dims)?;
    let declassifiers = compile_declassifiers(&cfg.declassifiers, &dims)?;
    let chains = compile_chains(&cfg.chains, &cfg.approvers)?;
    let tool_ids: BTreeSet<String> = tools.iter().map(|t| t.id.clone()).collect();
    let approvers = compile_approvers(&cfg.approvers, &tool_ids)?;
    let label_sources = compile_label_sources(&cfg.label_sources);
    let on_unknown = compile_on_unknown(&cfg.on_unknown, &cfg.assume, &dims)?;

    let mut rules = Vec::new();
    rules.push(rule_no_leak());
    rules.push(rule_no_tainted_consequential(&chains));
    if on_unknown.forbid {
        rules.push(rule_on_unknown());
    }
    rules.extend(compile_guards(&cfg.guards)?);

    Ok(CompiledPolicy {
        dims,
        rules,
        tools,
        declassifiers,
        chains,
        approvers,
        label_sources,
        on_unknown,
    })
}

fn compile_dims(dimensions: &BTreeMap<String, DimensionCfg>) -> DimRegistry {
    let mut m = BTreeMap::new();
    for (id, cfg) in dimensions {
        let compat = match cfg.compat {
            CompatCfg::Exact => afc_core::label::DimCompat::Exact,
            CompatCfg::AtMost => afc_core::label::DimCompat::AtMost,
        };
        m.insert(
            id.clone(),
            DimDecl {
                compat,
                order: cfg.order.clone(),
            },
        );
    }
    DimRegistry(m)
}

fn compile_tools(
    tools_cfg: &BTreeMap<String, ToolCfg>,
    dims: &DimRegistry,
) -> Result<Vec<ToolSpec>, SurfaceError> {
    let mut tools = Vec::new();
    for (id, cfg) in tools_cfg {
        let effects = cfg.effects.iter().map(effect_of).collect();
        let fields: BTreeMap<String, ArgType> = cfg
            .schema
            .iter()
            .map(|(k, v)| (k.clone(), arg_type_of(*v)))
            .collect();
        let result = match cfg.label_source {
            Some(LabelSourceTierCfg::Resolver) => ResultTier::Resolver,
            Some(LabelSourceTierCfg::Static) => {
                let label = cfg
                    .result
                    .as_ref()
                    .map(|l| compile_label(l, dims, id))
                    .transpose()?
                    .unwrap_or_else(Label::public);
                ResultTier::Static(label)
            }
            None => ResultTier::Unknown,
        };
        let sink = cfg
            .sink
            .as_ref()
            .map(|s| compile_sink(s, dims, &fields, id))
            .transpose()?;
        tools.push(ToolSpec {
            id: id.clone(),
            effects,
            fields,
            result,
            sink,
            labeled: cfg.label_source.is_some() || cfg.sink.is_some(),
        });
    }
    Ok(tools)
}

fn compile_sink(
    cfg: &SinkCfg,
    registry: &DimRegistry,
    fields: &BTreeMap<String, ArgType>,
    tool: &str,
) -> Result<SinkSpec, SurfaceError> {
    // Any `from_arg*` field a sink reads must exist in the tool's schema; otherwise the field name is
    // a typo that resolves to Unknown/Conflict at runtime and denies, invisibly to `afc check`.
    let require_field = |field: &str| -> Result<(), SurfaceError> {
        if fields.contains_key(field) {
            Ok(())
        } else {
            Err(SurfaceError::UnknownArgField {
                tool: tool.to_string(),
                field: field.to_string(),
            })
        }
    };
    let readers = match &cfg.readers {
        SinkReadersCfg::Public => SinkReaders::Public,
        SinkReadersCfg::Principal => SinkReaders::Principal,
        SinkReadersCfg::FromArgAcl { field } => {
            require_field(field)?;
            SinkReaders::FromArgAcl(field.clone())
        }
        SinkReadersCfg::FromArgRecipient { field } => {
            require_field(field)?;
            SinkReaders::FromArgRecipient(field.clone())
        }
    };
    let mut dims = BTreeMap::new();
    for (id, dc) in &cfg.dims {
        // A sink cannot constrain an undeclared dimension — the lattice would treat a typo as an
        // exact match and give it meaning at runtime.
        if !registry.contains(id) {
            return Err(SurfaceError::UnknownDimension {
                dim: id.clone(),
                whence: "sink".to_string(),
            });
        }
        let sd = match dc {
            SinkDimCfg::Static { value } => SinkDim::Static(DimValue::val(value.clone())),
            SinkDimCfg::FromArg { field } => {
                require_field(field)?;
                SinkDim::FromArg(field.clone())
            }
        };
        dims.insert(id.clone(), sd);
    }
    Ok(SinkSpec { readers, dims })
}

fn compile_declassifiers(
    declassifiers: &BTreeMap<String, DeclassCfg>,
    dims: &DimRegistry,
) -> Result<Vec<DeclassSpec>, SurfaceError> {
    let mut out = Vec::new();
    for (id, cfg) in declassifiers {
        // Robust declassification: the precondition MUST require Clean integrity. A config that asks
        // to declassify tainted content is rejected here — it can never be compiled into an IR rule.
        if !matches!(cfg.precondition.integrity, IntegrityCfg::Clean) {
            return Err(SurfaceError::IllegalDeclass { id: id.clone() });
        }
        let authority = match &cfg.authority {
            AuthorityCfg::Sanitizer { impl_pin } => DeclassAuthoritySpec::Sanitizer {
                impl_pin: impl_pin.clone(),
            },
            AuthorityCfg::Human => DeclassAuthoritySpec::Human,
            AuthorityCfg::LlmJudge { approver } => DeclassAuthoritySpec::LlmJudge {
                approver: approver.clone(),
            },
        };
        out.push(DeclassSpec {
            id: id.clone(),
            authority,
            relabel: compile_label(&cfg.relabel, dims, id)?,
            robust: true,
        });
    }
    Ok(out)
}

fn compile_chains(
    chains: &BTreeMap<String, ChainCfg>,
    approvers: &BTreeMap<String, ApproverCfg>,
) -> Result<Vec<ChainSpec>, SurfaceError> {
    let mut out = Vec::new();
    for (id, cfg) in chains {
        for a in &cfg.approvers {
            if !approvers.contains_key(a) {
                return Err(SurfaceError::UnknownApprover {
                    id: id.clone(),
                    approver: a.clone(),
                });
            }
        }
        out.push(ChainSpec {
            id: id.clone(),
            effect: effect_of(&cfg.on.effect),
            label_class: cfg.on.label_class.clone(),
            approvers: cfg.approvers.clone(),
        });
    }
    Ok(out)
}

fn compile_approvers(
    approvers: &BTreeMap<String, ApproverCfg>,
    tool_ids: &BTreeSet<String>,
) -> Result<Vec<ApproverSpec>, SurfaceError> {
    let mut out = Vec::new();
    for (id, cfg) in approvers {
        let spec = match cfg {
            ApproverCfg::Human {
                auto_approve,
                scope,
            } => ApproverSpec::Human {
                id: id.clone(),
                scope: compile_scope(scope, id, tool_ids)?,
                auto_approve: *auto_approve,
            },
            ApproverCfg::Llm {
                pin,
                budget,
                requires_clean_context,
                scope,
            } => ApproverSpec::Llm {
                id: id.clone(),
                pin: pin.clone(),
                scope: compile_scope(scope, id, tool_ids)?,
                budget: *budget,
                requires_clean_context: *requires_clean_context,
            },
            ApproverCfg::EuBusinessHours { open, close, scope } => ApproverSpec::EuBusinessHours {
                id: id.clone(),
                scope: compile_scope(scope, id, tool_ids)?,
                open: *open,
                close: *close,
            },
        };
        out.push(spec);
    }
    Ok(out)
}

fn compile_label_sources(label_sources: &BTreeMap<String, LabelSourceCfg>) -> Vec<LabelSourceSpec> {
    label_sources
        .iter()
        .map(|(id, cfg)| match cfg {
            LabelSourceCfg::FakeRiskBert { keywords } => LabelSourceSpec {
                id: id.clone(),
                keywords: keywords.clone(),
            },
        })
        .collect()
}

fn compile_on_unknown(
    on_unknown: &OnUnknownCfg,
    assume: &BTreeMap<String, LabelCfg>,
    dims: &DimRegistry,
) -> Result<OnUnknownSpec, SurfaceError> {
    let forbid = matches!(on_unknown.action, UnknownActionCfg::Forbid);
    let mut assumptions = Vec::new();
    for (tool, label) in assume {
        assumptions.push((tool.clone(), compile_label(label, dims, tool)?));
    }
    Ok(OnUnknownSpec {
        forbid,
        assumptions,
    })
}

fn compile_guards(guards: &BTreeMap<String, GuardCfg>) -> Result<Vec<Rule>, SurfaceError> {
    let mut out = Vec::new();
    for (id, cfg) in guards {
        let ty = arg_type_of(cfg.arg.ty);
        let value =
            match ty {
                ArgType::Str => ArgValue::Str(cfg.value.clone()),
                ArgType::Int => ArgValue::Int(cfg.value.parse().map_err(|_| {
                    SurfaceError::InvalidGuardValue {
                        guard: id.clone(),
                        value: cfg.value.clone(),
                        ty: "int".to_string(),
                    }
                })?),
                ArgType::Subject => ArgValue::Subject(Subject::User(cfg.value.clone())),
            };
        let op = match cfg.op {
            OpCfg::Eq => CmpOp::Eq,
            OpCfg::Ne => CmpOp::Ne,
        };
        let outcome = match cfg.outcome {
            OutcomeCfg::Forbid => Outcome::Forbid,
            OutcomeCfg::Warn => Outcome::Warn,
        };
        out.push(Rule {
            id: id.clone(),
            when: Predicate::And(vec![
                Predicate::ToolIs(cfg.tool.clone()),
                Predicate::ArgCmp(
                    TypedPath {
                        field: cfg.arg.field.clone(),
                        ty,
                    },
                    op,
                    ValueExpr::Lit(value),
                ),
            ]),
            then: outcome,
            origin: RuleOrigin::Org,
        });
    }
    Ok(out)
}

// --- stdlib rule generators -------------------------------------------------

fn governed_effects() -> Predicate {
    Predicate::Or(vec![
        Predicate::HasEffect(Effect::Write),
        Predicate::HasEffect(Effect::Egress),
        Predicate::HasEffect(Effect::Consequential),
    ])
}

/// `std.no_leak`: a governed sink refuses a value whose flow classifies as a leak (readers or dims).
fn rule_no_leak() -> Rule {
    Rule {
        id: "std.no_leak".to_string(),
        when: Predicate::And(vec![
            governed_effects(),
            Predicate::FlowIs(afc_core::lattice::FlowClass::Leak),
        ]),
        then: Outcome::Forbid,
        origin: RuleOrigin::Stdlib,
    }
}

/// `std.no_tainted_consequential`: a consequential action on tainted content escalates to the chain
/// registered for (consequential, tainted).
fn rule_no_tainted_consequential(chains: &[ChainSpec]) -> Rule {
    let chain = chains
        .iter()
        .find(|c| c.effect == Effect::Consequential && c.label_class == "tainted")
        .map(|c| c.approvers.clone())
        .unwrap_or_default();
    Rule {
        id: "std.no_tainted_consequential".to_string(),
        when: Predicate::And(vec![
            Predicate::HasEffect(Effect::Consequential),
            Predicate::IntegrityIs(Integrity::Tainted),
        ]),
        then: Outcome::Escalate(chain),
        origin: RuleOrigin::Stdlib,
    }
}

/// `on_unknown.egress`: an under-determined (NeedsPolicy) value at a governed sink is forbidden. This
/// is how "default-deny for governed effects" is expressed — as a rule, not an engine judgment.
fn rule_on_unknown() -> Rule {
    Rule {
        id: "on_unknown.egress".to_string(),
        when: Predicate::And(vec![
            governed_effects(),
            Predicate::FlowIs(afc_core::lattice::FlowClass::NeedsPolicy),
        ]),
        then: Outcome::Forbid,
        origin: RuleOrigin::Org,
    }
}

// --- small compilers --------------------------------------------------------

fn compile_scope(
    scope: &ScopeCfg,
    approver: &str,
    tool_ids: &BTreeSet<String>,
) -> Result<Predicate, SurfaceError> {
    match scope {
        // Only the literal `any` is an unbounded scope. Any other bare string is a typo (e.g. a
        // misspelled tool name) that must fail closed rather than silently become unbounded.
        ScopeCfg::Any(s) if s == "any" => Ok(Predicate::And(vec![])),
        ScopeCfg::Any(s) => Err(SurfaceError::InvalidScope {
            approver: approver.to_string(),
            scope: s.clone(),
        }),
        // A tool scope must name a real tool, or the approver silently governs nothing.
        ScopeCfg::Tool { tool } if !tool_ids.contains(tool) => {
            Err(SurfaceError::UnknownScopeTool {
                approver: approver.to_string(),
                tool: tool.clone(),
            })
        }
        ScopeCfg::Tool { tool } => Ok(Predicate::ToolIs(tool.clone())),
    }
}

fn compile_label(cfg: &LabelCfg, dims: &DimRegistry, whence: &str) -> Result<Label, SurfaceError> {
    let readers = match &cfg.readers {
        None => Readers::Known(BTreeSet::from([Subject::Any])),
        Some(ReadersCfg::Public) => Readers::Known(BTreeSet::from([Subject::Any])),
        Some(ReadersCfg::Unknown) => Readers::Unknown,
        Some(ReadersCfg::Users { users }) => {
            Readers::Known(users.iter().cloned().map(Subject::User).collect())
        }
        Some(ReadersCfg::Team { team }) => {
            Readers::Known(BTreeSet::from([Subject::Team(team.clone())]))
        }
        Some(ReadersCfg::Org { org }) => {
            Readers::Known(BTreeSet::from([Subject::Org(org.clone())]))
        }
    };
    let integrity = match cfg.integrity {
        None | Some(IntegrityCfg::Clean) => Integrity::Clean,
        Some(IntegrityCfg::Tainted) => Integrity::Tainted,
        Some(IntegrityCfg::Unknown) => Integrity::Unknown,
    };
    let mut dim_map = BTreeMap::new();
    for (id, value) in &cfg.dims {
        if !dims.contains(id) {
            return Err(SurfaceError::UnknownDimension {
                dim: id.clone(),
                whence: whence.to_string(),
            });
        }
        dim_map.insert(id.clone(), DimValue::val(value.clone()));
    }
    Ok(Label {
        readers,
        integrity,
        dims: dim_map,
        provenance: Vec::new(),
        provenance_truncated: false,
    })
}

fn effect_of(cfg: &EffectCfg) -> Effect {
    match cfg {
        EffectCfg::Read => Effect::Read,
        EffectCfg::Write => Effect::Write,
        EffectCfg::Egress => Effect::Egress,
        EffectCfg::Consequential => Effect::Consequential,
    }
}

fn arg_type_of(cfg: ArgTypeCfg) -> ArgType {
    match cfg {
        ArgTypeCfg::Str => ArgType::Str,
        ArgTypeCfg::Int => ArgType::Int,
        ArgTypeCfg::Subject => ArgType::Subject,
    }
}

fn read_yaml<T: DeserializeOwned>(path: &Path) -> Result<T, SurfaceError> {
    let text = std::fs::read_to_string(path).map_err(|source| SurfaceError::Io {
        path: path.display().to_string(),
        source,
    })?;
    serde_yaml::from_str(&text).map_err(|source| SurfaceError::Parse {
        path: path.display().to_string(),
        source,
    })
}
