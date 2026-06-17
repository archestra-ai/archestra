use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::fs;
use tokio::process::Command;
use tokio::time::{Duration, timeout};

use crate::config::types::Task;

const PYTEST_REQ: &str = "pytest==8.4.1";
const RESULT_NAME: &str = "result.json";
const OUTPUT_NAME: &str = "artifact.bin";
const STATE_NAME: &str = "state.json";
const FIXTURES_DIR: &str = "fixtures";
const RESULT_ENV: &str = "BENCH_RESULT";
const FIXTURES_ENV: &str = "BENCH_FIXTURES";
const OUTPUT_ENV: &str = "BENCH_OUTPUT";
const STATE_ENV: &str = "BENCH_STATE";

#[derive(Debug, Clone)]
pub struct VerifyOutcome {
    pub passed: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("uv is required to build the verifier environment but was not found")]
    UvMissing,
    #[error("failed to create verifier venv: {0}")]
    VenvCreationFailed(String),
    #[error("failed to install verifier deps {deps}: {message}")]
    DepInstallFailed { deps: String, message: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("task verifier {0} does not exist")]
    MissingVerifier(PathBuf),
}

pub async fn run_verifier(
    task: &Task,
    report_bytes: &[u8],
    artifact_bytes: Option<&[u8]>,
    state_bytes: Option<&[u8]>,
    timeout_s: f64,
) -> Result<VerifyOutcome, VerifyError> {
    let tmp = tempfile::tempdir().map_err(VerifyError::Io)?;
    let workdir = tmp.path().to_path_buf();

    let python = resolve_python(&task.verifier.deps, &workdir).await?;
    let (test_path, env) = stage(task, &workdir, report_bytes, artifact_bytes, state_bytes).await?;
    run_pytest(&test_path, env, &python, Duration::from_secs_f64(timeout_s)).await
}

async fn resolve_python(deps: &[String], workdir: &Path) -> Result<String, VerifyError> {
    // Always verify in an ephemeral uv env that installs pytest (plus any task deps). Unlike the
    // Python harness — which can fall back to its own pytest-bearing interpreter for no-dep tasks —
    // the Rust harness has no ambient interpreter guaranteed to have pytest, so a bare `python3`
    // would silently fail every `deps = []` task on hosts without pytest. uv is a hard requirement of
    // the eval host; a missing uv is a loud host error (UvMissing), never a task verdict.
    build_uv_env(deps, &workdir.join(".venv")).await
}

async fn build_uv_env(deps: &[String], venv_dir: &Path) -> Result<String, VerifyError> {
    let check = Command::new("uv").arg("--version").output().await;
    if check.is_err() || !check.unwrap().status.success() {
        return Err(VerifyError::UvMissing);
    }

    let create = Command::new("uv")
        .args([&"venv".to_string(), &venv_dir.to_string_lossy().to_string()])
        .output()
        .await?;
    if !create.status.success() {
        let message = String::from_utf8_lossy(&create.stderr).to_string();
        return Err(VerifyError::VenvCreationFailed(message));
    }

    let python = if cfg!(windows) {
        venv_dir.join("Scripts").join("python")
    } else {
        venv_dir.join("bin").join("python")
    };

    let mut install_args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        python.to_string_lossy().to_string(),
        PYTEST_REQ.to_string(),
    ];
    for dep in deps {
        install_args.push(dep.clone());
    }
    let install = Command::new("uv").args(&install_args).output().await?;
    if !install.status.success() {
        let message = String::from_utf8_lossy(&install.stderr).to_string();
        return Err(VerifyError::DepInstallFailed {
            deps: deps.join(", "),
            message,
        });
    }

    Ok(python.to_string_lossy().to_string())
}

async fn stage(
    task: &Task,
    workdir: &Path,
    report_bytes: &[u8],
    artifact_bytes: Option<&[u8]>,
    state_bytes: Option<&[u8]>,
) -> Result<(PathBuf, HashMap<String, String>), VerifyError> {
    let mut env: HashMap<String, String> = task
        .verifier
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let result_path = workdir.join(RESULT_NAME);
    fs::write(&result_path, report_bytes).await?;
    env.insert(
        RESULT_ENV.to_string(),
        result_path.to_string_lossy().to_string(),
    );

    let fixtures_root = workdir.join(FIXTURES_DIR);
    let mut staged_any = false;
    for (sub, source) in [
        ("inputs", task.inputs_dir()),
        ("expected", task.expected_dir()),
    ] {
        if source.is_dir() {
            let target = fixtures_root.join(sub);
            copy_dir(&source, &target).await?;
            staged_any = true;
        }
    }
    if staged_any {
        env.insert(
            FIXTURES_ENV.to_string(),
            fixtures_root.to_string_lossy().to_string(),
        );
    }

    if let Some(bytes) = artifact_bytes {
        let output_path = workdir.join(OUTPUT_NAME);
        fs::write(&output_path, bytes).await?;
        env.insert(
            OUTPUT_ENV.to_string(),
            output_path.to_string_lossy().to_string(),
        );
    }

    if let Some(bytes) = state_bytes {
        let state_path = workdir.join(STATE_NAME);
        fs::write(&state_path, bytes).await?;
        env.insert(
            STATE_ENV.to_string(),
            state_path.to_string_lossy().to_string(),
        );
    }

    let verifier_source = task.dir.join(&task.verifier.test_file);
    if !verifier_source.is_file() {
        return Err(VerifyError::MissingVerifier(verifier_source));
    }
    let test_path = workdir.join(Path::new(&task.verifier.test_file).file_name().unwrap());
    fs::copy(&verifier_source, &test_path).await?;

    Ok((test_path, env))
}

async fn copy_dir(source: &Path, target: &Path) -> Result<(), VerifyError> {
    fs::create_dir_all(target).await?;
    let mut entries = fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            Box::pin(copy_dir(&from, &to)).await?;
        } else {
            fs::copy(&from, &to).await?;
        }
    }
    Ok(())
}

async fn run_pytest(
    test_path: &Path,
    env: HashMap<String, String>,
    python: &str,
    timeout_duration: Duration,
) -> Result<VerifyOutcome, VerifyError> {
    let mut full_env = std::env::vars()
        .filter(|(k, _)| {
            k != "PYTHONPATH" && !k.starts_with("PYTEST") && !k.starts_with("COVERAGE")
        })
        .collect::<HashMap<_, _>>();
    full_env.extend(env);

    let mut cmd = Command::new(python);
    cmd.arg("-m")
        .arg("pytest")
        .arg(test_path)
        .arg("-rA")
        .current_dir(test_path.parent().unwrap_or_else(|| Path::new(".")))
        .envs(&full_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match timeout(timeout_duration, cmd.output()).await {
        Ok(Ok(output)) => Ok(VerifyOutcome {
            passed: output.status.success(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            timed_out: false,
        }),
        Ok(Err(e)) => Err(VerifyError::Io(e)),
        Err(_) => Ok(VerifyOutcome {
            passed: false,
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::types::{Stage, Verifier};

    fn make_task(tmp: &Path, test_file: &str, deps: Vec<String>) -> Task {
        Task {
            id: "t1".to_string(),
            dir: tmp.to_path_buf(),
            stages: vec![Stage {
                text: "go".to_string(),
                files: vec![],
            }],
            result_schema: serde_json::json!({"type": "object"}),
            verifier: Verifier {
                deps,
                test_file: test_file.to_string(),
                env: vec![],
            },
            artifact_key: None,
            max_format_attempts: 3,
            state_rest: vec![],
        }
    }

    #[tokio::test]
    async fn test_no_dep_verifier_passes() {
        if !uv_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let verifier = tmp.path().join("verifier.py");
        tokio::fs::write(&verifier, "def test_ok(): assert True\n")
            .await
            .unwrap();

        // deps = [] still gets pytest via uv (no ambient pytest assumed).
        let task = make_task(tmp.path(), "verifier.py", vec![]);
        let outcome = run_verifier(&task, b"{}", None, None, 120.0).await.unwrap();
        assert!(outcome.passed, "stderr: {}", outcome.stderr);
        assert!(!outcome.timed_out);
    }

    #[tokio::test]
    async fn test_no_dep_verifier_fails() {
        if !uv_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let verifier = tmp.path().join("verifier.py");
        tokio::fs::write(&verifier, "def test_bad(): assert False\n")
            .await
            .unwrap();

        let task = make_task(tmp.path(), "verifier.py", vec![]);
        let outcome = run_verifier(&task, b"{}", None, None, 120.0).await.unwrap();
        assert!(!outcome.passed);
    }

    fn uv_available() -> bool {
        std::process::Command::new("uv")
            .arg("--version")
            .output()
            .ok()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}
