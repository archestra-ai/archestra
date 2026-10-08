//! Offline replay of host-supplied scenarios through OpenAPPA's parser and runner.
//! The policy bytes are never rewritten. A deployment needing any live consult
//! is refused as a whole, including when its external is unused by a scenario.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::Runtime,
    config::{AudienceImplementation, Config, HostDefaults, Implementation},
    replay::{self, Got, StepOutcome, Trace, TraceReport, Verdict},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};

pub(crate) const ENGINE_VERSION: &str =
    "10aa0e09e32d8c6704bdb030dc3c66140bf81915:archestra-offline-v1";
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ASSERTIONS: usize = 1000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    content: String,
    files: Vec<File>,
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

/// No env lookup, secrets, modules, disk config, or production storage enters
/// replay. Inspect typed bindings before the runtime can dispatch any event.
fn offline_runtime(content: &str) -> Result<Runtime, String> {
    let document: toml::Table = toml::from_str(content)
        .map_err(|_| "The effective policy is not valid TOML".to_string())?;
    crate::policy::refuse_host_variables(&document)?;
    if document
        .get("externals")
        .and_then(|externals| externals.get("claude_code"))
        .is_some()
    {
        return Err("Offline replay cannot run a policy declaring a model process profile".into());
    }
    if document
        .get("policy")
        .and_then(|policy| policy.get("annotator"))
        .and_then(toml::Value::as_array)
        .is_some_and(|entries| !entries.is_empty())
    {
        return Err("Offline replay cannot run a policy declaring annotators; live annotation and model inference are disabled".into());
    }
    let config = Config::hosted(
        content,
        HostDefaults::new(Duration::from_secs(1), 65536),
        |_| None,
    )
    .map_err(|_| {
        "The effective policy cannot load without external credentials or services".to_string()
    })?;
    let externals = &config.externals;
    let stock = |binding: &Implementation| matches!(binding, Implementation::Builtin(name) if matches!(name.as_str(), "approve" | "redact-email" | "redact-secrets"));
    if !externals.annotators.is_empty()
        || !externals.context.is_empty()
        || externals.llm.is_some()
        || externals.jev.is_some()
        || externals
            .authorities
            .values()
            .chain(externals.sanitizers.values())
            .any(|binding| !stock(binding))
        || externals
            .audience
            .values()
            .any(|binding| !matches!(binding.implementation, AudienceImplementation::Readers(_)))
    {
        return Err("Offline replay cannot run a policy with external commands, URLs, model profiles, or live consults".into());
    }
    let store = Arc::new(LogStore::open(Backend::Memory).map_err(|error| error.to_string())?);
    Runtime::open_with_store_as(config, store, None, crate::adapter::adapter())
        .map_err(|error| error.to_string())
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
    let runtime = offline_runtime(&request.content);
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
            runtime.as_ref().map_err(Clone::clone)
        };
        match runtime {
            Ok(runtime) => {
                // Sequential files cap work and memory; each unique path opens a fresh root.
                for report in replay::run(runtime, std::slice::from_ref(&trace)).await {
                    files.push(result(&trace, report));
                }
            }
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
    async fn annotators_and_url_consults_are_refused_without_dispatch() {
        for extra in [
            "\n[[policy.annotator]]\nname = 'model'\nbuiltin = 'archestra'\n",
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
