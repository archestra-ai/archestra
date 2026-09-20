//! end-to-end check against a real Dagger engine. opt in with
//! `ARCHESTRA_SANDBOX_LIVE_TESTS=1` (needs Docker; the SDK downloads its CLI):
//! the live command must see its stdin and its secret variable, while a
//! replayed command from history still materializes the same way.

use sandbox_core::{Limits, ReplayCommand, ReplayEntry, RunSandboxInput, SecretEnvVar};

const SECRET: &str = "s3cret-value-7f3a";
// `printf %s s3cret-value-7f3a | sha256sum`
const SECRET_SHA256: &str = "a9794f37712ef58f7758db8b2bbb0c207ee00a8c2cda0a8fb3d428868970e98a";

#[tokio::test]
async fn live_command_sees_stdin_and_secret_after_replayed_history() {
    if std::env::var_os("ARCHESTRA_SANDBOX_LIVE_TESTS").is_none() {
        eprintln!("skipped: set ARCHESTRA_SANDBOX_LIVE_TESTS=1 to run against Dagger");
        return;
    }
    let input = RunSandboxInput {
        traceparent: None,
        replay_entries: vec![ReplayEntry {
            kind: "command".into(),
            command: Some(ReplayCommand {
                command: "printf replayed > /home/sandbox/history.txt".into(),
                cwd: None,
                timeout_seconds: 30,
            }),
            file: None,
            skill_mount: None,
        }],
        limits: Limits {
            output_bytes_limit: 64 * 1024,
            file_size_limit_bytes: 1024 * 1024,
            cpu_seconds: 30,
            memory_bytes: 256 * 1024 * 1024,
        },
        command: "cat; printf ' '; cat /home/sandbox/history.txt; printf ' '; printf %s \"$TOK\" | sha256sum | cut -c1-64".into(),
        cwd: "/home/sandbox".into(),
        timeout_seconds: 60,
        environment: None,
        spool_root: None,
        secret_env: Some(vec![SecretEnvVar {
            name: "TOK".into(),
            value: SECRET.into(),
        }]),
        stdin: Some("hello".into()),
    };
    let execution = sandbox_core::run_sandbox(input).await.unwrap();
    assert_eq!(execution.exit_code, 0, "stderr: {}", execution.stderr);
    assert_eq!(
        execution.stdout.trim_end(),
        format!("hello replayed {SECRET_SHA256}")
    );
}
