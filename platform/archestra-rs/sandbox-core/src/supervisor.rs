//! the in-container command supervisor and its wire contract. backend-agnostic:
//! any container backend that bakes `ARCHESTRA_RUN_PY` into its image and runs
//! commands through `supervised_argv` gets the same json result format, which
//! `parse_supervisor_output` turns back into a `CommandExecution`.

use serde::Deserialize;

use crate::{CommandExecution, Limits, Result, SandboxError};

/// path of the command supervisor injected into the warm base via `with_new_file`.
/// it runs each user command under cpu/memory rlimits and a wall-clock timeout,
/// caps output, and emits a structured json result (see `ARCHESTRA_RUN_PY`).
pub(crate) const SUPERVISOR_PATH: &str = "/usr/local/bin/archestra_run";

const TRUNCATION_MARKER: &str = "\n...[output truncated]";

/// command supervisor written into the warm base at `SUPERVISOR_PATH`. runs
/// `bash -c <cmd>` in its own session under cpu (`RLIMIT_CPU`) and memory
/// (`RLIMIT_AS`) limits, enforces the wall-clock timeout by SIGKILLing the whole
/// process group, caps each output stream at `--out-cap` bytes, and prints a
/// single json result on stdout. kept as a const so it shows up verbatim in
/// build logs and updates with a napi rebuild rather than an image republish.
/// stdlib-only, so any python3 on the image can run it.
pub(crate) const ARCHESTRA_RUN_PY: &str = r##"#!/usr/bin/env python3
import json
import os
import resource
import signal
import subprocess
import sys
import threading
import time


def main():
    argv = sys.argv[1:]
    if "--" not in argv:
        sys.stderr.write("archestra_run: missing -- separator\n")
        return 2
    sep = argv.index("--")
    flags = argv[:sep]
    cmd = argv[sep + 1:]
    if len(flags) % 2 != 0:
        sys.stderr.write("archestra_run: malformed flags\n")
        return 2
    if not cmd:
        sys.stderr.write("archestra_run: empty command\n")
        return 2
    opts = {flags[i]: flags[i + 1] for i in range(0, len(flags), 2)}
    timeout = int(opts["--timeout"])
    cpu = int(opts["--cpu"])
    mem = int(opts["--mem"])
    cap = int(opts["--out-cap"])

    def preexec():
        os.setsid()
        if cpu > 0:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        if mem > 0:
            resource.setrlimit(resource.RLIMIT_AS, (mem, mem))

    streams = {}

    def drain(name, fp):
        buf = bytearray()
        total = 0
        while True:
            chunk = fp.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if len(buf) < cap:
                buf.extend(chunk[: cap - len(buf)])
        streams[name] = (bytes(buf), total > cap)

    start = time.monotonic()
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=preexec
    )
    out_thread = threading.Thread(target=drain, args=("out", proc.stdout))
    err_thread = threading.Thread(target=drain, args=("err", proc.stderr))
    out_thread.start()
    err_thread.start()

    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    out_thread.join()
    err_thread.join()
    duration_ms = int((time.monotonic() - start) * 1000)

    out_bytes, out_trunc = streams.get("out", (b"", False))
    err_bytes, err_trunc = streams.get("err", (b"", False))

    rc = proc.returncode
    if timed_out:
        exit_code = 124
    elif rc is not None and rc < 0:
        exit_code = 128 - rc
    else:
        exit_code = rc if rc is not None else 0

    json.dump(
        {
            "stdout": out_bytes.decode("utf-8", "replace"),
            "stderr": err_bytes.decode("utf-8", "replace"),
            "exitCode": exit_code,
            "timedOut": timed_out,
            "stdoutTruncated": out_trunc,
            "stderrTruncated": err_trunc,
            "durationMs": duration_ms,
        },
        sys.stdout,
    )
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
"##;

/// the json document the in-container supervisor prints on stdout. it owns
/// output capping, the wall-clock timeout, and exit-code normalisation, so the
/// host just deserialises it instead of scraping bash.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
    duration_ms: u32,
}

/// build the argv that runs `command` under the in-container supervisor
/// (`SUPERVISOR_PATH`). the supervisor sets cpu/memory rlimits, enforces the
/// wall-clock timeout by SIGKILLing the whole process group, caps each output
/// stream at `output_bytes_limit` bytes, and prints a json result on stdout.
/// the command itself is handed to `bash -c` so shell syntax still works; cwd
/// is applied separately via the backend (e.g. `Container::with_workdir`).
pub(crate) fn supervised_argv(command: &str, timeout_seconds: u32, limits: &Limits) -> Vec<String> {
    vec![
        "python3".to_string(),
        SUPERVISOR_PATH.to_string(),
        "--timeout".to_string(),
        timeout_seconds.to_string(),
        "--cpu".to_string(),
        limits.cpu_seconds.to_string(),
        "--mem".to_string(),
        limits.memory_bytes.to_string(),
        "--out-cap".to_string(),
        limits.output_bytes_limit.to_string(),
        "--".to_string(),
        "bash".to_string(),
        "-c".to_string(),
        command.to_string(),
    ]
}

/// parse the supervisor's json result into a `CommandExecution`, appending the
/// truncation marker to any stream the supervisor capped.
pub(crate) fn parse_supervisor_output(raw: &str) -> Result<CommandExecution> {
    let result: SupervisorResult = serde_json::from_str(raw.trim()).map_err(|e| {
        SandboxError::internal(format!("failed to parse command supervisor output: {e}"))
    })?;
    let truncated = result.stdout_truncated || result.stderr_truncated;
    Ok(CommandExecution {
        stdout: mark_truncated(result.stdout, result.stdout_truncated),
        stderr: mark_truncated(result.stderr, result.stderr_truncated),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        truncated,
    })
}

fn mark_truncated(value: String, truncated: bool) -> String {
    if truncated {
        format!("{value}{TRUNCATION_MARKER}")
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_argv_builds_supervisor_invocation() {
        let argv = supervised_argv(
            "python --version",
            30,
            &Limits {
                output_bytes_limit: 1024,
                file_size_limit_bytes: 16 * 1024 * 1024,
                cpu_seconds: 30,
                memory_bytes: 1024 * 1024 * 1024,
            },
        );
        assert_eq!(argv[0], "python3");
        assert_eq!(argv[1], SUPERVISOR_PATH);
        // limits are passed as explicit flags, not baked into a shell string.
        assert!(argv.contains(&"--timeout".to_string()));
        assert!(argv.contains(&"30".to_string()));
        assert!(argv.contains(&"--out-cap".to_string()));
        assert!(argv.contains(&"1024".to_string()));
        // the command is handed verbatim to `bash -c` after the `--` separator.
        let sep = argv
            .iter()
            .position(|a| a == "--")
            .expect("missing separator");
        assert_eq!(&argv[sep + 1..], ["bash", "-c", "python --version"]);
    }
}
