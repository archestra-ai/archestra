use crate::{
    errors::invalid_input,
    operations::{YellArguments, proposed, required_arguments},
};
use appa_runtime::api::ExecuteRemedyPlanArgs;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Route resolved from the proxy-stamped trajectory and the session row, plus
/// the original call's retry text recovered from that call's stored context.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfferOwner {
    pub organization_id: String,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub root: String,
    pub tool: Option<String>,
    pub spelling: Option<String>,
    /// Client spelling of the dispatch tool (`run_tool`) used for this call.
    /// Retries use the same tool.
    pub dispatch: Option<String>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OfferId(pub String);

/// The current trajectory the proxy stamps on a remedy. Not a client claim.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrajectoryStamp {
    pub(crate) v: u8,
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RulingInput {
    Approve,
    Deny,
}

/// Request payload to execute a remedy by offer ID.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OfferInput {
    pub(crate) organization_id: String,
    /// Authenticated spender, recorded on a caller-bound receipt. Absent for an
    /// anonymous organization token; never compared to an offer owner.
    #[serde(default)]
    pub(crate) caller_id: Option<String>,
    pub(crate) trajectory: TrajectoryStamp,
    /// Client tool call ID for binding durable remedy receipts.
    #[serde(default)]
    pub(crate) tool_call_id: Option<String>,
    pub(crate) arguments: Box<RawValue>,
    pub(crate) execution_mode: ExecutionMode,
    /// Original argument JSON string before execution metadata stripping.
    pub(crate) original_arguments: String,
    pub(crate) presentation: PresentationInput,
    #[serde(default)]
    pub(crate) ruling: Option<RulingInput>,
    /// Explains why the host did not prompt for human review.
    /// Used when the target call would fail even if approved.
    /// Recorded as the remedy result.
    #[serde(default)]
    pub(crate) precheck_refusal: Option<String>,
    /// As on [`Input`]: a remedy's consults are recorded like any dispatch's.
    #[serde(default)]
    pub(crate) withhold_consult_content: bool,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionMode {
    Tracked,
    Untracked,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct YellReceiver {
    port: u16,
    token: String,
}

impl YellReceiver {
    pub(crate) fn endpoint(&self) -> napi::Result<String> {
        if self.port == 0
            || self.token.len() != 64
            || !self.token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid_input("invalid host yell receiver"));
        }
        Ok(format!("http://127.0.0.1:{}/{}", self.port, self.token))
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    /// Host-only loopback capture endpoint; never part of model tool arguments.
    #[serde(default)]
    pub(crate) yell_receiver: Option<YellReceiver>,
    pub(crate) organization_id: String,
    #[serde(default)]
    pub(crate) caller_id: Option<String>,
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
    /// The email of the user the session acts for, on every event: whichever event
    /// opens the session names it as the session principal. A session opened
    /// without one never gains one.
    #[serde(default)]
    pub(crate) principal: Option<String>,
    /// The session this one forks. Set on a new session whose history traces
    /// to an earlier session by the same caller. Its first event opens a root
    /// initialized from that session's state. Mutually exclusive with `parent_id`.
    #[serde(default)]
    pub(crate) fork_of: Option<String>,
    pub(crate) event: HookEventKind,
    #[serde(default)]
    pub(crate) operation_id: Option<String>,
    #[serde(default)]
    pub(crate) tool_call_id: Option<String>,
    #[serde(default)]
    pub(crate) tool: Option<String>,
    #[serde(default)]
    pub(crate) arguments: Option<Box<RawValue>>,
    /// The semantic input before a gateway strips transport-only execution
    /// metadata. Durable remedy receipts fingerprint this whole value.
    #[serde(default)]
    pub(crate) original_arguments: Option<Box<RawValue>>,
    #[serde(default)]
    pub(crate) spawn: bool,
    #[serde(default)]
    pub(crate) output: Option<String>,
    /// Fully scoped child trajectory on a parent-side SpawnResult.
    #[serde(default)]
    pub(crate) spawned_id: Option<String>,
    /// Raw spawn-call id, not `call:<id>`. A ChildEnd retains it so the parent
    /// can bind a returned value without a carrier. A child's first event uses
    /// it to load the sealed binding on the parent's `call:<id>` receipt.
    #[serde(default)]
    pub(crate) spawn_call_id: Option<String>,
    /// Client-native child identity a ChildEnd answers, retained likewise.
    #[serde(default)]
    pub(crate) child_native_id: Option<String>,
    #[serde(default)]
    pub(crate) outcome: Option<ExecutionOutcome>,
    #[serde(skip_deserializing, default)]
    pub(crate) owner_root: Option<String>,
    #[serde(default)]
    pub(crate) spelling: Option<String>,
    #[serde(default)]
    pub(crate) dispatch: Option<String>,
    #[serde(default)]
    pub(crate) presentation: Option<PresentationInput>,
    #[serde(default)]
    pub(crate) ruling: Option<RulingInput>,
    #[serde(default)]
    pub(crate) precheck_refusal: Option<String>,
    /// The host's Log Content mode is Metadata only: this dispatch's consult
    /// rows keep no content.
    #[serde(default)]
    pub(crate) withhold_consult_content: bool,
}

/// Maximum byte length for precheck refusal text.
/// Refusal text is recorded and replayed verbatim as the remedy result.
pub(crate) const MAX_PRECHECK_REFUSAL_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HookEventKind {
    SessionStart,
    ToolCall,
    ToolResult,
    CancelCall,
    Remedy,
    Yell,
    Prompt,
    TurnEnd,
    ChildEnd,
    /// A return that does not end the child. The value crosses as a stop's
    /// would. Open tool calls stay open; the runtime refuses the return until
    /// they report.
    ChildReturn,
    /// A parent addresses a child it already started, as when a lead sends
    /// its teammate a message: the parent's current label flows into the
    /// child. `spawned_id` names the child session and `output` the message,
    /// which the operation retains so the child's side can verify it.
    ChildAddress,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionOutcome {
    Success,
    Failure,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PresentationInput {
    pub(crate) control_tool: String,
    pub(crate) supports_delegation: bool,
    /// The reporting tool a block names, spelled the way the model calls it. Absent when
    /// reporting is off, and then a block does not mention it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) yell_tool: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecordedCall {
    pub(crate) tool: String,
    pub(crate) arguments: Box<RawValue>,
    #[serde(default)]
    pub(crate) spawn: bool,
    #[serde(default)]
    pub(crate) presentation: Option<PresentationInput>,
    /// Host retry text. Absent on rows written before it was stored. Not part
    /// of the call the runtime judges, so a result does not read them; they
    /// are accepted so a stored context still decodes.
    #[serde(default)]
    #[allow(dead_code)]
    spelling: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    dispatch: Option<String>,
}

pub(crate) fn required<'a>(value: &'a Option<String>, name: &str) -> napi::Result<&'a str> {
    value
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid_input(format!("missing {name}")))
}
/// Validates input fields and event requirements before processing.
pub(crate) fn validate(input: &Input) -> napi::Result<()> {
    // A session id may carry the proxy's principal scope in front of the id
    // the client named, so it gets the same room as the other identities.
    for (name, value, limit) in [
        ("organization", &input.organization_id, 512),
        ("session", &input.session_id, 1024),
    ] {
        if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err(invalid_input(format!("invalid {name} identity")));
        }
    }
    for (name, value) in [
        ("caller", &input.caller_id),
        ("parent", &input.parent_id),
        ("fork", &input.fork_of),
        ("operation", &input.operation_id),
        ("tool call", &input.tool_call_id),
        ("spawn call", &input.spawn_call_id),
    ] {
        if let Some(value) = value
            && (value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control))
        {
            return Err(invalid_input(format!("invalid {name} identity")));
        }
    }
    if let Some(presentation) = &input.presentation
        && (presentation.control_tool.is_empty()
            || presentation.control_tool.len() > 1024
            || presentation.control_tool.chars().any(char::is_control))
    {
        return Err(invalid_input("invalid control tool presentation"));
    }
    if let Some(yell) = input
        .presentation
        .as_ref()
        .and_then(|presentation| presentation.yell_tool.as_ref())
        && (yell.is_empty() || yell.len() > 1024 || yell.chars().any(char::is_control))
    {
        return Err(invalid_input("invalid yell tool presentation"));
    }
    for (name, value) in [
        ("tool spelling", &input.spelling),
        ("dispatch tool", &input.dispatch),
    ] {
        if let Some(value) = value
            && (value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control))
        {
            return Err(invalid_input(format!("invalid {name}")));
        }
    }
    if let Some(refusal) = &input.precheck_refusal {
        // A refusal answers a remedy no human ruled on, so a ruling beside
        // it would be silently dropped.
        if input.event != HookEventKind::Remedy || input.ruling.is_some() {
            return Err(invalid_input(
                "a precheck refusal only answers an unruled remedy",
            ));
        }
        if refusal.trim().is_empty() || refusal.len() > MAX_PRECHECK_REFUSAL_BYTES {
            return Err(invalid_input("invalid precheck refusal"));
        }
    }
    // Reject malformed host requests before writing an interrupted-operation
    // receipt. A typo is not evidence that an external consult may have run.
    match input.event {
        HookEventKind::SessionStart => {}
        HookEventKind::ToolResult => {
            required(&input.tool_call_id, "tool_call_id")?;
            if input.output.is_none() {
                return Err(invalid_input("missing output"));
            }
        }
        HookEventKind::CancelCall => {
            required(&input.tool_call_id, "tool_call_id")?;
        }
        HookEventKind::ToolCall => {
            let operation = required(&input.operation_id, "operation_id")?;
            if !operation.starts_with("call:") || operation == "call:" {
                return Err(invalid_input(
                    "tool call operation_id must be call:<tool-call-id>",
                ));
            }
            proposed(input)?;
        }
        HookEventKind::Yell => {
            required(&input.operation_id, "operation_id")?;
            let _: YellArguments =
                serde_json::from_str(required_arguments(input)?).map_err(invalid_input)?;
        }
        HookEventKind::Remedy => {
            let _: ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(input)?).map_err(invalid_input)?;
        }
        HookEventKind::Prompt | HookEventKind::TurnEnd | HookEventKind::ChildEnd => {
            required(&input.operation_id, "operation_id")?;
        }
        HookEventKind::ChildReturn => {
            required(&input.operation_id, "operation_id")?;
            required(&input.parent_id, "parent_id")?;
            if input.output.is_none() {
                return Err(invalid_input("missing output"));
            }
        }
        HookEventKind::ChildAddress => {
            required(&input.operation_id, "operation_id")?;
            let child = required(&input.spawned_id, "spawned_id")?;
            if child.len() > 1024 || child.chars().any(char::is_control) {
                return Err(invalid_input("invalid child identity"));
            }
            if input.output.is_none() {
                return Err(invalid_input("missing output"));
            }
        }
    }
    Ok(())
}
