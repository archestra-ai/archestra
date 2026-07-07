//! The AFC gate for a live agent. It turns a model-requested tool call into an engine decision and,
//! only if allowed, dispatches it over MCP.
//!
//! IFC over an opaque model: the model passes tool arguments as plain strings, so provenance would be
//! lost. We reuse AFC's own completion semantics — a **session context** value accumulates every read
//! the model has seen (`label_completion` folds each read's label in, a monotone meet). Each
//! effectful call's value is the model's serialized arguments labeled with that context, so a
//! confidential read taints any later egress. This is a sound over-approximation, not token-level
//! tracking.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use afc_core::approver::{ApprovalRequest, ChainOutcome, run_chain};
use afc_core::engine::{CallSite, Decision, DecisionRecord, Engine};
use afc_core::label::{Integrity, Label, Readers};
use afc_core::rule::{ArgValue, Effect};
use afc_core::value::{Chunk, Labeled, ModelInput};
use eyre::{Result, bail, eyre};
use serde_json::{Map, Value};

use crate::catalog;
use crate::mcp_client::McpTools;
use crate::parity::ParityApprover;

/// The outcome of governing one model-requested tool call.
pub enum Governed {
    /// A pure-read tool: dispatched, its result labeled and folded into the session context.
    Read { text: String },
    /// An effectful tool the engine allowed (directly or via an approval chain): dispatched.
    Allowed { text: String },
    /// The engine denied the call — a rule `Deny`, or a rejected/exhausted approval chain.
    Denied { rule_id: String, text: String },
    /// The model named a tool that is not in the exposed catalog — never dispatched.
    Unknown { text: String },
}

impl Governed {
    /// The string the model sees back as the tool result.
    pub fn text(&self) -> &str {
        match self {
            Governed::Read { text }
            | Governed::Allowed { text }
            | Governed::Denied { text, .. }
            | Governed::Unknown { text } => text,
        }
    }
}

/// The shared, mutable governance state. Held behind a single async mutex so a concurrent tool-call
/// wave serializes through the gate: a read's taint is committed to the context before any later
/// call is checked.
pub struct GovernanceState {
    rt: afc_demo::Runtime,
    mcp: McpTools,
    context: Labeled<Chunk>,
    prompt_len: usize,
    trace: Vec<String>,
}

impl GovernanceState {
    /// Build the engine from the policy at `config_dir`, connect to the MCP server at `server_bin`,
    /// override `human.oncall` with the demo parity approver, and fail closed if any effectful tool
    /// lacks a resolvable sink.
    pub async fn new(config_dir: &Path, server_bin: &Path) -> Result<Self> {
        let mut rt = afc_demo::Runtime::from_config(config_dir, None).map_err(|e| eyre!(e))?;

        let scope = rt
            .approvers
            .get("human.oncall")
            .ok_or_else(|| eyre!("policy has no human.oncall approver to override"))?
            .scope()
            .clone();
        rt.approvers
            .register(Box::new(ParityApprover::new("human.oncall", scope)));

        for t in catalog::catalog() {
            let spec = rt
                .tools
                .get(t.afc_id)
                .ok_or_else(|| eyre!("exposed tool {} is not in the policy", t.afc_id))?;
            if is_effectful(&spec.effects) && spec.sink.is_none() {
                bail!(
                    "effectful tool {} has no sink annotation — refusing to run (fail closed)",
                    t.afc_id
                );
            }
        }

        let mcp = McpTools::connect(server_bin).await?;
        Ok(Self {
            rt,
            mcp,
            context: Labeled::new(Chunk(String::new()), Label::public()),
            prompt_len: 0,
            trace: Vec::new(),
        })
    }

    /// Set the length of the current task's prompt — what the parity approver observes.
    pub fn set_prompt_len(&mut self, n: usize) {
        self.prompt_len = n;
    }

    /// Reset the session context to public/clean (a fresh governed session for the next task).
    pub fn reset_context(&mut self) {
        self.context = Labeled::new(Chunk(String::new()), Label::public());
    }

    pub fn trace(&self) -> &[String] {
        &self.trace
    }

    pub fn audit(&self) -> &[DecisionRecord] {
        self.rt.engine.audit()
    }

    /// Govern one tool call. Pure reads are dispatched and labeled; effectful calls are checked
    /// before dispatch. The returned `Governed::text` is what the model receives.
    pub async fn govern(&mut self, tool_name: &str, args: Map<String, Value>) -> Result<Governed> {
        let Some(afc_id) = catalog::afc_id_for(tool_name) else {
            self.trace
                .push(format!("· {tool_name}: unknown tool — refused"));
            return Ok(Governed::Unknown {
                text: format!("Unknown tool {tool_name:?}; not dispatched."),
            });
        };
        let afc_args = to_afc_args(&args);
        let effects = self.rt.tool(afc_id).effects.clone();

        if !is_effectful(&effects) {
            let raw = self.mcp.call(tool_name, args).await?;
            let labeled =
                self.rt
                    .engine
                    .label_result(&afc_id.to_string(), &afc_args, Chunk(raw.clone()));
            self.fold_context(&labeled);
            self.trace.push(format!(
                "· {afc_id}: read → {}",
                render_label(&labeled.label)
            ));
            return Ok(Governed::Read { text: raw });
        }

        // Effectful: value = the model's serialized arguments, labeled with the session context.
        let value = Labeled::new(
            Chunk(serde_json::to_string(&args).unwrap_or_default()),
            self.context.label.clone(),
        );
        let (call_effects, sink) = self.rt.sink_and_effects(afc_id, &afc_args);
        let call = CallSite::new(
            afc_id.to_string(),
            call_effects,
            value,
            sink,
            afc_args,
            self.rt.principal.clone(),
        );

        let decision = self.rt.engine.check_call(&call);
        match decision {
            Decision::Allow { .. } => {
                self.dispatch_allowed(afc_id, tool_name, args, "Allow")
                    .await
            }
            Decision::Deny {
                rule_id, reason, ..
            } => Ok(self.deny(afc_id, &rule_id, &reason)),
            Decision::Escalate { id, chain } => {
                let req = ApprovalRequest {
                    tainted: call.value.label.integrity == Integrity::Tainted,
                    clock: 0,
                    prompt_len: self.prompt_len,
                };
                let chain_id = self.rt.tainted_chain.0.clone();
                let final_decision = match run_chain(&chain, &self.rt.approvers, &req) {
                    ChainOutcome::Approved { approver, scope } => self
                        .rt
                        .engine
                        .finalize_escalation(&call, chain_id, id, approver, &scope),
                    ChainOutcome::Rejected { approver, reason } => self
                        .rt
                        .engine
                        .finalize_rejection(&call, chain_id, id, Some(approver), reason),
                    ChainOutcome::Exhausted => self.rt.engine.finalize_rejection(
                        &call,
                        chain_id,
                        id,
                        None,
                        "no approver authorized the call".to_string(),
                    ),
                };
                match final_decision {
                    Decision::Allow { .. } => {
                        self.dispatch_allowed(afc_id, tool_name, args, "Escalate → approved")
                            .await
                    }
                    Decision::Deny {
                        rule_id, reason, ..
                    } => Ok(self.deny(afc_id, &rule_id, &reason)),
                    Decision::Escalate { .. } => bail!("finalize unexpectedly returned Escalate"),
                }
            }
        }
    }

    async fn dispatch_allowed(
        &mut self,
        afc_id: &str,
        tool_name: &str,
        args: Map<String, Value>,
        via: &str,
    ) -> Result<Governed> {
        let text = self.mcp.call(tool_name, args).await?;
        self.trace.push(format!("✓ {afc_id}: {via}"));
        Ok(Governed::Allowed { text })
    }

    fn deny(&mut self, afc_id: &str, rule_id: &str, reason: &str) -> Governed {
        self.trace.push(format!("⛔ {afc_id}: Deny ({rule_id})"));
        Governed::Denied {
            rule_id: rule_id.to_string(),
            text: format!("Blocked by AFC policy ({rule_id}): {reason}"),
        }
    }

    fn fold_context(&mut self, added: &Labeled<Chunk>) {
        let folded = self.rt.engine.label_completion(
            &[
                ModelInput::Inline(self.context.clone()),
                ModelInput::Inline(added.clone()),
            ],
            Chunk("session context".to_string()),
        );
        self.context = folded;
    }
}

fn is_effectful(effects: &BTreeSet<Effect>) -> bool {
    effects
        .iter()
        .any(|e| matches!(e, Effect::Write | Effect::Egress | Effect::Consequential))
}

fn to_afc_args(args: &Map<String, Value>) -> BTreeMap<String, ArgValue> {
    args.iter()
        .filter_map(|(k, v)| {
            v.as_str()
                .map(|s| (k.clone(), ArgValue::Str(s.to_string())))
        })
        .collect()
}

fn render_label(l: &Label) -> String {
    match &l.readers {
        Readers::Unknown => format!("readers=Unknown integrity={:?}", l.integrity),
        Readers::Known(s) => format!("readers={s:?} integrity={:?}", l.integrity),
    }
}
