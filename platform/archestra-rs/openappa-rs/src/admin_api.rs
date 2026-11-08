use crate::{
    State, batteries, declarations, deployments,
    errors::{
        BindingFailure, Failure, failure, invalid_input, invariant, panicked, read_failure, storage,
    },
    initialized, metrics, on_deployment, policy, replay,
    session::{SessionKey, recorded_root, session_status},
    state_mutex,
};
use appa_eventlog::{Backend, LogStore};
use appa_runtime_api::TrajectoryId;
use futures_util::FutureExt;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::{
    collections::HashMap, num::NonZeroUsize, panic::AssertUnwindSafe, sync::Arc, time::Duration,
};
use tokio::sync::Semaphore;

#[napi(object)]
#[derive(Clone)]
pub struct ReportingOptions {
    pub endpoint: String,
    pub hostname: Option<String>,
}

/// Transient key material supplied separately from the serializable hook input.
/// The host validates conversation ownership, escrow and fingerprint first.
#[napi(object)]
pub struct ContentEncryption {
    pub key: napi::bindgen_prelude::Buffer,
    pub scope: String,
    /// Opaque capability for this dispatch's authenticated loopback annotator.
    pub annotator_context: Option<String>,
}

/// The upstream pin and host replay boundary version stored with each run.
#[napi(js_name = "getOpenappaReplayEngineVersion")]
pub fn get_openappa_replay_engine_version() -> String {
    replay::ENGINE_VERSION.to_string()
}

/// Parse scenario files into tools and assertion counts without loading a policy
/// or evaluating any call.
#[napi(js_name = "inspectOpenappaPolicyTests")]
pub async fn inspect_openappa_policy_tests(input: String) -> napi::Result<String> {
    AssertUnwindSafe(async move {
        let response = replay::inspect(&input).map_err(invalid_input)?;
        serde_json::to_string(&response).map_err(invariant)
    })
    .catch_unwind()
    .await
    .map_err(|_| panicked("OpenAPPA scenario inspection failed unexpectedly"))?
}

/// Evaluate bounded `.appa` scenarios against the supplied effective policy with the
/// credential values the host resolved for it. Every consult the policy declares is
/// made live, as a dispatch makes it; no tool runs and every trajectory stays in memory.
///
/// `onProgress`, when given, receives each file's progress as JSON while the replay runs:
/// `{"phase":"file_started","path"}`, then `{"phase":"file_finished", ...}` with that
/// file's result, before the next file starts. It only observes: calls are queued without
/// waiting, and the listener must not throw. Events still queued when the replay settles
/// may arrive after its promise resolves.
#[napi(js_name = "replayOpenappaPolicy")]
pub async fn replay_openappa_policy(
    input: String,
    on_progress: Option<ThreadsafeFunction<String, (), String, napi::Status, false>>,
) -> napi::Result<String> {
    // Live consults wait on remote parties, so a few replays may run at once.
    static REPLAY_SLOTS: Semaphore = Semaphore::const_new(4);
    AssertUnwindSafe(async move {
        let _permit = REPLAY_SLOTS.try_acquire().map_err(|_| {
            failure(
                Failure::Binding(BindingFailure::ReplayBusy),
                "Too many OpenAPPA replays are running; retry later",
            )
        })?;
        let request = replay::Request::parse(&input).map_err(invalid_input)?;
        let report = |event: replay::Progress<'_>| {
            let Some(listener) = &on_progress else {
                return;
            };
            // An event that cannot be encoded or queued is dropped; the run goes on.
            if let Ok(event) = serde_json::to_string(&event) {
                listener.call(event, ThreadsafeFunctionCallMode::NonBlocking);
            }
        };
        let response = tokio::time::timeout(Duration::from_secs(120), replay::run(request, report))
            .await
            .map_err(|_| {
                failure(
                    Failure::Binding(BindingFailure::ReplayTimedOut),
                    "OpenAPPA replay exceeded its 120 second limit",
                )
            })?;
        serde_json::to_string(&response).map_err(invariant)
    })
    .catch_unwind()
    .await
    .map_err(|_| panicked("OpenAPPA replay failed unexpectedly"))?
}
/// The effective policy of the dispatching organization, with the values the host
/// resolved for the credential variables the runtime reads itself.
#[napi(object)]
pub struct DispatchPolicy {
    pub content: String,
    /// Variable → value, for the document's `runtimeCredentials`. Secrets.
    pub credentials: HashMap<String, String>,
    /// The content hash of the stored composition `content` was read from. A
    /// dispatch whose composition is no longer the stored one publishes nothing
    /// and is refused as retryable; absent, nothing is checked.
    pub composition_hash: Option<String>,
}

#[napi(object)]
pub struct OpenappaStatus {
    pub trust: String,
    pub audience: String,
    /// The organization's policy revision the session's next event is decided under.
    pub policy_revision: i64,
}

impl From<DispatchPolicy> for deployments::HostedPolicy {
    fn from(policy: DispatchPolicy) -> Self {
        deployments::HostedPolicy {
            content: policy.content,
            credentials: deployments::HostCredentials::new(policy.credentials),
            composition: policy.composition_hash,
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
        .ok_or_else(|| {
            failure(
                Failure::Binding(BindingFailure::RuntimeMisconfigured),
                "OpenAPPA needs at least one PostgreSQL connection",
            )
        })?;
    metrics::initialize();
    let mut slot = state_mutex().lock().await;
    if slot.is_some() {
        return Ok(());
    }
    let state = tokio::task::spawn_blocking(move || -> napi::Result<State> {
        appa_runtime::tls::install_crypto_provider();
        let mut config = policy::compile(INITIAL_POLICY, |_| None)?;
        config.reporting.agent_yell = reporting.is_some();
        let store = Arc::new(
            LogStore::open(Backend::Postgres {
                url: database_url,
                max_connections,
            })
            .map_err(storage)?,
        );
        let runtime = policy::open(config, store.clone())?;
        Ok(State {
            runtime: Arc::new(runtime),
            store,
            deployments: Arc::default(),
            reporting,
            served: None,
        })
    })
    .await
    .map_err(panicked)??;
    *slot = Some(state);
    Ok(())
}

/// Validates a document already composed by the host, including host-owned helper
/// token bindings. Never use this for authored root or battery text: those must
/// pass their existing input checks before the host adds its bindings.
/// Validation defers secret lookup and opens no store or network connection.
#[napi(js_name = "validateHostedOpenappaPolicy")]
pub async fn validate_hosted_openappa_policy(content: String) -> napi::Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| policy::validate_hosted(&content))
            .map(|result| result.err().into_iter().collect())
            .map_err(|_| panicked("OpenAPPA hosted policy validation failed"))
    })
    .await
    .map_err(panicked)?
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
    /// The base policy text.
    pub policy: String,
    /// The target policy text deployed before the base; absent deploys the base alone.
    pub target_policy: Option<String>,
    pub helpers: Option<HelperBindingInput>,
}

#[napi(object)]
pub struct ComposePolicyInput {
    pub root: String,
    pub batteries: Vec<ComposeBatteryInput>,
    /// The readers of each member roster the host keeps, by roster name:
    /// principal → email. A roster absent here is declared empty.
    pub member_rosters: Option<HashMap<String, HashMap<String, String>>>,
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
                target: battery.target_policy,
                helpers: battery.helpers.map(|helpers| policy::HelperBinding {
                    url_base: helpers.url_base,
                    token_env: helpers.token_env,
                }),
            })
            .collect();
        let rosters: policy::MemberRosters = input
            .member_rosters
            .unwrap_or_default()
            .into_iter()
            .map(|(name, readers)| (name, readers.into_iter().collect()))
            .collect();
        std::panic::catch_unwind(|| policy::compose_with_rosters(&input.root, &batteries, &rosters))
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
            .map_err(|_| panicked("OpenAPPA policy composition failed"))
    })
    .await
    .map_err(panicked)?
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

/// A root external or profile naming a `token_env`; `reader` is its `externals`
/// path.
#[napi(object)]
pub struct TokenEnvReader {
    pub variable: String,
    pub reader: String,
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
    /// Every root external or profile naming a `token_env`, bound or not.
    pub token_env_readers: Vec<TokenEnvReader>,
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
                    .mcp_aliases
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
                token_env_readers: parsed
                    .token_env_readers
                    .into_iter()
                    .map(|reader| TokenEnvReader {
                        variable: reader.variable,
                        reader: reader.reader,
                    })
                    .collect(),
                errors: parsed.errors,
            })
            .map_err(|_| panicked("OpenAPPA declaration parsing failed"))
    })
    .await
    .map_err(panicked)?
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
            .map_err(|_| panicked("OpenAPPA policy editing failed"))
    })
    .await
    .map_err(panicked)?
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
    /// The base policy text: all a deployment without a target composes.
    pub base: String,
    pub helpers: Vec<String>,
    pub credentials: Vec<String>,
    pub externals: Vec<BatteryExternal>,
    pub benefit: Option<String>,
    pub setup: Option<String>,
    pub files: Vec<BatteryFileInput>,
    /// What a multi-user deployment composes, when the battery declares targets.
    pub multi_user: Option<BatteryTargetView>,
}

/// A battery deployed for one target: the target policy, composed before the base,
/// and what the two declare and read together.
#[napi(object)]
pub struct BatteryTargetView {
    pub policy: String,
    /// Every variable the target and its base read.
    pub credentials: Vec<String>,
    /// The variables the target policy itself reads, without the base's.
    pub target_credentials: Vec<String>,
    pub externals: Vec<BatteryExternal>,
    pub annotators: Vec<String>,
    pub routed_annotators: Vec<String>,
    pub setup: Option<String>,
}

fn battery_externals(externals: &[batteries::HelperExternal]) -> Vec<BatteryExternal> {
    externals
        .iter()
        .map(|external| BatteryExternal {
            kind: external.kind.clone(),
            name: external.name.clone(),
            command: external.command.clone(),
            token_env: external.token_env.clone(),
        })
        .collect()
}

impl From<&batteries::BatteryInfo> for BatteryPackage {
    fn from(info: &batteries::BatteryInfo) -> Self {
        BatteryPackage {
            name: info.name.clone(),
            description: info.description.clone(),
            namespaces: info.namespaces.clone(),
            annotators: info.annotators.clone(),
            routed_annotators: info.routed_annotators.clone(),
            base: info.base.clone(),
            helpers: info.helpers.clone(),
            credentials: info.credentials.clone(),
            externals: battery_externals(&info.externals),
            benefit: info.benefit.clone(),
            setup: info.setup.clone(),
            files: info
                .files
                .iter()
                .map(|file| BatteryFileInput {
                    path: file.path.clone(),
                    text: file.text.clone(),
                })
                .collect(),
            multi_user: info.multi_user.as_ref().map(|target| BatteryTargetView {
                policy: target.policy.clone(),
                credentials: target.credentials.clone(),
                target_credentials: target.target_credentials.clone(),
                externals: battery_externals(&target.externals),
                annotators: target.annotators.clone(),
                routed_annotators: target.routed_annotators.clone(),
                setup: target.setup.clone(),
            }),
        }
    }
}

/// The batteries bundled with the pinned OpenAPPA checkout that govern MCP tools,
/// which is what Archestra serves, or declare annotators alone.
#[napi(js_name = "listBundledOpenappaBatteries")]
pub async fn list_bundled_openappa_batteries() -> napi::Result<Vec<BatteryPackage>> {
    tokio::task::spawn_blocking(|| {
        let loaded = std::panic::catch_unwind(batteries::bundled)
            .map_err(|_| panicked("bundled OpenAPPA batteries failed to load"))?;
        loaded
            .map_err(invariant)
            .map(|batteries| batteries.iter().map(BatteryPackage::from).collect())
    })
    .await
    .map_err(panicked)?
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
        std::panic::catch_unwind(|| batteries::inspect(&files, batteries::PackageOrigin::Uploaded))
            .map_err(|_| panicked("OpenAPPA battery inspection failed"))?
            .map(|info| BatteryPackage::from(&info))
            .map_err(invalid_input)
    })
    .await
    .map_err(panicked)?
}

/// The kind of family each root opened as, in the order given, for the operator's
/// preflight count: `following` for one that follows a deployment line, `legacy`
/// for one pinned to a policy snapshot, `encrypted` for an opening sealed with a
/// conversation key this read does not hold, and none for a root with no log.
#[napi(js_name = "openappaRootKinds")]
pub async fn openappa_root_kinds(roots: Vec<String>) -> napi::Result<Vec<Option<String>>> {
    if roots
        .iter()
        .any(|root| root.is_empty() || root.len() > 1024 || root.chars().any(char::is_control))
    {
        return Err(invalid_input("invalid root identity"));
    }
    let leased = initialized().await?.lease().await?;
    tokio::task::spawn_blocking(move || {
        roots
            .into_iter()
            .map(|root| match leased.state.store.log(&TrajectoryId(root)) {
                Ok(_) => Ok(Some("following".to_owned())),
                Err(appa_eventlog::ReadError::LegacyFamily { .. }) => Ok(Some("legacy".to_owned())),
                Err(appa_eventlog::ReadError::UnknownRoot { .. }) => Ok(None),
                Err(read) if read.to_string().contains("requires its conversation key") => {
                    Ok(Some("encrypted".to_owned()))
                }
                Err(read) => Err(read_failure(read)),
            })
            .collect()
    })
    .await
    .map_err(panicked)?
}

/// Read the current label of a started session without mutating its trajectory.
/// The read runs through a view pinned to the organization's deployment line, as
/// a dispatch does: a family is read on the line it follows.
/// None before the session started, and for a family opened under the earlier
/// policy model, whose next event is refused instead.
#[napi(js_name = "getOpenappaStatus")]
pub async fn get_openappa_status(
    organization_id: String,
    session_id: String,
    policy: DispatchPolicy,
    encryption: Option<ContentEncryption>,
) -> napi::Result<Option<OpenappaStatus>> {
    if organization_id.is_empty()
        || organization_id.len() > 512
        || organization_id.chars().any(char::is_control)
    {
        return Err(invalid_input("invalid organization identity"));
    }
    if session_id.is_empty() || session_id.len() > 1024 || session_id.chars().any(char::is_control)
    {
        return Err(invalid_input("invalid session identity"));
    }
    let policy: deployments::HostedPolicy = policy.into();
    let result = AssertUnwindSafe(async move {
        let state = initialized().await?.encrypted(encryption)?;
        let session = SessionKey::new(&organization_id, &session_id);
        let lookup = state.clone();
        let root = tokio::task::spawn_blocking(move || recorded_root(&lookup, &session))
            .await
            .map_err(panicked)??;
        // An unstarted session has no status, and is no reason to publish.
        if root.is_none() {
            return Ok(None);
        }
        on_deployment(&state, &organization_id, &policy, |pinned| {
            let key = SessionKey::new(&organization_id, &session_id);
            async move { session_status(pinned, key).await }
        })
        .await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(result) => result,
        Err(_) => Err(panicked("OpenAPPA panicked while reading status")),
    }
}
