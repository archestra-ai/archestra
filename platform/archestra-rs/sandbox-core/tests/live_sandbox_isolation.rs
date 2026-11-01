//! end-to-end check against a real Dagger engine (#8662). opt in with
//! `ARCHESTRA_SANDBOX_LIVE_TESTS=1` (needs Docker): two sandboxes with the same
//! command history must each run their live command, never share a cached result.

use sandbox_core::{Limits, ReplayCommand, ReplayEntry, RunSandboxInput};

const TIMEOUT_SECONDS: u32 = 60;

fn limits() -> Limits {
    Limits {
        output_bytes_limit: 64 * 1024,
        file_size_limit_bytes: 1024 * 1024,
        cpu_seconds: 30,
        memory_bytes: 256 * 1024 * 1024,
    }
}

fn input(sandbox_key: Option<&str>, history: &[&str], command: &str) -> RunSandboxInput {
    RunSandboxInput {
        traceparent: None,
        replay_entries: history
            .iter()
            .map(|cmd| ReplayEntry {
                kind: "command".into(),
                command: Some(ReplayCommand {
                    command: (*cmd).into(),
                    cwd: None,
                    // same timeout as the live run below, as the platform records it
                    timeout_seconds: TIMEOUT_SECONDS,
                }),
                file: None,
                skill_mount: None,
            })
            .collect(),
        limits: limits(),
        command: command.into(),
        cwd: "/home/sandbox".into(),
        timeout_seconds: TIMEOUT_SECONDS,
        environment: None,
        spool_root: None,
        secret_env: None,
        stdin: None,
        sandbox_key: sandbox_key.map(Into::into),
    }
}

async fn run(sandbox_key: Option<&str>, history: &[&str], command: &str) -> String {
    let execution = sandbox_core::run_sandbox(input(sandbox_key, history, command))
        .await
        .unwrap();
    assert_eq!(execution.exit_code, 0, "stderr: {}", execution.stderr);
    execution.stdout.trim_end().to_string()
}

fn live() -> bool {
    if std::env::var_os("ARCHESTRA_SANDBOX_LIVE_TESTS").is_none() {
        eprintln!("skipped: set ARCHESTRA_SANDBOX_LIVE_TESTS=1 to run against Dagger");
        return false;
    }
    true
}

#[tokio::test]
async fn sandboxes_with_equal_history_do_not_share_live_results() {
    if !live() {
        return;
    }
    // a per-run nonce keeps reruns of this test from hitting an earlier run's cache.
    let nonce = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let a = format!("8662-a-{nonce}");
    let b = format!("8662-b-{nonce}");
    let cmd = format!("echo {nonce} >/dev/null; date -u +%T.%N");

    let first = run(Some(&a), &[], &cmd).await;
    let second = run(Some(&b), &[], &cmd).await;
    eprintln!("fresh sandboxes: a={first} b={second}");
    assert_ne!(
        first, second,
        "sandbox b was served sandbox a's cached result"
    );

    // same for a non-empty history: the replayed prefix is identical, the live
    // command must still run in each sandbox.
    let history = ["printf seeded > /home/sandbox/seed.txt"];
    let first = run(Some(&a), &history, &cmd).await;
    let second = run(Some(&b), &history, &cmd).await;
    eprintln!("equal history: a={first} b={second}");
    assert_ne!(
        first, second,
        "equal history shared a cached result across sandboxes"
    );
}

#[tokio::test]
async fn a_sandbox_replay_stays_cached_and_keeps_its_state() {
    if !live() {
        return;
    }
    let nonce = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let key = format!("8662-replay-{nonce}");
    // command 1 records its own output; replaying it must not run it again, so
    // the file keeps the value from the live run.
    let stamp = "date -u +%T.%N > /home/sandbox/stamp.txt; cat /home/sandbox/stamp.txt";
    let live_value = run(Some(&key), &[], stamp).await;
    let replayed = run(Some(&key), &[stamp], "cat /home/sandbox/stamp.txt").await;
    assert_eq!(
        live_value, replayed,
        "replaying history re-executed the earlier command"
    );
}
