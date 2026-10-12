//! Offline replay of host-supplied scenarios through OpenAPPA's parser and runner.
//! The policy bytes are never rewritten. Annotators, context providers and audience
//! sources are rebound to an in-process loopback stand-in: the host's own no-op
//! annotator endpoint, bound without a token, gets the answer the host says it serves.
//! Every other consult gets no answer, and the file ends `cannot_run` at the first step
//! that answer could have decided. A deployment needing a model process, a model profile
//! or an external remedy party is refused as a whole. Built-in human review
//! remains unanswered if a scenario reaches it; merely declaring it is safe.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::{ConsultRecord, ConsultRecorder, ExternalOutcome, ExternalRole, OfferKind, Runtime},
    config::{
        AnnotatorImplementation, ArchestraEndpoint, AudienceImplementation, Config, Endpoint,
        HostDefaults, Implementation,
    },
    replay::{self, Expect, Got, StepOutcome, Trace, TraceReport, Verdict},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) const ENGINE_VERSION: &str =
    "10aa0e09e32d8c6704bdb030dc3c66140bf81915:archestra-offline-v3";
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ASSERTIONS: usize = 1000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    content: String,
    files: Vec<File>,
    #[serde(default)]
    noop_annotator: Option<NoopAnnotator>,
}

/// The host's own annotator endpoint whose answer does not depend on the call: an
/// annotator bound to exactly this URL is answered with `response`, as the host serves it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoopAnnotator {
    url: String,
    response: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    path: String,
    content: String,
}

fn validate_files(files: &[File], max_file_bytes: usize, max_bytes: usize) -> Result<(), String> {
    if files.len() > MAX_FILES {
        return Err("At most 32 scenario files are supported".into());
    }
    let mut paths = HashSet::new();
    let mut bytes = 0;
    for file in files {
        if file.path.len() > 240
            || !file.path.ends_with(".appa")
            || file.path.starts_with('/')
            || file.path.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            })
            || !paths.insert(&file.path)
        {
            return Err("Scenario paths must be unique relative .appa file paths".into());
        }
        bytes += file.content.len();
        if file.content.len() > max_file_bytes || bytes > max_bytes {
            return Err("Scenarios exceed the per-file or collection byte limit".into());
        }
    }
    Ok(())
}

impl Request {
    pub(crate) fn parse(input: &str) -> Result<Self, String> {
        if input.len() > MAX_INPUT_BYTES {
            return Err("Replay request exceeds 2 MiB".into());
        }
        let request: Self = serde_json::from_str(input).map_err(|_| "Invalid replay request")?;
        if request.content.len() > MAX_FILE_BYTES {
            return Err("Effective policy exceeds 256 KiB".into());
        }
        if request.files.is_empty() || request.files.len() > MAX_FILES {
            return Err("Replay needs between 1 and 32 scenario files".into());
        }
        validate_files(&request.files, MAX_FILE_BYTES, 1024 * 1024)?;
        Ok(request)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectionRequest {
    files: Vec<File>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInspection {
    path: String,
    tools: Vec<String>,
    assertion_count: Option<usize>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct InspectionResponse {
    files: Vec<FileInspection>,
}

/// Parse scenarios only. Neither a policy nor a runtime is needed, including for
/// tool names that replay cannot dispatch through this host.
pub(crate) fn inspect(input: &str) -> Result<InspectionResponse, String> {
    // JSON escaping can expand the bounded decoded collection up to sixfold.
    if input.len() > 4 * 1024 * 1024 {
        return Err("Inspection request exceeds 4 MiB".into());
    }
    let request: InspectionRequest =
        serde_json::from_str(input).map_err(|_| "Invalid inspection request")?;
    validate_files(&request.files, 64 * 1024, 512 * 1024)?;
    let files = request
        .files
        .into_iter()
        .map(
            |file| match replay::parse(Path::new(&file.path), &file.content) {
                Ok(trace) => {
                    let mut seen = HashSet::new();
                    let tools = trace
                        .steps
                        .iter()
                        .map(|step| step.tool.to_string())
                        .filter(|tool| seen.insert(tool.clone()))
                        .collect();
                    FileInspection {
                        path: file.path,
                        tools,
                        assertion_count: Some(trace.steps.len()),
                        error: None,
                    }
                }
                Err(error) => FileInspection {
                    path: file.path,
                    tools: Vec::new(),
                    assertion_count: None,
                    error: Some(error.to_string()),
                },
            },
        )
        .collect();
    Ok(InspectionResponse { files })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Response {
    engine_version: &'static str,
    files: Vec<FileResult>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Passed,
    Failed,
    CannotRun,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    path: String,
    assertion_count: usize,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    steps: Vec<StepResult>,
}

#[derive(Serialize)]
struct StepResult {
    line: usize,
    tool: String,
    expected: String,
    actual: Option<String>,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// The call ran as proposed, or once the model accepted the narrowing it makes.
    #[serde(skip)]
    released: bool,
}

fn cannot_run(path: String, assertion_count: usize, error: String) -> FileResult {
    FileResult {
        path,
        assertion_count,
        status: Status::CannotRun,
        error: Some(error),
        steps: Vec::new(),
    }
}

/// The loopback stand-in every rebound consult reaches. Nothing it answers leaves the
/// process; it stops when dropped.
struct OfflineConsults {
    noop_url: String,
    refuse_url: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for OfflineConsults {
    fn drop(&mut self) {
        self.server.abort();
    }
}

const NOOP_PATH: &str = "/noop";
const MAX_CONSULT_BYTES: usize = 1024 * 1024;

impl OfflineConsults {
    async fn start(noop: Option<&NoopAnnotator>) -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| {
                format!("Offline replay cannot start its consult stand-in: {error}")
            })?;
        let address = listener.local_addr().map_err(|error| {
            format!("Offline replay cannot start its consult stand-in: {error}")
        })?;
        let noop: Option<Arc<[u8]>> = noop
            .map(|noop| serde_json::to_vec(&noop.response).map(Arc::from))
            .transpose()
            .map_err(|_| "The no-op annotator response is not serializable".to_string())?;
        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(stream, noop.clone()));
            }
        });
        Ok(Self {
            noop_url: format!("http://{address}{NOOP_PATH}"),
            refuse_url: format!("http://{address}/refuse"),
            server,
        })
    }
}

/// One consult, read in full before answering so the client never sees a reset: the
/// no-op body on the no-op path when the host supplied one, 503 otherwise.
async fn answer(mut stream: tokio::net::TcpStream, noop: Option<Arc<[u8]>>) {
    let mut request = Vec::new();
    let mut chunk = [0u8; 8192];
    let head = loop {
        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) if request.len() + read <= MAX_CONSULT_BYTES => {
                request.extend_from_slice(&chunk[..read])
            }
            Ok(_) => return,
        }
    };
    let head_text = String::from_utf8_lossy(&request[..head]).into_owned();
    let length = head_text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_CONSULT_BYTES {
        return;
    }
    while request.len() < head + length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&chunk[..read]),
        }
    }
    let path = head_text.split_whitespace().nth(1);
    let response = match (path, noop) {
        (Some(NOOP_PATH), Some(body)) => {
            let mut response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            response.extend_from_slice(&body);
            response
        }
        _ => b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            .to_vec(),
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

/// No env lookup, secrets, modules, disk config, or production storage enters replay.
/// Every token a binding names reads as a placeholder, and every binding that could carry
/// one is either rebound to the stand-in without a token or refused here.
async fn offline_runtime(content: &str, noop: Option<&NoopAnnotator>) -> Result<Offline, String> {
    let document: toml::Table = toml::from_str(content)
        .map_err(|_| "The effective policy is not valid TOML".to_string())?;
    if document
        .get("externals")
        .and_then(|externals| externals.get("claude_code"))
        .is_some()
    {
        return Err("Offline replay cannot run a policy declaring a model process profile".into());
    }
    if let Some(builtin) = document
        .get("policy")
        .and_then(|policy| policy.get("annotator"))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|annotator| annotator.get("builtin").and_then(toml::Value::as_str))
        .find(|builtin| *builtin != "archestra")
    {
        return Err(format!(
            "Offline replay cannot run a policy declaring a {builtin:?} annotator; live model inference is disabled"
        ));
    }
    let consults = OfflineConsults::start(noop).await?;
    let mut defaults = HostDefaults::new(Duration::from_secs(1), 65536);
    defaults.archestra = Some(ArchestraEndpoint::new(
        consults.refuse_url.clone(),
        "offline-replay".into(),
    ));
    let mut config = Config::hosted(content, defaults, |_| Some("offline-replay".into()))
        .map_err(|error| format!("The effective policy cannot load offline: {error}"))?;
    let externals = &mut config.externals;
    // Replay opens without an elicitation channel or a supplied human ruling.
    // The hitl backend therefore abstains when invoked, never prompts or approves.
    let stock = |binding: &Implementation| matches!(binding, Implementation::Builtin(name) if matches!(name.as_str(), "approve" | "hitl" | "redact-email" | "redact-secrets"));
    if externals.llm.is_some()
        || externals.jev.is_some()
        || externals
            .authorities
            .values()
            .chain(externals.sanitizers.values())
            .any(|binding| !stock(binding))
    {
        return Err("Offline replay cannot run a policy with external authorities or sanitizers, or model profiles".into());
    }
    let stand_in = |url: &str| AnnotatorImplementation::Resolver(Endpoint::new(url.into(), None));
    for binding in externals.annotators.values_mut() {
        let noop_bound = matches!(binding, AnnotatorImplementation::Resolver(endpoint)
            if endpoint.token.is_none() && noop.is_some_and(|noop| noop.url == endpoint.url));
        *binding = stand_in(match noop_bound {
            true => &consults.noop_url,
            false => &consults.refuse_url,
        });
    }
    for binding in externals.context.values_mut() {
        *binding = stand_in(&consults.refuse_url);
    }
    for binding in externals.audience.values_mut() {
        if !matches!(binding.implementation, AudienceImplementation::Readers(_)) {
            binding.implementation =
                AudienceImplementation::Resolver(Endpoint::new(consults.refuse_url.clone(), None));
        }
    }
    let store = Arc::new(LogStore::open(Backend::Memory).map_err(|error| error.to_string())?);
    let unanswered = Arc::new(Unanswered::default());
    let runtime = Runtime::open_with_store_as(config, store, None, crate::adapter::adapter())
        .map_err(|error| error.to_string())?
        .recording(unanswered.clone());
    Ok(Offline {
        runtime,
        unanswered,
        _consults: consults,
    })
}

struct Offline {
    runtime: Runtime,
    unanswered: Arc<Unanswered>,
    _consults: OfflineConsults,
}

/// The audience sources that gave no answer, in order. An unanswered annotator refuses
/// its call, which the runner already reports as `cannot_run`; an unanswered context
/// provider leaves the annotator asked, and only the no-op answers offline. An unanswered
/// audience source instead denies the call, which a `deny` expectation would take as a pass.
#[derive(Default)]
struct Unanswered(Mutex<Vec<String>>);

impl ConsultRecorder for Unanswered {
    fn record(&self, record: ConsultRecord) {
        if let (ExternalRole::AudienceSource, ExternalOutcome::NoAnswer(_)) =
            (record.role, record.outcome)
        {
            self.entries().push(record.external_name);
        }
    }
}

impl Unanswered {
    fn entries(&self) -> MutexGuard<'_, Vec<String>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Replay one trace. A call needing an answer that did not come is not released, so after
/// an unanswered audience source the first step whose call was not released as proposed
/// cannot run and ends the file. Steps before it were released without one.
async fn replay_trace(offline: &Offline, trace: &Trace) -> Vec<FileResult> {
    let mark = offline.unanswered.entries().len();
    let mut results: Vec<FileResult> = replay::run(&offline.runtime, std::slice::from_ref(trace))
        .await
        .into_iter()
        .map(|report| result(trace, report))
        .collect();
    let Some(source) = offline.unanswered.entries().get(mark).cloned() else {
        return results;
    };
    for file in &mut results {
        let Some(at) = file.steps.iter().position(|step| !step.released) else {
            continue;
        };
        file.steps.truncate(at + 1);
        let step = &mut file.steps[at];
        if step.status != Status::CannotRun {
            step.status = Status::CannotRun;
            step.actual = None;
            step.error = Some(format!(
                "audience source {source:?} gave no answer offline at or before this call, so replay cannot decide it"
            ));
        }
        file.status = Status::CannotRun;
    }
    results
}

fn result(trace: &Trace, report: TraceReport) -> FileResult {
    let status = match report.verdict() {
        Verdict::Ok => Status::Passed,
        Verdict::Failed => Status::Failed,
        Verdict::CannotRun => Status::CannotRun,
    };
    let steps = report
        .steps
        .into_iter()
        .map(|step| {
            let expected = step.expect.to_string();
            let released = matches!(
                (&step.outcome, &step.expect),
                (
                    StepOutcome::Passed {
                        taken: None | Some(OfferKind::Accept)
                    },
                    Expect::Allow
                ) | (
                    StepOutcome::Mismatch {
                        got: Got::Allowed,
                        ..
                    },
                    _
                )
            );
            let (status, actual, error) = match step.outcome {
                StepOutcome::Passed { taken } => {
                    let actual = match taken {
                        Some(kind) => {
                            Got::Blocked(std::collections::BTreeSet::from([kind])).to_string()
                        }
                        None => expected.clone(),
                    };
                    (Status::Passed, Some(actual), None)
                }
                StepOutcome::Mismatch { got, feedback, .. } => {
                    (Status::Failed, Some(got.to_string()), feedback)
                }
                StepOutcome::CannotRun(detail) => (Status::CannotRun, None, Some(detail)),
            };
            StepResult {
                line: step.line,
                tool: step.tool.to_string(),
                expected,
                actual,
                status,
                error,
                released,
            }
        })
        .collect();
    FileResult {
        path: report.path.to_string_lossy().into_owned(),
        assertion_count: trace.steps.len(),
        status,
        error: report.unopened,
        steps,
    }
}

pub(crate) async fn run(request: Request) -> Response {
    let offline = offline_runtime(&request.content, request.noop_annotator.as_ref()).await;
    let mut files = Vec::with_capacity(request.files.len());
    let mut assertions = 0;
    for file in request.files {
        let trace = match replay::parse(Path::new(&file.path), &file.content) {
            Ok(trace) => trace,
            Err(error) => {
                // Preserve upstream file/line diagnostics, which may include scenario text.
                files.push(cannot_run(file.path, 0, error.to_string()));
                continue;
            }
        };
        assertions += trace.steps.len();
        let runtime = if trace.steps.is_empty() || assertions > MAX_ASSERTIONS {
            Err("Scenarios need at least one assertion and at most 1000 assertions per run".into())
        } else if let Some(step) = trace
            .steps
            .iter()
            .find(|step| (crate::adapter::adapter().spell)(&step.tool).is_none())
        {
            Err(format!(
                "Line {}: {} cannot be dispatched through the Archestra adapter",
                step.line, step.tool
            ))
        } else {
            offline.as_ref().map_err(Clone::clone)
        };
        match runtime {
            // Sequential files cap work and memory; each unique path opens a fresh root.
            Ok(offline) => files.extend(replay_trace(offline, &trace).await),
            Err(error) => files.push(cannot_run(file.path, trace.steps.len(), error)),
        }
    }
    Response {
        engine_version: ENGINE_VERSION,
        files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: &str = "[policy]\nversion = 2\n\n[[policy.tool]]\nname = 'files__read'\ndelta = { trust = 'suspicious' }\n\n[[policy.tool]]\nname = 'mail__send'\ndelta = {}\nrequires = { trust = 'trusted' }\n";

    fn request(policy: &str, files: &[(&str, &str)]) -> Request {
        Request::parse(
            &serde_json::json!({
                "content":policy,
                "files":files.iter().map(|(path,content)|serde_json::json!({"path":path,"content":content})).collect::<Vec<_>>()
            })
            .to_string(),
        )
        .expect("bounded request")
    }

    #[tokio::test]
    async fn ordered_calls_share_state_but_files_do_not() {
        let response = run(request(
            POLICY,
            &[
                (
                    "tainted.appa",
                    "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny",
                ),
                ("fresh.appa", "mcp/mail/send {}\nexpect allow"),
            ],
        ))
        .await;
        assert_eq!(response.files[0].status, Status::Passed);
        assert_eq!(response.files[0].steps.len(), 2);
        assert_eq!(response.files[1].status, Status::Passed);
    }

    #[tokio::test]
    async fn mismatch_stops_one_file_and_reports_real_decision() {
        let response = run(request(
            POLICY,
            &[
                (
                    "mismatch.appa",
                    "mcp/mail/send {}\nexpect deny\nmcp/files/read {}\nexpect allow",
                ),
                ("valid.appa", "mcp/files/read {}\nexpect allow"),
            ],
        ))
        .await;
        assert_eq!(response.files[0].status, Status::Failed);
        assert_eq!(response.files[0].assertion_count, 2);
        assert_eq!(response.files[0].steps.len(), 1);
        assert_eq!(response.files[0].steps[0].actual.as_deref(), Some("allow"));
        assert_eq!(response.files[1].status, Status::Passed);
    }

    #[tokio::test]
    async fn archestra_server_aliases_resolve_under_the_production_adapter() {
        let policy = "[server_aliases]\nfiles = ['files_prod']\n[policy]\nversion = 2\n[[policy.tool]]\nname = 'mcp/files/read'\ndelta = {}";
        let response = run(request(
            policy,
            &[("alias.appa", "mcp/files_prod/read {}\nexpect allow")],
        ))
        .await;
        assert_eq!(response.files[0].status, Status::Passed);
    }

    #[tokio::test]
    async fn model_annotators_and_remedy_parties_are_refused_without_dispatch() {
        for extra in [
            "\n[[policy.annotator]]\nname = 'model'\nbuiltin = 'claude-code'\n",
            "\n[externals.authorities.remote]\nurl = 'https://example.test/authority'\n",
            "\n[externals.authorities.remote]\ncommand = ['touch', '/tmp/forbidden-replay']\n",
        ] {
            let response = run(request(
                &format!("{POLICY}{extra}"),
                &[("safe.appa", "mcp/files/read {}\nexpect allow")],
            ))
            .await;
            assert_eq!(response.files[0].status, Status::CannotRun);
            assert!(response.files[0].steps.is_empty());
        }
    }

    const NOOP_URL: &str = "http://127.0.0.1:9/api/guardrails-policy/annotators/noop";

    /// The default policy's shape: a catch-all routed to the host's no-op endpoint, one
    /// tool labelled by the `archestra` model builtin, and an audience source on the
    /// helper bridge that reads a host token.
    fn annotated_policy(noop_url: &str) -> String {
        format!(
            "[policy]\nversion = 2\n\n[policy.audience]\ninternal = ['org:members']\n\n[[policy.annotator]]\nname = 'noop'\n\n[[policy.annotator]]\nname = 'run-command'\nbuiltin = 'archestra'\nranks = ['suspicious', 'trusted']\nmarks = []\neffects = []\n\n[[policy.tool]]\nname = 'files__read'\ndelta = {{ trust = 'suspicious' }}\n\n[[policy.tool]]\nname = 'mail__send'\ndelta = {{}}\nrequires = {{ trust = 'trusted' }}\n\n[[policy.tool]]\nname = 'shell__run_command'\nannotator = 'run-command'\n\n[[policy.tool]]\nname = 'files__internal'\ndelta = {{ audience = ['internal'] }}\n\n[[policy.tool]]\nname = 'notes__share'\ndelta = {{}}\nrequires = {{ audience = {{ contains = ['@org:user/bob'] }} }}\n\n[[policy.tool]]\nname = '*'\nannotator = 'noop'\n\n[externals.annotators.noop]\nurl = '{noop_url}'\n\n[externals.audience.org]\nurl = 'http://127.0.0.1:9/helpers/org'\ntoken_env = 'APPA_ARCHESTRA_BRIDGE_TOKEN'\nselectors = [{{ template = 'members', feeds = 'internal' }}, {{ template = 'user/<user>' }}]\n"
        )
    }

    fn annotated_request(policy: &str, files: &[(&str, &str)]) -> Request {
        Request::parse(
            &serde_json::json!({
                "content": policy,
                "files": files.iter().map(|(path, content)| serde_json::json!({"path": path, "content": content})).collect::<Vec<_>>(),
                "noopAnnotator": {
                    "url": NOOP_URL,
                    "response": {"version": 1, "answer": {"delta": {}, "requires": {"history": [], "attention": []}, "emits": []}},
                },
            })
            .to_string(),
        )
        .expect("bounded request")
    }

    #[tokio::test]
    async fn the_host_noop_annotator_answers_offline_and_decisions_are_real() {
        let response = run(annotated_request(
            &annotated_policy(NOOP_URL),
            &[
                (
                    "pass.appa",
                    "mcp/notes/list {}\nexpect allow\nmcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny",
                ),
                ("fail.appa", "mcp/notes/list {}\nexpect deny"),
            ],
        ))
        .await;
        assert_eq!(
            response.files[0].status,
            Status::Passed,
            "{:?}",
            response.files[0]
                .steps
                .iter()
                .map(|step| &step.error)
                .collect::<Vec<_>>()
        );
        assert_eq!(response.files[0].steps.len(), 3);
        assert_eq!(response.files[1].status, Status::Failed);
        assert_eq!(response.files[1].steps[0].actual.as_deref(), Some("allow"));
    }

    #[tokio::test]
    async fn an_unanswered_annotator_stops_its_file_at_the_step_that_needs_it() {
        for expect in ["allow", "deny"] {
            let response = run(annotated_request(
                &annotated_policy(NOOP_URL),
                &[(
                    "model.appa",
                    &format!("mcp/notes/list {{}}\nexpect allow\nmcp/shell/run_command {{}}\nexpect {expect}\nmcp/notes/list {{}}\nexpect allow"),
                )],
            ))
            .await;
            let file = &response.files[0];
            assert_eq!(file.status, Status::CannotRun);
            assert_eq!(file.error, None);
            assert_eq!(
                file.steps
                    .iter()
                    .map(|step| step.status)
                    .collect::<Vec<_>>(),
                [Status::Passed, Status::CannotRun]
            );
            assert_eq!(file.steps[1].line, 3);
            assert_eq!(file.steps[1].actual, None);
        }
    }

    #[tokio::test]
    async fn a_check_needing_audience_members_cannot_run_offline() {
        let statuses = |response: &Response| {
            response.files[0]
                .steps
                .iter()
                .map(|step| (step.line, step.status))
                .collect::<Vec<_>>()
        };
        for expect in ["allow", "deny"] {
            let response = run(annotated_request(
                &annotated_policy(NOOP_URL),
                &[(
                    "audience.appa",
                    &format!("mcp/notes/share {{}}\nexpect allow\nmcp/files/internal {{}}\nexpect allow\nmcp/notes/share {{}}\nexpect {expect}\nmcp/notes/list {{}}\nexpect allow"),
                )],
            ))
            .await;
            assert_eq!(response.files[0].status, Status::CannotRun);
            assert_eq!(
                statuses(&response),
                [
                    (1, Status::Passed),
                    (3, Status::Passed),
                    (5, Status::CannotRun)
                ]
            );
        }
        // A denial earlier in the file may be the unanswered one: replay stops there.
        let response = run(annotated_request(
            &annotated_policy(NOOP_URL),
            &[(
                "earlier-deny.appa",
                "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\nmcp/files/internal {}\nexpect allow\nmcp/notes/share {}\nexpect deny",
            )],
        ))
        .await;
        assert_eq!(
            statuses(&response),
            [(1, Status::Passed), (3, Status::CannotRun)]
        );
    }

    #[tokio::test]
    async fn an_annotator_named_noop_elsewhere_is_not_the_host_noop() {
        for request in [
            annotated_request(
                &annotated_policy("http://127.0.0.1:9/elsewhere"),
                &[("other.appa", "mcp/notes/list {}\nexpect allow")],
            ),
            request(
                &annotated_policy(NOOP_URL),
                &[("unsupplied.appa", "mcp/notes/list {}\nexpect allow")],
            ),
            annotated_request(
                &annotated_policy(NOOP_URL).replace(
                    &format!("url = '{NOOP_URL}'"),
                    &format!("url = '{NOOP_URL}'\ntoken_env = 'APPA_NOOP_TOKEN'"),
                ),
                &[("credential.appa", "mcp/notes/list {}\nexpect allow")],
            ),
        ] {
            let response = run(request).await;
            assert_eq!(response.files[0].status, Status::CannotRun);
            assert_eq!(response.files[0].steps.len(), 1);
            assert_eq!(response.files[0].steps[0].status, Status::CannotRun);
        }
    }

    #[tokio::test]
    async fn empty_and_malformed_files_are_not_passing_tests() {
        let response = run(request(
            POLICY,
            &[
                ("empty.appa", "# no checks"),
                ("broken.appa", "files__read {}\nexpect allow"),
            ],
        ))
        .await;
        assert!(
            response
                .files
                .iter()
                .all(|file| file.status == Status::CannotRun)
        );
        assert!(
            response.files[1]
                .error
                .as_ref()
                .expect("syntax error")
                .contains(":1:")
        );
    }

    #[tokio::test]
    async fn other_hosts_and_agent_names_cannot_bypass_archestra_call_derivation() {
        let policy = "[policy]\nversion = 2\n[[policy.tool]]\nname = '*'\ndelta = {}";
        let response = run(request(
            policy,
            &[
                ("other-host.appa", "host/shell/read {}\nexpect allow"),
                ("agent.appa", "agent/kagent/helper {}\nexpect allow"),
            ],
        ))
        .await;
        assert!(
            response
                .files
                .iter()
                .all(|file| file.status == Status::CannotRun)
        );
        assert!(response.files.iter().all(|file| file.steps.is_empty()));
    }

    #[test]
    fn duplicate_paths_and_unbounded_input_are_rejected() {
        for files in [
            serde_json::json!([{"path":"../unsafe.appa","content":""}]),
            serde_json::json!([{"path":"same.appa","content":""},{"path":"same.appa","content":""}]),
            serde_json::json!([{"path":"large.appa","content":"x".repeat(MAX_FILE_BYTES + 1)}]),
        ] {
            assert!(
                Request::parse(&serde_json::json!({"content":POLICY,"files":files}).to_string())
                    .is_err()
            );
        }
    }

    #[test]
    fn inspection_counts_steps_and_preserves_distinct_tool_order_without_a_policy() {
        let input = serde_json::json!({"files":[{"path":"scenario.appa","content":"mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\nmcp/files/read {}\nexpect allow"}]}).to_string();
        let response = inspect(&input).expect("valid scenario");
        assert_eq!(response.files[0].tools, ["mcp/files/read", "mcp/mail/send"]);
        assert_eq!(response.files[0].assertion_count, Some(3));
        assert_eq!(response.files[0].error, None);
    }

    #[test]
    fn inspection_does_not_report_partial_coverage_and_keeps_valid_empty_files() {
        let input = serde_json::json!({"files":[{"path":"broken.appa","content":"mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect maybe"},{"path":"empty.appa","content":"# no steps"},{"path":"other-host.appa","content":"host/shell/run {}\nexpect allow"}]}).to_string();
        let response = inspect(&input).expect("bounded request");
        assert!(response.files[0].tools.is_empty());
        assert_eq!(response.files[0].assertion_count, None);
        assert!(
            response.files[0]
                .error
                .as_ref()
                .expect("parse error")
                .contains(":4:")
        );
        assert_eq!(response.files[1].assertion_count, Some(0));
        assert!(response.files[1].tools.is_empty());
        assert_eq!(response.files[1].error, None);
        assert_eq!(response.files[2].tools, ["host/shell/run"]);
        assert_eq!(response.files[2].assertion_count, Some(1));
        assert!(
            inspect("{\"files\":[]}")
                .expect("empty collection")
                .files
                .is_empty()
        );
    }

    #[test]
    fn inspection_caps_utf8_bytes_and_file_count() {
        for files in [
            serde_json::json!([{"path":"large.appa","content":"é".repeat(32769)}]),
            serde_json::json!((0..33).map(|index| serde_json::json!({"path":format!("{index}.appa"),"content":""})).collect::<Vec<_>>()),
            serde_json::json!((0..9).map(|index| serde_json::json!({"path":format!("{index}.appa"),"content":"x".repeat(65536)})).collect::<Vec<_>>()),
        ] {
            assert!(inspect(&serde_json::json!({"files":files}).to_string()).is_err());
        }
    }
}
