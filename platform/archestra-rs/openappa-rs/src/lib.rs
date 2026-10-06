//! Archestra's host boundary. Policy evaluation and event serialization live in
//! OpenAPPA; identity, call correlation and durable processing receipts live here.

mod adapter;
mod admission;
mod batteries;
mod consults;
mod declarations;
mod deployments;
#[allow(dead_code)]
mod peer;
mod policy;

use appa_eventlog::{
    Backend, Fact, LogStore, OperationClaim, OperationKey, OperationRequest, ProcessedResultClaim,
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
    /// Client spelling of the dispatch tool (`run_tool`) used for this call.
    /// Retries use the same tool.
    pub dispatch: Option<String>,
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
    /// Authenticated caller identity.
    #[serde(default)]
    caller_id: Option<String>,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    /// Principal that minted the offer, from verified host claims.
    #[serde(default)]
    owner_caller_id: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    spelling: Option<String>,
    #[serde(default)]
    dispatch: Option<String>,
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
    tool_call_ids: Option<Vec<String>>,
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
const MAX_REPLAY_RESULTS: usize = 256;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum HookEventKind {
    SessionStart,
    ToolCall,
    ToolResult,
    /// Read only already-completed, locally qualified result receipts.
    ReplayCompletedResults,
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
pub(crate) fn session_actor(session_id: &str) -> String {
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
    if input.event != HookEventKind::ReplayCompletedResults && input.tool_call_ids.is_some() {
        return Err(error(
            "tool_call_ids only belongs to completed-result replay",
        ));
    }
    match input.event {
        HookEventKind::SessionStart => {}
        HookEventKind::ReplayCompletedResults => {
            let ids = input
                .tool_call_ids
                .as_ref()
                .ok_or_else(|| error("missing tool_call_ids"))?;
            if ids.is_empty() || ids.len() > MAX_REPLAY_RESULTS {
                return Err(error(
                    "completed-result replay requires 1..256 tool call IDs",
                ));
            }
            for id in ids {
                if id.is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
                    return Err(error("invalid replay tool call identity"));
                }
            }
        }
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
            required(&input.caller_id, "caller_id")?;
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

/// Executes a remedy plan by offer ID, resolving the owner session from PostgreSQL.
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
    if input.session_id.is_empty()
        || input.session_id.len() > 1024
        || input.session_id.chars().any(char::is_control)
    {
        return Err(error("invalid session identity"));
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
    let _: ExecuteRemedyPlanArgs = serde_json::from_str(visible_arguments.get()).map_err(error)?;
    let caller = input
        .caller_id
        .as_deref()
        .map(Principal::parse)
        .transpose()?;
    let state = initialized().await?;
    let owner = {
        let leased = state.lease().await?;
        routing_owner(
            postgres_store(&leased.state.store)?,
            &input,
            caller.as_ref(),
        )?
    };
    let Some(owner) = owner else {
        return Ok(
            with_offer_status(render_unknown_offer()?, OfferStatusKind::Unknown)?.to_string(),
        );
    };
    let input = Input {
        yell_receiver: None,
        organization_id: owner.organization_id,
        // Scopes receipt to the authenticated spender to prevent replay.
        caller_id: input.caller_id.clone(),
        session_id: owner.session_id,
        parent_id: owner.parent_id,
        principal: None,
        fork_of: None,
        event: HookEventKind::Remedy,
        operation_id: None,
        tool_call_id: input.tool_call_id,
        tool_call_ids: None,
        tool: owner.tool.clone(),
        arguments: Some(visible_arguments),
        original_arguments: Some(original_arguments),
        spawn: false,
        output: None,
        spawned_id: None,
        spawn_call_id: None,
        child_native_id: None,
        outcome: None,
        owner_root: Some(owner.root),
        spelling: owner.spelling,
        dispatch: owner.dispatch,
        presentation: Some(input.presentation),
        ruling: input.ruling,
        precheck_refusal: input.precheck_refusal,
    };
    validate(&input)?;
    let response: Value = serde_json::from_str(&run(input, policy.into()).await?).map_err(error)?;
    Ok(with_offer_status(response, OfferStatusKind::Known)?.to_string())
}

#[napi(object)]
#[derive(Clone, Serialize)]
pub struct OfferReviewRestriction {
    /// `trust` or `readers`. Only a dimension the retained plan actually changes.
    pub dimension: String,
    pub before: String,
    pub after: String,
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
    /// The open plan's recorded narrowing, when this root's log has exactly one
    /// matching offer and that offer is still open. Absent means no verified
    /// pending restriction, not a permission grant.
    pub restrictions: Option<Vec<OfferReviewRestriction>>,
}

/// Loads the review entry for an offer from the retained DenyCall in PostgreSQL.
/// Session routing comes from the verified offer claims; no offer-owner lookup.
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
                 COALESCE(o.input->'context'->'arguments', o.input->'semantic'->'arguments')::text AS arguments, \
                 o.root AS root \
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
                    row.get::<_, String>("root"),
                )
            }))
        })
        .map_err(error)?;
    let Some((text, tool, arguments, root)) = review else {
        return Ok(None);
    };
    // The restriction is the plan recorded on this operation's root, not the
    // review prose and not the policy loaded for a later call.
    let log = leased
        .state
        .store
        .log(&TrajectoryId::new(root))
        .map_err(error)?;
    let restrictions = open_offer_restrictions(log.facts(), log.policy_file(), &offer_id);
    let text = disclosed_review_text(text, restrictions.as_deref());

    Ok(Some(OfferReviewOutput {
        offer_id,
        text,
        session_id: session_id_for_output,
        tool,
        arguments,
        restrictions,
    }))
}

const RESTRICTION_HEADING: &str = "Persistent session restriction this approval would accept:";
const RENDERED_OFFER_CHARS: usize = 16;
/// The engine's own default when a bound policy file omits `trust_chain`.
const DEFAULT_TRUST_CHAIN: [&str; 2] = ["suspicious", "trusted"];

/// Restrictions of the one open offer this rendered id names in `facts`.
/// `None` when the id is not one open offer of this log: another offer, an
/// ambiguous prefix, or an offer already accepted or denied.
fn open_offer_restrictions(
    facts: &[Fact],
    policy_file: &[u8],
    rendered_offer_id: &str,
) -> Option<Vec<OfferReviewRestriction>> {
    let offer = open_offer(facts, rendered_offer_id)?;
    let Fact::OfferOpened { plan, .. } = offer else {
        return None;
    };
    let narrowing = plan.narrowing()?;
    let names = trust_chain_names(policy_file);
    let mut restrictions = Vec::new();
    if narrowing.from.trust != narrowing.to.trust {
        restrictions.push(OfferReviewRestriction {
            dimension: "trust".to_owned(),
            before: trust_name(narrowing.from.trust.rank(), &names),
            after: trust_name(narrowing.to.trust.rank(), &names),
        });
    }
    if narrowing.from.audience != narrowing.to.audience {
        let [before, after] = [&narrowing.from.audience, &narrowing.to.audience].map(|audience| {
            if audience.is_public() {
                return "public".to_owned();
            }
            let clauses: Vec<String> = audience
                .clauses()
                .map(|clause| {
                    if clause.is_empty() {
                        return "nobody".to_owned();
                    }
                    let mut parts = Vec::new();
                    if let Some(chain) = clause.chain() {
                        parts.push(chain.as_str().to_owned());
                    }
                    for group in clause.groups() {
                        let spelled = group.to_string();
                        if spelled.starts_with('@') {
                            parts.push(spelled);
                        } else {
                            parts.push(format!("@{spelled}"));
                        }
                    }
                    for reader in clause.readers() {
                        parts.push(reader.as_str().to_owned());
                    }
                    if parts.len() > 1 {
                        format!("({})", parts.join(" or "))
                    } else {
                        parts.join("")
                    }
                })
                .collect();
            if clauses.is_empty() || clauses.iter().any(|clause| clause == "nobody") {
                "nobody".to_owned()
            } else {
                clauses.join(" and ")
            }
        });
        restrictions.push(OfferReviewRestriction {
            dimension: "readers".to_owned(),
            before,
            after,
        });
    }
    (!restrictions.is_empty()).then_some(restrictions)
}

fn open_offer<'a>(facts: &'a [Fact], rendered_offer_id: &str) -> Option<&'a Fact> {
    if rendered_offer_id.len() != RENDERED_OFFER_CHARS
        || !rendered_offer_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    let mut found = None;
    for fact in facts {
        let Fact::OfferOpened { offer, .. } = fact else {
            continue;
        };
        let hex = offer.to_hex();
        if !hex.starts_with(rendered_offer_id) {
            continue;
        }
        match found {
            None => found = Some(hex),
            Some(ref already) if already == &hex => {}
            Some(_) => return None,
        }
    }
    let hex = found?;
    let terminal = facts.iter().any(|fact| match fact {
        Fact::OfferAccepted { offer, .. }
        | Fact::OfferDenied { offer, .. }
        | Fact::OfferInvalidated { offer, .. } => offer.to_hex() == hex,
        _ => false,
    });
    if terminal {
        return None;
    }
    facts.iter().find(|fact| match fact {
        Fact::OfferOpened { offer, .. } => offer.to_hex() == hex,
        _ => false,
    })
}

fn disclosed_review_text(text: String, restrictions: Option<&[OfferReviewRestriction]>) -> String {
    let Some(restrictions) = restrictions.filter(|restrictions| !restrictions.is_empty()) else {
        return text;
    };
    let mut disclosed = text;
    if !disclosed.is_empty() && !disclosed.ends_with('\n') {
        disclosed.push('\n');
    }
    disclosed.push('\n');
    disclosed.push_str(RESTRICTION_HEADING);
    disclosed.push('\n');
    for restriction in restrictions {
        disclosed.push_str(&format!(
            "  {dimension}: {before} -> {after}\n",
            dimension = restriction.dimension,
            before = restriction.before,
            after = restriction.after,
        ));
    }
    disclosed.push_str(
        "Approving authorizes this exact call and accepts each listed restriction for the rest of this session. \
         These label changes only tighten session restrictions; they do not add permissions. \
         Denying keeps the call blocked and does not accept the restriction.",
    );
    disclosed
}

fn trust_chain_names(policy_file: &[u8]) -> Vec<String> {
    let Ok(text) = std::str::from_utf8(policy_file) else {
        return Vec::new();
    };
    let Ok(document) = toml::from_str::<toml::Value>(text) else {
        return Vec::new();
    };
    string_array(document.get("trust_chain"))
        .or_else(|| document.get("policy").and_then(string_array_at_trust_chain))
        .unwrap_or_else(|| {
            DEFAULT_TRUST_CHAIN
                .iter()
                .map(|rank| (*rank).to_owned())
                .collect()
        })
}

fn string_array_at_trust_chain(value: &toml::Value) -> Option<Vec<String>> {
    string_array(value.get("trust_chain"))
}

fn string_array(value: Option<&toml::Value>) -> Option<Vec<String>> {
    let array = value?.as_array()?;
    if array.is_empty() {
        return None;
    }
    array
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn trust_name(rank: u8, names: &[String]) -> String {
    let index = if rank == u8::MAX {
        names.len().checked_sub(1)
    } else {
        Some(usize::from(rank))
    };
    index
        .and_then(|index| names.get(index))
        .cloned()
        .unwrap_or_else(|| format!("rank {rank}"))
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

        if input.event == HookEventKind::ReplayCompletedResults {
            return replay_completed_results(pg, &input, &root, &key);
        }

        let actor = Actor {
            root: TrajectoryId(root.clone()),
            child: input
                .parent_id
                .is_some()
                .then(|| TrajectoryId(key.actor.clone())),
        };
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
            // Initialization can append or consult before a receipt claim. Recorded
            // sessions are admitted by their claim (or guarded replay) below.
            admission::touch(pg, admission_subject(&input, &root)).map_err(admission_error)?;
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
            admission::touch(pg, admission_subject(&input, &root)).map_err(admission_error)?;
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
            let binding = ReceiptBinding::Caller {
                caller_id: required(&input.caller_id, "caller_id")?.to_owned(),
            };
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
                match claim_processed_result(&self.store, &input, &root, result_key.clone())? {
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
            let outcome = self
                .runtime
                .execute_embedded_remedy_with_options(&actor, args, presentation_options(&input))
                .await;
            let owner = OfferOwner {
                organization_id: input.organization_id.clone(),
                caller_id: input.caller_id.clone(),
                session_id: input.session_id.clone(),
                parent_id: input.parent_id.clone(),
                root: root.clone(),
                arguments: None,
                tool: input.tool.clone(),
                spelling: input.spelling.clone(),
                dispatch: input.dispatch.clone(),
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
            if let Some(decision) = cached_cancel_decision(pg, &input, &root, call_id)? {
                return Ok(decision);
            }
        }
        let mut request = json!({ "event": input.event, "tool": input.tool, "arguments": input.arguments, "spawn": input.spawn, "output": input.output, "spawn_call_id": input.spawn_call_id, "child_native_id": input.child_native_id });
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
                | HookEventKind::ReplayCompletedResults
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
            // Native peer receipts bypass the processed-result claim. Their lookup
            // is read-only, but replay still needs current retention authority.
            admission::touch(pg, admission_subject(input, &actor.root.0))
                .map_err(admission_error)?;
            return Ok(withheld);
        }
        let key = processed_result_key(input, call_id.clone());
        match claim_processed_result(&self.store, input, &actor.root.0, key.clone())? {
            ProcessedResultClaim::Claimed => {}
            ProcessedResultClaim::Complete { decision, .. } => {
                // A recorded result already closed this call. A CancelCall that
                // arrives afterward replays that result and does not write
                // cancel:<id>. The claim above already admitted the group.
                return Ok(decision);
            }
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

fn cached_cancel_decision(
    pg: &LeasedPostgres,
    input: &Input,
    root: &str,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let Some(decision) = cancelled_call(pg, input, call_id)? else {
        return Ok(None);
    };
    admission::touch(pg, admission_subject(input, root)).map_err(admission_error)?;
    Ok(Some(decision))
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

fn routing_owner(
    pg: &LeasedPostgres,
    input: &OfferInput,
    spender: Option<&Principal>,
) -> napi::Result<Option<OfferOwner>> {
    if !owner_can_be_spent_by(input.owner_caller_id.as_deref(), spender) {
        return Ok(None);
    }
    let key = SessionKey::new(&input.organization_id, &input.session_id);
    let root = pg
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| row.get::<_, String>(0)))
        })
        .map_err(error)?;
    Ok(root.map(|root| OfferOwner {
        organization_id: input.organization_id.clone(),
        caller_id: input.owner_caller_id.clone(),
        session_id: input.session_id.clone(),
        parent_id: input.parent_id.clone(),
        root,
        arguments: None,
        tool: input.tool.clone(),
        spelling: input.spelling.clone(),
        dispatch: input.dispatch.clone(),
    }))
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

fn admission_subject<'a>(input: &'a Input, root: &'a str) -> admission::Subject<'a> {
    admission::Subject {
        organization_id: &input.organization_id,
        root,
        session_id: &input.session_id,
        fork_of: input.fork_of.as_deref(),
        parent_id: input.parent_id.as_deref(),
        caller_id: input.caller_id.as_deref(),
    }
}

fn admission_error(failure: admission::Error) -> napi::Error {
    match failure {
        admission::Error::Expired => error(admission::EXPIRED),
        admission::Error::Storage(failure) => error(failure),
    }
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
    let pg = postgres_store(store)?;
    let mut held = admission::hold(pg, admission_subject(input, root)).map_err(admission_error)?;
    let claimed = store.claim_operation(OperationRequest {
        key: operation_key(input, binding, operation.to_owned()),
        root: TrajectoryId::new(root),
        input: request.clone(),
        context,
    });
    if claimed.is_ok() {
        held.disarm();
    }
    match claimed.map_err(error)? {
        OperationClaim::Claimed => Ok(None),
        OperationClaim::Complete { decision } => Ok(Some(decision)),
    }
}

/// This operation never claims a missing result or opens a new session. IDs are
/// lookup hints, not release authority. Inherited receipts still use the ordered
/// dispatch path, which enforces the source session's fork watermark.
fn replay_completed_results(
    pg: &LeasedPostgres,
    input: &Input,
    root: &str,
    key: &SessionKey,
) -> napi::Result<Value> {
    let lookup = key.clone();
    let session = pg
        .with_client(move |client| {
            Ok(client.query_opt(
                "SELECT root, session_id, parent_id, forked_from, caller_id FROM openappa_sessions \
                 WHERE organization_id = $1 AND actor = $2",
                &[&lookup.organization_id, &lookup.actor],
            )?)
        })
        .map_err(error)?;
    let qualified_session = if let Some(session) = &session {
        let saved_root: String = session.get("root");
        let saved_session: String = session.get("session_id");
        let saved_parent: Option<String> = session.get("parent_id");
        let saved_fork: Option<String> = session.get("forked_from");
        let saved_caller: Option<String> = session.get("caller_id");
        if saved_root != root
            || saved_session != input.session_id
            || saved_parent != input.parent_id
            || (input.fork_of.is_some() && saved_fork != input.fork_of)
        {
            return Err(error("completed-result replay session identity changed"));
        }
        // Upstream session-bound claims allow other session participants. Do
        // not change that contract: an unproven caller uses the ordinary path,
        // but cannot obtain bytes from this fast lookup.
        saved_caller == input.caller_id
    } else {
        false
    };
    let held = admission::hold(pg, admission_subject(input, root)).map_err(admission_error)?;
    let results = if qualified_session {
        let organization = input.organization_id.clone();
        let session = input.session_id.clone();
        let caller = input.caller_id.clone();
        let root = root.to_owned();
        let ids = input
            .tool_call_ids
            .clone()
            .ok_or_else(|| error("missing tool_call_ids"))?;
        pg.with_client(move |client| {
            let rows = client.query(
                "SELECT wanted.id, result.decision, result.approved_output, operation.input \
                 FROM unnest($1::text[]) WITH ORDINALITY AS wanted(id, ordinal) \
                 JOIN openappa_processed_results AS result \
                   ON result.organization_id = $2 AND result.session_id = $3 \
                  AND result.tool_call_id = wanted.id AND result.root = $4 \
                  AND result.caller_id IS NOT DISTINCT FROM $5 AND result.status = 'complete' \
                 JOIN openappa_operations AS operation \
                   ON operation.organization_id = $2 AND operation.session_id = $3 \
                  AND operation.operation_id = 'call:' || wanted.id AND operation.root = $4 \
                  AND operation.caller_id IS NOT DISTINCT FROM $5 \
                  AND operation.status = 'complete' AND operation.decision IS NOT NULL \
                 ORDER BY wanted.ordinal",
                &[&ids, &organization, &session, &root, &caller],
            )?;
            let mut results = Vec::with_capacity(rows.len());
            for row in rows {
                let decision: Option<Value> = row.get("decision");
                let approved: Option<String> = row.get("approved_output");
                let operation_input: Option<Value> = row.get("input");
                if let Some(decision) =
                    qualified_replay_decision(decision, approved, operation_input)
                {
                    let id: String = row.get("id");
                    results.push(json!({ "tool_call_id": id, "decision": decision }));
                }
            }
            Ok(results)
        })
        .map_err(error)?
    } else {
        Vec::new()
    };
    held.commit().map_err(admission_error)?;
    Ok(json!({ "decision": "replay_completed_results", "results": results }))
}

fn qualified_replay_decision(
    decision: Option<Value>,
    approved: Option<String>,
    operation_input: Option<Value>,
) -> Option<Value> {
    let decision = decision?;
    // Legacy rows without explicit retained output cannot be replayed using the
    // client echo as a fallback. Leave them on the existing validated path.
    if decision.get("approved_output").and_then(Value::as_str) != approved.as_deref()
        || approved.is_none()
    {
        return None;
    }
    if !matches!(
        decision.get("decision").and_then(Value::as_str),
        Some(
            "ack"
                | "deny_call"
                | "block"
                | "replace_output"
                | "deliver_value"
                | "child_return"
                | "mcp_result"
        )
    ) {
        return None;
    }
    let input = operation_input?;
    if input.get("semantic").is_some()
        && (input.get("version").and_then(Value::as_u64) != Some(1)
            || input.get("binding").and_then(Value::as_str) != Some("session"))
    {
        return None;
    }
    let context = input.get("context").cloned();
    let semantic = input
        .get("semantic")
        .or_else(|| input.get("input"))
        .cloned()
        .unwrap_or(input);
    let call = recorded_call(context, semantic).ok()?;
    let tool = canonical_tool(&call.tool).ok()?;
    // Peer receipts have additional native read/list evidence and can replace a
    // prior denial. Use forged_read_result's existing validation, never a plain
    // processed-result hit, even if a client copied peer flags into its echo.
    if peer::is_peer_read_tool(&call.tool)
        || call.tool == "list_peer_messages"
        || call.tool.ends_with("__list_peer_messages")
        || tool.ends_with("/list_peer_messages")
    {
        return None;
    }
    Some(decision)
}

fn claim_processed_result(
    store: &LogStore,
    input: &Input,
    root: &str,
    key: ProcessedResultKey,
) -> napi::Result<ProcessedResultClaim> {
    let pg = postgres_store(store)?;
    let mut held = admission::hold(pg, admission_subject(input, root)).map_err(admission_error)?;
    let claimed = store.claim_processed_result(ProcessedResultRequest {
        key,
        root: TrajectoryId::new(root),
    });
    if claimed.is_ok() {
        held.disarm();
    }
    claimed.map_err(error)
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
        authoritative_unexecuted_response, owner_can_be_spent_by, presentation_offer_ids,
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
    fn released_call_uses_saved_spelling_and_reports_the_accepted_plan() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            caller_id: Some("user:owner".to_owned()),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            arguments: Some(r#"{ "value": 1 }"#.to_owned()),
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
            caller_id: Some("user:owner".to_owned()),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            arguments: Some(r#"{ "value": 1 }"#.to_owned()),
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
            caller_id: Some("user:owner".to_owned()),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            arguments: None,
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
            caller_id: Some("user:owner".to_owned()),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            arguments: None,
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
    fn a_remedy_requires_a_caller() {
        assert!(validate(&remedy_input(json!({ "caller_id": null }))).is_err());
        assert!(validate(&remedy_input(json!({}))).is_ok());
    }
}

#[cfg(test)]
mod completed_replay_tests {
    use super::{Input, qualified_replay_decision, validate};
    use serde_json::{Value, json};

    #[test]
    fn replay_input_is_bounded_and_not_accepted_on_other_events() {
        let input = |ids: Value| -> Input {
            serde_json::from_value(json!({
                "organization_id": "org", "session_id": "session",
                "event": "replay_completed_results", "tool_call_ids": ids,
            }))
            .unwrap()
        };
        assert!(validate(&input(json!(["one", "one"]))).is_ok());
        assert!(validate(&input(json!(vec!["id"; 256]))).is_ok());
        for ids in [
            json!([]),
            json!([""]),
            json!(["bad\n"]),
            json!(["x".repeat(1025)]),
            json!(vec!["id"; 257]),
        ] {
            assert!(validate(&input(ids)).is_err());
        }
        let mut request = input(json!(["one"]));
        request.event = super::HookEventKind::SessionStart;
        assert!(validate(&request).is_err());
    }

    #[test]
    fn retained_decision_is_exact_and_requires_retained_output_and_call_context() {
        let decision = json!({
            "decision": "replace_output", "approved_output": "exact\nretained bytes",
            "output_source": "runtime", "reason": "policy", "offers": [{"offer_id": "offer"}],
        });
        let input = json!({
            "version": 1, "binding": "session",
            "semantic": {"tool": "original_dispatch", "arguments": {"original": true}},
            "context": {"tool": "read_file", "arguments": {"path": "file"}, "spawn": false},
        });
        assert_eq!(
            qualified_replay_decision(
                Some(decision.clone()),
                Some("exact\nretained bytes".into()),
                Some(input.clone())
            ),
            Some(decision.clone())
        );
        assert!(
            qualified_replay_decision(
                Some(decision.clone()),
                Some("different".into()),
                Some(input)
            )
            .is_none()
        );
        assert!(qualified_replay_decision(Some(decision.clone()), None, None).is_none());
        for (version, binding) in [(2, "session"), (1, "caller")] {
            assert!(
                qualified_replay_decision(
                    Some(decision.clone()),
                    Some("exact\nretained bytes".into()),
                    Some(json!({
                        "version": version, "binding": binding,
                        "semantic": {"tool": "read_file", "arguments": {}},
                    })),
                )
                .is_none()
            );
        }
        assert!(
            qualified_replay_decision(
                Some(decision),
                Some("exact\nretained bytes".into()),
                Some(json!({"tool": "read_file"}))
            )
            .is_none()
        );
    }

    #[test]
    fn peer_reads_lists_and_forged_peer_receipts_use_the_existing_validation() {
        for tool in [
            "read_peer_message",
            "acme__read_peer_message",
            "list_peer_messages",
            "acme__list_peer_messages",
            "mcp__gateway__archestra__list_peer_messages",
        ] {
            for flags in [
                json!({}),
                json!({"peer_read": true, "result": {"isError": false}}),
                json!({"peer_list": true}),
            ] {
                let mut decision = json!({"decision": "ack", "approved_output": "not evidence"});
                decision
                    .as_object_mut()
                    .unwrap()
                    .extend(flags.as_object().unwrap().clone());
                assert!(
                    qualified_replay_decision(
                        Some(decision),
                        Some("not evidence".into()),
                        Some(json!({"tool": tool, "arguments": {}}))
                    )
                    .is_none()
                );
            }
        }
    }
}

#[cfg(test)]
mod replay_expiry_tests {
    use super::{
        HookEventKind, INITIAL_POLICY, Input, SessionKey, State, cached_cancel_decision,
        claim_processed_result, processed_result_key,
    };
    use appa_eventlog::{Backend, LogStore, ProcessedResultClaim};
    use postgres::{Client, NoTls};
    use std::num::NonZeroUsize;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};
    use tokio::sync::Semaphore;

    #[test]
    fn expired_replay_refuses_before_a_cached_cancel_or_completed_result_returns() {
        let Some(url) = std::env::var("OPENAPPA_ADMISSION_PG_URL")
            .ok()
            .filter(|url| !url.is_empty())
        else {
            eprintln!("OPENAPPA_ADMISSION_PG_URL unset; skipped replay expiry test");
            return;
        };
        let name = format!("replay_expiry_{}", std::process::id());
        let mut admin = Client::connect(&url, NoTls).expect("disposable postgres");
        let _ = admin.batch_execute(&format!("DROP DATABASE IF EXISTS {name}"));
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .expect("replay database");
        let mut config: postgres::Config = url.parse().expect("admission url");
        config.dbname(&name);
        let replay_url = config_url(&config);
        install(&mut config.connect(NoTls).expect("replay database"));
        let store = LogStore::open(Backend::Postgres {
            url: format!("{replay_url}?sslmode=disable"),
            max_connections: NonZeroUsize::new(4).unwrap(),
        })
        .expect("leased store");
        expired_cancel_cache_is_410(&store);
        wrong_protocol_cancel_cache_is_410(&store);
        live_cancel_replay_stays_idempotent(&store);
        expired_completed_result_is_410_and_writes_no_cancel(&store);
        live_completed_result_does_not_write_cancel(&store);
        // postgres::Client owns a blocking runtime. Keep direct fixture connects
        // and cleanup outside Tokio; only dispatch futures need this executor.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("replay dispatch runtime")
            .block_on(async {
                recorded_dispatches_keep_authoritative_admission(&store).await;
                unstarted_dispatch_refuses_before_initialization(&store).await;
                completed_batch_is_ordered_readonly_and_conservative(&store).await;
            });
        cleanup_wins_before_a_result_claim(&store, &replay_url, true, false);
        cleanup_wins_before_a_result_claim(&store, &replay_url, false, false);
        cleanup_wins_before_a_result_claim(&store, &replay_url, true, true);
        cleanup_wins_before_a_result_claim(&store, &replay_url, false, true);
        drop(store);
        drop(config);
        admin
            .batch_execute(&format!("DROP DATABASE {name}"))
            .expect("drop replay database");
    }

    fn expired_cancel_cache_is_410(store: &LogStore) {
        let org = "org-expired-cancel";
        seed(store, org, "expired", 1);
        insert_cancel(
            store,
            org,
            r#"{"decision":"deny_call","feedback":"withheld"}"#,
        );
        let leased = store.lease().unwrap();
        let error = cached_cancel_decision(
            leased.postgres().unwrap(),
            &input(org),
            &root(org),
            "call-1",
        )
        .expect_err("expired group must not replay a cached cancel");
        assert!(
            error
                .to_string()
                .contains("OpenAPPA replay retention expired")
        );
        assert_eq!(group_status(store, org), "expired");
        assert_eq!(pending_count(store, org), 0);
        assert_eq!(cancel_count(store, org), 1);
    }

    fn wrong_protocol_cancel_cache_is_410(store: &LogStore) {
        let org = "org-protocol-cancel";
        seed(store, org, "live", 2);
        insert_cancel(
            store,
            org,
            r#"{"decision":"deny_call","feedback":"withheld"}"#,
        );
        let leased = store.lease().unwrap();
        let error = cached_cancel_decision(
            leased.postgres().unwrap(),
            &input(org),
            &root(org),
            "call-1",
        )
        .expect_err("foreign protocol must not replay a cached cancel");
        assert!(
            error
                .to_string()
                .contains("OpenAPPA replay retention expired")
        );
        assert_eq!(protocol_version(store, org), 2);
        assert_eq!(pending_count(store, org), 0);
    }

    fn live_cancel_replay_stays_idempotent(store: &LogStore) {
        let org = "org-live-cancel";
        seed(store, org, "live", 1);
        let decision = r#"{"decision":"deny_call","feedback":"withheld"}"#;
        insert_cancel(store, org, decision);
        let leased = store.lease().unwrap();
        let replayed = cached_cancel_decision(
            leased.postgres().unwrap(),
            &input(org),
            &root(org),
            "call-1",
        )
        .unwrap()
        .expect("live cancel replay");
        assert_eq!(
            replayed,
            serde_json::from_str::<serde_json::Value>(decision).unwrap()
        );
        assert_eq!(group_status(store, org), "live");
        assert_eq!(pending_count(store, org), 0);
        assert_eq!(cancel_count(store, org), 1);
    }

    fn expired_completed_result_is_410_and_writes_no_cancel(store: &LogStore) {
        let org = "org-expired-result";
        seed(store, org, "expired", 1);
        insert_completed_result(store, org);
        let leased = store.lease().unwrap();
        let error = claim_processed_result(
            &leased,
            &input(org),
            &root(org),
            processed_result_key(&input(org), "call-1".to_owned()),
        )
        .expect_err("expired group must not replay a completed result");
        assert!(
            error
                .to_string()
                .contains("OpenAPPA replay retention expired")
        );
        assert_eq!(group_status(store, org), "expired");
        assert_eq!(cancel_count(store, org), 0);
        assert_eq!(pending_count(store, org), 0);
    }

    fn live_completed_result_does_not_write_cancel(store: &LogStore) {
        let org = "org-live-result";
        seed(store, org, "live", 1);
        insert_completed_result(store, org);
        let leased = store.lease().unwrap();
        let claimed = claim_processed_result(
            &leased,
            &input(org),
            &root(org),
            processed_result_key(&input(org), "call-1".to_owned()),
        )
        .unwrap();
        assert!(matches!(claimed, ProcessedResultClaim::Complete { .. }));
        assert_eq!(cancel_count(store, org), 0);
        drop(leased);
    }

    async fn recorded_dispatches_keep_authoritative_admission(store: &LogStore) {
        for (status, protocol) in [("expired", 1), ("live", 2)] {
            for (index, event) in [
                HookEventKind::ToolResult,
                HookEventKind::ReplayCompletedResults,
                HookEventKind::CancelCall,
                HookEventKind::ToolCall,
                HookEventKind::SessionStart,
                HookEventKind::Remedy,
                HookEventKind::Yell,
                HookEventKind::Prompt,
                HookEventKind::TurnEnd,
                HookEventKind::ChildEnd,
                HookEventKind::ChildReturn,
                HookEventKind::ChildAddress,
            ]
            .into_iter()
            .enumerate()
            {
                let org = format!("org-recorded-{status}-{index}");
                seed(store, &org, status, protocol);
                insert_session(store, &org);
                insert_completed_result(store, &org);
                let state = leased_state(store);
                let request = dispatch_input(&org, event);
                let error = state
                    .dispatch_on_lease(request.clone(), root(&org), SessionKey::of(&request))
                    .await
                    .expect_err("recorded dispatch must not bypass its final admission");
                assert!(error.to_string().contains(crate::admission::EXPIRED));
                assert_eq!(pending_count(store, &org), 0);
                assert_eq!(result_pending_count(store, &org), 0);
                assert_eq!(cancel_count(store, &org), 0);
                assert_eq!(group_status(store, &org), status);
                assert_eq!(protocol_version(store, &org), protocol);
            }
        }

        let org = "org-recorded-live";
        seed(store, org, "live", 1);
        insert_session(store, org);
        insert_completed_result(store, org);
        let state = leased_state(store);
        for event in [HookEventKind::ToolResult, HookEventKind::CancelCall] {
            let request = dispatch_input(org, event);
            let decision = state
                .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
                .await
                .expect("completed result replays unchanged");
            assert_eq!(decision, serde_json::json!({"decision": "allow_call"}));
        }
        let request = dispatch_input(org, HookEventKind::SessionStart);
        assert_eq!(
            state
                .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
                .await
                .unwrap(),
            serde_json::json!({"decision": "ack"})
        );
        assert_eq!(cancel_count(store, org), 0);
        assert_eq!(pending_count(store, org), 0);

        let org = "org-expired-peer-replay";
        seed(store, org, "expired", 1);
        insert_session(store, org);
        insert_cancel(store, org, r#"{"decision":"allow_call"}"#);
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(|client| {
                client.execute(
                    "UPDATE openappa_operations SET operation_id = 'call:call-1', \
                 input = '{\"tool\":\"read_peer_message\",\"arguments\":{},\"spawn\":false}' \
                 WHERE organization_id = 'org-expired-peer-replay'",
                    &[],
                )?;
                Ok(())
            })
            .unwrap();
        drop(leased);
        let state = leased_state(store);
        let request = dispatch_input(org, HookEventKind::ToolResult);
        let error = state
            .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
            .await
            .expect_err("peer replay must not bypass retention admission");
        assert!(error.to_string().contains(crate::admission::EXPIRED));
        assert_eq!(result_pending_count(store, org), 0);
    }

    async fn unstarted_dispatch_refuses_before_initialization(store: &LogStore) {
        let org = "org-unstarted-expired";
        seed(store, org, "expired", 1);
        let state = leased_state(store);
        let request = dispatch_input(org, HookEventKind::SessionStart);
        let error = state
            .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
            .await
            .expect_err("initialization needs admission before runtime effects");
        assert!(error.to_string().contains(crate::admission::EXPIRED));
        assert_eq!(
            count(
                store,
                org,
                "SELECT count(*) FROM openappa_sessions WHERE organization_id = $1"
            ),
            0
        );
        let native_root = root(org);
        let events: i64 = state
            .store
            .postgres()
            .unwrap()
            .with_client(move |client| {
                Ok(client
                    .query_one(
                        "SELECT count(*) FROM openappa_events WHERE root = $1",
                        &[&native_root],
                    )?
                    .get(0))
            })
            .unwrap();
        assert_eq!(events, 0);
    }

    async fn completed_batch_is_ordered_readonly_and_conservative(store: &LogStore) {
        let org = "org-completed-batch";
        seed(store, org, "live", 1);
        insert_session(store, org);
        let native_root = root(org);
        let leased = store.lease().unwrap();
        leased.postgres().unwrap().with_client(move |client| {
            for (id, tool) in [
                ("first", "read_file"),
                ("last", "read_file"),
                ("peer", "read_peer_message"),
                ("foreign-root", "read_file"),
                ("foreign-caller", "read_file"),
            ] {
                let operation = format!("call:{id}");
                let input = serde_json::json!({"tool": tool, "arguments": {}, "spawn": false});
                let release = serde_json::json!({"decision": "allow_call"});
                let decision = serde_json::json!({
                    "decision": "ack", "approved_output": format!("retained {id}"), "output_source": "tool"
                });
                let approved = format!("retained {id}");
                client.execute(
                    "INSERT INTO openappa_operations \
                     (organization_id, session_id, operation_id, root, input, status, decision) \
                     VALUES ($1, 'session', $2, $3, $4, 'complete', $5)",
                    &[&org, &operation, &native_root, &input, &release],
                )?;
                client.execute(
                    "INSERT INTO openappa_processed_results \
                     (organization_id, session_id, tool_call_id, root, status, approved_output, decision) \
                     VALUES ($1, 'session', $2, $3, 'complete', $4, $5)",
                    &[&org, &id, &native_root, &approved, &decision],
                )?;
            }
            client.execute(
                "UPDATE openappa_processed_results SET root = 'wrong-root' \
                 WHERE organization_id = $1 AND tool_call_id = 'foreign-root'",
                &[&org],
            )?;
            client.execute(
                "UPDATE openappa_operations SET caller_id = 'user:other' \
                 WHERE organization_id = $1 AND operation_id = 'call:foreign-caller'",
                &[&org],
            )?;
            Ok(())
        }).unwrap();
        drop(leased);
        let state = leased_state(store);
        let mut request = dispatch_input(org, HookEventKind::ReplayCompletedResults);
        request.tool_call_ids = Some(
            [
                "last",
                "new",
                "first",
                "peer",
                "foreign-root",
                "foreign-caller",
                "last",
            ]
            .map(str::to_owned)
            .to_vec(),
        );
        let replay = state
            .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
            .await
            .unwrap();
        assert_eq!(
            replay,
            serde_json::json!({
                "decision": "replay_completed_results",
                "results": [
                    {"tool_call_id": "last", "decision": {"decision": "ack", "approved_output": "retained last", "output_source": "tool"}},
                    {"tool_call_id": "first", "decision": {"decision": "ack", "approved_output": "retained first", "output_source": "tool"}},
                    {"tool_call_id": "last", "decision": {"decision": "ack", "approved_output": "retained last", "output_source": "tool"}},
                ]
            })
        );
        assert_eq!(result_pending_count(store, org), 0);
        assert_eq!(pending_count(store, org), 0);
        assert_eq!(cancel_count(store, org), 0);
        assert_eq!(
            count(
                store,
                org,
                "SELECT count(*) FROM openappa_processed_results WHERE organization_id = $1"
            ),
            5
        );

        let mut peer_request = dispatch_input(org, HookEventKind::ToolResult);
        peer_request.tool_call_id = Some("peer".to_owned());
        let withheld = state
            .dispatch_on_lease(
                peer_request.clone(),
                root(org),
                SessionKey::of(&peer_request),
            )
            .await
            .expect("peer fallback must validate its native evidence");
        assert_eq!(withheld, crate::peer::withheld_peer_read());
        assert_ne!(withheld["approved_output"], "retained peer");
        assert_eq!(result_pending_count(store, org), 0);

        request.caller_id = Some("user:forged".to_owned());
        let replay = state
            .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
            .await
            .expect("an unqualified participant falls back without fast-path bytes");
        assert_eq!(replay["results"], serde_json::json!([]));
        request.caller_id = None;
        request.fork_of = Some("other-history".to_owned());
        assert!(
            state
                .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
                .await
                .is_err()
        );
        request.fork_of = None;

        let native_root = root(org);
        state
            .store
            .postgres()
            .unwrap()
            .with_client(move |client| {
                client.execute(
                    "INSERT INTO openappa_processed_results \
                 (organization_id, session_id, tool_call_id, root, status) \
                 VALUES ($1, 'session', 'pending', $2, 'pending')",
                    &[&org, &native_root],
                )?;
                Ok(())
            })
            .unwrap();
        let error = state
            .dispatch_on_lease(request.clone(), root(org), SessionKey::of(&request))
            .await
            .expect_err("a completed prefix cannot bypass interrupted family work");
        assert!(error.to_string().contains("interrupted processing"));
        assert_eq!(result_pending_count(store, org), 1);
        drop(state);

        let unstarted_org = "org-batch-unstarted";
        seed(store, unstarted_org, "live", 1);
        let state = leased_state(store);
        let request = dispatch_input(unstarted_org, HookEventKind::ReplayCompletedResults);
        let replay = state
            .dispatch_on_lease(
                request.clone(),
                root(unstarted_org),
                SessionKey::of(&request),
            )
            .await
            .unwrap();
        assert_eq!(replay["results"], serde_json::json!([]));
        assert_eq!(
            count(
                store,
                unstarted_org,
                "SELECT count(*) FROM openappa_sessions WHERE organization_id = $1"
            ),
            0
        );
        assert_eq!(
            count(
                store,
                unstarted_org,
                "SELECT count(*) FROM openappa_processed_results WHERE organization_id = $1"
            ),
            0
        );
        assert_eq!(pending_count(store, unstarted_org), 0);
        drop(state);

        // No local call metadata means the ordinary path must enforce the fork
        // watermark; this readonly lookup must not adopt the parent's receipt.
        let fork_org = "org-batch-fork";
        seed(store, fork_org, "live", 1);
        insert_session(store, fork_org);
        insert_completed_result(store, fork_org);
        let state = leased_state(store);
        state.store.postgres().unwrap().with_client(move |client| {
            client.execute(
                "UPDATE openappa_sessions SET forked_from = 'parent-history', forked_at = clock_timestamp() WHERE organization_id = $1",
                &[&fork_org],
            )?;
            let actor = crate::session_actor("parent-history");
            client.execute(
                "INSERT INTO openappa_sessions (organization_id, actor, root, session_id) \
                 VALUES ($1, $2, 'parent-root', 'parent-history')",
                &[&fork_org, &actor],
            )?;
            let decision = serde_json::json!({"decision": "ack", "approved_output": "exact inherited output", "output_source": "tool"});
            client.execute(
                "INSERT INTO openappa_processed_results \
                 (organization_id, session_id, tool_call_id, root, status, approved_output, decision, created_at) \
                 VALUES ($1, 'parent-history', 'before', 'parent-root', 'complete', 'exact inherited output', $2, clock_timestamp() - INTERVAL '1 hour'), \
                        ($1, 'parent-history', 'after', 'parent-root', 'complete', 'exact inherited output', $2, clock_timestamp() + INTERVAL '1 hour')",
                &[&fork_org, &decision],
            )?;
            Ok(())
        }).unwrap();
        let mut request = dispatch_input(fork_org, HookEventKind::ReplayCompletedResults);
        request.fork_of = Some("parent-history".to_owned());
        request.tool_call_ids = Some(["call-1", "before", "after"].map(str::to_owned).to_vec());
        let replay = state
            .dispatch_on_lease(request.clone(), root(fork_org), SessionKey::of(&request))
            .await
            .unwrap();
        assert_eq!(replay["results"], serde_json::json!([]));
        assert_eq!(result_pending_count(store, fork_org), 0);
        assert_eq!(cancel_count(store, fork_org), 0);
        for (id, expected) in [
            (
                "before",
                serde_json::json!({"decision": "ack", "approved_output": "exact inherited output", "output_source": "tool"}),
            ),
            ("after", crate::unknown_result_response()),
        ] {
            let mut request = dispatch_input(fork_org, HookEventKind::ToolResult);
            request.fork_of = Some("parent-history".to_owned());
            request.tool_call_id = Some(id.to_owned());
            let replay = state
                .dispatch_on_lease(request.clone(), root(fork_org), SessionKey::of(&request))
                .await
                .unwrap();
            assert_eq!(replay, expected);
        }
        assert_eq!(result_pending_count(store, fork_org), 0);
        assert_eq!(cancel_count(store, fork_org), 0);
    }

    fn cleanup_wins_before_a_result_claim(
        store: &LogStore,
        url: &str,
        complete: bool,
        batch: bool,
    ) {
        let org = match (complete, batch) {
            (true, false) => "org-race-complete",
            (false, false) => "org-race-unrecorded",
            (true, true) => "org-race-batch-complete",
            (false, true) => "org-race-batch-unrecorded",
        };
        seed(store, org, "live", 1);
        insert_session(store, org);
        if complete {
            insert_completed_result(store, org);
        }
        let mut cleanup = Client::connect(url, NoTls).unwrap();
        cleanup.batch_execute("BEGIN").unwrap();
        cleanup
            .query_one(
                "SELECT 1 FROM openappa_rewrite_groups WHERE organization_id = $1 FOR UPDATE",
                &[&org],
            )
            .unwrap();
        let state = leased_state(store);
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let pid: i32 = state
                .store
                .postgres()
                .unwrap()
                .with_client(|client| Ok(client.query_one("SELECT pg_backend_pid()", &[])?.get(0)))
                .unwrap();
            ready_tx.send(pid).unwrap();
            let request = dispatch_input(
                org,
                if batch {
                    HookEventKind::ReplayCompletedResults
                } else {
                    HookEventKind::ToolResult
                },
            );
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(state.dispatch_on_lease(
                    request.clone(),
                    root(org),
                    SessionKey::of(&request),
                ))
        });
        let pid = ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let blocked: bool = cleanup.query_one(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock')",
                &[&pid],
            ).unwrap().get(0);
            if blocked {
                break;
            }
            assert!(Instant::now() < deadline, "claim did not wait on cleanup");
            thread::sleep(Duration::from_millis(20));
        }
        cleanup
            .execute(
                "UPDATE openappa_rewrite_groups SET status = 'expired' WHERE organization_id = $1",
                &[&org],
            )
            .unwrap();
        cleanup.batch_execute("COMMIT").unwrap();
        let error = worker.join().unwrap().expect_err("cleanup won admission");
        assert!(error.to_string().contains(crate::admission::EXPIRED));
        assert_eq!(result_pending_count(store, org), 0);
        assert_eq!(pending_count(store, org), 0);
        assert_eq!(cancel_count(store, org), 0);
        assert_eq!(group_status(store, org), "expired");
    }

    fn leased_state(store: &LogStore) -> State {
        let store = Arc::new(store.lease().unwrap());
        let runtime = crate::policy::open(
            crate::policy::compile(INITIAL_POLICY, |_| None).unwrap(),
            store.clone(),
        )
        .unwrap();
        State {
            runtime: Arc::new(runtime),
            store,
            connections: Arc::new(Semaphore::new(4)),
            deployments: Arc::default(),
            reporting: None,
        }
    }

    fn dispatch_input(org: &str, event: HookEventKind) -> Input {
        let mut request = input(org);
        request.event = event;
        if event == HookEventKind::ReplayCompletedResults {
            request.tool_call_ids = Some(vec!["call-1".to_owned()]);
        }
        request.tool_call_id = Some("call-1".to_owned());
        request.operation_id = Some("call:call-1".to_owned());
        request.output = Some("untrusted replay".to_owned());
        request.arguments =
            Some(serde_json::value::RawValue::from_string("{}".to_owned()).unwrap());
        if event == HookEventKind::Remedy {
            request.caller_id = Some("user:reviewer".to_owned());
        }
        request
    }

    fn insert_session(store: &LogStore, org: &str) {
        let org = org.to_owned();
        let native_root = root(&org);
        let actor = crate::session_actor("session");
        let leased = store.lease().unwrap();
        leased.postgres().unwrap().with_client(move |client| {
            client.execute(
                "INSERT INTO openappa_sessions (organization_id, actor, root, session_id, start_decision) \
                 VALUES ($1, $2, $3, 'session', '{\"decision\":\"ack\"}')",
                &[&org, &actor, &native_root],
            )?;
            Ok(())
        }).unwrap();
    }

    fn result_pending_count(store: &LogStore, org: &str) -> i64 {
        count(
            store,
            org,
            "SELECT count(*) FROM openappa_processed_results WHERE organization_id = $1 AND status = 'pending'",
        )
    }

    fn input(org: &str) -> Input {
        serde_json::from_value(serde_json::json!({
            "organization_id": org,
            "session_id": "session",
            "event": HookEventKind::ToolCall,
        }))
        .unwrap()
    }

    fn root(org: &str) -> String {
        format!("root-{org}")
    }

    fn seed(store: &LogStore, org: &str, status: &str, protocol: i32) {
        let leased = store.lease().unwrap();
        let org = org.to_owned();
        let status = status.to_owned();
        let root = root(&org);
        let group = format!("group-{org}");
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| {
                client.execute(
                    "INSERT INTO openappa_rewrite_groups \
                     (organization_id, group_id, status, protocol_version, idle_ttl_ms, expires_at, touched_at) \
                     VALUES ($1, $2, $3, $4, 86400000, clock_timestamp() + INTERVAL '1 hour', clock_timestamp())",
                    &[&org, &group, &status, &protocol],
                )?;
                client.execute(
                    "INSERT INTO openappa_rewrite_roots (organization_id, native_root, group_id) \
                     VALUES ($1, $2, $3)",
                    &[&org, &root, &group],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn insert_cancel(store: &LogStore, org: &str, decision: &str) {
        let decision: serde_json::Value = serde_json::from_str(decision).unwrap();
        let org = org.to_owned();
        let root = root(&org);
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| {
                client.execute(
                    "INSERT INTO openappa_operations \
                     (organization_id, session_id, operation_id, root, status, input, decision) \
                     VALUES ($1, 'session', 'cancel:call-1', $2, 'complete', '{\"event\":\"cancel_call\"}', $3)",
                    &[&org, &root, &decision],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn insert_completed_result(store: &LogStore, org: &str) {
        let org = org.to_owned();
        let root = root(&org);
        let decision = serde_json::json!({"decision": "allow_call"});
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| {
                client.execute(
                    "INSERT INTO openappa_processed_results \
                     (organization_id, session_id, tool_call_id, root, status, approved_output, decision) \
                     VALUES ($1, 'session', 'call-1', $2, 'complete', 'ok', $3)",
                    &[&org, &root, &decision],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn group_status(store: &LogStore, org: &str) -> String {
        scalar(
            store,
            org,
            "SELECT status FROM openappa_rewrite_groups WHERE organization_id = $1",
        )
    }

    fn protocol_version(store: &LogStore, org: &str) -> i32 {
        let org = org.to_owned();
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| {
                Ok(client
                    .query_one(
                        "SELECT protocol_version FROM openappa_rewrite_groups WHERE organization_id = $1",
                        &[&org],
                    )?
                    .get(0))
            })
            .unwrap()
    }

    fn pending_count(store: &LogStore, org: &str) -> i64 {
        count(
            store,
            org,
            "SELECT count(*) FROM openappa_operations WHERE organization_id = $1 AND status = 'pending'",
        )
    }

    fn cancel_count(store: &LogStore, org: &str) -> i64 {
        count(
            store,
            org,
            "SELECT count(*) FROM openappa_operations WHERE organization_id = $1 AND operation_id LIKE 'cancel:%'",
        )
    }

    fn count(store: &LogStore, org: &str, sql: &'static str) -> i64 {
        let org = org.to_owned();
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| Ok(client.query_one(sql, &[&org])?.get(0)))
            .unwrap()
    }

    fn scalar(store: &LogStore, org: &str, sql: &'static str) -> String {
        let org = org.to_owned();
        let leased = store.lease().unwrap();
        leased
            .postgres()
            .unwrap()
            .with_client(move |client| Ok(client.query_one(sql, &[&org])?.get(0)))
            .unwrap()
    }

    fn install(client: &mut Client) {
        client
            .batch_execute(
                "CREATE TABLE openappa_events (root text NOT NULL, seq bigint NOT NULL, payload bytea NOT NULL);
                 CREATE TABLE openappa_policy_files (hash text NOT NULL, bytes bytea NOT NULL);
                 CREATE TABLE openappa_host_keys (key text NOT NULL, root text NOT NULL);
                 CREATE TABLE openappa_rewrite_groups (
                   organization_id text NOT NULL,
                   group_id text NOT NULL,
                   status text NOT NULL,
                   protocol_version integer NOT NULL,
                   idle_ttl_ms integer NOT NULL,
                   expires_at timestamptz NOT NULL,
                   touched_at timestamptz NOT NULL,
                   PRIMARY KEY (organization_id, group_id)
                 );
                 CREATE TABLE openappa_rewrite_roots (
                   organization_id text NOT NULL,
                   native_root text NOT NULL,
                   group_id text NOT NULL,
                   PRIMARY KEY (organization_id, native_root)
                 );
                 CREATE TABLE openappa_sessions (
                   organization_id text NOT NULL,
                   actor text NOT NULL,
                   root text NOT NULL,
                   session_id text NOT NULL,
                   start_decision jsonb NOT NULL DEFAULT '{}',
                   forked_from text,
                   forked_at timestamptz,
                   parent_id text,
                   caller_id text,
                   PRIMARY KEY (organization_id, actor)
                 );
                 CREATE TABLE openappa_operations (
                   organization_id text NOT NULL,
                   caller_id text,
                   session_id text NOT NULL,
                   operation_id text NOT NULL,
                   root text NOT NULL,
                   input jsonb,
                   status text NOT NULL,
                   decision jsonb,
                   created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                   PRIMARY KEY (organization_id, session_id, operation_id)
                 );
                  CREATE TABLE openappa_processed_results (
                    organization_id text NOT NULL,
                    caller_id text,
                    session_id text NOT NULL,
                    tool_call_id text NOT NULL,
                    root text NOT NULL,
                    status text NOT NULL,
                    approved_output text,
                    decision jsonb,
                    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                    PRIMARY KEY (organization_id, session_id, tool_call_id)
                  );
                  CREATE TABLE openappa_held_peer_messages (
                    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    id text NOT NULL UNIQUE,
                    receiver text NOT NULL,
                    digest text NOT NULL,
                    label jsonb NOT NULL,
                    body text NOT NULL,
                    expires_at bigint NOT NULL,
                    notified boolean NOT NULL DEFAULT false
                  );
                  CREATE TABLE openappa_embedded_peer_messages (
                    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    id text NOT NULL UNIQUE,
                    root text NOT NULL,
                    sender text NOT NULL,
                    recipient text NOT NULL,
                    pending_spawn text,
                    dispatch text NOT NULL,
                    digest text NOT NULL,
                    label jsonb NOT NULL,
                    body text,
                    status text NOT NULL,
                    read_call_id text,
                    read_arguments text,
                    decision jsonb,
                    expires_at bigint NOT NULL,
                    created_at bigint NOT NULL,
                    UNIQUE (root, sender, dispatch)
                  );",
            )
            .unwrap();
    }

    fn config_url(config: &postgres::Config) -> String {
        let user = config.get_user().unwrap_or("admission");
        let host = config.get_hosts().first().map(|host| match host {
            postgres::config::Host::Tcp(host) => host.clone(),
            _ => "127.0.0.1".to_owned(),
        });
        let port = config.get_ports().first().copied().unwrap_or(5432);
        let db = config.get_dbname().unwrap_or("postgres");
        match config.get_password() {
            Some(password) => format!(
                "postgresql://{user}:{}@{}:{port}/{db}",
                percent(&String::from_utf8_lossy(password)),
                host.unwrap_or_else(|| "127.0.0.1".to_owned())
            ),
            None => format!(
                "postgresql://{user}@{}:{port}/{db}",
                host.unwrap_or_else(|| "127.0.0.1".to_owned())
            ),
        }
    }

    fn percent(value: &str) -> String {
        value.replace('%', "%25").replace('@', "%40")
    }
}

#[cfg(test)]
mod review_restriction_tests {
    use super::{
        RESTRICTION_HEADING, disclosed_review_text, open_offer_restrictions, trust_chain_names,
        trust_name,
    };
    use appa_eventlog::Fact;

    const OPEN_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER_HEX: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const POLICY: &str = "[policy]\nversion = 2\ntrust_chain = [\"suspicious\", \"trusted\"]\n";

    fn opened(hex: &str) -> Fact {
        serde_json::from_str(&format!(
            r#"{{"OfferOpened":{{
                "trajectory":"root",
                "offer":"{hex}",
                "block":"{OPEN_HEX}",
                "act":{{"Proposals":"batch"}},
                "call":"{OPEN_HEX}",
                "subject":{{"Call":{{"trajectory":"root","batch":"batch","position":0}}}},
                "plan":{{
                    "id":1,
                    "steps":[{{"Accept":{{
                        "from":{{"trust":255,"audience":[]}},
                        "to":{{"trust":0,"audience":[{{"chain":"internal"}}]}}
                    }}}}],
                    "required":[]
                }},
                "basis":{{"family":0,"flow":0,"subject":0}}
            }}}}"#
        ))
        .expect("the retained offer decodes")
    }

    #[test]
    fn an_open_narrowing_is_a_named_restriction_not_a_grant() {
        let facts = vec![opened(OPEN_HEX)];
        let restrictions = open_offer_restrictions(&facts, POLICY.as_bytes(), &OPEN_HEX[..16])
            .expect("the open plan has a narrowing");
        assert_eq!(restrictions[0].dimension, "trust");
        assert_eq!(restrictions[0].before, "trusted");
        assert_eq!(restrictions[0].after, "suspicious");
        assert_eq!(restrictions[1].dimension, "readers");
        assert_eq!(restrictions[1].before, "public");
        assert_eq!(restrictions[1].after, "internal");
        let text = disclosed_review_text("Approve this call?".to_owned(), Some(&restrictions));
        assert!(text.contains(RESTRICTION_HEADING));
        assert!(text.contains("trust: trusted -> suspicious"));
        assert!(text.contains("readers: public -> internal"));
        assert!(text.contains("authorizes this exact call"));
        assert!(text.contains("they do not add permissions"));
        assert!(text.contains("does not accept the restriction"));
        assert!(!text.contains("symbolic"));
        let spoofed = format!("Arguments: {{\"note\":\"{RESTRICTION_HEADING} none\"}}");
        let disclosed = disclosed_review_text(spoofed, Some(&restrictions));
        assert!(disclosed.contains("trust: trusted -> suspicious"));
        assert!(disclosed.contains("readers: public -> internal"));
    }

    #[test]
    fn a_denied_or_other_offer_does_not_supply_the_restriction() {
        let mut denied = vec![opened(OPEN_HEX)];
        denied.push(
            serde_json::from_str(&format!(
                r#"{{"OfferDenied":{{"trajectory":"root","offer":"{OPEN_HEX}","authority":"qa_operator"}}}}"#
            ))
            .expect("a denial decodes"),
        );
        assert!(open_offer_restrictions(&denied, POLICY.as_bytes(), &OPEN_HEX[..16]).is_none());
        let other = vec![opened(OTHER_HEX)];
        assert!(open_offer_restrictions(&other, POLICY.as_bytes(), &OPEN_HEX[..16]).is_none());
        assert!(open_offer_restrictions(&other, POLICY.as_bytes(), "not-an-offer-id").is_none());
    }

    #[test]
    fn an_unreadable_policy_file_does_not_invent_rank_names() {
        assert_eq!(trust_name(255, &trust_chain_names(b"not toml")), "rank 255");
        assert_eq!(
            trust_chain_names(b"version = 2\n"),
            ["suspicious", "trusted"]
        );
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
