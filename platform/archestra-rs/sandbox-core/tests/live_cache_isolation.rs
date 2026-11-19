//! end-to-end check against a real Dagger engine. opt in with
//! `ARCHESTRA_SANDBOX_LIVE_TESTS=1` (needs Docker; the SDK downloads its CLI):
//! the engine's content-addressed cache must never serve one sandbox's command
//! result to another, nor a one-off run's result to a later one, while a
//! sandbox's own replay still reuses the layer its live run produced.

use std::time::{SystemTime, UNIX_EPOCH};

use sandbox_core::{Limits, ReplayCommand, ReplayEntry, RunSandboxInput};

// nanosecond clock: two real executions never print the same value.
const STAMP: &str = "date +%s%N | tee /home/sandbox/stamp";

#[tokio::test]
async fn equal_command_text_never_shares_a_cached_result() {
    if std::env::var_os("ARCHESTRA_SANDBOX_LIVE_TESTS").is_none() {
        eprintln!("skipped: set ARCHESTRA_SANDBOX_LIVE_TESTS=1 to run against Dagger");
        return;
    }
    // ids unique to this test run, so an engine cache warmed by an earlier run
    // of this test cannot satisfy them.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let first_id = format!("cache-a-{nonce}");

    // two fresh sandboxes run the same first command.
    let first = run(STAMP, Some(&first_id), Vec::new()).await;
    let second = run(STAMP, Some(&format!("cache-b-{nonce}")), Vec::new()).await;
    assert_ne!(
        first, second,
        "a second sandbox was served the first one's result"
    );

    // a run without a command id always executes.
    let once = run(STAMP, None, Vec::new()).await;
    let again = run(STAMP, None, Vec::new()).await;
    assert_ne!(once, again, "a one-off run was served from cache");

    // the first sandbox's next call replays its history: the replayed command
    // reuses the live run's layer instead of executing a second time.
    let history = vec![ReplayEntry {
        kind: "command".into(),
        command: Some(ReplayCommand {
            id: first_id,
            command: STAMP.into(),
            cwd: Some("/home/sandbox".into()),
            timeout_seconds: 30,
        }),
        file: None,
        skill_mount: None,
    }];
    let replayed = run("cat /home/sandbox/stamp", None, history).await;
    assert_eq!(replayed, first, "replay re-executed the history command");
}

async fn run(command: &str, command_id: Option<&str>, replay_entries: Vec<ReplayEntry>) -> String {
    let execution = sandbox_core::run_sandbox(RunSandboxInput {
        traceparent: None,
        replay_entries,
        limits: Limits {
            output_bytes_limit: 64 * 1024,
            file_size_limit_bytes: 1024 * 1024,
            cpu_seconds: 30,
            memory_bytes: 256 * 1024 * 1024,
        },
        command: command.into(),
        cwd: "/home/sandbox".into(),
        timeout_seconds: 30,
        environment: None,
        spool_root: None,
        secret_env: None,
        stdin: None,
        command_id: command_id.map(str::to_string),
    })
    .await
    .unwrap();
    assert_eq!(execution.exit_code, 0, "stderr: {}", execution.stderr);
    execution.stdout.trim().to_string()
}
