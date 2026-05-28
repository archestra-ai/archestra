use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use dagger_sdk::{Container, ContainerWithExecOpts, DaggerConn, ReturnType};
use tracing::Span;

use crate::session::{ArtifactRequest, RunRequest, Session};
use crate::{
    ARTIFACT_NOT_FOUND_EXIT_CODE, ARTIFACT_TOO_LARGE_EXIT_CODE, ArtifactBytes, CommandExecution,
    Limits, Result, SKILL_SANDBOX_ROOT, SKILL_SANDBOX_USER, SandboxError, SnapshotFile,
    TIMEOUT_EXIT_CODE, tracing_ctx, validate_artifact_path, validate_cwd, wrap_with_timeout,
};

pub(crate) async fn execute_run(
    session: Arc<Session>,
    req: RunRequest,
) -> Result<CommandExecution> {
    attach_trace(req.traceparent.as_deref());
    validate_cwd(&req.cwd)?;

    let warm = session.ensure_warm().await?;
    let started = Instant::now();
    let materialized = materialize(session.client(), warm, &req).await?;

    let wrapped = wrap_with_timeout(&req.command, req.timeout_seconds, &req.limits);
    let executed = materialized.with_workdir(&req.cwd).with_exec_opts(
        vec!["bash".to_string(), "-c".to_string(), wrapped],
        any_exit_opts(),
    );

    // dagger-sdk returns stdout/stderr as Strings, so non-UTF-8 bytes are
    // lossily decoded at the GraphQL layer. for binary output the command
    // should redirect to a file and use the artifact-read path (base64-safe).
    let stdout_raw = executed.stdout().await.map_err(SandboxError::from_sdk)?;
    let stderr_raw = executed.stderr().await.map_err(SandboxError::from_sdk)?;
    let raw_exit = executed.exit_code().await.map_err(SandboxError::from_sdk)? as i32;
    let stdout = crate::truncate_output(&stdout_raw, output_limit(&req.limits));
    let stderr = crate::truncate_output(&stderr_raw, output_limit(&req.limits));

    let timed_out = raw_exit == TIMEOUT_EXIT_CODE;
    let exit_code = raw_exit;

    Ok(CommandExecution {
        stdout: stdout.value,
        stderr: stderr.value,
        exit_code,
        duration_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
        timed_out,
        truncated: stdout.truncated || stderr.truncated,
    })
}

pub(crate) async fn execute_read_artifact(
    session: Arc<Session>,
    req: ArtifactRequest,
) -> Result<ArtifactBytes> {
    attach_trace(req.traceparent.as_deref());
    validate_artifact_path(&req.path)?;

    let warm = session.ensure_warm().await?;
    // replay must use the same cwd as the original run, otherwise commands
    // recorded with `cwd: None` materialise in the wrong directory and
    // subsequent artifact reads can't find their files. pythonpath forwards
    // for the same reason: replayed `python` invocations need the same module
    // search path as the live ones.
    let run = RunRequest {
        snapshots: req.snapshots,
        replay_commands: req.replay_commands,
        limits: req.limits.clone(),
        command: String::new(),
        cwd: req.default_cwd,
        timeout_seconds: 0,
        traceparent: None,
        pythonpath: req.pythonpath,
    };
    let materialized = materialize(session.client(), warm, &run).await?;
    let bytes_limit = u64::from(req.limits.file_size_limit_bytes);
    let command = format!(
        "[ -e {path} ] || {{ echo 'artifact not found: {path}' >&2; exit {not_found}; }}; _s=$(stat -c '%s' {path}) && [ \"$_s\" -le {limit} ] || {{ echo 'artifact is too large' >&2; exit {too_large}; }}; base64 -w0 {path}",
        path = crate::shell_quote(&req.path),
        limit = bytes_limit,
        not_found = ARTIFACT_NOT_FOUND_EXIT_CODE,
        too_large = ARTIFACT_TOO_LARGE_EXIT_CODE,
    );
    let encoder = materialized.with_exec_opts(
        vec!["bash".to_string(), "-c".to_string(), command],
        any_exit_opts(),
    );

    let base64_stdout = encoder.stdout().await.map_err(SandboxError::from_sdk)?;
    let exit_code = encoder.exit_code().await.map_err(SandboxError::from_sdk)?;
    let stderr = encoder.stderr().await.map_err(SandboxError::from_sdk)?;

    match exit_code {
        0 => {}
        ARTIFACT_NOT_FOUND_EXIT_CODE => {
            let message =
                crate::format_artifact_error("failed to read artifact", &req.path, &stderr);
            return Err(SandboxError::ArtifactNotFound {
                path: req.path,
                message,
            });
        }
        ARTIFACT_TOO_LARGE_EXIT_CODE => {
            let message =
                crate::format_artifact_error("failed to read artifact", &req.path, &stderr);
            return Err(SandboxError::ArtifactTooLarge {
                path: req.path,
                message,
            });
        }
        other => {
            return Err(SandboxError::Internal(format!(
                "failed to read artifact at {}: {}",
                req.path,
                if stderr.trim().is_empty() {
                    format!("exit {other}")
                } else {
                    stderr.trim().to_string()
                }
            )));
        }
    }

    let data_base64 = base64_stdout.trim().to_string();
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| SandboxError::internal(format!("failed to decode artifact bytes: {e}")))?;
    let size_bytes = data.len().min(u32::MAX as usize) as u32;
    Ok(ArtifactBytes {
        data_base64,
        size_bytes,
    })
}

pub(crate) async fn execute_check_session(
    session: Arc<Session>,
    traceparent: Option<String>,
) -> Result<()> {
    attach_trace(traceparent.as_deref());
    // ensure_warm covers the engine-reachable + base-image-buildable invariant.
    let _ = session.ensure_warm().await?;
    Ok(())
}

async fn materialize(client: &DaggerConn, warm: Container, req: &RunRequest) -> Result<Container> {
    let mut container = warm;

    if !req.snapshots.is_empty() {
        let mut by_skill: BTreeMap<String, Vec<&SnapshotFile>> = BTreeMap::new();
        for f in &req.snapshots {
            by_skill.entry(f.skill_name.clone()).or_default().push(f);
        }
        for (skill_name, files) in by_skill {
            let root = crate::skill_root_path(&skill_name)?;
            for f in files {
                container = apply_snapshot_file(container, &root, f)?;
            }
        }
        // re-chown skill files; with_new_file writes as root.
        container = container
            .with_user("root")
            .with_exec(vec![
                "sh".to_string(),
                "-c".to_string(),
                format!("chown -R {SKILL_SANDBOX_USER} {SKILL_SANDBOX_ROOT}"),
            ])
            .with_user(SKILL_SANDBOX_USER);
    }

    if let Some(pythonpath) = &req.pythonpath {
        container = container.with_env_variable("PYTHONPATH", pythonpath);
    }

    // replay re-executes every prior command on each call: per-call cost is
    // O(history). we lean on Dagger's content-addressed layer cache to keep
    // the wall-clock cost near-zero when the prefix is unchanged. if cache
    // misses become a real concern, key a per-sandbox materialised container
    // off the log hash and replay only the new delta.
    for entry in &req.replay_commands {
        // replay cwds are historical data: they were validated when first
        // accepted and trusting them here keeps pre-existing sandboxes with
        // legacy cwds usable. Live `req.cwd` is validated at the entry points.
        // each command is wrapped with its own `with_workdir` so cwd switches
        // happen via Dagger's container layer (no shell `cd` needed).
        let cwd = entry.cwd.as_deref().unwrap_or(&req.cwd);
        let wrapped = wrap_with_timeout(&entry.command, entry.timeout_seconds, &req.limits);
        container = container.with_workdir(cwd).with_exec_opts(
            vec!["bash".to_string(), "-c".to_string(), wrapped],
            any_exit_opts(),
        );
    }

    let _ = client; // reserved for future host()-based bulk uploads
    Ok(container)
}

fn apply_snapshot_file(container: Container, root: &str, file: &SnapshotFile) -> Result<Container> {
    crate::validate_snapshot_file_path(&file.path)?;
    let target = format!("{root}/{}", file.path);
    match file.encoding.as_str() {
        "utf8" => Ok(container.with_new_file(target, &file.content)),
        "base64" => {
            let temp_path = format!("{target}.b64");
            let parent_dir = target
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(root);
            Ok(container
                .with_new_file(&temp_path, &file.content)
                .with_exec(vec![
                    "bash".to_string(),
                    "-c".to_string(),
                    format!(
                        "mkdir -p {} && base64 -d {} > {} && rm {}",
                        crate::shell_quote(parent_dir),
                        crate::shell_quote(&temp_path),
                        crate::shell_quote(&target),
                        crate::shell_quote(&temp_path),
                    ),
                ]))
        }
        other => Err(SandboxError::InvalidInput(format!(
            "unsupported snapshot encoding: {other}"
        ))),
    }
}

fn attach_trace(traceparent: Option<&str>) {
    let span = Span::current();
    tracing_ctx::attach_parent(&span, traceparent);
}

fn any_exit_opts<'a>() -> ContainerWithExecOpts<'a> {
    ContainerWithExecOpts {
        expect: Some(ReturnType::Any),
        expand: None,
        experimental_privileged_nesting: None,
        insecure_root_capabilities: None,
        no_init: None,
        redirect_stderr: None,
        redirect_stdin: None,
        redirect_stdout: None,
        stdin: None,
        use_entrypoint: None,
    }
}

fn output_limit(limits: &Limits) -> usize {
    limits.output_bytes_limit as usize
}
