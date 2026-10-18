//! Replay of host-supplied scenarios through OpenAPPA's parser and runner, as `appa replay`
//! runs them. The effective policy compiles the way a dispatch compiles it, with the
//! credential values the host resolved for it, so every annotator, context provider and
//! audience source it declares is consulted live: the host's own endpoints, battery
//! helpers, and model-backed annotators such as `archestra` or `jev`. No tool runs, and
//! every trajectory stays in memory. A consult that gives no answer ends its file
//! `cannot_run` at the first step that answer could have decided. As in `appa replay`,
//! every authority and sanitizer is answered in process: an authority approves and a
//! sanitizer returns the body unchanged, so a step that expects `hitl` takes the offer and
//! its file goes on. A policy naming an external authority or sanitizer is refused as a
//! whole.
use appa_runtime::{
    api::{ConsultRecord, ConsultRecorder, ExternalOutcome, ExternalRole, OfferKind, Runtime},
    config::{Config, HostDefaults, Implementation},
    replay::{self, Expect, Got, StepOutcome, Trace, TraceReport, Verdict},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use crate::deployments::HostCredentials;

pub(crate) const ENGINE_VERSION: &str =
    "672d62aef1b330a3dcf920cb1cb42e9ede74d0fc:archestra-live-v3";
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ASSERTIONS: usize = 1000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    content: String,
    files: Vec<File>,
    /// The credential values the host resolved for the policy, variable → value, as a
    /// dispatch carries them. Secrets: nothing here is logged or formatted.
    #[serde(default)]
    credentials: BTreeMap<String, String>,
    /// The capability the host's `archestra` annotator route resolves to whoever runs
    /// this replay, so its model calls are filed under that organization.
    #[serde(default)]
    annotator_context: Option<String>,
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

/// The runtime a replay runs on: the effective policy compiled as a dispatch compiles it,
/// over a log that lives in memory for the run.
fn replay_runtime(request: &Request, defaults: HostDefaults) -> Result<Replaying, String> {
    let credentials = HostCredentials::new(request.credentials.clone());
    let config = Config::hosted(&request.content, defaults, |var| credentials.lookup(var))
        .map_err(|error| format!("The effective policy cannot load: {error}"))?;
    let externals = &config.externals;
    let stock = |binding: &Implementation| matches!(binding, Implementation::Builtin(name) if matches!(name.as_str(), "approve" | "hitl" | "redact-email" | "redact-secrets"));
    if externals
        .authorities
        .values()
        .chain(externals.sanitizers.values())
        .any(|binding| !stock(binding))
    {
        return Err("Replay cannot run a policy with an external authority or sanitizer: replay takes every remedy it is offered, which would act through that party".into());
    }
    let unanswered = Arc::new(Unanswered::default());
    // The deployment `appa replay` runs, under the Archestra adapter: no person is asked,
    // since every authority and sanitizer is answered in process.
    let runtime =
        Runtime::open_in_memory_as(config.with_do_something(), None, crate::adapter::adapter())
            .map_err(|error| error.to_string())?
            .recording(unanswered.clone());
    let runtime = match &request.annotator_context {
        Some(context) => runtime.with_archestra_context(context.clone()),
        None => runtime,
    };
    Ok(Replaying {
        runtime,
        unanswered,
    })
}

struct Replaying {
    runtime: Runtime,
    unanswered: Arc<Unanswered>,
}

/// The audience sources that gave no answer, in order. An unanswered annotator refuses
/// its call, which the runner already reports as `cannot_run`; an unanswered context
/// provider leaves the annotator asked without its context. An unanswered
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
async fn replay_trace(replaying: &Replaying, trace: &Trace) -> Vec<FileResult> {
    let mark = replaying.unanswered.entries().len();
    let mut results: Vec<FileResult> = replay::run(&replaying.runtime, std::slice::from_ref(trace))
        .await
        .into_iter()
        .map(|report| result(trace, report))
        .collect();
    let Some(source) = replaying.unanswered.entries().get(mark).cloned() else {
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
                "audience source {source:?} gave no answer at or before this call, so replay cannot decide it"
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
    run_with(request, crate::policy::defaults()).await
}

/// [`run`] under `defaults`, the host settings a dispatch compiles with.
async fn run_with(request: Request, defaults: HostDefaults) -> Response {
    let replaying = replay_runtime(&request, defaults);
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
        } else if let Some(step) = trace.steps.iter().find(|step| {
            step.tool
                .canonical()
                .is_some_and(|tool| (crate::adapter::adapter().spell)(tool).is_none())
        }) {
            Err(format!(
                "Line {}: {} cannot be dispatched through the Archestra adapter",
                step.line, step.tool
            ))
        } else {
            replaying.as_ref().map_err(Clone::clone)
        };
        match runtime {
            // Sequential files cap work and memory; each unique path opens a fresh root.
            Ok(replaying) => files.extend(replay_trace(replaying, &trace).await),
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
    async fn archestra_mcp_aliases_resolve_under_the_production_adapter() {
        for table in ["[aliases.mcp]", "[server_aliases]"] {
            let policy = format!(
                "{table}\nfiles = ['files_prod']\n[policy]\nversion = 2\n[[policy.tool]]\nname = 'mcp/files/read'\ndelta = {{}}"
            );
            let response = run(request(
                &policy,
                &[("alias.appa", "mcp/files_prod/read {}\nexpect allow")],
            ))
            .await;
            assert_eq!(response.files[0].status, Status::Passed, "{table}");
        }
    }

    #[tokio::test]
    async fn a_host_alias_rebinds_another_hosts_rules_onto_archestra_built_ins_only() {
        let policy = "[aliases.host]\nclaude-code = ['archestra']\n[policy]\nversion = 2\n[[policy.tool]]\nname = 'host/claude-code/Bash(command:*rm -rf*)'\ndelta = {}\nrequires = { attention = ['blocked'] }\n[[policy.tool]]\nname = 'mcp/claude-code/Bash'\ndelta = {}";
        let response = run(request(
            policy,
            &[
                (
                    "built-in.appa",
                    "host/archestra/Bash {\n  command: \"rm -rf /\"\n}\nexpect deny",
                ),
                (
                    "mcp.appa",
                    "mcp/claude-code/Bash {\n  command: \"rm -rf /\"\n}\nexpect allow",
                ),
            ],
        ))
        .await;
        assert!(
            response
                .files
                .iter()
                .all(|file| file.status == Status::Passed),
            "{:?}",
            response
                .files
                .iter()
                .map(|file| (&file.path, &file.status, &file.error))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn external_remedy_parties_are_refused_without_dispatch() {
        for extra in [
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

    /// A call that lowers trust, then one that needs `trusted`: the block offers `hitl`,
    /// which replay answers in process, so the expectation passes and the file goes on.
    #[tokio::test]
    async fn an_expected_hitl_offer_is_taken_as_approved_and_the_file_goes_on() {
        let policy = format!(
            "{POLICY}\n[[policy.authority]]\nname = 'hitl'\n\n[policy.authority.permits]\ntrust_below = 'trusted'\n\n[externals.authorities.hitl]\nbuiltin = 'hitl'\n"
        );
        let response = run(request(
            &policy,
            &[
                (
                    "review.appa",
                    "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect authority hitl\nmcp/files/read {}\nexpect allow",
                ),
                (
                    "deny.appa",
                    "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny",
                ),
            ],
        ))
        .await;
        let review = &response.files[0];
        assert_eq!(
            review.status,
            Status::Passed,
            "{:?}",
            review
                .steps
                .iter()
                .map(|step| &step.error)
                .collect::<Vec<_>>()
        );
        assert_eq!(review.steps.len(), 3);
        assert_eq!(review.steps[1].actual.as_deref(), Some("authority hitl"));
        // An offered review is not a plain refusal.
        assert_eq!(response.files[1].status, Status::Failed);
        assert_eq!(
            response.files[1].steps[1].actual.as_deref(),
            Some("authority hitl")
        );
    }

    /// A consult endpoint on loopback: the no-op path answers with the host's no-op
    /// annotation, every other path with 503. Each request's head is kept.
    struct Consults {
        base: String,
        heads: Arc<Mutex<Vec<String>>>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for Consults {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    const NOOP_PATH: &str = "/api/guardrails-policy/annotators/noop";
    const NOOP_ANSWER: &str = "{\"version\":1,\"answer\":{\"delta\":{},\"requires\":{\"history\":[],\"attention\":[]},\"emits\":[]}}";

    impl Consults {
        async fn start() -> Self {
            // The helper bridge bearer the host publishes; the policy tests set the same.
            unsafe { std::env::set_var("APPA_ARCHESTRA_BRIDGE_TOKEN", "bridge-token") };
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("a loopback port");
            let base = format!("http://{}", listener.local_addr().expect("bound"));
            let heads = Arc::new(Mutex::new(Vec::new()));
            let seen = heads.clone();
            let server = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    tokio::spawn(answer(stream, seen.clone()));
                }
            });
            Self {
                base,
                heads,
                server,
            }
        }

        fn noop_url(&self) -> String {
            format!("{}{NOOP_PATH}", self.base)
        }

        /// The settings a dispatch compiles with, the `archestra` builtin served here.
        fn defaults(&self) -> HostDefaults {
            HostDefaults {
                archestra: Some(appa_runtime::config::ArchestraEndpoint::new(
                    format!("{}/archestra", self.base),
                    "bridge".into(),
                )),
                ..HostDefaults::new(
                    crate::policy::CONSULT_TIMEOUT,
                    crate::policy::host_max_body_bytes(),
                )
            }
        }

        fn heads(&self) -> Vec<String> {
            self.heads.lock().unwrap().clone()
        }
    }

    async fn answer(mut stream: tokio::net::TcpStream, heads: Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut request = Vec::new();
        let mut chunk = [0u8; 8192];
        let head = loop {
            if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
            }
        };
        let head_text = String::from_utf8_lossy(&request[..head]).into_owned();
        let length = head_text
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while request.len() < head + length {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => request.extend_from_slice(&chunk[..read]),
            }
        }
        let response = match head_text.split_whitespace().nth(1) {
            Some(NOOP_PATH) => format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{NOOP_ANSWER}",
                NOOP_ANSWER.len()
            ),
            _ => {
                "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_string()
            }
        };
        heads.lock().unwrap().push(head_text);
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    /// The default policy's shape: a catch-all routed to the host's no-op endpoint, one
    /// tool labelled by the `archestra` model builtin, and an audience source on the
    /// helper bridge that reads a host token.
    fn annotated_policy(noop_url: &str) -> String {
        format!(
            "[policy]\nversion = 2\n\n[policy.audience]\ninternal = ['org:members']\n\n[[policy.annotator]]\nname = 'noop'\n\n[[policy.annotator]]\nname = 'run-command'\nbuiltin = 'archestra'\nranks = ['suspicious', 'trusted']\nmarks = []\neffects = []\n\n[[policy.tool]]\nname = 'files__read'\ndelta = {{ trust = 'suspicious' }}\n\n[[policy.tool]]\nname = 'mail__send'\ndelta = {{}}\nrequires = {{ trust = 'trusted' }}\n\n[[policy.tool]]\nname = 'shell__run_command'\nannotator = 'run-command'\n\n[[policy.tool]]\nname = 'files__internal'\ndelta = {{ audience = ['internal'] }}\n\n[[policy.tool]]\nname = 'notes__share'\ndelta = {{}}\nrequires = {{ audience = {{ contains = ['@org:user/bob'] }} }}\n\n[[policy.tool]]\nname = '*'\nannotator = 'noop'\n\n[externals.annotators.noop]\nurl = '{noop_url}'\n\n[externals.audience.org]\nurl = 'http://127.0.0.1:9/helpers/org'\ntoken_env = 'APPA_ARCHESTRA_BRIDGE_TOKEN'\nselectors = [{{ template = 'members', feeds = 'internal' }}, {{ template = 'user/<user>' }}]\n"
        )
    }

    fn live_request(policy: &str, files: &[(&str, &str)], extra: serde_json::Value) -> Request {
        let mut input = serde_json::json!({
            "content": policy,
            "files": files.iter().map(|(path, content)| serde_json::json!({"path": path, "content": content})).collect::<Vec<_>>(),
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        Request::parse(&input.to_string()).expect("bounded request")
    }

    #[tokio::test]
    async fn the_host_noop_annotator_is_consulted_and_decisions_are_real() {
        let consults = Consults::start().await;
        let response = run_with(
            live_request(
                &annotated_policy(&consults.noop_url()),
                &[
                    (
                        "pass.appa",
                        "mcp/notes/list {}\nexpect allow\nmcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny",
                    ),
                    ("fail.appa", "mcp/notes/list {}\nexpect deny"),
                ],
                serde_json::json!({}),
            ),
            consults.defaults(),
        )
        .await;
        assert_eq!(
            response.files[0].status,
            Status::Passed,
            "{:?} {:?}",
            response.files[0].error,
            response.files[0]
                .steps
                .iter()
                .map(|step| &step.error)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            response.files[0].steps.len(),
            3,
            "{:?}",
            response.files[0].error
        );
        assert_eq!(response.files[1].status, Status::Failed);
        assert_eq!(response.files[1].steps[0].actual.as_deref(), Some("allow"));
        assert!(
            consults
                .heads()
                .iter()
                .any(|head| head.starts_with(&format!("POST {NOOP_PATH} ")))
        );
    }

    #[tokio::test]
    async fn the_archestra_annotator_is_asked_live_under_the_replay_context() {
        let consults = Consults::start().await;
        let response = run_with(
            live_request(
                &annotated_policy(&consults.noop_url()),
                &[(
                    "model.appa",
                    "mcp/notes/list {}\nexpect allow\nmcp/shell/run_command {}\nexpect allow\nmcp/notes/list {}\nexpect allow",
                )],
                serde_json::json!({"annotatorContext": "replay-token"}),
            ),
            consults.defaults(),
        )
        .await;
        let file = &response.files[0];
        // The endpoint answered 503: the step it decides cannot run and ends the file.
        assert_eq!(file.status, Status::CannotRun);
        assert_eq!(
            file.steps
                .iter()
                .map(|step| (step.line, step.status))
                .collect::<Vec<_>>(),
            [(1, Status::Passed), (3, Status::CannotRun)]
        );
        let asked: Vec<String> = consults
            .heads()
            .into_iter()
            .filter(|head| head.starts_with("POST /archestra "))
            .collect();
        assert!(!asked.is_empty());
        assert!(asked.iter().all(|head| {
            head.to_ascii_lowercase()
                .contains("x-archestra-openappa-context: replay-token")
        }));
    }

    #[tokio::test]
    async fn a_model_annotator_is_consulted_instead_of_refusing_the_run() {
        let consults = Consults::start().await;
        let policy = format!(
            "{}\n[[policy.annotator]]\nname = 'classifier'\nbuiltin = 'jev'\nranks = ['suspicious', 'trusted']\naudiences = ['self', 'internal']\nmarks = []\neffects = []\n\n[externals.jev]\ntoken_env = 'APPA_PROVIDER_JEV_API_KEY'\n",
            annotated_policy(&consults.noop_url()).replace(
                "name = 'shell__run_command'\nannotator = 'run-command'",
                "name = 'shell__run_command'\nannotator = 'classifier'",
            )
        );
        // The classifier asks this endpoint, with the key the host resolved, in place of
        // TypeSafe's; it answers 503, so the step it decides cannot run.
        unsafe {
            std::env::set_var(
                "APPA_PROVIDER_JEV_API_URL",
                format!("{}/jev", consults.base),
            )
        };
        let response = run_with(
            live_request(
                &policy,
                &[
                    ("plain.appa", "mcp/notes/list {}\nexpect allow"),
                    (
                        "classified.appa",
                        "mcp/notes/list {}\nexpect allow\nmcp/shell/run_command {}\nexpect allow",
                    ),
                ],
                serde_json::json!({"credentials": {"APPA_PROVIDER_JEV_API_KEY": "jev-key"}}),
            ),
            consults.defaults(),
        )
        .await;
        assert_eq!(
            response.files[0].status,
            Status::Passed,
            "{:?}",
            response.files[0].error
        );
        assert_eq!(response.files[1].status, Status::CannotRun);
        assert_eq!(response.files[1].error, None);
        assert_eq!(
            response.files[1]
                .steps
                .iter()
                .map(|step| step.status)
                .collect::<Vec<_>>(),
            [Status::Passed, Status::CannotRun]
        );
        let asked: Vec<String> = consults
            .heads()
            .into_iter()
            .filter(|head| head.starts_with("POST /jev "))
            .collect();
        assert!(!asked.is_empty());
        assert!(asked.iter().all(|head| head.contains("jev-key")));
    }

    #[tokio::test]
    async fn a_check_needing_audience_members_cannot_run_without_an_answer() {
        let consults = Consults::start().await;
        let statuses = |response: &Response| {
            response.files[0]
                .steps
                .iter()
                .map(|step| (step.line, step.status))
                .collect::<Vec<_>>()
        };
        for expect in ["allow", "deny"] {
            let response = run_with(
                live_request(
                    &annotated_policy(&consults.noop_url()),
                    &[(
                        "audience.appa",
                        &format!("mcp/notes/share {{}}\nexpect allow\nmcp/files/internal {{}}\nexpect allow\nmcp/notes/share {{}}\nexpect {expect}\nmcp/notes/list {{}}\nexpect allow"),
                    )],
                    serde_json::json!({}),
                ),
                consults.defaults(),
            )
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
        let response = run_with(
            live_request(
                &annotated_policy(&consults.noop_url()),
                &[(
                    "earlier-deny.appa",
                    "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\nmcp/files/internal {}\nexpect allow\nmcp/notes/share {}\nexpect deny",
                )],
                serde_json::json!({}),
            ),
            consults.defaults(),
        )
        .await;
        assert_eq!(
            statuses(&response),
            [(1, Status::Passed), (3, Status::CannotRun)]
        );
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
