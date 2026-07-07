//! The raw YAML authoring surface: the per-section serde types the single policy document
//! deserializes into. These carry no judgment — [`crate::compile`] turns them into afc-core IR.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct DimensionCfg {
    pub compat: CompatCfg,
    #[serde(default)]
    pub order: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum CompatCfg {
    Exact,
    AtMost,
}

#[derive(Debug, Deserialize)]
pub struct ToolCfg {
    pub effects: Vec<EffectCfg>,
    #[serde(default)]
    pub schema: BTreeMap<String, ArgTypeCfg>,
    /// tier of the result label source: `resolver` (tier2) or `static` (tier3). Absent → tier4 Unknown.
    #[serde(default)]
    pub label_source: Option<LabelSourceTierCfg>,
    /// tier3 static result label, when `label_source: static`.
    #[serde(default)]
    pub result: Option<LabelCfg>,
    #[serde(default)]
    pub sink: Option<SinkCfg>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectCfg {
    Read,
    Write,
    Egress,
    Consequential,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ArgTypeCfg {
    Str,
    Int,
    Subject,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum LabelSourceTierCfg {
    Resolver,
    Static,
}

#[derive(Debug, Deserialize, Clone)]
pub struct LabelCfg {
    #[serde(default)]
    pub readers: Option<ReadersCfg>,
    #[serde(default)]
    pub integrity: Option<IntegrityCfg>,
    #[serde(default)]
    pub dims: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadersCfg {
    Public,
    Unknown,
    Users { users: Vec<String> },
    Team { team: String },
    Org { org: String },
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum IntegrityCfg {
    Clean,
    Tainted,
    Unknown,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SinkCfg {
    pub readers: SinkReadersCfg,
    #[serde(default)]
    pub dims: BTreeMap<String, SinkDimCfg>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SinkReadersCfg {
    Public,
    Principal,
    FromArgAcl { field: String },
    FromArgRecipient { field: String },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SinkDimCfg {
    Static { value: String },
    FromArg { field: String },
}

#[derive(Debug, Deserialize)]
pub struct DeclassCfg {
    pub authority: AuthorityCfg,
    pub relabel: LabelCfg,
    pub precondition: PreconditionCfg,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthorityCfg {
    Sanitizer { impl_pin: String },
    Human,
    LlmJudge { approver: String },
}

#[derive(Debug, Deserialize)]
pub struct PreconditionCfg {
    pub integrity: IntegrityCfg,
}

#[derive(Debug, Deserialize)]
pub struct ChainCfg {
    pub on: ChainOnCfg,
    pub approvers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChainOnCfg {
    pub effect: EffectCfg,
    pub label_class: String,
}

#[derive(Debug, Deserialize)]
pub struct OnUnknownCfg {
    pub action: UnknownActionCfg,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum UnknownActionCfg {
    Forbid,
    Allow,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LabelSourceCfg {
    FakeRiskBert { keywords: Vec<String> },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApproverCfg {
    Human {
        #[serde(default)]
        auto_approve: bool,
        scope: ScopeCfg,
    },
    Llm {
        pin: String,
        budget: u32,
        #[serde(default)]
        requires_clean_context: bool,
        scope: ScopeCfg,
    },
    EuBusinessHours {
        open: u64,
        close: u64,
        scope: ScopeCfg,
    },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum ScopeCfg {
    /// The literal string `any` — an unbounded scope.
    Any(String),
    Tool {
        tool: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct GuardCfg {
    pub tool: String,
    pub arg: GuardArgCfg,
    pub op: OpCfg,
    pub value: String,
    pub outcome: OutcomeCfg,
}

#[derive(Debug, Deserialize)]
pub struct GuardArgCfg {
    pub field: String,
    #[serde(rename = "type")]
    pub ty: ArgTypeCfg,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum OpCfg {
    Eq,
    Ne,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeCfg {
    Forbid,
    Warn,
}
