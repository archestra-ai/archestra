//! Turn a compiled policy + fixtures into a running engine, approver registry, declassifiers, and
//! label sources. This is the "data plumbing" layer: it resolves sinks and result labels, which is
//! deliberately outside the judgment-free kernel.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use afc_core::declassify::{DeclassAuthority, DeclassRule};
use afc_core::directory::DirectorySnapshot;
use afc_core::engine::{ResultLabelSpec, ResultResolver, RuleEngine};
use afc_core::hook::FakeRiskBert;
use afc_core::label::{DimRegistry, DimValue, Label, Readers, Subject};
use afc_core::rule::{ArgValue, Principal, ToolId};
use afc_core::value::Chunk;
use afc_surface::{
    ApproverSpec, CompiledPolicy, DeclassAuthoritySpec, ResultTier, SinkDim, SinkReaders, ToolSpec,
    compile_dir,
};

use crate::fixtures;

/// Everything needed to run the scenario.
pub struct Runtime {
    pub engine: RuleEngine,
    pub approvers: afc_core::approver::ApproverRegistry,
    pub declassifiers: BTreeMap<String, DeclassRule>,
    pub risk_bert: FakeRiskBert,
    pub tools: BTreeMap<ToolId, ToolSpec>,
    pub dims: DimRegistry,
    pub dir: DirectorySnapshot,
    pub principal: Principal,
    /// The (chain id, approver ids) that `std.no_tainted_consequential` escalates to.
    pub tainted_chain: (String, Vec<String>),
    doc_acls: BTreeMap<String, Readers>,
}

/// A tier-2 resolver: labels a `drive.read_doc` result from the fixture ACL of the doc it read.
struct DriveAclResolver {
    doc_acls: BTreeMap<String, Readers>,
}

impl ResultResolver for DriveAclResolver {
    fn resolve(&self, tool: &ToolId, args: &BTreeMap<String, ArgValue>) -> Option<Label> {
        if tool != "drive.read_doc" {
            return None;
        }
        let doc = as_str(args.get("doc")?)?;
        let readers = self.doc_acls.get(doc)?.clone();
        Some(Label {
            readers,
            integrity: afc_core::label::Integrity::Clean,
            dims: BTreeMap::new(),
            provenance: vec![afc_core::label::SourceRef(format!("drive.read_doc:{doc}"))],
            provenance_truncated: false,
        })
    }
}

fn redact(c: &Chunk) -> Chunk {
    Chunk(format!("[redacted summary, {} chars]", c.0.len()))
}

/// Resolve a sanitizer impl by its pin. Unknown pins are refused (return `None`) — falling back to an
/// identity transform would let a typo'd pin launder confidential content through the declassifier.
fn sanitizer_fn(impl_pin: &str) -> Option<fn(&Chunk) -> Chunk> {
    match impl_pin {
        "redact@1" => Some(redact),
        _ => None,
    }
}

impl Runtime {
    pub fn from_config(config_dir: &Path, jsonl: Option<PathBuf>) -> Result<Self, String> {
        let policy = compile_dir(config_dir).map_err(|e| e.to_string())?;
        Self::from_policy(policy, jsonl)
    }

    pub fn from_policy(policy: CompiledPolicy, jsonl: Option<PathBuf>) -> Result<Self, String> {
        let dir = fixtures::directory();
        let doc_acls = fixtures::doc_acls();
        let principal = fixtures::principal();

        let tools: BTreeMap<ToolId, ToolSpec> =
            policy.tools.into_iter().map(|t| (t.id.clone(), t)).collect();

        // tier1 meta / tier3 static result labels, from the annotations.
        let mut result_labels = BTreeMap::new();
        for (id, tool) in &tools {
            if let ResultTier::Static(label) = &tool.result {
                result_labels.insert(
                    id.clone(),
                    ResultLabelSpec {
                        meta: None,
                        static_label: Some(label.clone()),
                    },
                );
            }
        }

        let mut declassifiers: BTreeMap<String, DeclassRule> = BTreeMap::new();
        for spec in policy.declassifiers {
            let authority = match &spec.authority {
                DeclassAuthoritySpec::Sanitizer { impl_pin } => {
                    let f = sanitizer_fn(impl_pin).ok_or_else(|| {
                        format!(
                            "declassifier `{}` pins unknown sanitizer impl `{impl_pin}`; refusing to load",
                            spec.id
                        )
                    })?;
                    DeclassAuthority::Sanitizer {
                        impl_pin: impl_pin.clone(),
                        f,
                    }
                }
                DeclassAuthoritySpec::Human => DeclassAuthority::Human,
                DeclassAuthoritySpec::LlmJudge { approver } => {
                    DeclassAuthority::LlmJudge(approver.clone())
                }
            };
            declassifiers.insert(spec.id.clone(), DeclassRule::new(spec.id, authority, spec.relabel));
        }

        let declass_ids: Vec<String> = declassifiers.keys().cloned().collect();
        let chain_ids: Vec<String> = policy.chains.iter().map(|c| c.id.clone()).collect();

        let approvers = build_approvers(&policy.approvers);

        let risk_bert = policy
            .label_sources
            .iter()
            .find(|s| !s.keywords.is_empty())
            .map(|s| FakeRiskBert::new(s.keywords.clone()))
            .unwrap_or_else(|| FakeRiskBert::new(vec![]));

        let tainted_chain = policy
            .chains
            .iter()
            .find(|c| c.effect == afc_core::rule::Effect::Consequential && c.label_class == "tainted")
            .map(|c| (c.id.clone(), c.approvers.clone()))
            .unwrap_or_else(|| ("tainted_consequential".to_string(), vec![]));

        let mut engine = RuleEngine::new(policy.rules, policy.dims.clone(), dir.clone())
            .with_result_labels(result_labels)
            .with_resolver(Box::new(DriveAclResolver {
                doc_acls: doc_acls.clone(),
            }))
            .with_remedies(declass_ids, chain_ids);
        if let Some(path) = jsonl {
            engine = engine.with_jsonl(path);
        }

        Ok(Runtime {
            engine,
            approvers,
            declassifiers,
            risk_bert,
            tools,
            dims: policy.dims,
            dir,
            principal,
            tainted_chain,
            doc_acls,
        })
    }

    /// Resolve the sink ceiling for a governed call from its annotation, args, and the principal.
    pub fn resolve_sink(&self, tool: &ToolSpec, args: &BTreeMap<String, ArgValue>) -> Label {
        let sink = tool
            .sink
            .as_ref()
            .expect("resolve_sink called on a tool without a sink annotation");
        let readers = match &sink.readers {
            SinkReaders::Public => Readers::Known([Subject::Any].into()),
            SinkReaders::Principal => Readers::Known([self.principal.subject.clone()].into()),
            SinkReaders::FromArgAcl(field) => args
                .get(field)
                .and_then(as_str)
                .and_then(|doc| self.doc_acls.get(doc).cloned())
                .unwrap_or(Readers::Unknown),
            SinkReaders::FromArgRecipient(field) => match args.get(field) {
                Some(ArgValue::Subject(s)) => Readers::Known([s.clone()].into()),
                Some(ArgValue::Str(email)) => {
                    Readers::Known([Subject::User(email.clone())].into())
                }
                _ => Readers::Unknown,
            },
        };
        let mut dims = BTreeMap::new();
        for (id, sd) in &sink.dims {
            let value = match sd {
                SinkDim::Static(v) => v.clone(),
                SinkDim::FromArg(field) => args
                    .get(field)
                    .and_then(as_str)
                    .map(DimValue::val)
                    .unwrap_or(DimValue::Conflict),
            };
            dims.insert(id.clone(), value);
        }
        Label {
            readers,
            integrity: afc_core::label::Integrity::Clean,
            dims,
            provenance: Vec::new(),
            provenance_truncated: false,
        }
    }

    pub fn tool(&self, id: &str) -> &ToolSpec {
        self.tools.get(id).expect("tool present in annotations")
    }

    /// Resolve a governed call's effects and sink ceiling together, returning owned values so the
    /// caller can then mutably borrow the engine to `check_call`.
    pub fn sink_and_effects(
        &self,
        tool_id: &str,
        args: &BTreeMap<String, ArgValue>,
    ) -> (std::collections::BTreeSet<afc_core::rule::Effect>, Label) {
        let tool = self.tool(tool_id);
        (tool.effects.clone(), self.resolve_sink(tool, args))
    }
}

fn build_approvers(specs: &[ApproverSpec]) -> afc_core::approver::ApproverRegistry {
    use afc_core::approver::{
        ApproverRegistry, Budget, EuBusinessHours, HumanApprover, LlmApprover, Verdict,
    };
    let mut registry = ApproverRegistry::new();
    for spec in specs {
        match spec {
            ApproverSpec::Human {
                id,
                scope,
                auto_approve,
            } => registry.register(Box::new(HumanApprover::new(
                id.clone(),
                scope.clone(),
                *auto_approve,
            ))),
            ApproverSpec::Llm {
                id,
                pin,
                scope,
                budget,
                requires_clean_context,
            } => registry.register(Box::new(LlmApprover::new(
                id.clone(),
                pin.clone(),
                scope.clone(),
                Budget::new(*budget),
                *requires_clean_context,
            ))),
            ApproverSpec::EuBusinessHours {
                id,
                scope,
                open,
                close,
            } => registry.register(Box::new(EuBusinessHours::new(
                id.clone(),
                scope.clone(),
                *open,
                *close,
                Verdict::Abstain,
            ))),
        }
    }
    registry
}

pub fn as_str(v: &ArgValue) -> Option<&str> {
    match v {
        ArgValue::Str(s) => Some(s),
        _ => None,
    }
}
