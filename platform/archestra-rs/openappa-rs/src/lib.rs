//! Archestra's host boundary. Policy evaluation and event serialization live in
//! OpenAPPA; identity, call correlation and durable processing receipts live here.

mod policy;

use appa_eventlog::{
    Backend, LogStore,
    postgres::{
        OfferOwnerKey, OfferOwnerRecord, OperationClaim, OperationKey, OperationRequest,
        PostgresError, PostgresStore, ProcessedResultClaim, ProcessedResultKey,
        ProcessedResultRequest, ReceiptBinding, ReceiptScope,
    },
};
use appa_runtime::{
    api::{
        EmbeddedPresentationOptions, ExecuteRemedyPlanArgs, RemedyOutcome, RemedyPresentation,
        RemedyRefusal, Runtime,
    },
    config::Config,
    hooks,
};
use appa_runtime_api::{
    Actor, HookDecision, HookEvent, OutcomeBody, ProposedCall, SpawnRef, ToolOutcome, TrajectoryId,
    WireDecision,
};
use futures_util::FutureExt;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
};
use tokio::sync::Mutex;

#[napi(object)]
#[derive(Clone)]
pub struct ReportingOptions {
    pub endpoint: String,
    pub hostname: Option<String>,
}

/// Process-wide runtime slot. The mutex covers initialize, policy reload, and
/// panic rebuild. Dispatch clones `State` and drops the lock before any await;
/// PostgreSQL session locks serialize one trajectory, and `Runtime` is internally
/// synchronized.
static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

#[derive(Clone)]
struct State {
    runtime: Arc<Runtime>,
    config: Config,
    store: Arc<LogStore>,
    policy_content: String,
    reporting: Option<ReportingOptions>,
}

fn state_mutex() -> &'static Mutex<Option<State>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Identity context associated with a denial offer for cross-replica routing.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfferOwner {
    pub organization_id: String,
    pub caller_id: Option<String>,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub root: String,
    pub arguments: Option<String>,
    pub tool: Option<String>,
    pub spelling: Option<String>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OfferId(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Principal {
    User(String),
    App(String),
    VirtualKey(String),
    Opaque(String),
}

impl Principal {
    fn parse(value: &str) -> napi::Result<Self> {
        let parsed = if let Some(id) = value.strip_prefix("user:") {
            Self::User(id.to_owned())
        } else if let Some(id) = value.strip_prefix("app:") {
            Self::App(id.to_owned())
        } else if let Some(id) = value.strip_prefix("virtual-key:") {
            Self::VirtualKey(id.to_owned())
        } else {
            Self::Opaque(value.to_owned())
        };
        if matches!(&parsed, Self::User(id) | Self::App(id) | Self::VirtualKey(id) if id.is_empty())
        {
            return Err(error("invalid caller identity"));
        }
        Ok(parsed)
    }
}

/// Request payload to execute a remedy by offer ID.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OfferInput {
    organization_id: String,
    /// Authenticated caller identity.
    #[serde(default)]
    caller_id: Option<String>,
    /// Client tool call ID for binding durable remedy receipts.
    #[serde(default)]
    tool_call_id: Option<String>,
    arguments: Box<RawValue>,
    execution_mode: ExecutionMode,
    /// Original argument JSON string before execution metadata stripping.
    original_arguments: String,
    presentation: PresentationInput,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExecutionMode {
    Tracked,
    Untracked,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    organization_id: String,
    #[serde(default)]
    caller_id: Option<String>,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    event: HookEventKind,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    arguments: Option<Box<RawValue>>,
    /// The semantic input before a gateway strips transport-only execution
    /// metadata. Durable remedy receipts fingerprint this whole value.
    #[serde(default)]
    original_arguments: Option<Box<RawValue>>,
    #[serde(default)]
    spawn: bool,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    outcome: Option<ExecutionOutcome>,
    #[serde(skip_deserializing, default)]
    owner_root: Option<String>,
    #[serde(default)]
    spelling: Option<String>,
    #[serde(default)]
    presentation: Option<PresentationInput>,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum HookEventKind {
    SessionStart,
    ToolCall,
    ToolResult,
    CancelCall,
    Remedy,
    Yell,
    Prompt,
    TurnEnd,
    ChildEnd,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExecutionOutcome {
    Success,
    Failure,
    Unknown,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PresentationInput {
    control_tool: String,
    supports_delegation: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedCall {
    tool: String,
    arguments: Box<RawValue>,
    #[serde(default)]
    spawn: bool,
    #[serde(default)]
    presentation: Option<PresentationInput>,
}

fn error(message: impl ToString) -> napi::Error {
    napi::Error::from_reason(message.to_string())
}
fn required<'a>(value: &'a Option<String>, name: &str) -> napi::Result<&'a str> {
    value
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(format!("missing {name}")))
}
fn wire(decision: &HookDecision) -> napi::Result<Value> {
    serde_json::to_value(WireDecision::of(decision)).map_err(error)
}

fn receipt_scope(input: &Input, binding: ReceiptBinding) -> ReceiptScope {
    ReceiptScope {
        organization_id: input.organization_id.clone(),
        caller_id: input.caller_id.clone(),
        session_id: input.session_id.clone(),
        binding,
    }
}

fn presentation_options(input: &Input) -> EmbeddedPresentationOptions {
    input
        .presentation
        .as_ref()
        .map_or_else(native_presentation_options, |presentation| {
            EmbeddedPresentationOptions {
                control_tool: presentation.control_tool.clone(),
                supports_delegation: presentation.supports_delegation,
                include_display_plan: true,
            }
        })
}

fn result_presentation_options(input: &Input, call: &RecordedCall) -> EmbeddedPresentationOptions {
    input
        .presentation
        .as_ref()
        .or(call.presentation.as_ref())
        .map_or_else(native_presentation_options, |presentation| {
            EmbeddedPresentationOptions {
                control_tool: presentation.control_tool.clone(),
                supports_delegation: presentation.supports_delegation,
                include_display_plan: true,
            }
        })
}

fn native_presentation_options() -> EmbeddedPresentationOptions {
    // Default presentation options without delegation transport.
    EmbeddedPresentationOptions {
        supports_delegation: false,
        include_display_plan: true,
        ..EmbeddedPresentationOptions::default()
    }
}

fn postgres_store(store: &LogStore) -> napi::Result<&PostgresStore> {
    store
        .postgres()
        .ok_or_else(|| error("OpenAPPA requires PostgreSQL storage"))
}
fn identity(input: &Input) -> String {
    format!(
        "archestra:{:x}",
        Sha256::digest(input.session_id.as_bytes())
    )
}

#[napi(js_name = "initializeOpenappa")]
pub async fn initialize_openappa(
    database_url: String,
    policy_content: String,
    reporting: Option<ReportingOptions>,
) -> napi::Result<()> {
    let mut slot = state_mutex().lock().await;
    if slot.is_some() {
        return Ok(());
    }
    let state = tokio::task::spawn_blocking(move || -> napi::Result<State> {
        appa_runtime::tls::install_crypto_provider();
        let mut config = policy::compile(&policy_content).map_err(error)?;
        config.reporting.agent_yell = reporting.is_some();
        let store =
            Arc::new(LogStore::open(Backend::Postgres { url: database_url }).map_err(error)?);
        let runtime =
            Runtime::open_with_store(config.clone(), store.clone(), None).map_err(error)?;
        Ok(State {
            runtime: Arc::new(runtime),
            config,
            store,
            policy_content,
            reporting,
        })
    })
    .await
    .map_err(error)??;
    *slot = Some(state);
    Ok(())
}

#[napi(js_name = "validateOpenappaPolicy")]
pub async fn validate_openappa_policy(content: String) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| policy::validate(&content))
            .map(|result| result.err().into_iter().collect())
            .map_err(|_| error("OpenAPPA policy validation failed"))
    })
    .await
    .map_err(error)?
}

#[napi(js_name = "dispatchHook")]
pub async fn dispatch_hook(input: String, policy_content: Option<String>) -> napi::Result<String> {
    let input: Input = serde_json::from_str(&input).map_err(error)?;
    validate(&input)?;
    run(input, policy_content).await
}

/// Validates input fields and event requirements before processing.
fn validate(input: &Input) -> napi::Result<()> {
    // A session id may carry the proxy's principal scope in front of the id
    // the client named, so it gets the same room as the other identities.
    for (name, value, limit) in [
        ("organization", &input.organization_id, 512),
        ("session", &input.session_id, 1024),
    ] {
        if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err(error(format!("invalid {name} identity")));
        }
    }
    for (name, value) in [
        ("caller", &input.caller_id),
        ("parent", &input.parent_id),
        ("operation", &input.operation_id),
        ("tool call", &input.tool_call_id),
    ] {
        if let Some(value) = value
            && (value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control))
        {
            return Err(error(format!("invalid {name} identity")));
        }
    }
    if let Some(presentation) = &input.presentation
        && (presentation.control_tool.is_empty()
            || presentation.control_tool.len() > 1024
            || presentation.control_tool.chars().any(char::is_control))
    {
        return Err(error("invalid control tool presentation"));
    }
    if let Some(spelling) = &input.spelling
        && (spelling.is_empty() || spelling.len() > 1024 || spelling.chars().any(char::is_control))
    {
        return Err(error("invalid tool spelling"));
    }
    // Reject malformed host requests before writing an interrupted-operation
    // receipt. A typo is not evidence that an external consult may have run.
    match input.event {
        HookEventKind::SessionStart => {}
        HookEventKind::ToolResult => {
            required(&input.tool_call_id, "tool_call_id")?;
            if input.output.is_none() {
                return Err(error("missing output"));
            }
        }
        HookEventKind::CancelCall => {
            required(&input.tool_call_id, "tool_call_id")?;
        }
        HookEventKind::ToolCall => {
            let operation = required(&input.operation_id, "operation_id")?;
            if !operation.starts_with("call:") || operation == "call:" {
                return Err(error("tool call operation_id must be call:<tool-call-id>"));
            }
            proposed(input)?;
        }
        HookEventKind::Yell => {
            required(&input.operation_id, "operation_id")?;
            let _: YellArguments =
                serde_json::from_str(required_arguments(input)?).map_err(error)?;
        }
        HookEventKind::Remedy => {
            let _: ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(input)?).map_err(error)?;
        }
        HookEventKind::Prompt | HookEventKind::TurnEnd | HookEventKind::ChildEnd => {
            required(&input.operation_id, "operation_id")?;
        }
    }
    Ok(())
}

/// Runs one validated event against the shared runtime.
async fn run(input: Input, policy_content: Option<String>) -> napi::Result<String> {
    let result = AssertUnwindSafe(async {
        let state = {
            let mut slot = state_mutex().lock().await;
            let state = slot
                .as_mut()
                .ok_or_else(|| error("OpenAPPA is not initialized"))?;
            if let Some(content) = policy_content
                && content != state.policy_content
            {
                let mut config = policy::compile(&content).map_err(error)?;
                config.reporting.agent_yell = state.reporting.is_some();
                state.runtime.reload(config.clone()).map_err(error)?;
                state.config = config;
                state.policy_content = content;
            }
            state.clone()
        };
        state.dispatch(input).await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(Ok(value)) => Ok(value.to_string()),
        failure => {
            // A rollback must also discard tentative in-memory vouches and
            // turn markers. Durable pending receipts remain fail-closed.
            let mut slot = state_mutex().lock().await;
            if let Some(state) = slot.as_mut() {
                let rebuilt =
                    Runtime::open_with_store(state.config.clone(), state.store.clone(), None)
                        .map_err(error)?;
                state.runtime = Arc::new(rebuilt);
            }
            match failure {
                Ok(Err(error)) => Err(error),
                _ => Err(error("OpenAPPA panicked; operation was not released")),
            }
        }
    }
}

/// Executes a remedy plan by offer ID, resolving the owner session from PostgreSQL.
#[napi(js_name = "executeRemedyByOffer")]
pub async fn execute_remedy_by_offer(
    input: String,
    policy_content: Option<String>,
) -> napi::Result<String> {
    let input: OfferInput = serde_json::from_str(&input).map_err(error)?;
    if input.organization_id.is_empty()
        || input.organization_id.len() > 512
        || input.organization_id.chars().any(char::is_control)
    {
        return Err(error("invalid organization identity"));
    }
    match (input.execution_mode, &input.tool_call_id) {
        (ExecutionMode::Tracked, Some(tool_call_id))
            if !tool_call_id.is_empty()
                && tool_call_id.len() <= 1024
                && !tool_call_id.chars().any(char::is_control) => {}
        (ExecutionMode::Tracked, _) => return Err(error("tracked remedy requires tool_call_id")),
        (ExecutionMode::Untracked, None) => {}
        (ExecutionMode::Untracked, Some(_)) => {
            return Err(error("untracked remedy must not include tool_call_id"));
        }
    }
    let visible_arguments = object_raw(&input.arguments, "remedy arguments")?;
    let original_arguments = original_arguments_raw(&input.original_arguments)?;
    let quoted: ExecuteRemedyPlanArgs =
        serde_json::from_str(visible_arguments.get()).map_err(error)?;
    let offer_id = OfferId(quoted.offer_id.clone());
    let caller = input
        .caller_id
        .as_deref()
        .map(Principal::parse)
        .transpose()?;
    let store = {
        let slot = state_mutex().lock().await;
        slot.as_ref()
            .ok_or_else(|| error("OpenAPPA is not initialized"))?
            .store
            .clone()
    };
    let owner = lookup_offer_owner(
        postgres_store(&store)?,
        &input.organization_id,
        &offer_id,
        caller.as_ref(),
    )?;
    let Some(owner) = owner else {
        return Ok(
            with_offer_status(render_unknown_offer()?, OfferStatusKind::Unknown)?.to_string(),
        );
    };
    let input = Input {
        organization_id: owner.organization_id,
        // Scopes receipt to the authenticated spender to prevent replay.
        caller_id: input.caller_id.clone(),
        session_id: owner.session_id,
        parent_id: owner.parent_id,
        event: HookEventKind::Remedy,
        operation_id: None,
        tool_call_id: input.tool_call_id,
        tool: owner.tool.clone(),
        arguments: Some(visible_arguments),
        original_arguments: Some(original_arguments),
        spawn: false,
        output: None,
        outcome: None,
        owner_root: Some(owner.root),
        spelling: owner.spelling,
        presentation: Some(input.presentation),
    };
    validate(&input)?;
    let response: Value =
        serde_json::from_str(&run(input, policy_content).await?).map_err(error)?;
    Ok(with_offer_status(response, OfferStatusKind::Known)?.to_string())
}

struct SessionLock {
    pg: PostgresStore,
    root: String,
}
impl SessionLock {
    fn acquire(pg: &PostgresStore, root: String) -> napi::Result<Self> {
        let key = root.clone();
        pg.with_client(move |client| {
            client.query_one("SELECT pg_advisory_lock(hashtextextended($1, 0))", &[&key])?;
            Ok(())
        })
        .map_err(error)?;
        Ok(Self {
            pg: pg.clone(),
            root,
        })
    }
}
impl Drop for SessionLock {
    fn drop(&mut self) {
        let key = self.root.clone();
        let _ = self.pg.with_client(move |client| {
            client.query_one(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                &[&key],
            )?;
            Ok(())
        });
    }
}

impl State {
    /// Records only the offer ids exposed by the runtime's typed call denial.
    /// Rendered notices and arbitrary tool output never create executable
    /// offer ownership.
    fn record_offers(
        &self,
        pg: &PostgresStore,
        input: &Input,
        root: &str,
        presentation: Option<&RemedyPresentation>,
    ) -> napi::Result<()> {
        let offered = presentation_offer_ids(presentation);
        if offered.is_empty() {
            return Ok(());
        }
        let owner = OfferOwner {
            organization_id: input.organization_id.clone(),
            caller_id: input.caller_id.clone(),
            session_id: input.session_id.clone(),
            parent_id: input.parent_id.clone(),
            root: root.to_owned(),
            arguments: input
                .original_arguments
                .as_ref()
                .or(input.arguments.as_ref())
                .map(|arguments| arguments.get().to_owned()),
            tool: input.tool.clone(),
            spelling: input.spelling.clone(),
        };
        for offer_id in offered {
            insert_offer_owner(pg, &offer_id, &owner)?;
        }
        Ok(())
    }

    async fn dispatch(&self, input: Input) -> napi::Result<Value> {
        let pg = postgres_store(&self.store)?;
        let actor_id = identity(&input);
        let parent = input.parent_id.clone().map(|id| Input {
            session_id: id,
            ..input.clone()
        });
        let root = if let Some(root) = input.owner_root.clone() {
            root
        } else if let Some(parent) = parent {
            let parent_key = identity(&parent);
            let organization_id = input.organization_id.clone();
            pg.with_client(move |client| {
                client
                    .query_opt(
                        "SELECT root, organization_id FROM openappa_sessions WHERE actor = $1",
                        &[&parent_key],
                    )?
                    .and_then(|row| {
                        (row.get::<_, String>(1) == organization_id)
                            .then(|| row.get::<_, String>(0))
                    })
                    .ok_or_else(|| PostgresError("parent session has not started".into()))
            })
            .map_err(error)?
        } else {
            actor_id.clone()
        };
        let _lock = SessionLock::acquire(pg, root.clone())?;
        // Check every member of the family: continuing a parent while a child's
        // result is interrupted could otherwise bypass inherited restrictions.
        let check_root = root.clone();
        let interrupted = pg.has_pending_receipts(check_root).map_err(error)?;
        if interrupted {
            return Err(error(
                "OpenAPPA session has interrupted processing; operator recovery is required",
            ));
        }

        let actor = Actor {
            root: TrajectoryId(root.clone()),
            child: (root != actor_id).then(|| TrajectoryId(actor_id.clone())),
        };
        let lookup = actor_id.clone();
        let existing = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id, organization_id FROM openappa_sessions WHERE actor = $1",
                        &[&lookup],
                    )?
                    .map(|row| {
                        (
                            row.get::<_, String>(0),
                            row.get::<_, Option<String>>(1),
                            row.get::<_, String>(2),
                        )
                    }))
            })
            .map_err(error)?;
        if let Some((saved_root, saved_parent, saved_organization)) = &existing {
            if *saved_root != root
                || *saved_parent != input.parent_id
                || *saved_organization != input.organization_id
            {
                return Err(error("session identity changed"));
            }
        } else {
            let tx = pg.begin().map_err(error)?;
            let start = if let Some(child) = &actor.child {
                HookEvent::ChildStart {
                    root: actor.root.clone(),
                    child: child.clone(),
                    spawn: SpawnRef::InFlight,
                }
            } else {
                HookEvent::SessionStart {
                    root: actor.root.clone(),
                }
            };
            let decision = hooks::handle(&self.runtime, start).await;
            if !matches!(decision, HookDecision::Ack | HookDecision::Context { .. }) {
                return Err(error(wire(&decision)?));
            }
            // A return contract must be delivered before the child starts work.
            // Keep it in the start receipt so repeat SessionStart can deliver it.
            let start_decision = wire(&decision)?;
            let (id, root, input) = (actor_id.clone(), root.clone(), input.clone());
            pg.with_client(move |client| {
                client.execute("INSERT INTO openappa_sessions (actor, root, organization_id, caller_id, session_id, parent_id, start_decision) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    &[&id, &root, &input.organization_id, &input.caller_id, &input.session_id, &input.parent_id, &start_decision])?;
                Ok(())
            }).map_err(error)?;
            tx.commit().map_err(error)?;
        }

        if input.event == HookEventKind::SessionStart {
            return pg
                .with_client(move |client| {
                    Ok(client
                        .query_one(
                            "SELECT start_decision FROM openappa_sessions WHERE actor = $1",
                            &[&actor_id],
                        )?
                        .get(0))
                })
                .map_err(error);
        }
        if matches!(
            input.event,
            HookEventKind::ToolResult | HookEventKind::CancelCall
        ) {
            return self.result(pg, &input, &actor).await;
        }
        if input.event == HookEventKind::Remedy {
            let operation = remedy_operation(&input)?;
            let request = remedy_request(&input)?;
            if let Some(decision) = claim_operation(
                pg,
                &input,
                &root,
                &operation,
                &request,
                ReceiptBinding::Caller,
                None,
            )? {
                return Ok(decision);
            }
            let result_key = input
                .tool_call_id
                .as_ref()
                .map(|tool_call_id| ProcessedResultKey {
                    scope: receipt_scope(&input, ReceiptBinding::Session),
                    tool_call_id: tool_call_id.clone(),
                });
            if let Some(result_key) = &result_key {
                match pg
                    .claim_processed_result(ProcessedResultRequest {
                        key: result_key.clone(),
                        root: root.clone(),
                    })
                    .map_err(error)?
                {
                    ProcessedResultClaim::Claimed => {}
                    ProcessedResultClaim::Complete { decision, .. } => return Ok(decision),
                }
            }
            let tx = pg.begin().map_err(error)?;
            let args: ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(&input)?).map_err(error)?;
            let call = ProposedCall {
                tool: appa_runtime_api::CONTROL_TOOL.into(),
                arguments: input
                    .arguments
                    .clone()
                    .ok_or_else(|| error("missing remedy arguments"))?,
            };
            let gate = hooks::handle(
                &self.runtime,
                HookEvent::ToolCall {
                    actor: actor.clone(),
                    call,
                    call_id: None,
                    spawn: false,
                    ruling: None,
                },
            )
            .await;
            if !matches!(gate, HookDecision::PassControl) {
                let text = match gate {
                    HookDecision::DenyCall { feedback, .. } => feedback,
                    HookDecision::Block { reason } => reason,
                    HookDecision::Refuse { detail } => detail,
                    _ => return Err(error("unexpected remedy control decision")),
                };
                let response = serde_json::to_value(HostMcpResult {
                    decision: "mcp_result",
                    approved_output: text.clone(),
                    output_source: OutputSource::Runtime,
                    reason: None,
                    result: HostToolResult {
                        is_error: true,
                        content: vec![HostText { kind: "text", text }],
                    },
                })
                .map_err(error)?;
                finish_operation(pg, &input, &operation, &response, ReceiptBinding::Caller)?;
                if let Some(result_key) = result_key {
                    let approved = decision_text(&response)?;
                    pg.complete_processed_result(result_key, approved, response.clone())
                        .map_err(error)?;
                }
                tx.commit().map_err(error)?;
                return Ok(response);
            }
            let quoted_offer = OfferId(args.offer_id.clone());
            let outcome = self
                .runtime
                .execute_embedded_remedy_with_options(&actor, args, presentation_options(&input))
                .await;
            let presentation = remedy_presentation(&outcome);
            self.record_offers(pg, &input, &root, presentation)?;
            let owner = lookup_offer_owner_record(pg, &input.organization_id, &quoted_offer)?;
            let response = render_remedy_outcome(outcome, owner.as_ref())?;
            finish_operation(pg, &input, &operation, &response, ReceiptBinding::Caller)?;
            if let Some(result_key) = result_key {
                let approved = decision_text(&response)?;
                pg.complete_processed_result(result_key, approved, response.clone())
                    .map_err(error)?;
            }
            tx.commit().map_err(error)?;
            return Ok(response);
        }

        let operation = input
            .operation_id
            .clone()
            .ok_or_else(|| error("an operation id is required"))?;
        if input.event == HookEventKind::ToolCall {
            let call_id = operation
                .strip_prefix("call:")
                .ok_or_else(|| error("tool call operation_id must be call:<tool-call-id>"))?;
            if let Some(decision) = cancelled_call(pg, &input, call_id)? {
                return Ok(decision);
            }
        }
        let mut request = json!({ "event": input.event, "tool": input.tool, "arguments": input.arguments, "spawn": input.spawn, "output": input.output });
        let context = (input.event == HookEventKind::ToolCall).then(|| {
            json!({
                "tool": input.tool,
                "arguments": input.arguments,
                "spawn": input.spawn,
                "presentation": input.presentation,
            })
        });
        if input.event == HookEventKind::ToolCall {
            // The receipt key is also the host call identity. Results reconstruct
            // the same namespace from the provider's tool-call ID.
            request["call_id"] = json!(operation);
        }
        if let Some(decision) = claim_operation(
            pg,
            &input,
            &root,
            &operation,
            &request,
            ReceiptBinding::Session,
            context,
        )? {
            return Ok(decision);
        }
        let tx = pg.begin().map_err(error)?;
        let decision = if input.event == HookEventKind::Yell {
            let reporting = self
                .reporting
                .as_ref()
                .ok_or_else(|| error("OpenAPPA reporting is disabled"))?;
            let args: YellArguments =
                serde_json::from_str(required_arguments(&input)?).map_err(error)?;
            let result = appa_runtime::yell::embedded::send(
                &self.runtime,
                appa_runtime::yell::embedded::Request {
                    actor: actor.clone(),
                    endpoint: reporting.endpoint.clone(),
                    hostname: reporting.hostname.clone(),
                    message: args.message,
                    with_trajectory: args.with_trajectory,
                },
            )
            .await;
            let (is_error, message) = match result {
                Ok(receipt) => (false, format!("[appa] Reported. Receipt {receipt}.")),
                Err(reason) => (true, format!("[appa] Not reported: {reason}")),
            };
            json!({ "decision": "mcp_result", "result": { "isError": is_error, "content": [{ "type": "text", "text": message }] } })
        } else {
            let event = match input.event {
                HookEventKind::ToolCall => HookEvent::ToolCall {
                    actor: actor.clone(),
                    call: proposed(&input)?,
                    call_id: Some(operation.clone()),
                    spawn: input.spawn,
                    ruling: None,
                },
                HookEventKind::Prompt => HookEvent::Prompt {
                    actor: actor.clone(),
                    text: String::new(),
                },
                HookEventKind::TurnEnd => HookEvent::TurnEnd {
                    actor: actor.clone(),
                },
                HookEventKind::ChildEnd => HookEvent::ChildEnd {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| error("not a child session"))?,
                    value: input.output.clone(),
                },
                HookEventKind::SessionStart
                | HookEventKind::ToolResult
                | HookEventKind::CancelCall
                | HookEventKind::Remedy
                | HookEventKind::Yell => return Err(error("unsupported OpenAPPA event")),
            };
            let outcome = hooks::handle_embedded_with_options(
                &self.runtime,
                event,
                presentation_options(&input),
            )
            .await;
            if input.event == HookEventKind::ToolCall {
                self.record_offers(pg, &input, &root, outcome.presentation.as_ref())?;
            }
            wire(&outcome.decision)?
        };
        finish_operation(pg, &input, &operation, &decision, ReceiptBinding::Session)?;
        tx.commit().map_err(error)?;
        Ok(decision)
    }

    async fn result(
        &self,
        pg: &PostgresStore,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let call_id = required(&input.tool_call_id, "tool_call_id")?.to_owned();
        let key = ProcessedResultKey {
            scope: receipt_scope(input, ReceiptBinding::Session),
            tool_call_id: call_id.clone(),
        };
        match pg
            .claim_processed_result(ProcessedResultRequest {
                key: key.clone(),
                root: actor.root.0.clone(),
            })
            .map_err(error)?
        {
            ProcessedResultClaim::Claimed => {}
            ProcessedResultClaim::Complete { decision, .. } => return Ok(decision),
        }
        let operation = OperationKey {
            scope: receipt_scope(input, ReceiptBinding::Session),
            operation_id: format!("call:{call_id}"),
        };
        let Some(released) = read_completed_operation(pg, &operation)? else {
            let response = unknown_result_response();
            let approved = decision_text(&response)?;
            pg.complete_processed_result(key, approved, response.clone())
                .map_err(error)?;
            return Ok(response);
        };
        let allowed = matches!(
            released.decision.get("decision").and_then(Value::as_str),
            Some("allow_call" | "pass_control")
        );
        if !allowed {
            let response = authoritative_unexecuted_response(released.decision)?;
            let approved = decision_text(&response)?;
            pg.complete_processed_result(key, approved, response.clone())
                .map_err(error)?;
            return Ok(response);
        }
        let call = recorded_call(released.context, released.input)?;
        let cancelled = input.event == HookEventKind::CancelCall;
        let output = if cancelled {
            "OpenAPPA withheld the tool-call batch. This tool was not executed. Retry with a new tool-call ID.".to_owned()
        } else {
            input
                .output
                .clone()
                .ok_or_else(|| error("missing tool output"))?
        };
        let outcome = match (cancelled, input.outcome) {
            (true, _) => ToolOutcome::Failure {
                message: output.clone(),
            },
            (false, Some(ExecutionOutcome::Success)) => ToolOutcome::Success {
                body: OutcomeBody::Available(output.clone()),
            },
            (false, Some(ExecutionOutcome::Failure)) => ToolOutcome::Failure {
                message: output.clone(),
            },
            (false, Some(ExecutionOutcome::Unknown) | None) => ToolOutcome::Indeterminate,
        };
        let tx = pg.begin().map_err(error)?;
        let event = if call.spawn {
            // No child return is guessed from an opaque tool result. The child
            // must have reported ChildEnd through its adapter first.
            HookEvent::SpawnResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call),
                call_id: Some(format!("call:{call_id}")),
                outcome,
                child: None,
                value: None,
            }
        } else {
            HookEvent::ToolResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call),
                call_id: Some(format!("call:{call_id}")),
                outcome,
            }
        };
        let outcome = hooks::handle_embedded_with_options(
            &self.runtime,
            event,
            result_presentation_options(input, &call),
        )
        .await;
        let decision = outcome.decision;
        self.record_offers(pg, input, &actor.root.0, outcome.presentation.as_ref())?;
        if cancelled && !matches!(decision, HookDecision::Ack) {
            return Err(error("OpenAPPA could not settle a withheld tool call"));
        }
        let approved = match &decision {
            HookDecision::Ack
                if !cancelled
                    && matches!(input.outcome, Some(ExecutionOutcome::Unknown) | None) =>
            {
                "[appa] Tool output withheld: execution outcome is unknown.".into()
            }
            HookDecision::Ack => output,
            HookDecision::DeliverValue { value } | HookDecision::ChildReturn { value } => {
                value.clone()
            }
            HookDecision::ReplaceOutput { output } => output.clone(),
            HookDecision::Block { reason } => {
                format!("[appa] Tool output withheld: {reason}")
            }
            HookDecision::Refuse { detail } => {
                return Err(error(format!("OpenAPPA result refused: {detail}")));
            }
            _ => return Err(error("unexpected tool result decision")),
        };
        let mut response = if cancelled {
            // Never replay an admission for a dispatch we have closed without
            // execution. The processed-result receipt closes this exact call.
            let refusal = json!({ "decision": "deny_call", "feedback": approved });
            refusal
        } else {
            wire(&decision)?
        };
        let output_source = if cancelled {
            OutputSource::Runtime
        } else {
            match decision {
                HookDecision::Ack
                | HookDecision::DeliverValue { .. }
                | HookDecision::ChildReturn { .. } => OutputSource::Tool,
                HookDecision::ReplaceOutput { .. }
                | HookDecision::Block { .. }
                | HookDecision::Refuse { .. } => OutputSource::Runtime,
                _ => return Err(error("unexpected tool result decision")),
            }
        };
        response = with_approved_output(&response, approved.clone(), output_source)?;
        if cancelled {
            let operation = cancellation_operation(&call_id);
            let request = json!({ "event": "cancel_call", "tool_call_id": call_id });
            if let Some(saved) = claim_operation(
                pg,
                input,
                &actor.root.0,
                &operation,
                &request,
                ReceiptBinding::Session,
                None,
            )? {
                response = saved;
            } else {
                finish_operation(pg, input, &operation, &response, ReceiptBinding::Session)?;
            }
        }
        let approved = decision_text(&response)?;
        pg.complete_processed_result(key, approved, response.clone())
            .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(response)
    }
}

#[derive(Serialize)]
struct ApprovedOutput<'a, T> {
    #[serde(flatten)]
    decision: &'a T,
    approved_output: String,
    output_source: OutputSource,
}

#[derive(Serialize)]
struct OfferStatusResponse<'a> {
    #[serde(flatten)]
    response: &'a Value,
    offer: OfferStatus,
}

#[derive(Serialize)]
struct OfferStatus {
    status: OfferStatusKind,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum OfferStatusKind {
    Known,
    Unknown,
}

#[derive(Serialize)]
struct HostMcpResult {
    decision: &'static str,
    approved_output: String,
    output_source: OutputSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    result: HostToolResult,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum OutputSource {
    Runtime,
    Tool,
}

#[derive(Serialize)]
struct RenderedRemedy {
    decision: &'static str,
    approved_output: String,
    output_source: OutputSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    result: HostToolResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostToolResult {
    is_error: bool,
    content: Vec<HostText>,
}

#[derive(Serialize)]
struct HostText {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

fn with_approved_output<T: Serialize>(
    decision: &T,
    approved_output: String,
    output_source: OutputSource,
) -> napi::Result<Value> {
    serde_json::to_value(ApprovedOutput {
        decision,
        approved_output,
        output_source,
    })
    .map_err(error)
}

fn render_unknown_offer() -> napi::Result<Value> {
    let approved_output = "[appa] No live offer with this id is available.".to_owned();
    serde_json::to_value(HostMcpResult {
        decision: "mcp_result",
        approved_output: approved_output.clone(),
        output_source: OutputSource::Runtime,
        reason: Some("unknown_control_call"),
        result: HostToolResult {
            is_error: true,
            content: vec![HostText {
                kind: "text",
                text: approved_output,
            }],
        },
    })
    .map_err(error)
}

fn with_offer_status(response: Value, status: OfferStatusKind) -> napi::Result<Value> {
    serde_json::to_value(OfferStatusResponse {
        response: &response,
        offer: OfferStatus { status },
    })
    .map_err(error)
}

fn presentation_offer_ids(presentation: Option<&RemedyPresentation>) -> Vec<OfferId> {
    presentation
        .map(|presentation| {
            presentation
                .offers
                .iter()
                .map(|offer| OfferId(offer.id.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn render_remedy_outcome(
    outcome: RemedyOutcome,
    owner: Option<&OfferOwner>,
) -> napi::Result<Value> {
    let (output_source, reason, is_error, text) = match outcome {
        RemedyOutcome::Authorized { call } => (
            OutputSource::Runtime,
            None,
            false,
            render_released_call("Authorized", &call, owner),
        ),
        RemedyOutcome::Substituted { call } => (
            OutputSource::Runtime,
            None,
            false,
            render_substituted_call(&call, owner),
        ),
        RemedyOutcome::Returned { value } => (OutputSource::Tool, None, false, value),
        RemedyOutcome::Declined { presentation } => {
            (OutputSource::Runtime, None, false, presentation.feedback)
        }
        RemedyOutcome::NoAnswer { feedback } => (OutputSource::Runtime, None, false, feedback),
        RemedyOutcome::Refused { reason } => (
            OutputSource::Runtime,
            unknown_control_reason(&reason),
            true,
            reason.detail().to_owned(),
        ),
    };
    serde_json::to_value(RenderedRemedy {
        decision: "mcp_result",
        approved_output: text.clone(),
        output_source,
        reason,
        result: HostToolResult {
            is_error,
            content: vec![HostText { kind: "text", text }],
        },
    })
    .map_err(error)
}

fn unknown_control_reason(reason: &RemedyRefusal) -> Option<&'static str> {
    match reason {
        RemedyRefusal::Unvouched | RemedyRefusal::UnknownOffer => Some("unknown_control_call"),
        RemedyRefusal::InvalidOfferId(_)
        | RemedyRefusal::ActorMismatch
        | RemedyRefusal::AlreadyExecuting
        | RemedyRefusal::Runtime { .. } => None,
    }
}

fn render_released_call(status: &str, call: &ProposedCall, owner: Option<&OfferOwner>) -> String {
    let tool = owner
        .and_then(|owner| owner.spelling.as_deref())
        .unwrap_or(&call.tool);
    format!(
        "[appa] {status}. Call the {tool} tool again with exactly these arguments: {}",
        call.arguments.get()
    )
}

fn render_substituted_call(call: &ProposedCall, owner: Option<&OfferOwner>) -> String {
    let unchanged = owner
        .and_then(|owner| owner.arguments.as_deref())
        .is_some_and(|original| json_arguments_match(original, call.arguments.get()));
    let status = if unchanged {
        "Released unchanged. The sanitizer reviewed the arguments and admitted them as they were"
    } else {
        "Substituted. The sanitizer released the call"
    };
    render_released_call(status, call, owner)
}

fn json_arguments_match(original: &str, proposed: &str) -> bool {
    match (
        serde_json::from_str::<Value>(original),
        serde_json::from_str::<Value>(proposed),
    ) {
        (Ok(original), Ok(proposed)) => original == proposed,
        _ => false,
    }
}

fn remedy_presentation(outcome: &RemedyOutcome) -> Option<&RemedyPresentation> {
    match outcome {
        RemedyOutcome::Declined { presentation } => Some(presentation),
        RemedyOutcome::Authorized { .. }
        | RemedyOutcome::Substituted { .. }
        | RemedyOutcome::Returned { .. }
        | RemedyOutcome::NoAnswer { .. }
        | RemedyOutcome::Refused { .. } => None,
    }
}

fn remedy_operation(input: &Input) -> napi::Result<String> {
    match &input.tool_call_id {
        Some(tool_call_id) => Ok(format!("remedy:{tool_call_id}")),
        // Direct clients without a provider call id get a durable crash fence,
        // but no later result is inferred from a fabricated transport id.
        None => Ok(format!(
            "remedy:untracked:{:x}",
            Sha256::digest(serde_json::to_vec(&remedy_fingerprint(input)?).map_err(error)?)
        )),
    }
}

fn remedy_fingerprint(input: &Input) -> napi::Result<Value> {
    Ok(json!({
        "visible_arguments": raw_object_value(input.arguments.as_deref(), "remedy arguments")?,
        "original_arguments": raw_object_value(
            input.original_arguments.as_deref().or(input.arguments.as_deref()),
            "remedy arguments",
        )?,
    }))
}

fn remedy_request(input: &Input) -> napi::Result<Value> {
    Ok(json!({
        "event": "remedy",
        "tool_call_id": input.tool_call_id,
        "arguments": raw_object_value(input.arguments.as_deref(), "remedy arguments")?,
        "original_arguments": raw_object_value(
            input.original_arguments.as_deref().or(input.arguments.as_deref()),
            "remedy arguments",
        )?,
        "organization_id": input.organization_id,
        "caller_id": input.caller_id,
        "session_id": input.session_id,
        "parent_id": input.parent_id,
        "owner_root": input.owner_root,
    }))
}

fn original_arguments_raw(arguments: &str) -> napi::Result<Box<RawValue>> {
    let value: Value = serde_json::from_str(arguments).map_err(error)?;
    if !value.is_object() {
        return Err(error("original remedy arguments must be a JSON object"));
    }
    serde_json::value::to_raw_value(&value).map_err(error)
}

fn object_raw(arguments: &RawValue, name: &str) -> napi::Result<Box<RawValue>> {
    let value: Value = serde_json::from_str(arguments.get()).map_err(error)?;
    if !value.is_object() {
        return Err(error(format!("{name} must be a JSON object")));
    }
    serde_json::value::to_raw_value(&value).map_err(error)
}

fn raw_object_value(arguments: Option<&RawValue>, name: &str) -> napi::Result<Value> {
    let arguments = arguments.ok_or_else(|| error(format!("missing {name}")))?;
    let value: Value = serde_json::from_str(arguments.get()).map_err(error)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(error(format!("{name} must be a JSON object")))
    }
}

fn decision_text(response: &Value) -> napi::Result<String> {
    response
        .get("approved_output")
        .or_else(|| response.get("feedback"))
        .or_else(|| response.get("detail"))
        .or_else(|| response.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error("control response lacks model-visible text"))
}

fn recorded_call(context: Option<Value>, legacy_input: Value) -> napi::Result<RecordedCall> {
    let value = context.unwrap_or(legacy_input);
    serde_json::from_value(value).map_err(|_| error("released call receipt lacks call context"))
}

fn proposed_recorded_call(call: &RecordedCall) -> ProposedCall {
    ProposedCall {
        tool: call.tool.clone(),
        arguments: call.arguments.clone(),
    }
}

fn authoritative_unexecuted_response(decision: Value) -> napi::Result<Value> {
    let feedback = decision
        .get("feedback")
        .or_else(|| decision.get("detail"))
        .or_else(|| decision.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("OpenAPPA blocked this tool call");
    with_approved_output(
        &decision,
        format!(
            "{feedback}\n\nThe tool was not executed. Use an offered remedy if appropriate before retrying; otherwise explain the ruling."
        ),
        OutputSource::Runtime,
    )
}

fn unknown_result_response() -> Value {
    let approved_output =
        "[appa] Tool output withheld: this result has no record of releasing a call.".to_owned();
    json!({
        "decision": "block",
        "feedback": approved_output,
        "approved_output": approved_output,
        "output_source": OutputSource::Runtime,
    })
}

fn cancellation_operation(call_id: &str) -> String {
    format!("cancel:{call_id}")
}

struct CompletedOperation {
    #[allow(dead_code)]
    root: String,
    input: Value,
    context: Option<Value>,
    decision: Value,
}

fn read_completed_operation(
    pg: &PostgresStore,
    key: &OperationKey,
) -> napi::Result<Option<CompletedOperation>> {
    let session_id = key.scope.session_id.clone();
    let operation_id = key.operation_id.clone();
    pg.with_client(move |client| {
        let row = client.query_opt(
            "SELECT root, input, status, decision FROM openappa_operations WHERE session_id=$1 AND operation_id=$2",
            &[&session_id, &operation_id],
        )?;
        let Some(row) = row else {
            return Ok(None);
        };
        let status: String = row.get("status");
        if status != "complete" {
            return Ok(None);
        }
        let root: String = row.get("root");
        let input: Value = row.get("input");
        let decision: Option<Value> = row.get("decision");
        let Some(decision) = decision else {
            return Ok(None);
        };
        let (actual_input, context) = if let Some(obj) = input.as_object() {
            if let Some(semantic) = obj.get("semantic") {
                (semantic.clone(), obj.get("context").cloned())
            } else if let Some(legacy) = obj.get("input") {
                (legacy.clone(), obj.get("context").cloned())
            } else {
                (input, None)
            }
        } else {
            (input, None)
        };
        Ok(Some(CompletedOperation {
            root,
            input: actual_input,
            context,
            decision,
        }))
    })
    .map_err(error)
}

fn cancelled_call(pg: &PostgresStore, input: &Input, call_id: &str) -> napi::Result<Option<Value>> {
    let key = OperationKey {
        scope: receipt_scope(input, ReceiptBinding::Session),
        operation_id: cancellation_operation(call_id),
    };
    Ok(read_completed_operation(pg, &key)?.map(|record| record.decision))
}

fn required_arguments(input: &Input) -> napi::Result<&str> {
    input
        .arguments
        .as_ref()
        .map(|args| args.get())
        .ok_or_else(|| error("missing arguments"))
}
fn proposed(input: &Input) -> napi::Result<ProposedCall> {
    Ok(ProposedCall {
        tool: required(&input.tool, "tool")?.to_owned(),
        arguments: input
            .arguments
            .clone()
            .ok_or_else(|| error("missing arguments"))?,
    })
}

fn lookup_offer_owner(
    pg: &PostgresStore,
    organization_id: &str,
    offer_id: &OfferId,
    caller: Option<&Principal>,
) -> napi::Result<Option<OfferOwner>> {
    let record = pg
        .offer_owner(OfferOwnerKey {
            organization_id: organization_id.to_owned(),
            offer_id: offer_id.0.clone(),
        })
        .map_err(error)?;
    Ok(record
        .filter(|record| owner_can_be_spent_by(record.scope.caller_id.as_deref(), caller))
        .map(offer_owner_from_record))
}

fn lookup_offer_owner_record(
    pg: &PostgresStore,
    organization_id: &str,
    offer_id: &OfferId,
) -> napi::Result<Option<OfferOwner>> {
    pg.offer_owner(OfferOwnerKey {
        organization_id: organization_id.to_owned(),
        offer_id: offer_id.0.clone(),
    })
    .map_err(error)
    .map(|record| record.map(offer_owner_from_record))
}

fn offer_owner_from_record(record: OfferOwnerRecord) -> OfferOwner {
    OfferOwner {
        organization_id: record.scope.organization_id,
        caller_id: record.scope.caller_id,
        session_id: record.scope.session_id,
        parent_id: record.parent_id,
        root: record.root,
        arguments: record.arguments,
        tool: record.tool,
        spelling: record.spelling,
    }
}

fn owner_can_be_spent_by(owner: Option<&str>, spender: Option<&Principal>) -> bool {
    let Some(spender) = spender else {
        return false;
    };
    match owner.map(Principal::parse).transpose() {
        Ok(Some(Principal::User(owner))) => {
            matches!(spender, Principal::User(actual) if actual == &owner)
        }
        // Credential owners are organization scoped. The caller has already
        // authenticated into the organization selected by the owner lookup.
        Ok(Some(Principal::App(_) | Principal::VirtualKey(_) | Principal::Opaque(_))) => true,
        Ok(None) | Err(_) => false,
    }
}

fn insert_offer_owner(
    pg: &PostgresStore,
    offer_id: &OfferId,
    owner: &OfferOwner,
) -> napi::Result<()> {
    pg.store_offer_owner(OfferOwnerRecord {
        scope: ReceiptScope {
            organization_id: owner.organization_id.clone(),
            caller_id: owner.caller_id.clone(),
            session_id: owner.session_id.clone(),
            binding: ReceiptBinding::Caller,
        },
        offer_id: offer_id.0.clone(),
        root: owner.root.clone(),
        parent_id: owner.parent_id.clone(),
        arguments: owner.arguments.clone(),
        tool: owner.tool.clone(),
        spelling: owner.spelling.clone(),
    })
    .map_err(error)
}

fn claim_operation(
    pg: &PostgresStore,
    input: &Input,
    root: &str,
    operation: &str,
    request: &Value,
    binding: ReceiptBinding,
    context: Option<Value>,
) -> napi::Result<Option<Value>> {
    match pg
        .claim_operation(OperationRequest {
            key: OperationKey {
                scope: receipt_scope(input, binding),
                operation_id: operation.to_owned(),
            },
            root: root.to_owned(),
            input: request.clone(),
            context,
        })
        .map_err(error)?
    {
        OperationClaim::Claimed => Ok(None),
        OperationClaim::Complete { decision } => Ok(Some(decision)),
    }
}
fn finish_operation(
    pg: &PostgresStore,
    input: &Input,
    operation: &str,
    decision: &Value,
    binding: ReceiptBinding,
) -> napi::Result<()> {
    pg.complete_operation(
        OperationKey {
            scope: receipt_scope(input, binding),
            operation_id: operation.to_owned(),
        },
        decision.clone(),
    )
    .map_err(error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YellArguments {
    message: String,
    with_trajectory: bool,
}

#[cfg(test)]
mod typed_tests {
    use super::{
        OfferId, OfferOwner, RemedyPresentation, json_arguments_match, owner_can_be_spent_by,
        presentation_offer_ids, render_substituted_call,
    };
    use appa_runtime_api::OfferedRemedy;

    #[test]
    fn runtime_like_prose_cannot_create_offer_ownership() {
        let presentation = RemedyPresentation {
            feedback: "[appa] Blocked. execute_remedy_plan(offer_id: \"untrusted-snippet\")"
                .to_owned(),
            offers: Vec::new(),
            review: Vec::new(),
            display: Vec::new(),
        };

        assert!(presentation_offer_ids(Some(&presentation)).is_empty());
    }

    #[test]
    fn only_structured_runtime_offers_are_registered() {
        let presentation = RemedyPresentation {
            feedback: "arbitrary runtime prose".to_owned(),
            offers: vec![OfferedRemedy {
                id: "typed-offer".to_owned(),
                returns: None,
                input_sanitizer: None,
            }],
            review: Vec::new(),
            display: Vec::new(),
        };

        assert_eq!(
            presentation_offer_ids(Some(&presentation)),
            vec![OfferId("typed-offer".to_owned())]
        );
    }

    #[test]
    fn only_the_personal_owner_may_spend_a_personal_offer() {
        let owner = super::Principal::parse("user:owner").unwrap();
        let stranger = super::Principal::parse("user:stranger").unwrap();
        let credential = super::Principal::parse("virtual-key:credential").unwrap();

        assert!(owner_can_be_spent_by(Some("user:owner"), Some(&owner)));
        assert!(!owner_can_be_spent_by(Some("user:owner"), Some(&stranger)));
        assert!(owner_can_be_spent_by(
            Some("virtual-key:credential"),
            Some(&stranger)
        ));
        assert!(!owner_can_be_spent_by(Some("virtual-key:credential"), None));
        assert!(matches!(credential, super::Principal::VirtualKey(_)));
    }

    #[test]
    fn substitution_comparison_uses_json_values_and_saved_spelling() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            caller_id: Some("user:owner".to_owned()),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            arguments: Some(r#"{ "value": 1 }"#.to_owned()),
            tool: Some("canonical_tool".to_owned()),
            spelling: Some("client_tool".to_owned()),
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "canonical_tool".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "value": 1 })).unwrap(),
        };

        assert!(json_arguments_match(r#"{"value":1}"#, call.arguments.get()));
        assert!(render_substituted_call(&call, Some(&owner)).contains("client_tool"));
        assert!(render_substituted_call(&call, Some(&owner)).contains("Released unchanged"));
    }

    #[test]
    fn legacy_presentation_fallback_never_advertises_delegation() {
        assert!(!super::native_presentation_options().supports_delegation);
    }
}
