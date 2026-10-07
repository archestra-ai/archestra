//! Archestra's host boundary. Policy evaluation and event serialization live in
//! OpenAPPA; identity, call correlation and durable processing receipts live here.

mod adapter;
mod batteries;
mod consults;
mod declarations;
mod deployments;
#[allow(dead_code)]
mod peer;
mod policy;

use appa_eventlog::{
    Backend, LogStore, OperationClaim, OperationKey, OperationRequest, ProcessedResultClaim,
    ProcessedResultKey, ProcessedResultRequest, ReceiptBinding, SessionScope,
    postgres::{LeasedPostgres, PostgresError},
};
use appa_runtime::{
    api::{
        EmbeddedPresentationOptions, ExecuteRemedyPlanArgs, PreparedDeployment, RemedyOutcome,
        RemedyPresentation, RemedyRefusal, Runtime,
    },
    hooks,
};
use appa_runtime_api::{
    Actor, CanonicalTool, HookDecision, HookEvent, OutcomeBody, ProposedCall, Ruling, SpawnBinding,
    SpawnKind, SpawnRef, ToolOutcome, TrajectoryId, WireDecision,
};
use futures_util::FutureExt;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime},
};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

#[napi(object)]
#[derive(Clone)]
pub struct ReportingOptions {
    pub endpoint: String,
    pub hostname: Option<String>,
}

/// Process-wide runtime slot. The mutex covers initialize only. Every dispatch
/// runs through a view pinned to its organization's deployment (see
/// [`deployments`]), so dispatches run concurrently and none changes what another
/// serves. A root keeps its opening policy revision, and a fork its parent's.
/// Same-trajectory exclusion uses an in-process root lock and an advisory session
/// lock. Ledger writes use short self-committing transactions.
static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

#[derive(Clone)]
struct State {
    runtime: Arc<Runtime>,
    store: Arc<LogStore>,
    /// One permit per pooled connection, so a dispatch waits for a connection
    /// here, asynchronously, and never inside the store.
    connections: Arc<Semaphore>,
    deployments: Arc<deployments::Deployments>,
    reporting: Option<ReportingOptions>,
}

/// Field order is drop order: the connection goes back before its permit does.
struct Leased {
    state: State,
    _permit: OwnedSemaphorePermit,
}

/// A dispatch holds its connection across its consults, so slow authorities
/// can keep every connection busy. Waiting dispatches then fail closed rather
/// than hang; the bound matches the ledger's own `lock_timeout`.
const CONNECTION_WAIT: Duration = Duration::from_secs(30);

async fn connection_permit(
    connections: &Arc<Semaphore>,
    wait: Duration,
) -> napi::Result<OwnedSemaphorePermit> {
    tokio::time::timeout(wait, connections.clone().acquire_owned())
        .await
        .map_err(|_| error("OpenAPPA had no free PostgreSQL connection in time; retry later"))?
        .map_err(error)
}

fn state_mutex() -> &'static Mutex<Option<State>> {
    STATE.get_or_init(|| Mutex::new(None))
}

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
struct TrajectoryStamp {
    v: u8,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
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
struct OfferInput {
    organization_id: String,
    /// Authenticated spender, recorded on a caller-bound receipt. Absent for an
    /// anonymous organization token; never compared to an offer owner.
    #[serde(default)]
    caller_id: Option<String>,
    trajectory: TrajectoryStamp,
    /// Client tool call ID for binding durable remedy receipts.
    #[serde(default)]
    tool_call_id: Option<String>,
    arguments: Box<RawValue>,
    execution_mode: ExecutionMode,
    /// Original argument JSON string before execution metadata stripping.
    original_arguments: String,
    presentation: PresentationInput,
    #[serde(default)]
    ruling: Option<RulingInput>,
    /// Explains why the host did not prompt for human review.
    /// Used when the target call would fail even if approved.
    /// Recorded as the remedy result.
    #[serde(default)]
    precheck_refusal: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExecutionMode {
    Tracked,
    Untracked,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct YellReceiver {
    port: u16,
    token: String,
}

impl YellReceiver {
    fn endpoint(&self) -> napi::Result<String> {
        if self.port == 0
            || self.token.len() != 64
            || !self.token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(error("invalid host yell receiver"));
        }
        Ok(format!("http://127.0.0.1:{}/{}", self.port, self.token))
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    /// Host-only loopback capture endpoint; never part of model tool arguments.
    #[serde(default)]
    yell_receiver: Option<YellReceiver>,
    organization_id: String,
    #[serde(default)]
    caller_id: Option<String>,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    /// The email of the user the session acts for, on every event: whichever event
    /// opens the session names it as the session principal. A session opened
    /// without one never gains one.
    #[serde(default)]
    principal: Option<String>,
    /// The session this one forks. Set on a new session whose history traces
    /// to an earlier session by the same caller. Its first event opens a root
    /// initialized from that session's state. Mutually exclusive with `parent_id`.
    #[serde(default)]
    fork_of: Option<String>,
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
    /// Fully scoped child trajectory on a parent-side SpawnResult.
    #[serde(default)]
    spawned_id: Option<String>,
    /// Raw spawn-call id, not `call:<id>`. A ChildEnd retains it so the parent
    /// can bind a returned value without a carrier. A child's first event uses
    /// it to load the sealed binding on the parent's `call:<id>` receipt.
    #[serde(default)]
    spawn_call_id: Option<String>,
    /// Client-native child identity a ChildEnd answers, retained likewise.
    #[serde(default)]
    child_native_id: Option<String>,
    #[serde(default)]
    outcome: Option<ExecutionOutcome>,
    #[serde(skip_deserializing, default)]
    owner_root: Option<String>,
    #[serde(default)]
    spelling: Option<String>,
    #[serde(default)]
    dispatch: Option<String>,
    #[serde(default)]
    presentation: Option<PresentationInput>,
    #[serde(default)]
    ruling: Option<RulingInput>,
    #[serde(default)]
    precheck_refusal: Option<String>,
}

/// Maximum byte length for precheck refusal text.
/// Refusal text is recorded and replayed verbatim as the remedy result.
const MAX_PRECHECK_REFUSAL_BYTES: usize = 64 * 1024;

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

fn session_scope(input: &Input) -> SessionScope {
    SessionScope {
        organization_id: input.organization_id.clone(),
        session_id: input.session_id.clone(),
    }
}

fn session_binding(input: &Input) -> ReceiptBinding {
    ReceiptBinding::Session {
        caller_id: input.caller_id.clone(),
    }
}

fn operation_key(input: &Input, binding: ReceiptBinding, operation_id: String) -> OperationKey {
    OperationKey {
        session: session_scope(input),
        binding,
        operation_id,
    }
}

fn processed_result_key(input: &Input, tool_call_id: String) -> ProcessedResultKey {
    ProcessedResultKey {
        session: session_scope(input),
        caller_id: input.caller_id.clone(),
        tool_call_id,
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

fn postgres_store(store: &LogStore) -> napi::Result<&LeasedPostgres> {
    store
        .postgres()
        .ok_or_else(|| error("OpenAPPA requires PostgreSQL storage"))
}

/// The key of a session's `openappa_sessions` row. Session ids come from clients, so
/// two organizations may share one; the row and its lookups are therefore keyed by
/// the organization as well as the actor.
#[derive(Clone)]
struct SessionKey {
    organization_id: String,
    actor: String,
}

impl SessionKey {
    fn new(organization_id: &str, session_id: &str) -> Self {
        Self {
            organization_id: organization_id.to_owned(),
            actor: session_actor(session_id),
        }
    }

    fn of(input: &Input) -> Self {
        Self::new(&input.organization_id, &input.session_id)
    }
}

/// A session's actor, and a child session's trajectory id. It hashes the session id
/// alone; the organization is part of the row key beside it.
fn session_actor(session_id: &str) -> String {
    format!("archestra:{}", sha256_hex(session_id.as_bytes()))
}

/// The root a top-level session opens. The runtime shares in-process state by root id
/// alone, so the root formula names the organization. Neither identity may hold a
/// control character, which makes the separator unambiguous.
fn root_id(organization_id: &str, session_id: &str) -> String {
    format!(
        "archestra:{}",
        sha256_hex(format!("{organization_id}\n{session_id}"))
    )
}

/// The effective policy of the dispatching organization, with the values the host
/// resolved for the credential variables the runtime reads itself.
#[napi(object)]
pub struct DispatchPolicy {
    pub content: String,
    /// Variable → value, for the document's `runtimeCredentials`. Secrets.
    pub credentials: HashMap<String, String>,
}

#[napi(object)]
pub struct OpenappaStatus {
    pub trust: String,
    pub audience: String,
}

impl From<DispatchPolicy> for deployments::HostedPolicy {
    fn from(policy: DispatchPolicy) -> Self {
        deployments::HostedPolicy {
            content: policy.content,
            credentials: deployments::HostCredentials::new(policy.credentials),
        }
    }
}

/// What the runtime serves before any organization dispatches. Every dispatch
/// serves its own organization's deployment instead.
const INITIAL_POLICY: &str = "[policy]\nversion = 2\n";

#[napi(js_name = "initializeOpenappa")]
pub async fn initialize_openappa(
    database_url: String,
    postgres_max_connections: u32,
    reporting: Option<ReportingOptions>,
) -> napi::Result<()> {
    let max_connections = usize::try_from(postgres_max_connections)
        .ok()
        .and_then(NonZeroUsize::new)
        .ok_or_else(|| error("OpenAPPA needs at least one PostgreSQL connection"))?;
    let mut slot = state_mutex().lock().await;
    if slot.is_some() {
        return Ok(());
    }
    let state = tokio::task::spawn_blocking(move || -> napi::Result<State> {
        appa_runtime::tls::install_crypto_provider();
        let mut config = policy::compile(INITIAL_POLICY, |_| None).map_err(error)?;
        config.reporting.agent_yell = reporting.is_some();
        let store = Arc::new(
            LogStore::open(Backend::Postgres {
                url: database_url,
                max_connections,
            })
            .map_err(error)?,
        );
        let runtime = policy::open(config, store.clone()).map_err(error)?;
        Ok(State {
            runtime: Arc::new(runtime),
            store,
            connections: Arc::new(Semaphore::new(max_connections.get())),
            deployments: Arc::default(),
            reporting,
        })
    })
    .await
    .map_err(error)??;
    *slot = Some(state);
    Ok(())
}

/// Validates a root document that declares no battery: [`compose_openappa_policy`]
/// with nothing to resolve. A root whose `include` list names a battery does not
/// validate this way — the entry resolves to nothing — so a caller holding
/// declarations composes instead.
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

#[napi(object)]
pub struct HelperBindingInput {
    /// The endpoint every `command` external of the battery is served under; the
    /// external's name is appended as the last path segment.
    pub url_base: String,
    /// The runtime variable holding the bearer token the endpoint checks.
    pub token_env: String,
}

#[napi(object)]
pub struct ComposeBatteryInput {
    /// The include entry this battery answers, as the root document spells it.
    pub entry: String,
    pub name: String,
    pub policy: String,
    pub helpers: Option<HelperBindingInput>,
}

#[napi(object)]
pub struct ComposePolicyInput {
    pub root: String,
    pub batteries: Vec<ComposeBatteryInput>,
}

#[napi(object)]
pub struct ComposedPolicy {
    /// The composed document, absent when composition failed.
    pub content: Option<String>,
    /// The composed credential table, variable → store key, absent when composition
    /// failed.
    pub credentials: Option<HashMap<String, String>>,
    pub errors: Vec<String>,
}

/// Composes the effective policy: the root's own declarations, with every battery its
/// `include` list names composed under it. An entry outside `batteries` is unresolved
/// and refuses the composition. The composed document is opened in a memory runtime,
/// so a composition that returns content is also a successful validation.
/// Deterministic in its inputs, so equal inputs give equal bytes.
#[napi(js_name = "composeOpenappaPolicy")]
pub async fn compose_openappa_policy(input: ComposePolicyInput) -> napi::Result<ComposedPolicy> {
    tokio::task::spawn_blocking(move || {
        let batteries: Vec<policy::ResolvedBattery> = input
            .batteries
            .into_iter()
            .map(|battery| policy::ResolvedBattery {
                entry: battery.entry,
                name: battery.name,
                policy: battery.policy,
                helpers: battery.helpers.map(|helpers| policy::HelperBinding {
                    url_base: helpers.url_base,
                    token_env: helpers.token_env,
                }),
            })
            .collect();
        std::panic::catch_unwind(|| policy::compose(&input.root, &batteries))
            .map(|result| match result {
                Ok(composed) => ComposedPolicy {
                    content: Some(composed.content),
                    credentials: Some(composed.credentials.into_iter().collect()),
                    errors: Vec::new(),
                },
                Err(message) => ComposedPolicy {
                    content: None,
                    credentials: None,
                    errors: vec![message],
                },
            })
            .map_err(|_| error("OpenAPPA policy composition failed"))
    })
    .await
    .map_err(error)?
}

#[napi(object)]
pub struct IncludeDeclaration {
    pub entry: String,
    /// The 1-based line the entry is authored on.
    pub line: u32,
}

#[napi(object)]
pub struct ServerAliasDeclaration {
    pub namespace: String,
    pub servers: Vec<String>,
    pub line: u32,
}

#[napi(object)]
pub struct CredentialDeclaration {
    pub variable: String,
    pub key: String,
    pub line: u32,
}

#[napi(object)]
pub struct PolicyDeclarations {
    pub include: Vec<IncludeDeclaration>,
    pub server_aliases: Vec<ServerAliasDeclaration>,
    pub credentials: Vec<CredentialDeclaration>,
    /// The annotators the root's own `[[policy.tool]]` rules route calls to.
    pub routed_annotators: Vec<String>,
    /// The `[credentials]` variables the runtime resolves itself, because an external
    /// or profile of the document names them as its `token_env`. A dispatch carries
    /// their values in `DispatchPolicy.credentials`.
    pub runtime_credentials: Vec<String>,
    /// A shape the reader could not make sense of, naming the key and its line. An
    /// unparsable document is one error and no declarations.
    pub errors: Vec<String>,
}

/// Reads what a root document declares about its batteries, with the line each
/// declaration is authored on. Unknown top-level keys are the loader's concern, not
/// this reader's.
#[napi(js_name = "parseOpenappaDeclarations")]
pub async fn parse_openappa_declarations(content: String) -> napi::Result<PolicyDeclarations> {
    tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| declarations::parse(&content))
            .map(|parsed| PolicyDeclarations {
                include: parsed
                    .include
                    .into_iter()
                    .map(|include| IncludeDeclaration {
                        entry: include.entry,
                        line: include.line,
                    })
                    .collect(),
                server_aliases: parsed
                    .server_aliases
                    .into_iter()
                    .map(|alias| ServerAliasDeclaration {
                        namespace: alias.namespace,
                        servers: alias.servers,
                        line: alias.line,
                    })
                    .collect(),
                credentials: parsed
                    .credentials
                    .into_iter()
                    .map(|credential| CredentialDeclaration {
                        variable: credential.variable,
                        key: credential.key,
                        line: credential.line,
                    })
                    .collect(),
                routed_annotators: parsed.routed_annotators,
                runtime_credentials: parsed.runtime_credentials,
                errors: parsed.errors,
            })
            .map_err(|_| error("OpenAPPA declaration parsing failed"))
    })
    .await
    .map_err(error)?
}

#[napi(object)]
pub struct PolicyEditInput {
    /// `addInclude`, `removeInclude`, `bindServers`, `unbindServers` or
    /// `setCredential`. The fields the kind does not take are ignored; one it takes
    /// and the caller left out is an error.
    pub kind: String,
    pub entry: Option<String>,
    pub namespace: Option<String>,
    pub servers: Option<Vec<String>>,
    pub namespaces: Option<Vec<String>>,
    pub variable: Option<String>,
    /// Absent removes the variable's binding.
    pub key: Option<String>,
}

#[napi(object)]
pub struct EditedPolicy {
    /// The edited document, absent when an edit was refused.
    pub content: Option<String>,
    pub errors: Vec<String>,
}

/// Applies the edits to one root document in order, through the runtime's own
/// comment-preserving editor: a document that already says what an edit asks for
/// comes back byte for byte. The first refusal stops the sequence and returns no
/// text.
#[napi(js_name = "editOpenappaPolicy")]
pub async fn edit_openappa_policy(
    content: String,
    edits: Vec<PolicyEditInput>,
) -> napi::Result<EditedPolicy> {
    tokio::task::spawn_blocking(move || {
        let requests: Vec<declarations::EditRequest> = edits
            .into_iter()
            .map(|edit| declarations::EditRequest {
                kind: edit.kind,
                entry: edit.entry,
                namespace: edit.namespace,
                servers: edit.servers,
                namespaces: edit.namespaces,
                variable: edit.variable,
                key: edit.key,
            })
            .collect();
        std::panic::catch_unwind(|| declarations::edit(&content, requests))
            .map(|result| match result {
                Ok(content) => EditedPolicy {
                    content: Some(content),
                    errors: Vec::new(),
                },
                Err(message) => EditedPolicy {
                    content: None,
                    errors: vec![message],
                },
            })
            .map_err(|_| error("OpenAPPA policy editing failed"))
    })
    .await
    .map_err(error)?
}

#[napi(object)]
pub struct BatteryFileInput {
    pub path: String,
    pub text: String,
}

#[napi(object)]
pub struct BatteryExternal {
    pub kind: String,
    pub name: String,
    pub command: Vec<String>,
    pub token_env: Option<String>,
}

#[napi(object)]
pub struct BatteryPackage {
    pub name: String,
    pub description: String,
    pub namespaces: Vec<String>,
    /// The `[[policy.annotator]]` names the battery declares.
    pub annotators: Vec<String>,
    /// The annotators the battery's own `[[policy.tool]]` rules route calls to.
    pub routed_annotators: Vec<String>,
    pub policy: String,
    pub helpers: Vec<String>,
    pub credentials: Vec<String>,
    pub externals: Vec<BatteryExternal>,
    pub setup: Option<String>,
    pub files: Vec<BatteryFileInput>,
}

impl From<&batteries::BatteryInfo> for BatteryPackage {
    fn from(info: &batteries::BatteryInfo) -> Self {
        BatteryPackage {
            name: info.name.clone(),
            description: info.description.clone(),
            namespaces: info.namespaces.clone(),
            annotators: info.annotators.clone(),
            routed_annotators: info.routed_annotators.clone(),
            policy: info.policy.clone(),
            helpers: info.helpers.clone(),
            credentials: info.credentials.clone(),
            externals: info
                .externals
                .iter()
                .map(|external| BatteryExternal {
                    kind: external.kind.clone(),
                    name: external.name.clone(),
                    command: external.command.clone(),
                    token_env: external.token_env.clone(),
                })
                .collect(),
            setup: info.setup.clone(),
            files: info
                .files
                .iter()
                .map(|file| BatteryFileInput {
                    path: file.path.clone(),
                    text: file.text.clone(),
                })
                .collect(),
        }
    }
}

/// The batteries bundled with the pinned OpenAPPA checkout that govern MCP tools,
/// which is what Archestra serves, or declare annotators alone.
#[napi(js_name = "listBundledOpenappaBatteries")]
pub async fn list_bundled_openappa_batteries() -> napi::Result<Vec<BatteryPackage>> {
    tokio::task::spawn_blocking(|| {
        let loaded = std::panic::catch_unwind(batteries::bundled)
            .map_err(|_| error("bundled OpenAPPA batteries failed to load"))?;
        loaded
            .map_err(error)
            .map(|batteries| batteries.iter().map(BatteryPackage::from).collect())
    })
    .await
    .map_err(error)?
}

/// Validates an uploaded battery package with the marketplace's own checks and reads
/// what the host needs from it. The message names the first refusal.
#[napi(js_name = "inspectOpenappaBattery")]
pub async fn inspect_openappa_battery(
    files: Vec<BatteryFileInput>,
) -> napi::Result<BatteryPackage> {
    tokio::task::spawn_blocking(move || {
        let files: Vec<batteries::BatteryFile> = files
            .into_iter()
            .map(|file| batteries::BatteryFile {
                path: file.path,
                text: file.text,
            })
            .collect();
        std::panic::catch_unwind(|| batteries::inspect(&files))
            .map_err(|_| error("OpenAPPA battery inspection failed"))?
            .map(|info| BatteryPackage::from(&info))
            .map_err(error)
    })
    .await
    .map_err(error)?
}

#[napi(js_name = "dispatchHook")]
pub async fn dispatch_hook(input: String, policy: DispatchPolicy) -> napi::Result<String> {
    let input: Input = serde_json::from_str(&input).map_err(error)?;
    validate(&input)?;
    run(input, policy.into()).await
}

/// Read the current label of a started session without mutating its trajectory.
#[napi(js_name = "getOpenappaStatus")]
pub async fn get_openappa_status(
    organization_id: String,
    session_id: String,
) -> napi::Result<Option<OpenappaStatus>> {
    if organization_id.is_empty()
        || organization_id.len() > 512
        || organization_id.chars().any(char::is_control)
    {
        return Err(error("invalid organization identity"));
    }
    if session_id.is_empty() || session_id.len() > 1024 || session_id.chars().any(char::is_control)
    {
        return Err(error("invalid session identity"));
    }
    let result = AssertUnwindSafe(async move {
        let state = initialized().await?;
        let leased = state.lease().await?;
        tokio::task::spawn_blocking(move || {
            let key = SessionKey::new(&organization_id, &session_id);
            let root = postgres_store(&leased.state.store)?
                .with_client(move |client| {
                    Ok(client
                        .query_opt(
                            "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                            &[&key.organization_id, &key.actor],
                        )?
                        .map(|row| row.get::<_, String>(0)))
                })
                .map_err(error)?;
            let Some(root) = root else { return Ok(None) };
            let status = leased
                .state
                .runtime
                .try_status(&TrajectoryId(root))
                .map_err(error)?;
            Ok(Some(OpenappaStatus {
                trust: status.trust,
                audience: status.audience,
            }))
        })
        .await
        .map_err(error)?
    })
    .catch_unwind()
    .await;
    match result {
        Ok(result) => result,
        Err(_) => Err(error("OpenAPPA panicked while reading status")),
    }
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
        ("fork", &input.fork_of),
        ("operation", &input.operation_id),
        ("tool call", &input.tool_call_id),
        ("spawn call", &input.spawn_call_id),
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
    for (name, value) in [
        ("tool spelling", &input.spelling),
        ("dispatch tool", &input.dispatch),
    ] {
        if let Some(value) = value
            && (value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control))
        {
            return Err(error(format!("invalid {name}")));
        }
    }
    if let Some(refusal) = &input.precheck_refusal {
        // A refusal answers a remedy no human ruled on, so a ruling beside
        // it would be silently dropped.
        if input.event != HookEventKind::Remedy || input.ruling.is_some() {
            return Err(error("a precheck refusal only answers an unruled remedy"));
        }
        if refusal.trim().is_empty() || refusal.len() > MAX_PRECHECK_REFUSAL_BYTES {
            return Err(error("invalid precheck refusal"));
        }
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
        HookEventKind::ChildReturn => {
            required(&input.operation_id, "operation_id")?;
            required(&input.parent_id, "parent_id")?;
            if input.output.is_none() {
                return Err(error("missing output"));
            }
        }
        HookEventKind::ChildAddress => {
            required(&input.operation_id, "operation_id")?;
            let child = required(&input.spawned_id, "spawned_id")?;
            if child.len() > 1024 || child.chars().any(char::is_control) {
                return Err(error("invalid child identity"));
            }
            if input.output.is_none() {
                return Err(error("missing output"));
            }
        }
    }
    Ok(())
}

/// Runs one validated event through a view pinned to its organization's deployment.
async fn run(input: Input, policy: deployments::HostedPolicy) -> napi::Result<String> {
    let result = AssertUnwindSafe(async {
        let state = initialized().await?;
        let deployment = state
            .deployments
            .deployment(
                &state.runtime,
                &input.organization_id,
                &policy,
                state.reporting.is_some(),
            )
            .await
            .map_err(error)?;
        state.pinned(&deployment).dispatch(input).await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(Ok(value)) => Ok(value.to_string()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(error("OpenAPPA panicked; operation was not released")),
    }
}

async fn initialized() -> napi::Result<State> {
    state_mutex()
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| error("OpenAPPA is not initialized"))
}

/// Executes a remedy for the proxy-stamped trajectory, resolving that session
/// from PostgreSQL. The caller, when present, is the receipt spender.
#[napi(js_name = "executeRemedyByOffer")]
pub async fn execute_remedy_by_offer(
    input: String,
    policy: DispatchPolicy,
) -> napi::Result<String> {
    let input: OfferInput = serde_json::from_str(&input).map_err(error)?;
    if input.organization_id.is_empty()
        || input.organization_id.len() > 512
        || input.organization_id.chars().any(char::is_control)
    {
        return Err(error("invalid organization identity"));
    }
    validate_trajectory(&input.trajectory)?;
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
    let _: ExecuteRemedyPlanArgs = serde_json::from_str(visible_arguments.get()).map_err(error)?;
    let state = initialized().await?;
    let owner = {
        let leased = state.lease().await?;
        routing_owner(postgres_store(&leased.state.store)?, &input)?
    };
    let Some(owner) = owner else {
        return Ok(
            with_offer_status(render_unknown_offer()?, OfferStatusKind::Unknown)?.to_string(),
        );
    };
    let input = Input {
        yell_receiver: None,
        organization_id: owner.organization_id,
        // Scopes a caller-bound receipt to the authenticated spender. Absent
        // for an anonymous organization token.
        caller_id: input.caller_id.clone(),
        session_id: owner.session_id,
        parent_id: owner.parent_id,
        principal: None,
        fork_of: None,
        event: HookEventKind::Remedy,
        operation_id: None,
        tool_call_id: input.tool_call_id,
        tool: None,
        arguments: Some(visible_arguments),
        original_arguments: Some(original_arguments),
        spawn: false,
        output: None,
        spawned_id: None,
        spawn_call_id: None,
        child_native_id: None,
        outcome: None,
        owner_root: Some(owner.root),
        spelling: None,
        dispatch: None,
        presentation: Some(input.presentation),
        ruling: input.ruling,
        precheck_refusal: input.precheck_refusal,
    };
    validate(&input)?;
    let response: Value = serde_json::from_str(&run(input, policy.into()).await?).map_err(error)?;
    Ok(with_offer_status(response, OfferStatusKind::Known)?.to_string())
}

#[napi(object)]
#[derive(Serialize)]
pub struct OfferReviewOutput {
    pub offer_id: String,
    pub text: String,
    pub session_id: String,
    /// The reviewed call's tool, as the host proposed it.
    pub tool: Option<String>,
    /// The reviewed call's arguments as JSON text. The ledger keeps them as
    /// JSONB, so key order and spacing can differ from the proposal; the
    /// values cannot.
    pub arguments: Option<String>,
}

/// Loads the review entry for an offer from the retained DenyCall in PostgreSQL.
/// Session routing comes from the proxy-stamped current trajectory; no offer-owner lookup.
#[napi(js_name = "loadOfferReview")]
pub async fn load_offer_review(
    organization_id: String,
    session_id: String,
    offer_id: String,
) -> napi::Result<Option<OfferReviewOutput>> {
    let session_id_for_output = session_id.clone();
    // Mirror execute_remedy_by_offer: clone state, drop the mutex, then lease
    // a connection before host SQL so review loads never contend with
    // dispatches on the runtime state mutex.
    let state = initialized().await?;
    let leased = state.lease().await?;
    let pg = postgres_store(&leased.state.store)?;
    // The SQL closure needs its own offer id copy because it must be 'static.
    let target_offer_id = offer_id.clone();
    let review = pg
        .with_client(move |client| {
            // session_id is the leading PK column of openappa_operations, and
            // organization_id is an additional tenancy guard. The JSONB match
            // is pushed into SQL so only the matching entry's text crosses the
            // boundary instead of every reviewed decision. The lateral join
            // scans each reviewed decision's entries linearly, which is
            // bounded by the handful of review entries a policy's DenyCall
            // carries; it is not sized for unbounded per-decision reviews.
            // The reviewed call is the one this receipt admitted or blocked:
            // its host context, or the semantic input of a receipt that
            // predates context.
            let row = client.query_opt(
                "SELECT entry->>'text' AS text, \
                 COALESCE(o.input->'context'->>'tool', o.input->'semantic'->>'tool') AS tool, \
                 COALESCE(o.input->'context'->'arguments', o.input->'semantic'->'arguments')::text AS arguments \
                 FROM openappa_operations o \
                 CROSS JOIN LATERAL jsonb_array_elements(o.decision->'review') AS entry \
                 WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                 AND o.decision->'review' IS NOT NULL \
                 AND entry->>'offer_id' = $3 \
                 ORDER BY o.created_at DESC \
                 LIMIT 1",
                &[&organization_id, &session_id, &target_offer_id],
            )?;
            Ok(row.map(|row| {
                (
                    row.get::<_, String>("text"),
                    row.get::<_, Option<String>>("tool"),
                    row.get::<_, Option<String>>("arguments"),
                )
            }))
        })
        .map_err(error)?;

    Ok(review.map(|(text, tool, arguments)| OfferReviewOutput {
        offer_id,
        text,
        session_id: session_id_for_output,
        tool,
        arguments,
    }))
}

#[napi(object)]
#[derive(Default)]
pub struct ChildReturnLookup {
    /// Narrow the authority lookup to one registered child when known.
    pub child_session_id: Option<String>,
    /// Load only the latest admitted operation with this task prefix.
    pub operation_prefix: Option<String>,
}

#[napi(object)]
#[derive(Serialize)]
pub struct ChildReturnRecord {
    /// Fully scoped session id of the child whose return crossed.
    pub child_session_id: String,
    /// The spawn call the return answers, when the child named it at ChildEnd.
    pub spawn_call_id: Option<String>,
    /// The client-native child identity, when the child named one.
    pub child_native_id: Option<String>,
    /// The operation that durably recorded this crossing. An echo keeps its
    /// `:echo` suffix so a task prefix still matches.
    pub operation_id: Option<String>,
    /// The exact bytes the runtime admitted across the child boundary.
    pub value: String,
}

/// Loads the child returns a parent's family durably crossed, from the
/// retained ChildEnd and admitted ChildReturn operations in PostgreSQL. This
/// is the authority the parent side verifies an arriving completion against;
/// nothing the client carries proves a return.
#[napi(js_name = "loadChildReturns")]
pub async fn load_child_returns(
    organization_id: String,
    parent_session_id: String,
    lookup: Option<ChildReturnLookup>,
) -> napi::Result<Vec<ChildReturnRecord>> {
    // Mirror load_offer_review: clone state, drop the mutex, then lease a
    // connection before host SQL so lookups never contend with dispatches.
    let state = {
        let slot = state_mutex().lock().await;
        slot.as_ref()
            .ok_or_else(|| error("OpenAPPA is not initialized"))?
            .clone()
    };
    let leased = state.lease().await?;
    let pg = postgres_store(&leased.state.store)?;
    pg.with_client(move |client| {
        // session_id is the leading PK column of openappa_operations, and
        // organization_id is an additional tenancy guard. ChildEnd keeps its
        // existing reading: a staged end carries decision.value, a released
        // one carries input.output, and the echo is not another crossing.
        // ChildReturn is a mid-turn crossing. Only an ack is admitted — a
        // child_return decision is still staged, or is a substitution the
        // host has not echoed — and the ack's output is the exact bytes that
        // crossed. The echo ack is that crossing, so its operation id is kept,
        // suffix included. A row this filter drops must not fail the lookup.
        use postgres::{fallible_iterator::FallibleIterator, types::ToSql};
        let lookup = lookup.unwrap_or_default();
        let limit: i64 = if lookup.operation_prefix.is_some() { 1 } else { 10_001 };
        // PostgreSQL's heterogeneous bind-parameter API, not domain type erasure.
        let params: &[&(dyn ToSql + Sync)] = &[
            &organization_id, &parent_session_id, &lookup.child_session_id,
            &lookup.operation_prefix, &limit,
        ];
        let mut rows = client.query_raw(
            "SELECT o.session_id AS child_session_id, \
              o.operation_id, \
              COALESCE(o.input->'semantic'->>'event', o.input->>'event') AS event, \
              o.decision->>'decision' AS decision, \
              o.decision->>'value' AS decision_value, \
              COALESCE(o.input->'semantic'->>'spawn_call_id', o.input->>'spawn_call_id') AS spawn_call_id, \
              COALESCE(o.input->'semantic'->>'child_native_id', o.input->>'child_native_id') AS child_native_id, \
              COALESCE(o.input->'semantic'->>'output', o.input->>'output') AS output \
              FROM openappa_operations o \
              WHERE o.organization_id=$1 AND o.status='complete' \
              AND EXISTS (SELECT 1 FROM openappa_sessions s \
                WHERE s.session_id=o.session_id AND s.organization_id=$1 AND s.parent_id=$2) \
              AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') IN ('child_end', 'child_return') \
              AND (o.decision->>'decision' = 'ack' OR \
                (COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_end' \
                 AND o.decision->>'decision' = 'child_return')) \
              AND ((COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_return' \
                    AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL) \
                OR (COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_end' \
                    AND o.operation_id NOT LIKE '%:echo' \
                    AND ((o.decision->>'decision' = 'ack' \
                          AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL) \
                      OR (o.decision->>'decision' = 'child_return' AND o.decision->>'value' IS NOT NULL)))) \
              AND ($3::text IS NULL OR o.session_id=$3) \
              AND ($4::text IS NULL OR left(o.operation_id,length($4))=$4) \
              ORDER BY o.created_at DESC, o.session_id, o.operation_id DESC LIMIT $5",
            params.iter().copied(),
        )?;
        let mut records = Vec::new();
        let mut budget = ReceiptLookupBudget::default();
        while let Some(row) = rows.next()? {
            let event: Option<String> = row.get("event");
            let operation_id: String = row.get("operation_id");
            let decision: Option<String> = row.get("decision");
            let decision_value: Option<String> = row.get("decision_value");
            let output: Option<String> = row.get("output");
            budget.take(decision_value.as_deref().unwrap_or("").len()
                .saturating_add(output.as_deref().unwrap_or("").len()))?;
            let Some(crossed) = crossed_return(ReturnReceipt {
                event: event.as_deref().unwrap_or(""),
                operation_id: &operation_id,
                decision: decision.as_deref().unwrap_or(""),
                decision_value: decision_value.as_deref(),
                output: output.as_deref(),
            }) else {
                continue;
            };
            records.push(ChildReturnRecord {
                child_session_id: row.get("child_session_id"),
                spawn_call_id: row.get("spawn_call_id"),
                child_native_id: row.get("child_native_id"),
                operation_id: Some(crossed.operation_id),
                value: crossed.value,
            });
        }
        Ok(records)
    })
    .map_err(error)
}

#[napi(object)]
#[derive(Serialize)]
pub struct ChildAddressRecord {
    /// Fully scoped session id of the parent that addressed the child.
    pub parent_session_id: String,
    /// The exact message the parent addressed to the child.
    pub value: String,
}

/// Loads the messages a child's parent addressed to it, from the retained
/// ChildAddress operations in PostgreSQL. This is the authority the child side
/// verifies an arriving message against; nothing the client carries proves one.
#[napi(js_name = "loadChildAddresses")]
pub async fn load_child_addresses(
    organization_id: String,
    child_session_id: String,
) -> napi::Result<Vec<ChildAddressRecord>> {
    // Mirror load_child_returns: clone state, drop the mutex, then lease a
    // connection before host SQL so lookups never contend with dispatches.
    let state = {
        let slot = state_mutex().lock().await;
        slot.as_ref()
            .ok_or_else(|| error("OpenAPPA is not initialized"))?
            .clone()
    };
    let leased = state.lease().await?;
    let pg = postgres_store(&leased.state.store)?;
    pg.with_client(move |client| {
        // Only the child's own parent addresses it, and only an address the
        // runtime acknowledged carried the parent's label into the child.
        use postgres::{fallible_iterator::FallibleIterator, types::ToSql};
        let params: &[&(dyn ToSql + Sync)] = &[&organization_id, &child_session_id];
        let mut rows = client.query_raw(
            "SELECT o.session_id AS parent_session_id, \
              COALESCE(o.input->'semantic'->>'output', o.input->>'output') AS value \
              FROM openappa_operations o \
              WHERE o.organization_id=$1 AND o.status='complete' \
              AND EXISTS (SELECT 1 FROM openappa_sessions s \
                WHERE s.organization_id=$1 AND s.session_id=$2 AND s.parent_id=o.session_id) \
              AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_address' \
              AND COALESCE(o.input->'semantic'->>'spawned_id', o.input->>'spawned_id') = $2 \
              AND o.decision->>'decision' = 'ack' \
              AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL \
              ORDER BY o.created_at LIMIT 10001",
            params.iter().copied(),
        )?;
        let mut records = Vec::new();
        let mut budget = ReceiptLookupBudget::default();
        while let Some(row) = rows.next()? {
            let value: Option<String> = row.get("value");
            budget.take(value.as_deref().unwrap_or("").len())?;
            records.push(ChildAddressRecord {
                parent_session_id: row.get("parent_session_id"),
                value: value.ok_or_else(|| {
                    PostgresError("OpenAPPA retained a child address without a value".into())
                })?,
            });
        }
        Ok(records)
    })
    .map_err(error)
}

/// Whether this child's parent addressed it before the child's first event.
fn addressed_before_start(pg: &LeasedPostgres, input: &Input) -> napi::Result<bool> {
    let Some(parent) = input.parent_id.clone() else {
        return Ok(false);
    };
    let (organization_id, child) = (input.organization_id.clone(), input.session_id.clone());
    pg.with_client(move |client| {
        Ok(client
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM openappa_operations o \
                  WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                  AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_address' \
                  AND COALESCE(o.input->'semantic'->>'spawned_id', o.input->>'spawned_id') = $3)",
                &[&organization_id, &parent, &child],
            )?
            .get::<_, bool>(0))
    })
    .map_err(error)
}

/// Receipt key for a spawn call. The host's id is raw; the operation the tool-call
/// dispatch stored is `call:<id>`. The engine does not accept either string as a
/// [`SpawnRef`].
fn spawn_operation_id(spawn_call_id: &str) -> String {
    format!("call:{spawn_call_id}")
}

/// Refuse the whole authority lookup on overflow: partial history cannot prove
/// that an omitted child never crossed, including enforcement-off recovery.
#[derive(Default)]
struct ReceiptLookupBudget {
    records: usize,
    bytes: usize,
}

impl ReceiptLookupBudget {
    fn take(&mut self, bytes: usize) -> Result<(), PostgresError> {
        self.records = self.records.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.records > 10_000 || self.bytes > 8 * 1024 * 1024 {
            return Err(PostgresError(
                "OpenAPPA receipt history exceeds its bounded lookup; narrow the child/task lookup"
                    .into(),
            ));
        }
        Ok(())
    }
}

struct ReturnReceipt<'a> {
    event: &'a str,
    operation_id: &'a str,
    decision: &'a str,
    decision_value: Option<&'a str>,
    output: Option<&'a str>,
}

struct CrossedReturn {
    operation_id: String,
    value: String,
}

/// Which retained receipt is a crossing the parent may read back.
///
/// ChildEnd is unchanged: the base operation carries the admitted bytes, and
/// its echo is not a second crossing. ChildReturn admits only an ack. A
/// `child_return` decision is still staged, or is a substitution the host has
/// not echoed, so it is not a value. The echo ack is the crossing, and its
/// operation id keeps the `:echo` suffix.
fn crossed_return(receipt: ReturnReceipt<'_>) -> Option<CrossedReturn> {
    let value = match receipt.event {
        "child_end"
            if !receipt.operation_id.ends_with(":echo")
                && matches!(receipt.decision, "ack" | "child_return") =>
        {
            receipt.decision_value.or(receipt.output)
        }
        "child_return" if receipt.decision == "ack" => receipt.output,
        _ => None,
    }?;
    Some(CrossedReturn {
        operation_id: receipt.operation_id.to_owned(),
        value: value.to_owned(),
    })
}

/// A named spawn call binds only through the receipt's sealed binding. Omitting the
/// call id keeps the native in-flight path. A named call with no binding does not
/// guess.
fn spawn_ref_from_receipt(
    spawn_call_id: Option<&str>,
    binding: Option<String>,
) -> Result<SpawnRef, &'static str> {
    match spawn_call_id {
        None => Ok(SpawnRef::InFlight),
        Some(_) => {
            let Some(binding) = binding.filter(|binding| !binding.is_empty()) else {
                return Err("spawn call has no released binding");
            };
            Ok(SpawnRef::Binding(SpawnBinding(binding)))
        }
    }
}

/// The sealed binding a released spawn handed back, from the parent's completed
/// allow-call receipt. `None` when that receipt is absent, incomplete, or not a
/// spawn release.
fn released_spawn_binding(
    pg: &LeasedPostgres,
    organization_id: &str,
    parent_session_id: &str,
    spawn_call_id: &str,
) -> napi::Result<Option<String>> {
    let organization_id = organization_id.to_owned();
    let parent_session_id = parent_session_id.to_owned();
    let operation_id = spawn_operation_id(spawn_call_id);
    pg.with_client(move |client| {
        let Some(row) = client.query_opt(
            "SELECT input, status, decision FROM openappa_operations \
             WHERE organization_id = $1 AND session_id = $2 AND operation_id = $3",
            &[&organization_id, &parent_session_id, &operation_id],
        )?
        else {
            return Ok(None);
        };
        let status: String = row.get("status");
        if status != "complete" {
            return Ok(None);
        }
        let input: Value = row.get("input");
        let decision: Option<Value> = row.get("decision");
        let Some(decision) = decision else {
            return Ok(None);
        };
        let semantic = input.get("semantic").unwrap_or(&input);
        if semantic.get("spawn").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        if decision.get("decision").and_then(Value::as_str) != Some("allow_call") {
            return Ok(None);
        }
        Ok(decision
            .get("spawn_binding")
            .and_then(Value::as_str)
            .filter(|binding| !binding.is_empty())
            .map(str::to_owned))
    })
    .map_err(error)
}

enum AddressedChild {
    /// Exact persisted child. The string is the stored actor, not a synthesized id.
    Rebind(String),
    /// Native `{parent}:` name with no row yet. The first event joins the label.
    UnstartedNative,
    /// No exact row, and not an unstarted native child.
    Foreign,
}

fn classify_addressed_child(
    parent: &str,
    child_session: &str,
    stored_actor: Option<String>,
) -> AddressedChild {
    if let Some(actor) = stored_actor {
        return AddressedChild::Rebind(actor);
    }
    if child_session.starts_with(&format!("{parent}:")) {
        AddressedChild::UnstartedNative
    } else {
        AddressedChild::Foreign
    }
}

/// Re-bind a started child to the dispatcher's family root and the actor the row stored.
fn rebind_child(root: &TrajectoryId, stored_actor: String) -> HookEvent {
    HookEvent::ChildStart {
        root: root.clone(),
        child: TrajectoryId(stored_actor),
        spawn: SpawnRef::InFlight,
    }
}

struct SessionLock<'a> {
    pg: &'a LeasedPostgres,
    root: String,
}
impl<'a> SessionLock<'a> {
    fn acquire(pg: &'a LeasedPostgres, root: String) -> napi::Result<Self> {
        let key = root.clone();
        pg.with_client(move |client| {
            client.query_one("SELECT pg_advisory_lock(hashtextextended($1, 0))", &[&key])?;
            Ok(())
        })
        .map_err(error)?;
        Ok(Self { pg, root })
    }
}
impl Drop for SessionLock<'_> {
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

/// In-process per-trajectory exclusion. The advisory session lock only
/// excludes other connections: on this process's one ledger connection it is
/// reentrant, so it cannot order this process's own dispatches. Unrelated
/// roots overlap freely; dispatches for one root queue here. One root is one
/// chat session, so the registry grows with the distinct sessions this
/// process has served, a few hundred bytes each — the same lifetime the
/// sandbox handle slots keep. Removing an entry is not safe while a later
/// dispatch could already be queued on it, so entries stay for the process's
/// life; revisit only if distinct-root counts grow unbounded in production.
static ROOT_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

struct RootLock {
    _guard: OwnedMutexGuard<()>,
}

impl RootLock {
    async fn acquire(root: String) -> Self {
        let lock = {
            let mut registry = root_locks().lock().await;
            registry.entry(root).or_default().clone()
        };
        let _guard = lock.lock_owned().await;
        Self { _guard }
    }
}

fn root_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    ROOT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl State {
    /// Opens this session's root as a fork of `fork_of`.
    /// Freezes the parent session's policy revision, labels, effects, and
    /// denials into the new root. Returns the parent watermark bounding inherited results.
    fn open_fork(
        &self,
        pg: &LeasedPostgres,
        input: &Input,
        fork_of: &str,
        root: &str,
    ) -> napi::Result<Option<SystemTime>> {
        if input.parent_id.is_some() {
            return Err(error(
                "an OpenAPPA session cannot both fork a session and be its child",
            ));
        }
        let parent = SessionKey::new(&input.organization_id, fork_of);
        let (lookup, caller_id) = (parent.clone(), input.caller_id.clone());
        let (parent_root, parent_is_child) = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id IS NOT NULL FROM openappa_sessions WHERE organization_id = $1 AND actor = $2 AND caller_id IS NOT DISTINCT FROM $3",
                        &[&lookup.organization_id, &lookup.actor, &caller_id],
                    )?
                    .map(|row| (row.get::<_, String>(0), row.get::<_, bool>(1))))
            })
            .map_err(error)?
            .ok_or_else(|| error("the session this one forks has not started"))?;
        // A top-level session's trajectory is its root, a child's is its actor.
        let parent_trajectory = if parent_is_child {
            parent.actor
        } else {
            parent_root.clone()
        };

        let fork_root = root.to_owned();
        let already_opened = pg
            .with_client(move |client| {
                Ok(client
                    .query_one(
                        "SELECT EXISTS (SELECT 1 FROM openappa_events WHERE root = $1)",
                        &[&fork_root],
                    )?
                    .get::<_, bool>(0))
            })
            .map_err(error)?;
        if already_opened {
            // A crash after `Runtime::open_root_fork` but before our session row left a
            // durable opening without a reliable boundary. Re-open it to verify
            // its immutable origin matches this request, but keep results closed.
            self.runtime
                .open_root_fork(
                    &TrajectoryId(parent_root),
                    &TrajectoryId(parent_trajectory),
                    &TrajectoryId(root.to_owned()),
                )
                .map_err(error)?;
            return Ok(None);
        }

        // This dispatch already holds the child lock. It then takes the parent
        // lock, while a parent never takes a child lock, so this order has no cycle.
        let _parent_lock = SessionLock::acquire(pg, parent_root.clone())?;
        self.runtime
            .open_root_fork(
                &TrajectoryId(parent_root),
                &TrajectoryId(parent_trajectory),
                &TrajectoryId(root.to_owned()),
            )
            .map_err(error)?;
        // A parent result claims `created_at` under this same parent lock. The
        // database clock taken before releasing it is therefore an exact cutoff.
        pg.with_client(|client| {
            Ok(client
                .query_one("SELECT clock_timestamp()", &[])?
                .get::<_, SystemTime>(0))
        })
        .map(Some)
        .map_err(error)
    }

    /// This state with its runtime pinned to `deployment`: every lease of it, and
    /// every view made of such a lease, serves that deployment.
    fn pinned(&self, deployment: &PreparedDeployment) -> State {
        State {
            runtime: Arc::new(self.runtime.pinned(deployment)),
            ..self.clone()
        }
    }

    /// This state over one pooled connection: the store is a lease of it and
    /// the runtime records through that lease.
    async fn lease(&self) -> napi::Result<Leased> {
        let permit = connection_permit(&self.connections, CONNECTION_WAIT).await?;
        let store = Arc::new(self.store.lease().map_err(error)?);
        Ok(Leased {
            state: State {
                runtime: Arc::new(self.runtime.on(store.clone())),
                store,
                ..self.clone()
            },
            _permit: permit,
        })
    }

    async fn dispatch(&self, input: Input) -> napi::Result<Value> {
        let key = SessionKey::of(&input);
        let root = if let Some(root) = input.owner_root.clone() {
            root
        } else if let Some(parent_id) = &input.parent_id {
            // A parent is only ever looked up in the child's own organization.
            let parent = SessionKey::new(&input.organization_id, parent_id);
            let leased = self.lease().await?;
            postgres_store(&leased.state.store)?
                .with_client(move |client| {
                    client
                        .query_opt(
                            "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                            &[&parent.organization_id, &parent.actor],
                        )?
                        .map(|row| row.get::<_, String>(0))
                        .ok_or_else(|| PostgresError("parent session has not started".into()))
                })
                .map_err(error)?
        } else {
            self.session_root(&input, &key).await?
        };
        let _root = RootLock::acquire(root.clone()).await;
        let mut leased = self.lease().await?;
        let consults = Arc::new(consults::ConsultBuffer::default());
        leased.state.runtime = Arc::new(leased.state.runtime.recording(consults.clone()));
        let attribution = consults::Attribution {
            organization_id: input.organization_id.clone(),
            session_id: input.session_id.clone(),
            caller_id: input.caller_id.clone(),
        };
        let result = leased.state.dispatch_on_lease(input, root, key).await;
        // On the dispatch's own connection, after its session lock is released.
        if let Ok(pg) = postgres_store(&leased.state.store) {
            consults::store(pg, attribution, &consults);
        }
        result
    }

    /// The root a top-level session governs: the one its row records once it has
    /// started, [`root_id`] before. A session that started while roots were named by
    /// the session id alone keeps that root, so its history carries on.
    async fn session_root(&self, input: &Input, key: &SessionKey) -> napi::Result<String> {
        let lookup = key.clone();
        let leased = self.lease().await?;
        let recorded = postgres_store(&leased.state.store)?
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                        &[&lookup.organization_id, &lookup.actor],
                    )?
                    .map(|row| row.get::<_, String>(0)))
            })
            .map_err(error)?;
        Ok(recorded.unwrap_or_else(|| root_id(&input.organization_id, &input.session_id)))
    }

    /// The session lock and the runtime's appends lock the same key, which
    /// only one connection can hold twice, so both run on this state's lease.
    async fn dispatch_on_lease(
        &self,
        input: Input,
        root: String,
        key: SessionKey,
    ) -> napi::Result<Value> {
        let pg = postgres_store(&self.store)?;
        let _lock = SessionLock::acquire(pg, root.clone())?;
        // Check every member of the family: continuing a parent while a child's
        // result is interrupted could otherwise bypass inherited restrictions.
        let interrupted = self
            .store
            .has_pending_receipts(&TrajectoryId::new(root.as_str()))
            .map_err(error)?;
        if interrupted {
            return Err(error(
                "OpenAPPA session has interrupted processing; operator recovery is required",
            ));
        }

        let actor = expected_actor(&root, &input.session_id, input.parent_id.as_deref());
        let lookup = key.clone();
        let existing = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id, forked_from FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                        &[&lookup.organization_id, &lookup.actor],
                    )?
                    .map(|row| {
                        (
                            row.get::<_, String>(0),
                            row.get::<_, Option<String>>(1),
                            row.get::<_, Option<String>>(2),
                        )
                    }))
            })
            .map_err(error)?;
        if let Some((saved_root, saved_parent, saved_fork)) = &existing {
            if *saved_root != root || *saved_parent != input.parent_id {
                return Err(error("session identity changed"));
            }
            // A fork retains its parent session. A session with its own root cannot move
            // to a different history.
            if input.fork_of.is_some() && *saved_fork != input.fork_of {
                return Err(error(
                    "OpenAPPA cannot continue another session's history in a session that governs its own trajectory",
                ));
            }
        } else {
            let forked_at = input
                .fork_of
                .as_deref()
                .map(|fork_of| self.open_fork(pg, &input, fork_of, &root))
                .transpose()?
                .flatten();
            let start = if let Some(child) = &actor.child {
                HookEvent::ChildStart {
                    root: actor.root.clone(),
                    child: child.clone(),
                    spawn: self.child_spawn_ref(pg, &input)?,
                }
            } else {
                HookEvent::SessionStart {
                    root: actor.root.clone(),
                    principal: input.principal.clone(),
                    address: None,
                    title: None,
                    start: None,
                    launch: None,
                }
            };
            let decision = hooks::handle(&self.runtime, start).await;
            if !matches!(decision, HookDecision::Ack | HookDecision::Context { .. }) {
                return Err(error(wire(&decision)?));
            }
            // A child opens under its fork's seed: the parent's label when it spawned
            // the child. A parent that addressed the child before this first event may
            // have read more since, so the child takes the parent's current label now,
            // as a later address would give it.
            if let Some(child) = &actor.child
                && addressed_before_start(pg, &input)?
            {
                let readdress = hooks::handle(
                    &self.runtime,
                    HookEvent::ChildStart {
                        root: actor.root.clone(),
                        child: child.clone(),
                        spawn: SpawnRef::InFlight,
                    },
                )
                .await;
                if !matches!(readdress, HookDecision::Ack | HookDecision::Context { .. }) {
                    return Err(error(wire(&readdress)?));
                }
            }
            // A return contract must be delivered before the child starts work.
            // Keep it in the start receipt so repeat SessionStart can deliver it.
            let start_decision = wire(&decision)?;
            let (id, root, input) = (key.actor.clone(), root.clone(), input.clone());
            pg.with_client(move |client| {
                client.execute("INSERT INTO openappa_sessions (actor, root, organization_id, caller_id, session_id, parent_id, forked_from, forked_at, start_decision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                    &[&id, &root, &input.organization_id, &input.caller_id, &input.session_id, &input.parent_id, &input.fork_of, &forked_at, &start_decision])?;
                Ok(())
            }).map_err(error)?;
        }

        if input.event == HookEventKind::SessionStart {
            return pg
                .with_client(move |client| {
                    Ok(client
                        .query_one(
                            "SELECT start_decision FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                            &[&key.organization_id, &key.actor],
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
            let binding = remedy_binding(&input.caller_id);
            if let Some(decision) = claim_operation(
                &self.store,
                &input,
                &root,
                &operation,
                &request,
                binding.clone(),
                None,
            )? {
                return Ok(decision);
            }
            let result_key = input
                .tool_call_id
                .clone()
                .map(|tool_call_id| processed_result_key(&input, tool_call_id));
            if let Some(result_key) = &result_key {
                match self
                    .store
                    .claim_processed_result(ProcessedResultRequest {
                        key: result_key.clone(),
                        root: TrajectoryId::new(root.as_str()),
                    })
                    .map_err(error)?
                {
                    ProcessedResultClaim::Claimed => {}
                    ProcessedResultClaim::Complete { decision, .. } => return Ok(decision),
                }
            }
            if let Some(refusal) = &input.precheck_refusal {
                // The host found the target call would fail even if approved,
                // so no human was asked. The runtime never sees this act: the
                // offer is neither vouched nor spent, and a corrected call
                // earns its own review.
                let response = runtime_refusal(refusal.clone())?;
                return finish_remedy(
                    &self.store,
                    &input,
                    &operation,
                    binding,
                    result_key,
                    response,
                );
            }
            let args: ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(&input)?).map_err(error)?;
            let offer_id = args.offer_id.clone();
            let call = ProposedCall {
                tool: appa_runtime_api::CONTROL_TOOL.into(),
                arguments: input
                    .arguments
                    .clone()
                    .ok_or_else(|| error("missing remedy arguments"))?,
                cwd: None,
            };
            let ruling = input.ruling.as_ref().map(|r| match r {
                RulingInput::Approve => Ruling::Approve,
                RulingInput::Deny => Ruling::Deny,
            });
            let gate = hooks::handle(
                &self.runtime,
                HookEvent::ToolCall {
                    actor: actor.clone(),
                    call,
                    call_id: None,
                    spawn: None,
                    prompt: None,
                    ruling,
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
                let response = runtime_refusal(text)?;
                return finish_remedy(
                    &self.store,
                    &input,
                    &operation,
                    binding,
                    result_key,
                    response,
                );
            }
            // Before the runtime spends the offer. A missing row is empty
            // presentation, not an error, so an old call still redeems.
            let recorded = recorded_call_presentation(
                pg,
                &input.organization_id,
                &input.session_id,
                &offer_id,
            )?;
            let outcome = self
                .runtime
                .execute_embedded_remedy_with_options(&actor, args, presentation_options(&input))
                .await;
            let owner = OfferOwner {
                organization_id: input.organization_id.clone(),
                session_id: input.session_id.clone(),
                parent_id: input.parent_id.clone(),
                root: root.clone(),
                tool: recorded.tool,
                spelling: recorded.spelling,
                dispatch: recorded.dispatch,
            };
            let response = render_remedy_outcome(
                outcome,
                &RemedyAct {
                    owner: &owner,
                    offer_id: &offer_id,
                    ruling: input.ruling,
                },
            )?;
            return finish_remedy(
                &self.store,
                &input,
                &operation,
                binding,
                result_key,
                response,
            );
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
        let mut request = operation_semantic(&input);
        let context = (input.event == HookEventKind::ToolCall).then(|| tool_call_context(&input));
        if input.event == HookEventKind::ToolCall {
            // The receipt key is also the host call identity. Results reconstruct
            // the same namespace from the provider's tool-call ID.
            request["call_id"] = json!(operation);
        }
        if input.event == HookEventKind::ChildAddress {
            // Retained so the child's side can find what its parent addressed to it.
            request["spawned_id"] = json!(input.spawned_id);
        }
        if let Some(decision) = claim_operation(
            &self.store,
            &input,
            &root,
            &operation,
            &request,
            session_binding(&input),
            context,
        )? {
            return Ok(decision);
        }
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
                    harness: adapter::harness(),
                    endpoint: match &input.yell_receiver {
                        Some(receiver) => receiver.endpoint()?,
                        None => reporting.endpoint.clone(),
                    },
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
        } else if input.event == HookEventKind::ChildAddress {
            self.address_child(pg, &input, &actor).await?
        } else {
            let event = match input.event {
                HookEventKind::ToolCall => HookEvent::ToolCall {
                    actor: actor.clone(),
                    call: proposed(&input)?,
                    call_id: Some(operation.clone()),
                    spawn: input.spawn.then_some(SpawnKind::Single),
                    prompt: None,
                    ruling: None,
                },
                HookEventKind::Prompt => HookEvent::Prompt {
                    actor: actor.clone(),
                    text: String::new(),
                    settles: None,
                    peer: None,
                    title: None,
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
                HookEventKind::ChildReturn => HookEvent::ChildReturn {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| error("not a child session"))?,
                    value: input
                        .output
                        .clone()
                        .ok_or_else(|| error("missing output"))?,
                },
                HookEventKind::SessionStart
                | HookEventKind::ToolResult
                | HookEventKind::CancelCall
                | HookEventKind::Remedy
                | HookEventKind::Yell
                | HookEventKind::ChildAddress => return Err(error("unsupported OpenAPPA event")),
            };
            let outcome = hooks::handle_embedded_with_options(
                &self.runtime,
                event,
                presentation_options(&input),
            )
            .await;
            wire(&outcome.decision)?
        };
        finish_operation(
            &self.store,
            &input,
            &operation,
            &decision,
            session_binding(&input),
        )?;
        Ok(decision)
    }

    /// The sealed spawn binding on the parent's completed allow-call receipt, or the
    /// family's in-flight fork when the host named no spawn call. A supplied call id
    /// never falls back to in-flight: the engine has no call-id spawn reference, and
    /// the receipt's `spawn_binding` is the reference it minted.
    fn child_spawn_ref(&self, pg: &LeasedPostgres, input: &Input) -> napi::Result<SpawnRef> {
        let binding = match input.spawn_call_id.as_deref() {
            Some(spawn_call_id) => {
                let parent = required(&input.parent_id, "parent_id")?;
                released_spawn_binding(pg, &input.organization_id, parent, spawn_call_id)?
            }
            None => None,
        };
        spawn_ref_from_receipt(input.spawn_call_id.as_deref(), binding).map_err(error)
    }

    /// The parent addresses a child it started, so the parent's current label flows into
    /// the child before the child reads the message. The runtime reads a start for a child
    /// it already bound as exactly this. A child that has not started yet is left to its
    /// first event, which takes the parent's label at that point (`addressed_before_start`).
    ///
    /// A started child is the `openappa_sessions` row for this organization whose
    /// `session_id` and `parent_id` are exactly the addressed session and this dispatcher.
    /// That row authorizes a runtime workspace id that does not use the native prefix.
    /// An unstarted native child still has to be named `{parent}:` plus a suffix. A prefix
    /// alone never selects a row: a grandchild or a same-prefix foreign session does not
    /// match `parent_id` and is not joined.
    ///
    /// ChildStart names this dispatcher's family root and the stored child actor, not the
    /// dispatcher's own child trajectory. The dispatch already holds the family lock.
    async fn address_child(
        &self,
        pg: &LeasedPostgres,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let (parent, child_session) = (
            input.session_id.clone(),
            required(&input.spawned_id, "spawned_id")?.to_owned(),
        );
        let (lookup_org, lookup_parent, lookup_child) = (
            input.organization_id.clone(),
            parent.clone(),
            child_session.clone(),
        );
        let started = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT actor FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2 AND parent_id = $3",
                        &[&lookup_org, &lookup_child, &lookup_parent],
                    )?
                    .map(|row| row.get::<_, String>(0)))
            })
            .map_err(error)?;
        let stored_actor = match classify_addressed_child(&parent, &child_session, started) {
            AddressedChild::Rebind(stored_actor) => stored_actor,
            AddressedChild::UnstartedNative => return Ok(json!({ "decision": "ack" })),
            AddressedChild::Foreign => {
                return Ok(json!({
                    "decision": "block",
                    "feedback": "OpenAPPA did not send this message: its recipient is not a child of this session.",
                }));
            }
        };
        let decision = hooks::handle(&self.runtime, rebind_child(&actor.root, stored_actor)).await;
        match decision {
            // The contract text is the child's to read at its own start, not the parent's.
            HookDecision::Ack | HookDecision::Context { .. } => Ok(json!({ "decision": "ack" })),
            other => wire(&other),
        }
    }

    async fn result(
        &self,
        pg: &LeasedPostgres,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let call_id = required(&input.tool_call_id, "tool_call_id")?.to_owned();
        if let Some(withheld) = peer::forged_read_result(pg, input, &call_id)? {
            return Ok(withheld);
        }
        let key = processed_result_key(input, call_id.clone());
        match self
            .store
            .claim_processed_result(ProcessedResultRequest {
                key: key.clone(),
                root: actor.root.clone(),
            })
            .map_err(error)?
        {
            ProcessedResultClaim::Claimed => {}
            ProcessedResultClaim::Complete { decision, .. } => return Ok(decision),
        }
        let operation = operation_key(input, session_binding(input), format!("call:{call_id}"));
        let Some(released) = read_completed_operation(pg, &operation)? else {
            // A fork replays the history of the session it forks: a result from before the
            // fork comes back as that session processed it, never as an unknown call.
            let response =
                inherited_result(pg, input, &call_id)?.unwrap_or_else(unknown_result_response);
            let approved = decision_text(&response)?;
            self.store
                .complete_processed_result(key, approved, response.clone())
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
            self.store
                .complete_processed_result(key, approved, response.clone())
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
        let event = if call.spawn {
            // No child return is guessed from an opaque tool result. The child
            // must have reported ChildEnd through its adapter first.
            HookEvent::SpawnResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call)?,
                call_id: Some(format!("call:{call_id}")),
                outcome,
                child: input
                    .spawned_id
                    .as_deref()
                    .map(session_actor)
                    .map(TrajectoryId),
                value: input.spawned_id.as_ref().and_then(|_| input.output.clone()),
            }
        } else {
            HookEvent::ToolResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call)?,
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
            with_presentation_offers(wire(&decision)?, outcome.presentation.as_ref())?
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
                &self.store,
                input,
                &actor.root.0,
                &operation,
                &request,
                session_binding(input),
                None,
            )? {
                response = saved;
            } else {
                finish_operation(
                    &self.store,
                    input,
                    &operation,
                    &response,
                    session_binding(input),
                )?;
            }
        }
        let approved = decision_text(&response)?;
        self.store
            .complete_processed_result(key, approved, response.clone())
            .map_err(error)?;
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

/// Constructs a refusal response not generated by the runtime engine.
/// Used for control-gate refusals and host precheck refusals.
fn runtime_refusal(text: String) -> napi::Result<Value> {
    serde_json::to_value(HostMcpResult {
        decision: "mcp_result",
        approved_output: text.clone(),
        output_source: OutputSource::Runtime,
        reason: None,
        result: HostToolResult {
            is_error: true,
            content: vec![HostText { kind: "text", text }],
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

fn with_presentation_offers(
    mut response: Value,
    presentation: Option<&RemedyPresentation>,
) -> napi::Result<Value> {
    let offers = presentation_offer_ids(presentation);
    if offers.is_empty() {
        return Ok(response);
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| error("decision is not an object"))?;
    object.insert(
        "offers".to_owned(),
        json!(
            offers
                .into_iter()
                .map(|id| json!({ "offer_id": id.0 }))
                .collect::<Vec<_>>()
        ),
    );
    Ok(response)
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

/// Context for a remedy outcome, including offer ownership, offer ID,
/// and human review decision.
struct RemedyAct<'a> {
    owner: &'a OfferOwner,
    offer_id: &'a str,
    ruling: Option<RulingInput>,
}

fn render_remedy_outcome(outcome: RemedyOutcome, act: &RemedyAct) -> napi::Result<Value> {
    let owner = Some(act.owner);
    let (output_source, reason, is_error, text) = match outcome {
        RemedyOutcome::Authorized { call } => (
            OutputSource::Runtime,
            None,
            false,
            render_released_call("Authorized", &call, owner),
        ),
        RemedyOutcome::Returned { value } => (OutputSource::Tool, None, false, value),
        RemedyOutcome::Declined { presentation } => (
            OutputSource::Runtime,
            None,
            false,
            render_human_denial(&presentation, act).unwrap_or(presentation.feedback),
        ),
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

/// Formats a human reviewer denial message.
/// The runtime records the denial and retires the offer.
/// Rewriting requires three conditions: the host recorded a denial, the runtime
/// returned a block, and the offer was retired.
/// Otherwise, the original runtime text returns unchanged.
fn render_human_denial(presentation: &RemedyPresentation, act: &RemedyAct) -> Option<String> {
    let denied = act.ruling == Some(RulingInput::Deny)
        && presentation.feedback.starts_with("[appa] Blocked:")
        && !presentation
            .offers
            .iter()
            .any(|offer| offer.id == act.offer_id);
    if !denied {
        return None;
    }
    let target = act
        .owner
        .spelling
        .as_deref()
        .or(act.owner.tool.as_deref())
        .map_or_else(
            || "this call".to_owned(),
            |tool| format!("this call to {tool}"),
        );
    let mut text = format!(
        "[appa] Denied: the human reviewer refused {target}. It did not run and will not run. \
         Do not retry it or re-submit it with changed arguments or encoding to get another \
         approval; tell the user it was denied."
    );
    if !presentation.offers.is_empty() {
        text.push_str("\n\nThe policy still offers options that do not need this reviewer:\n");
        text.push_str(&presentation.feedback);
    }
    Some(text)
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
    // A call made through the dispatch tool is retried through it: the client
    // may hold no tool by the target's own name.
    if let Some(dispatch) = owner.and_then(|owner| owner.dispatch.as_deref()) {
        return format!(
            "[appa] {status}. Call the {dispatch} tool again with exactly these arguments: {{\"tool_name\":{},\"tool_args\":{}}}",
            Value::String(spelled_tool(&call.tool)),
            call.arguments.get()
        );
    }
    let tool = owner
        .and_then(|owner| owner.spelling.clone())
        .unwrap_or_else(|| spelled_tool(&call.tool));
    // A model that just ran a remedy moves straight on to the retry and never
    // mentions it; the user must still learn which plan changed their session.
    // The user may have accepted the plan through ask_user, so the text does
    // not credit the model with the choice.
    format!(
        "[appa] {status}. Tell the user in your reply which plan was accepted. Make this your next call: until it runs, the session keeps its current label and calls that need the plan stay blocked. Call the {tool} tool again with exactly these arguments: {}",
        call.arguments.get()
    )
}

fn remedy_operation(input: &Input) -> napi::Result<String> {
    match &input.tool_call_id {
        Some(tool_call_id) => Ok(format!("remedy:{tool_call_id}")),
        // Direct clients without a provider call id get a durable crash fence,
        // but no later result is inferred from a fabricated transport id.
        None => Ok(format!(
            "remedy:untracked:{}",
            sha256_hex(serde_json::to_vec(&remedy_fingerprint(input)?).map_err(error)?)
        )),
    }
}

fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    Sha256::digest(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

/// How many forks up the line a result is looked for. A fork of a fork of … deeper than this
/// sees an older result as unknown, which withholds it: the safe side.
const MAX_FORK_DEPTH: usize = 32;

/// The decision the session this one forks from processed for `call_id`, looked up the fork
/// line. A child accepts only results claimed before its parent-lock-protected watermark, so it
/// replays the history it started with rather than later parent activity.
fn inherited_result(
    pg: &LeasedPostgres,
    input: &Input,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let (organization_id, mut session, call_id) = (
        input.organization_id.clone(),
        input.session_id.clone(),
        call_id.to_owned(),
    );
    pg.with_client(move |client| {
        for _ in 0..MAX_FORK_DEPTH {
            let Some((parent, forked_at)) = client
                .query_opt(
                    "SELECT forked_from, forked_at FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&organization_id, &session_actor(&session)],
                )?
                .and_then(|row| {
                    row.get::<_, Option<String>>(0)
                        .zip(row.get::<_, Option<SystemTime>>(1))
                })
            else {
                return Ok(None);
            };
            if let Some(row) = client.query_opt(
                "SELECT decision FROM openappa_processed_results WHERE session_id = $1 AND tool_call_id = $2 AND organization_id = $3 AND status = 'complete' AND created_at < $4",
                &[&parent, &call_id, &organization_id, &forked_at],
            )? {
                return Ok(row.get::<_, Option<Value>>(0));
            }
            session = parent;
        }
        Ok(None)
    })
    .map_err(error)
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

fn proposed_recorded_call(call: &RecordedCall) -> napi::Result<ProposedCall> {
    Ok(ProposedCall {
        tool: canonical_tool(&call.tool)?,
        arguments: call.arguments.clone(),
        cwd: None,
    })
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
        format!("{feedback}\n\n{UNEXECUTED_CALL_HINT}"),
        OutputSource::Runtime,
    )
}

/// Appended to every ruling a model reads in place of a blocked call's result,
/// in Chat and in every proxied client alike, so it is the one place to state
/// what to do after a block. The ruling counts readers rather than naming
/// them, and a model left to fill the gap invents who they are. Clients spell
/// tool names differently, so tools are named generically, ask_user by the
/// short name every spelling keeps. Which question tool to use follows
/// ask_user's own description: the client's own first. A plan is carried out
/// by the call the ruling shows for it, which is not always the remedy tool (a
/// redispatch plan names another tool to run first). The hint says what to do
/// and who decides; provider safety classifiers refused requests that told the
/// model to skip the user.
const UNEXECUTED_CALL_HINT: &str = "The tool did not run. A plan fits unless the narrower session could no longer do what the user asked for or will clearly ask next. Apply a fitting plan with the exact call that the ruling shows for it. If no plan fits, ask the user with a question tool, not in plain text: the client's own question tool if it has one, otherwise ask_user, and say which part of their request the plan would prevent. In questions and replies, describe the block and any plan in the ruling's own words, and do not guess who the readers are beyond the audiences the ruling names. If the ruling offers no plan, explain the ruling to the user.";

/// A result for a call this session never released. The code tells the proxy
/// that nothing ran on the runtime's side: a remedy the gateway never ran
/// comes back this way, and the proxy shows the model what the client returned
/// instead of this text. It is a separate field because callers read `reason`
/// as the text of a block.
fn unknown_result_response() -> Value {
    let approved_output =
        "[appa] Tool output withheld: this result has no record of releasing a call.".to_owned();
    json!({
        "decision": "block",
        "feedback": approved_output,
        "approved_output": approved_output,
        "output_source": OutputSource::Runtime,
        "code": UNRELEASED_CALL_CODE,
    })
}

const UNRELEASED_CALL_CODE: &str = "unreleased_call";

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
    pg: &LeasedPostgres,
    key: &OperationKey,
) -> napi::Result<Option<CompletedOperation>> {
    let session_id = key.session.session_id.clone();
    let operation_id = key.operation_id.clone();
    let organization_id = key.session.organization_id.clone();
    pg.with_client(move |client| {
        let row = client.query_opt(
            "SELECT root, input, status, decision FROM openappa_operations WHERE session_id=$1 AND operation_id=$2 AND organization_id=$3",
            &[&session_id, &operation_id, &organization_id],
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

fn cancelled_call(
    pg: &LeasedPostgres,
    input: &Input,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let key = operation_key(
        input,
        session_binding(input),
        cancellation_operation(call_id),
    );
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
        tool: canonical_tool(required(&input.tool, "tool")?)?,
        arguments: input
            .arguments
            .clone()
            .ok_or_else(|| error("missing arguments"))?,
        cwd: None,
    })
}

/// The identity the runtime judges: the host's spelling derived through the
/// Archestra adapter, the way the wire derives a served host's calls.
fn canonical_tool(raw: &str) -> napi::Result<String> {
    (adapter::adapter().identify_tool)(raw)
        .map(|derived| derived.canonical.as_str().to_owned())
        .map_err(|refusal| {
            error(match refusal {
                appa_runtime_api::ParseRefusal::Unreadable { detail }
                | appa_runtime_api::ParseRefusal::Malformed { detail } => detail,
            })
        })
}

/// The host's spelling of a canonical identity the runtime hands back, for the
/// model's eyes; a canonical id the adapter cannot spell stays as it is.
fn spelled_tool(canonical: &str) -> String {
    CanonicalTool::parse(canonical)
        .ok()
        .and_then(|tool| (adapter::adapter().spell)(&tool))
        .unwrap_or_else(|| canonical.to_owned())
}

fn validate_trajectory(trajectory: &TrajectoryStamp) -> napi::Result<()> {
    if trajectory.v != 1 {
        return Err(error("invalid trajectory"));
    }
    if trajectory.session_id.is_empty()
        || trajectory.session_id.len() > 1024
        || trajectory.session_id.chars().any(char::is_control)
    {
        return Err(error("invalid session identity"));
    }
    if let Some(parent) = &trajectory.parent_id
        && (parent.is_empty() || parent.len() > 1024 || parent.chars().any(char::is_control))
    {
        return Err(error("invalid parent identity"));
    }
    Ok(())
}

/// The actor the runtime must match. A child stamp names this session; a root
/// stamp does not.
fn expected_actor(root: &str, session_id: &str, parent_id: Option<&str>) -> Actor {
    Actor {
        root: TrajectoryId(root.to_owned()),
        child: parent_id
            .is_some()
            .then(|| TrajectoryId(session_actor(session_id))),
    }
}

/// A present caller is the receipt spender. An anonymous token has no user id,
/// so its receipt is session-bound and still not an owner match.
fn remedy_binding(caller_id: &Option<String>) -> ReceiptBinding {
    match caller_id {
        Some(caller_id) => ReceiptBinding::Caller {
            caller_id: caller_id.clone(),
        },
        None => ReceiptBinding::Session { caller_id: None },
    }
}

fn operation_semantic(input: &Input) -> Value {
    json!({
        "event": input.event,
        "tool": input.tool,
        "arguments": input.arguments,
        "spawn": input.spawn,
        "output": input.output,
        "spawn_call_id": input.spawn_call_id,
        "child_native_id": input.child_native_id,
    })
}

/// Host retry text lives beside the call, not in the idempotency key. Absent
/// fields are omitted so an old row and a call without them stay the same shape.
fn tool_call_context(input: &Input) -> Value {
    let mut context = json!({
        "tool": input.tool,
        "arguments": input.arguments,
        "spawn": input.spawn,
        "presentation": input.presentation,
    });
    if let Some(spelling) = &input.spelling {
        context["spelling"] = Value::String(spelling.clone());
    }
    if let Some(dispatch) = &input.dispatch {
        context["dispatch"] = Value::String(dispatch.clone());
    }
    context
}

#[derive(Default)]
struct CallPresentation {
    tool: Option<String>,
    spelling: Option<String>,
    dispatch: Option<String>,
}

fn presentation_from_context(context: Option<&Value>) -> CallPresentation {
    let Some(context) = context else {
        return CallPresentation::default();
    };
    CallPresentation {
        tool: json_string(context, "tool"),
        spelling: json_string(context, "spelling"),
        dispatch: json_string(context, "dispatch"),
    }
}

fn presentation_from_row(context: Option<&Value>, tool: Option<String>) -> CallPresentation {
    let mut presentation = presentation_from_context(context);
    if presentation.tool.is_none() {
        presentation.tool = present(tool);
    }
    presentation
}

fn presentation_from_receipt(
    context: Option<&Value>,
    tool: Option<String>,
    event: Option<&str>,
) -> CallPresentation {
    let mut presentation = presentation_from_row(context, tool);
    if presentation.spelling.is_none() && event == Some("peer_read_notice") {
        presentation.spelling = presentation.tool.clone();
    }
    presentation
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    present(value.get(key).and_then(Value::as_str).map(str::to_owned))
}

fn present(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// The original call's retry text. A missing row or missing fields is an empty
/// presentation, not a refusal: the runtime still decides whether the offer is
/// live, and old rows fall back to the canonical tool spelling.
fn recorded_call_presentation(
    pg: &LeasedPostgres,
    organization_id: &str,
    session_id: &str,
    offer_id: &str,
) -> napi::Result<CallPresentation> {
    let (organization_id, session_id, offer_id) = (
        organization_id.to_owned(),
        session_id.to_owned(),
        offer_id.to_owned(),
    );
    let row = pg
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT o.input->'context' AS context, \
                     COALESCE(o.input->'context'->>'tool', o.input->'semantic'->>'tool', o.input->>'tool') AS tool, \
                     COALESCE(o.input->'semantic'->>'event', o.input->>'event') AS event \
                     FROM openappa_operations o \
                     WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                     AND ( \
                       EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.decision->'offers', '[]'::jsonb)) AS offer \
                         WHERE offer->>'offer_id' = $3) \
                       OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.decision->'review', '[]'::jsonb)) AS entry \
                         WHERE entry->>'offer_id' = $3) \
                     ) \
                     ORDER BY o.created_at DESC \
                     LIMIT 1",
                    &[&organization_id, &session_id, &offer_id],
                )?
                .map(|row| {
                    (
                        row.get::<_, Option<Value>>("context"),
                        row.get::<_, Option<String>>("tool"),
                        row.get::<_, Option<String>>("event"),
                    )
                }))
        })
        .map_err(error)?;
    Ok(match row {
        Some((context, tool, event)) => {
            presentation_from_receipt(context.as_ref(), tool, event.as_deref())
        }
        None => CallPresentation::default(),
    })
}

fn routing_owner(pg: &LeasedPostgres, input: &OfferInput) -> napi::Result<Option<OfferOwner>> {
    let key = SessionKey::new(&input.organization_id, &input.trajectory.session_id);
    let stamped_parent = input.trajectory.parent_id.clone();
    let row = pg
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root, parent_id FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| (row.get::<_, String>(0), row.get::<_, Option<String>>(1))))
        })
        .map_err(error)?;
    let Some((root, recorded_parent)) = row else {
        return Ok(None);
    };
    if recorded_parent != stamped_parent {
        return Ok(None);
    }
    Ok(Some(OfferOwner {
        organization_id: input.organization_id.clone(),
        session_id: input.trajectory.session_id.clone(),
        parent_id: stamped_parent,
        root,
        tool: None,
        spelling: None,
        dispatch: None,
    }))
}

fn claim_operation(
    store: &LogStore,
    input: &Input,
    root: &str,
    operation: &str,
    request: &Value,
    binding: ReceiptBinding,
    context: Option<Value>,
) -> napi::Result<Option<Value>> {
    match store
        .claim_operation(OperationRequest {
            key: operation_key(input, binding, operation.to_owned()),
            root: TrajectoryId::new(root),
            input: request.clone(),
            context,
        })
        .map_err(error)?
    {
        OperationClaim::Claimed => Ok(None),
        OperationClaim::Complete { decision } => Ok(Some(decision)),
    }
}

/// Completes a remedy's operation receipt and, for a tracked call, its
/// processed result, so a retry of either replays this response.
fn finish_remedy(
    store: &LogStore,
    input: &Input,
    operation: &str,
    binding: ReceiptBinding,
    result_key: Option<ProcessedResultKey>,
    response: Value,
) -> napi::Result<Value> {
    finish_operation(store, input, operation, &response, binding)?;
    if let Some(result_key) = result_key {
        let approved = decision_text(&response)?;
        store
            .complete_processed_result(result_key, approved, response.clone())
            .map_err(error)?;
    }
    Ok(response)
}

fn finish_operation(
    store: &LogStore,
    input: &Input,
    operation: &str,
    decision: &Value,
    binding: ReceiptBinding,
) -> napi::Result<()> {
    store
        .complete_operation(
            operation_key(input, binding, operation.to_owned()),
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
mod connection_permit_tests {
    use super::connection_permit;
    use std::{sync::Arc, time::Duration};
    use tokio::sync::Semaphore;

    #[test]
    fn a_busy_pool_refuses_within_its_wait_and_serves_once_freed() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .expect("a test runtime builds");
        runtime.block_on(async {
            let connections = Arc::new(Semaphore::new(1));
            let wait = Duration::from_secs(30);
            let held = connection_permit(&connections, wait)
                .await
                .expect("a free connection is granted");
            assert!(connection_permit(&connections, wait).await.is_err());
            drop(held);
            assert!(connection_permit(&connections, wait).await.is_ok());
        });
    }
}

#[cfg(test)]
mod root_lock_tests {
    use super::RootLock;
    use futures_util::FutureExt;

    // One test function: the registry is process-global, so parallel test
    // bodies would contend for it and a single `now_or_never` poll could
    // observe a momentarily held registry instead of the root under test.
    #[test]
    fn same_roots_serialize_while_other_roots_overlap() {
        // An uncontended acquire settles without an executor; a contended one
        // stays pending, so `now_or_never` observes exclusion directly.
        let held = RootLock::acquire("held-root".to_owned())
            .now_or_never()
            .expect("an uncontended root acquires immediately");
        assert!(
            RootLock::acquire("held-root".to_owned())
                .now_or_never()
                .is_none(),
            "a second dispatch for the same root must wait"
        );
        let other = RootLock::acquire("other-root".to_owned())
            .now_or_never()
            .expect("a different root acquires while another is held");
        drop(other);
        drop(held);
        assert!(
            RootLock::acquire("held-root".to_owned())
                .now_or_never()
                .is_some(),
            "a released root can be acquired again"
        );
    }
}

#[cfg(test)]
mod typed_tests {
    use super::{
        OfferId, OfferOwner, RemedyAct, RemedyOutcome, RemedyPresentation,
        authoritative_unexecuted_response, presentation_from_context, presentation_offer_ids,
        render_released_call, render_remedy_outcome, unknown_result_response,
    };
    use appa_runtime_api::OfferedRemedy;
    use serde_json::Value;

    #[test]
    fn session_actor_preserves_existing_sha256_identifiers() {
        assert_eq!(
            super::session_actor(""),
            "archestra:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            super::session_actor("abc"),
            "archestra:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// The root formula names the organization, and a root is never a session's row
    /// key, which remains the actor.
    #[test]
    fn a_root_names_its_organization() {
        assert_eq!(
            super::root_id("org", "session"),
            "archestra:25fa5093fa99432cd7453063ddade778c3d57e7a67f33c93ba4ad77600046654"
        );
        assert_ne!(
            super::root_id("org-a", "session"),
            super::root_id("org-b", "session")
        );
        assert_ne!(
            super::root_id("org", "session"),
            super::session_actor("session")
        );
    }

    #[test]
    fn remedy_operation_preserves_existing_receipt_identifiers() {
        let mut input: super::Input = serde_json::from_str(
            r#"{
                "organization_id": "test-organization",
                "session_id": "test-session",
                "event": "remedy",
                "arguments": {"value": 1}
            }"#,
        )
        .unwrap();

        assert_eq!(
            super::remedy_operation(&input).unwrap(),
            "remedy:untracked:1069ef23007b183f1d41a1944bbab35a87080806febc7c4fba3a17ae9750c58a"
        );
        input.tool_call_id = Some("test-call".to_owned());
        assert_eq!(super::remedy_operation(&input).unwrap(), "remedy:test-call");
    }

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
    fn a_remedy_takes_a_stamped_trajectory_and_rejects_owner_claims() {
        let accepted = serde_json::from_str::<super::OfferInput>(
            r#"{
                "organization_id": "organization",
                "caller_id": "user:spender",
                "trajectory": {"v": 1, "session_id": "session"},
                "arguments": {"offer_id": "0123456789abcdef"},
                "execution_mode": "untracked",
                "original_arguments": "{}",
                "presentation": {"control_tool": "archestra__execute_remedy_plan", "supports_delegation": false}
            }"#,
        );
        assert!(accepted.is_ok());
        assert_eq!(accepted.unwrap().caller_id.as_deref(), Some("user:spender"));

        for claimed in [
            r#""owner_caller_id": "user:owner""#,
            r#""session_id": "session""#,
            r#""tool": "read_untrusted""#,
            r#""spelling": "client_tool""#,
            r#""dispatch": "run_tool""#,
            r#""protected": "header""#,
        ] {
            let payload = format!(
                r#"{{
                    "organization_id": "organization",
                    {claimed},
                    "trajectory": {{"v": 1, "session_id": "session"}},
                    "arguments": {{"offer_id": "0123456789abcdef"}},
                    "execution_mode": "untracked",
                    "original_arguments": "{{}}",
                    "presentation": {{"control_tool": "archestra__execute_remedy_plan", "supports_delegation": false}}
                }}"#
            );
            assert!(
                serde_json::from_str::<super::OfferInput>(&payload).is_err(),
                "{claimed} must not select a route"
            );
        }
    }

    #[test]
    fn an_anonymous_remedy_omits_the_spender_and_a_foreign_version_is_invalid() {
        let anonymous = serde_json::from_str::<super::OfferInput>(
            r#"{
                "organization_id": "organization",
                "trajectory": {"v": 1, "session_id": "session", "parent_id": null},
                "arguments": {"offer_id": "0123456789abcdef"},
                "execution_mode": "untracked",
                "original_arguments": "{}",
                "presentation": {"control_tool": "archestra__execute_remedy_plan", "supports_delegation": false}
            }"#,
        )
        .unwrap();
        assert!(anonymous.caller_id.is_none());
        assert!(anonymous.trajectory.parent_id.is_none());
        assert!(super::validate_trajectory(&anonymous.trajectory).is_ok());

        let foreign = super::TrajectoryStamp {
            v: 2,
            session_id: "session".to_owned(),
            parent_id: None,
        };
        assert_eq!(
            super::validate_trajectory(&foreign).unwrap_err().reason,
            "invalid trajectory"
        );
    }

    #[test]
    fn a_child_stamp_is_the_expected_actor_and_a_root_stamp_is_not() {
        let child = super::expected_actor("recorded-root", "child-session", Some("parent"));
        let child_actor = super::session_actor("child-session");
        assert_eq!(child.root.0, "recorded-root");
        assert_eq!(
            child.child.as_ref().map(|id| id.0.as_str()),
            Some(child_actor.as_str())
        );
        assert!(
            super::expected_actor("recorded-root", "session", None)
                .child
                .is_none()
        );
    }

    #[test]
    fn retry_text_comes_from_recorded_context_and_old_rows_fall_back() {
        let recorded = presentation_from_context(Some(&serde_json::json!({
            "tool": "archestra__whoami",
            "arguments": {"verbose": true},
            "spawn": false,
            "spelling": "client_whoami",
            "dispatch": "my_gateway_archestra__run_tool"
        })));
        let call = appa_runtime_api::ProposedCall {
            tool: "mcp/archestra/whoami".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "verbose": true }))
                .unwrap(),
            cwd: None,
        };
        let hint = render_released_call("Authorized", &call, Some(&owner_from(recorded)));
        let (prefix, arguments) = hint.split_once("exactly these arguments: ").unwrap();
        assert_eq!(
            prefix,
            "[appa] Authorized. Call the my_gateway_archestra__run_tool tool again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "tool_name": "archestra__whoami", "tool_args": { "verbose": true } })
        );

        let legacy = presentation_from_context(Some(&serde_json::json!({
            "tool": "read_untrusted",
            "arguments": {"path": "report.txt"},
            "spawn": false
        })));
        assert!(legacy.spelling.is_none());
        assert!(legacy.dispatch.is_none());
        let direct = render_released_call(
            "Authorized",
            &appa_runtime_api::ProposedCall {
                tool: "read_untrusted".to_owned(),
                arguments: serde_json::value::to_raw_value(
                    &serde_json::json!({ "path": "report.txt" }),
                )
                .unwrap(),
                cwd: None,
            },
            Some(&owner_from(legacy)),
        );
        assert!(direct.contains("Call the read_untrusted tool again"));
        assert!(!direct.contains("run_tool"));
        assert!(presentation_from_context(None).tool.is_none());
    }

    #[test]
    fn a_peer_read_notice_uses_its_stored_tool_as_retry_spelling() {
        let peer = super::presentation_from_receipt(
            None,
            Some("acme__read_peer_message".to_owned()),
            Some("peer_read_notice"),
        );
        assert_eq!(peer.spelling.as_deref(), Some("acme__read_peer_message"));
        let ordinary = super::presentation_from_receipt(
            None,
            Some("read_untrusted".to_owned()),
            Some("tool_call"),
        );
        assert!(ordinary.spelling.is_none());
        assert_eq!(ordinary.tool.as_deref(), Some("read_untrusted"));
    }

    #[test]
    fn retry_fields_stay_in_context_and_out_of_the_idempotency_key() {
        let input: super::Input = serde_json::from_value(serde_json::json!({
            "organization_id": "organization",
            "session_id": "session",
            "event": "tool_call",
            "tool": "read_untrusted",
            "arguments": {"path": "report.txt"},
            "spelling": "client.read_untrusted",
            "dispatch": "my_gateway_archestra__run_tool"
        }))
        .unwrap();
        let semantic = super::operation_semantic(&input);
        assert!(semantic.get("spelling").is_none());
        assert!(semantic.get("dispatch").is_none());
        let context = super::tool_call_context(&input);
        assert_eq!(context["spelling"], "client.read_untrusted");
        assert_eq!(context["dispatch"], "my_gateway_archestra__run_tool");

        let legacy: super::Input = serde_json::from_value(serde_json::json!({
            "organization_id": "organization",
            "session_id": "session",
            "event": "tool_call",
            "tool": "read_untrusted",
            "arguments": {}
        }))
        .unwrap();
        let old = super::tool_call_context(&legacy);
        assert!(old.get("spelling").is_none());
        assert!(old.get("dispatch").is_none());
        assert!(super::recorded_call(Some(context), serde_json::json!({})).is_ok());
        assert!(super::recorded_call(Some(old), serde_json::json!({})).is_ok());
    }

    fn owner_from(presentation: super::CallPresentation) -> OfferOwner {
        OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: presentation.tool,
            spelling: presentation.spelling,
            dispatch: presentation.dispatch,
        }
    }

    #[test]
    fn released_call_uses_saved_spelling_and_reports_the_accepted_plan() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("canonical_tool".to_owned()),
            spelling: Some("client_tool".to_owned()),
            dispatch: None,
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "canonical_tool".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "value": 1 })).unwrap(),
            cwd: None,
        };

        // The user may have accepted the plan through ask_user, so the model
        // reports the plan without claiming the choice.
        let released = render_released_call("Authorized", &call, Some(&owner));
        assert!(released.contains("client_tool"));
        assert!(released.contains("Tell the user in your reply which plan was accepted."));
        assert!(!released.contains("you accepted"));
    }

    #[test]
    fn a_blocked_result_repeats_the_ruling_and_steers_the_model() {
        let ruling = "[appa] Blocked: this call cannot run yet.\n\nWhy:\n  - allowed readers would narrow: public -> 1 reader";
        let response = authoritative_unexecuted_response(serde_json::json!({
            "decision": "deny_call",
            "feedback": ruling,
        }))
        .unwrap();

        assert_eq!(response["decision"], "deny_call");
        assert_eq!(response["output_source"], "runtime");
        let text = response["approved_output"].as_str().unwrap();
        // The ruling stays verbatim and first: it is the only account of the
        // block the model has.
        assert!(text.starts_with(&format!("{ruling}\n\nThe tool did not run.")));
        // A plan is carried out by the call the ruling shows, which for a
        // redispatch plan is another tool rather than the remedy tool.
        assert!(
            text.contains("Apply a fitting plan with the exact call that the ruling shows for it")
        );
        assert!(!text.contains("remedy tool"));
        // The same order of question tools as ask_user's own description.
        assert!(text.contains("the client's own question tool if it has one, otherwise ask_user"));
        assert!(text.contains("not in plain text"));
        assert!(text.contains("in the ruling's own words"));
        assert!(text.contains("do not guess who the readers are"));
        // Who decides, not an instruction to skip the user.
        assert!(!text.contains("choose one yourself"));
    }

    #[test]
    fn an_unreleased_result_is_withheld_and_says_why() {
        let response = unknown_result_response();

        assert_eq!(response["decision"], "block");
        assert_eq!(response["output_source"], "runtime");
        assert_eq!(response["code"], "unreleased_call");
        // Callers read `reason` as the text of a block, so the code stays out of it.
        assert!(response.get("reason").is_none());
        assert_eq!(
            response["approved_output"],
            "[appa] Tool output withheld: this result has no record of releasing a call."
        );
    }

    #[test]
    fn authorized_remedy_uses_released_arguments_and_saved_spelling() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("canonical_tool".to_owned()),
            spelling: Some("client_tool".to_owned()),
            dispatch: None,
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "canonical_tool".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "value": 2 })).unwrap(),
            cwd: None,
        };

        let result = render_remedy_outcome(
            RemedyOutcome::Authorized { call },
            &RemedyAct {
                owner: &owner,
                offer_id: "offer-1",
                ruling: None,
            },
        )
        .unwrap();
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        let (prefix, arguments) = text.split_once("exactly these arguments: ").unwrap();
        assert_eq!(
            prefix,
            "[appa] Authorized. Tell the user in your reply which plan was accepted. Make this your next call: until it runs, \
             the session keeps its current label and calls that need the plan stay blocked. Call the client_tool tool \
             again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "value": 2 })
        );
        assert_eq!(result["output_source"], "runtime");
        assert_eq!(result["approved_output"], text);
        assert_eq!(result["result"]["isError"], false);
    }

    #[test]
    fn invalid_client_tool_names_identify_the_rejected_field() {
        for (field, reason) in [
            ("spelling", "invalid tool spelling"),
            ("dispatch", "invalid dispatch tool"),
        ] {
            for value in [String::new(), "tool\nname".to_owned(), "x".repeat(1025)] {
                let mut json = serde_json::json!({
                    "organization_id": "organization",
                    "session_id": "session",
                    "event": "session_start",
                });
                json[field] = Value::String(value);
                let input = serde_json::from_value(json).unwrap();
                assert_eq!(super::validate(&input).unwrap_err().reason, reason);
            }
        }
    }

    #[test]
    fn receipt_lookup_refuses_record_or_byte_overflow_instead_of_partial_authority() {
        let mut by_records = super::ReceiptLookupBudget::default();
        for _ in 0..10_000 {
            by_records.take(0).unwrap();
        }
        assert!(by_records.take(0).is_err());
        let mut by_bytes = super::ReceiptLookupBudget::default();
        by_bytes.take(8 * 1024 * 1024).unwrap();
        assert!(by_bytes.take(1).is_err());
        assert!(
            super::ReceiptLookupBudget::default()
                .take(usize::MAX)
                .is_err()
        );
    }

    #[test]
    fn a_dispatched_call_is_retried_through_the_dispatch_tool() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("archestra__whoami".to_owned()),
            spelling: Some("archestra__whoami".to_owned()),
            dispatch: Some("my_gateway_archestra__run_tool".to_owned()),
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "mcp/archestra/whoami".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "verbose": true }))
                .unwrap(),
            cwd: None,
        };

        let hint = render_released_call("Authorized", &call, Some(&owner));
        let (prefix, arguments) = hint
            .split_once("exactly these arguments: ")
            .expect("hint names the arguments");
        assert_eq!(
            prefix,
            "[appa] Authorized. Call the my_gateway_archestra__run_tool tool again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "tool_name": "archestra__whoami", "tool_args": { "verbose": true } })
        );
    }

    #[test]
    fn legacy_presentation_fallback_never_advertises_delegation() {
        assert!(!super::native_presentation_options().supports_delegation);
    }
}

#[cfg(test)]
mod remedy_tests {
    use super::{
        HookEventKind, Input, MAX_PRECHECK_REFUSAL_BYTES, OfferOwner, RemedyAct, RemedyOutcome,
        RemedyPresentation, RulingInput, render_remedy_outcome, validate,
    };
    use appa_runtime_api::OfferedRemedy;
    use serde_json::{Value, json};

    const QUOTED: &str = "0123456789abcdef";
    const OTHER: &str = "fedcba9876543210";
    // The runtime's re-rendered block after a denial: the operator plan is
    // filtered out, so no Continue section remains.
    const DENIED_BLOCK: &str =
        "[appa] Blocked: this call cannot run yet.\n\nWhy:\n  - requires attention: signoff";

    fn owner(spelling: Option<&str>) -> OfferOwner {
        OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("archestra__todo_write".to_owned()),
            spelling: spelling.map(str::to_owned),
            dispatch: None,
        }
    }

    fn declined(feedback: &str, offers: &[&str]) -> RemedyOutcome {
        RemedyOutcome::Declined {
            presentation: RemedyPresentation {
                feedback: feedback.to_owned(),
                offers: offers
                    .iter()
                    .map(|id| OfferedRemedy {
                        id: (*id).to_owned(),
                        returns: None,
                        input_sanitizer: None,
                    })
                    .collect(),
                review: Vec::new(),
                display: Vec::new(),
            },
        }
    }

    fn render(outcome: RemedyOutcome, owner: &OfferOwner, ruling: Option<RulingInput>) -> Value {
        render_remedy_outcome(
            outcome,
            &RemedyAct {
                owner,
                offer_id: QUOTED,
                ruling,
            },
        )
        .unwrap()
    }

    fn text(response: &Value) -> &str {
        response["approved_output"].as_str().unwrap()
    }

    #[test]
    fn a_human_denial_reads_as_final_under_the_name_the_model_called() {
        let owner = owner(Some("mcp__archestra__todo_write"));
        let response = render(declined(DENIED_BLOCK, &[]), &owner, Some(RulingInput::Deny));

        let text = text(&response);
        assert!(text.starts_with("[appa] Denied:"), "{text}");
        assert!(text.contains("this call to mcp__archestra__todo_write"));
        assert!(text.contains("will not run"));
        assert!(text.contains("Do not retry it"));
        assert!(!text.contains("cannot run yet"));
        assert_eq!(response["result"]["content"][0]["text"], text);
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["output_source"], "runtime");
    }

    #[test]
    fn a_human_denial_names_the_canonical_tool_without_a_client_spelling() {
        let response = render(
            declined(DENIED_BLOCK, &[]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert!(text(&response).contains("this call to archestra__todo_write."));
    }

    #[test]
    fn a_block_without_a_deny_ruling_keeps_the_runtime_text() {
        for ruling in [None, Some(RulingInput::Approve)] {
            let response = render(declined(DENIED_BLOCK, &[]), &owner(None), ruling);
            assert_eq!(text(&response), DENIED_BLOCK);
        }
    }

    #[test]
    fn a_deny_ruling_on_a_non_block_decline_keeps_the_runtime_text() {
        let invalidated =
            "[appa] the state changed and this offer no longer applies; re-propose the call";
        let response = render(
            declined(invalidated, &[]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert_eq!(text(&response), invalidated);
    }

    #[test]
    fn a_block_that_still_offers_the_quoted_offer_is_not_a_denial() {
        let response = render(
            declined(DENIED_BLOCK, &[QUOTED]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert_eq!(text(&response), DENIED_BLOCK);
    }

    #[test]
    fn a_denial_keeps_the_options_that_do_not_need_the_reviewer() {
        let remaining =
            format!("{DENIED_BLOCK}\n\nContinue:\n  - execute_remedy_plan(offer_id: \"{OTHER}\")");
        let response = render(
            declined(&remaining, &[OTHER]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        let text = text(&response);
        assert!(text.starts_with("[appa] Denied:"), "{text}");
        assert!(text.contains("The policy still offers options that do not need this reviewer:"));
        assert!(text.ends_with(&remaining));
    }

    fn remedy_input(extra: Value) -> Input {
        let mut input = json!({
            "organization_id": "organization",
            "session_id": "session",
            "caller_id": "user:caller",
            "event": "remedy",
            "tool_call_id": "provider-call",
            "arguments": { "offer_id": QUOTED },
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(input).unwrap()
    }

    #[test]
    fn a_precheck_refusal_is_accepted_only_on_an_unruled_remedy() {
        assert!(
            validate(&remedy_input(
                json!({ "precheck_refusal": "[appa] Not submitted" })
            ))
            .is_ok()
        );
        assert!(
            validate(&remedy_input(
                json!({ "precheck_refusal": "[appa] Not submitted", "ruling": "approve" })
            ))
            .is_err()
        );
        let mut result = remedy_input(json!({ "precheck_refusal": "[appa] Not submitted" }));
        result.event = HookEventKind::ToolResult;
        result.output = Some("output".to_owned());
        assert!(validate(&result).is_err());
    }

    #[test]
    fn a_precheck_refusal_must_carry_bounded_text() {
        assert!(validate(&remedy_input(json!({ "precheck_refusal": " \n " }))).is_err());
        let oversized = "x".repeat(MAX_PRECHECK_REFUSAL_BYTES + 1);
        assert!(validate(&remedy_input(json!({ "precheck_refusal": oversized }))).is_err());
        let largest = "x".repeat(MAX_PRECHECK_REFUSAL_BYTES);
        assert!(validate(&remedy_input(json!({ "precheck_refusal": largest }))).is_ok());
    }

    #[test]
    fn a_remedy_accepts_an_anonymous_spender() {
        assert!(validate(&remedy_input(json!({ "caller_id": null }))).is_ok());
        assert!(validate(&remedy_input(json!({}))).is_ok());
        assert!(validate(&remedy_input(json!({ "caller_id": "" }))).is_err());
    }
}

#[cfg(test)]
mod runtime_child_tests {
    use super::{
        AddressedChild, HookEventKind, Input, ReturnReceipt, classify_addressed_child,
        crossed_return, rebind_child, spawn_operation_id, spawn_ref_from_receipt, validate, wire,
    };
    use appa_eventlog::{Backend, LogStore};
    use appa_runtime::{
        api::{AuditEvent, LabelSpelling, OfferId, RemedyArguments, RemedyOutcome},
        hooks,
    };
    use appa_runtime_api::{
        Actor, HookDecision, HookEvent, OfferedReturn, OutcomeBody, ProposedCall, SpawnBinding,
        SpawnKind, SpawnRef, ToolOutcome, TrajectoryId,
    };
    use serde_json::{Value, json};
    use std::sync::Arc;

    fn event_input(event: &str, extra: Value) -> Input {
        let mut input = json!({
            "organization_id": "organization",
            "session_id": "child-session",
            "parent_id": "parent-session",
            "event": event,
            "operation_id": "return-1",
            "output": "exact bytes",
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(input).unwrap()
    }

    #[test]
    fn child_return_requires_a_child_operation_and_output_before_a_receipt() {
        assert!(validate(&event_input("child_return", json!({}))).is_ok());
        let mut missing_output = event_input("child_return", json!({}));
        missing_output.output = None;
        assert_eq!(
            validate(&missing_output).unwrap_err().reason,
            "missing output"
        );
        let mut missing_parent = event_input("child_return", json!({}));
        missing_parent.parent_id = None;
        assert_eq!(
            validate(&missing_parent).unwrap_err().reason,
            "missing parent_id"
        );
        let mut missing_operation = event_input("child_return", json!({}));
        missing_operation.operation_id = None;
        assert_eq!(
            validate(&missing_operation).unwrap_err().reason,
            "missing operation_id"
        );
        assert!(matches!(
            event_input("child_return", json!({})).event,
            HookEventKind::ChildReturn
        ));
    }

    #[test]
    fn a_spawn_call_id_stays_raw_and_does_not_fall_back_to_in_flight() {
        assert_eq!(spawn_operation_id("toolu_1"), "call:toolu_1");
        assert_eq!(spawn_operation_id("call:toolu_1"), "call:call:toolu_1");
        assert!(matches!(
            spawn_ref_from_receipt(None, None).unwrap(),
            SpawnRef::InFlight
        ));
        match spawn_ref_from_receipt(Some("toolu_1"), Some("sealed".into())).unwrap() {
            SpawnRef::Binding(binding) => assert_eq!(binding.0, "sealed"),
            other => panic!("a released receipt must bind explicitly, got {other:?}"),
        }
        assert_eq!(
            spawn_ref_from_receipt(Some("toolu_1"), None).unwrap_err(),
            "spawn call has no released binding"
        );
        assert_eq!(
            spawn_ref_from_receipt(Some("toolu_1"), Some(String::new())).unwrap_err(),
            "spawn call has no released binding"
        );
    }

    #[test]
    fn an_exact_row_authorizes_an_arbitrary_id_and_a_prefix_does_not_rebind() {
        let parent = "user:1|workload";
        let stored = "archestra:stored-actor".to_owned();
        match classify_addressed_child(parent, "workspace-9f3c", Some(stored.clone())) {
            AddressedChild::Rebind(actor) => assert_eq!(actor, stored),
            _ => panic!("an exact row must rebind the stored actor"),
        }
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:native"), None),
            AddressedChild::UnstartedNative
        ));
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:child:grand"), None),
            AddressedChild::UnstartedNative
        ));
        assert!(matches!(
            classify_addressed_child(parent, "workspace-9f3c", None),
            AddressedChild::Foreign
        ));
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:other"), None),
            AddressedChild::UnstartedNative
        ));
    }

    #[test]
    fn a_rebind_uses_the_family_root_and_the_stored_actor() {
        let root = TrajectoryId("archestra:family".into());
        let event = rebind_child(&root, "archestra:stored".into());
        match event {
            HookEvent::ChildStart {
                root: bound_root,
                child,
                spawn,
            } => {
                assert_eq!(bound_root, root);
                assert_eq!(child.0, "archestra:stored");
                assert_eq!(spawn, SpawnRef::InFlight);
            }
            other => panic!("rebind must be a child start, got {other:?}"),
        }
    }

    #[test]
    fn child_return_wire_keeps_the_exact_value_and_a_block_names_its_reason() {
        let staged = wire(&HookDecision::ChildReturn {
            value: "scrubbed".into(),
        })
        .unwrap();
        assert_eq!(staged["decision"], "child_return");
        assert_eq!(staged["value"], "scrubbed");
        let blocked = wire(&HookDecision::Block {
            reason: "the child has a call still open; report its outcome before the child ends"
                .into(),
        })
        .unwrap();
        assert_eq!(blocked["decision"], "block");
        assert_eq!(
            blocked["reason"],
            "the child has a call still open; report its outcome before the child ends"
        );
        assert!(blocked.get("feedback").is_none());
    }

    #[test]
    fn a_loader_keeps_admitted_child_returns_and_drops_an_unechoed_stage() {
        let admitted = crossed_return(ReturnReceipt {
            event: "child_return",
            operation_id: "runtime-return:task-1:req-1",
            decision: "ack",
            decision_value: None,
            output: Some("exact file bytes"),
        })
        .expect("an ack is a crossing");
        assert_eq!(admitted.operation_id, "runtime-return:task-1:req-1");
        assert_eq!(admitted.value, "exact file bytes");

        assert!(
            crossed_return(ReturnReceipt {
                event: "child_return",
                operation_id: "runtime-return:task-1:req-2",
                decision: "child_return",
                decision_value: Some("staged"),
                output: Some("raw"),
            })
            .is_none(),
            "an unechoed stage is not a crossing"
        );

        let echo = crossed_return(ReturnReceipt {
            event: "child_return",
            operation_id: "runtime-return:task-1:req-2:echo",
            decision: "ack",
            decision_value: None,
            output: Some("canonical"),
        })
        .expect("the echo ack is the crossing");
        assert_eq!(echo.operation_id, "runtime-return:task-1:req-2:echo");
        assert!(echo.operation_id.starts_with("runtime-return:task-1:"));
        assert_eq!(echo.value, "canonical");

        assert!(
            crossed_return(ReturnReceipt {
                event: "child_return",
                operation_id: "runtime-return:task-1:req-3",
                decision: "block",
                decision_value: None,
                output: Some("held"),
            })
            .is_none()
        );

        let ended = crossed_return(ReturnReceipt {
            event: "child_end",
            operation_id: "end-1",
            decision: "child_return",
            decision_value: Some("canonical end"),
            output: Some("raw end"),
        })
        .expect("a child end still carries its staged value");
        assert_eq!(ended.value, "canonical end");
        assert!(
            crossed_return(ReturnReceipt {
                event: "child_end",
                operation_id: "end-1:echo",
                decision: "ack",
                decision_value: None,
                output: Some("canonical end"),
            })
            .is_none(),
            "a child-end echo is not a second crossing"
        );
    }

    fn arguments() -> Box<serde_json::value::RawValue> {
        serde_json::value::RawValue::from_string("{}".into()).unwrap()
    }

    fn policy(delegate: &str, read: &str) -> String {
        format!(
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"{delegate}\"\ndelta = {{}}\n[[policy.tool]]\nname = \"{read}\"\ndelta = {{}}\n[policy.deployment]\ncontext_control = true\n"
        )
    }

    fn open_runtime(delegate: &str, read: &str) -> appa_runtime::api::Runtime {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        crate::policy::open(
            crate::policy::compile(&policy(delegate, read), |_| None).unwrap(),
            store,
        )
        .unwrap()
    }

    fn tool_call(
        root: &TrajectoryId,
        child: Option<&TrajectoryId>,
        tool: &str,
        call_id: Option<&str>,
        spawn: bool,
    ) -> HookEvent {
        HookEvent::ToolCall {
            actor: Actor {
                root: root.clone(),
                child: child.cloned(),
            },
            call: ProposedCall {
                tool: tool.to_owned(),
                arguments: arguments(),
                cwd: None,
            },
            call_id: call_id.map(str::to_owned),
            spawn: spawn.then_some(SpawnKind::Single),
            prompt: None,
            ruling: None,
        }
    }

    async fn released_binding(
        runtime: &appa_runtime::api::Runtime,
        root: &TrajectoryId,
        tool: &str,
    ) -> SpawnBinding {
        let spawn = || tool_call(root, None, tool, None, true);
        let HookDecision::DenyCall { offers, .. } = hooks::handle(runtime, spawn()).await else {
            panic!("a marked spawn blocks until its return is declared");
        };
        let offer = offers
            .iter()
            .find(|offer| offer.returns == Some(OfferedReturn::AsSpoken))
            .expect("the menu offers an as-spoken return");
        let outcome = runtime
            .execute_remedy_with(
                &Actor {
                    root: root.clone(),
                    child: None,
                },
                OfferId(offer.id.clone()),
                RemedyArguments {
                    label: Some(LabelSpelling::default()),
                    return_schema: None,
                },
            )
            .await;
        assert!(
            matches!(outcome, RemedyOutcome::Authorized { .. }),
            "{outcome:?}"
        );
        let released = hooks::handle(runtime, spawn()).await;
        let HookDecision::AllowCall {
            spawn: Some(binding),
            ..
        } = released
        else {
            panic!("the declared spawn must release a binding, got {released:?}");
        };
        binding
    }

    fn start(root: &TrajectoryId) -> HookEvent {
        HookEvent::SessionStart {
            root: root.clone(),
            principal: None,
            address: None,
            title: None,
            start: None,
            launch: None,
        }
    }

    fn child_of(root: &TrajectoryId) -> TrajectoryId {
        let child = TrajectoryId("archestra:workspace-9f3c".into());
        assert!(
            !child.0.starts_with(&format!("{}:", root.0)),
            "the workspace id must not pass the native prefix check"
        );
        child
    }

    async fn opened_child(
        runtime: &appa_runtime::api::Runtime,
        root: &TrajectoryId,
        child: &TrajectoryId,
        delegate: &str,
    ) {
        assert_eq!(hooks::handle(runtime, start(root)).await, HookDecision::Ack);
        let binding = released_binding(runtime, root, delegate).await;
        let forged = hooks::handle(
            runtime,
            HookEvent::ChildStart {
                root: root.clone(),
                child: child.clone(),
                spawn: SpawnRef::Binding(SpawnBinding("not-a-seal".into())),
            },
        )
        .await;
        assert!(
            matches!(forged, HookDecision::Refuse { .. }),
            "a forged binding must not fall back to in-flight, got {forged:?}"
        );
        assert!(
            runtime
                .audit(root)
                .unwrap()
                .iter()
                .all(|entry| entry.trajectory != child.0)
        );
        let started = hooks::handle(
            runtime,
            HookEvent::ChildStart {
                root: root.clone(),
                child: child.clone(),
                spawn: SpawnRef::Binding(binding),
            },
        )
        .await;
        assert!(
            matches!(started, HookDecision::Ack | HookDecision::Context { .. }),
            "{started:?}"
        );
    }

    #[tokio::test]
    async fn a_sealed_binding_opens_an_arbitrary_child_and_a_return_leaves_it_live() {
        let delegate = super::canonical_tool("delegate").unwrap();
        let read = super::canonical_tool("read").unwrap();
        let runtime = open_runtime(&delegate, &read);
        let root = TrajectoryId("archestra:parent-root".into());
        let child = child_of(&root);
        opened_child(&runtime, &root, &child, &delegate).await;

        let returned = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "exact file bytes".into(),
            },
        )
        .await;
        assert_eq!(returned, HookDecision::Ack);
        assert!(runtime.audit(&root).unwrap().iter().any(|entry| {
            entry.trajectory == child.0 && matches!(entry.event, AuditEvent::ChildReturn { .. })
        }));

        let later = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:later"), false),
        )
        .await;
        assert!(
            matches!(later, HookDecision::AllowCall { .. }),
            "the child stays live after a return, got {later:?}"
        );
    }

    #[tokio::test]
    async fn a_child_return_does_not_settle_an_open_call() {
        let delegate = super::canonical_tool("delegate").unwrap();
        let read = super::canonical_tool("read").unwrap();
        let runtime = open_runtime(&delegate, &read);
        let root = TrajectoryId("archestra:parent-root".into());
        let child = child_of(&root);
        opened_child(&runtime, &root, &child, &delegate).await;

        let opened = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:read-1"), false),
        )
        .await;
        assert!(
            matches!(opened, HookDecision::AllowCall { .. }),
            "{opened:?}"
        );
        let blocked = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "pending".into(),
            },
        )
        .await;
        let HookDecision::Block { reason } = blocked else {
            panic!("an open call must hold the return, got {blocked:?}");
        };
        assert!(
            reason.contains("call still open"),
            "held reason was {reason}"
        );
        assert!(runtime.audit(&root).unwrap().iter().all(|entry| {
            entry.trajectory != child.0 || !matches!(entry.event, AuditEvent::ChildReturn { .. })
        }));
        assert!(
            runtime.audit(&root).unwrap().iter().all(|entry| {
                entry.trajectory != child.0 || !matches!(entry.event, AuditEvent::Closed { .. })
            }),
            "the open call must stay open"
        );

        let reported = hooks::handle(
            &runtime,
            HookEvent::ToolResult {
                actor: Actor {
                    root: root.clone(),
                    child: Some(child.clone()),
                },
                call: ProposedCall {
                    tool: read.clone(),
                    arguments: arguments(),
                    cwd: None,
                },
                call_id: Some("call:read-1".into()),
                outcome: ToolOutcome::Success {
                    body: OutcomeBody::Available("note".into()),
                },
            },
        )
        .await;
        assert!(
            matches!(reported, HookDecision::Ack),
            "the withheld return must not have settled the call, got {reported:?}"
        );

        let returned = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "exact file bytes".into(),
            },
        )
        .await;
        assert_eq!(returned, HookDecision::Ack);
        let later = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:after"), false),
        )
        .await;
        assert!(
            matches!(later, HookDecision::AllowCall { .. }),
            "a later call still runs after the crossing, got {later:?}"
        );
    }
}
