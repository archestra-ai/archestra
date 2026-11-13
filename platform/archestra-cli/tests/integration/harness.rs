//! Helpers of the integration tests: a temp folder for each test, the run
//! loop of the client in a task, and the test MCP servers.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use archestra_cli::bridge::config::{CommandEntry, Config, McpConfig, ServerUrlEntry};
use archestra_cli::bridge::{
    Backoff, BridgeState, BridgeStatus, RunOptions, ServerState, SyncState, Timings,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::mock_control_plane::MockControlPlane;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// The Python of the test MCP servers: `python` on Windows (the installers
/// and `actions/setup-python` have no `python3` there), `python3` elsewhere.
pub const PYTHON: &str = if cfg!(windows) { "python" } else { "python3" };

/// Short waits, so that the tests are quick. The sync interval is long: a
/// test that is not about it gets no sync that it did not ask for.
pub fn timings() -> Timings {
    let backoff = Backoff {
        initial: Duration::from_millis(20),
        max: Duration::from_millis(100),
    };
    Timings {
        poll_wait: Duration::from_millis(500),
        poll_guard: Duration::from_secs(5),
        config_check_interval: Duration::from_millis(50),
        sync_interval: Duration::from_secs(3600),
        state_report_delay: Duration::from_millis(20),
        control_plane_backoff: backoff,
        mcp_server_backoff: backoff,
        initialize_timeout: Duration::from_secs(30),
    }
}

/// The folder of one test. Nothing of a test is outside it.
pub struct TestDir {
    dir: TempDir,
}

impl TestDir {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir(dir.path().join("root")).expect("root folder");
        Self { dir }
    }

    /// The root folder of the files MCP server.
    pub fn root(&self) -> PathBuf {
        self.dir.path().join("root")
    }

    pub fn config_path(&self) -> PathBuf {
        self.dir.path().join("config.yaml")
    }

    pub fn pid_file(&self) -> PathBuf {
        self.dir.path().join("server.pid")
    }

    /// The `command` of a config entry that starts the stdio test server on
    /// the root folder of this test.
    pub fn stdio_command(&self) -> String {
        format!(
            "{PYTHON} '{FIXTURES}/files_mcp_server.py' '{}' --pid-file '{}'",
            self.root().display(),
            self.pid_file().display()
        )
    }

    /// As [`Self::stdio_command`]. This server writes to stderr when it
    /// starts and for each request.
    pub fn stdio_command_with_log(&self) -> String {
        format!("{} --log-to-stderr", self.stdio_command())
    }
}

pub fn command_entry(channel: &str, command: &str) -> CommandEntry {
    CommandEntry {
        channel: channel.to_owned(),
        name: format!("{channel} name"),
        command: command.to_owned(),
        enabled: true,
    }
}

pub fn url_entry(channel: &str, url: &str) -> ServerUrlEntry {
    ServerUrlEntry {
        channel: channel.to_owned(),
        name: format!("{channel} name"),
        url: url.to_owned(),
        enabled: true,
    }
}

/// The run loop of the tunnel client, with no autostart.
/// Dropping it stops the client and its MCP servers.
pub struct Bridge {
    state: watch::Receiver<BridgeState>,
    task: JoinHandle<()>,
}

impl Bridge {
    /// Writes the config file of the test and starts the run loop on it, as
    /// after a start with no connection to Archestra: no sync was done.
    pub fn start(mock: &MockControlPlane, dir: &TestDir, mcp: McpConfig) -> Self {
        Self::start_with(mock, dir, mcp, timings())
    }

    pub fn start_with(
        mock: &MockControlPlane,
        dir: &TestDir,
        mcp: McpConfig,
        timings: Timings,
    ) -> Self {
        let config = Config {
            control_plane: mock.control_plane_config(),
            synced_at: None,
            mcp,
        };
        config.save(&dir.config_path()).expect("save the config");
        Self::run(RunOptions {
            config_path: dir.config_path(),
            control_plane: config.control_plane,
            timings,
            sync: SyncState::default(),
            update: None,
            auto_update: None,
        })
    }

    /// Starts the run loop on a config file that is there already.
    pub fn run(options: RunOptions) -> Self {
        let mut bridge = archestra_cli::bridge::Bridge::new(options);
        let state = bridge.state();
        let task = tokio::spawn(async move {
            bridge.run().await.expect("the run loop starts");
            // Keep the state open after the loop ends (signed out).
            std::future::pending::<()>().await;
        });
        Self { state, task }
    }

    pub fn state(&self) -> BridgeState {
        self.state.borrow().clone()
    }

    /// Waits until the state passes the check, and gives that state.
    pub async fn wait_for_state(
        &mut self,
        what: &str,
        check: impl FnMut(&BridgeState) -> bool,
    ) -> BridgeState {
        tokio::time::timeout(Duration::from_secs(30), self.state.wait_for(check))
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for the state: {what}"))
            .expect("the run loop is there")
            .clone()
    }

    pub async fn wait_for_status(&mut self, status: BridgeStatus) {
        self.wait_for_state("the status", |state| state.status == status)
            .await;
    }

    /// Waits until the MCP server of a channel has this state.
    pub async fn wait_for_server_state(&mut self, channel: &str, wanted: &ServerState) {
        self.wait_for_state(&format!("{channel} is {wanted:?}"), |state| {
            state
                .servers
                .iter()
                .any(|server| server.channel == channel && server.state == *wanted)
        })
        .await;
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The HTTP test server, started by the test (as a user starts an HTTP MCP
/// server on the device). Dropping it stops the server.
pub struct HttpFixture {
    pub port: u16,
    child: Child,
}

impl HttpFixture {
    pub fn start(root: &Path) -> Self {
        Self::start_on(root, free_port())
    }

    pub fn start_on(root: &Path, port: u16) -> Self {
        let child = Command::new(PYTHON)
            .arg(format!("{FIXTURES}/http_mcp_server.py"))
            .arg(root)
            .arg(port.to_string())
            .stdin(Stdio::null())
            .spawn()
            .expect("python starts");
        Self { port, child }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.local_addr().expect("address").port()
}

/// Reads the process id that the stdio test server wrote. Waits until the
/// file has an id that is not `previous`.
pub async fn server_pid(dir: &TestDir, previous: Option<u32>) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let pid = std::fs::read_to_string(dir.pid_file())
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok());
        if let Some(pid) = pid.filter(|pid| Some(*pid) != previous) {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for the pid file"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Runs a line of Python on a process id. Python is the only external
/// program that the tests use.
fn python_on_pid(code: &str, pid: u32) -> bool {
    Command::new(PYTHON)
        .args(["-c", code])
        .arg(pid.to_string())
        .stderr(Stdio::null())
        .status()
        .expect("python starts")
        .success()
}

/// Ends a process at once: SIGKILL, or `TerminateProcess` on Windows (which
/// `os.kill` calls for a signal that is not a Ctrl event).
pub fn kill(pid: u32) {
    let code = if cfg!(windows) {
        "import os, sys; os.kill(int(sys.argv[1]), 9)"
    } else {
        "import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGKILL)"
    };
    assert!(python_on_pid(code, pid), "kill {pid}");
}

/// Succeeds while a process has this id. Not `os.kill(pid, 0)` on Windows:
/// there it ends the process.
const IS_RUNNING: &str = if cfg!(windows) {
    "import ctypes, sys
kernel32 = ctypes.windll.kernel32
handle = kernel32.OpenProcess(0x00100000, False, int(sys.argv[1]))  # SYNCHRONIZE
if not handle:
    sys.exit(1)
running = kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
kernel32.CloseHandle(handle)
sys.exit(0 if running else 1)"
} else {
    "import os, sys; os.kill(int(sys.argv[1]), 0)"
};

/// Waits until no process has this id.
pub async fn wait_until_gone(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while python_on_pid(IS_RUNNING, pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the process {pid} still runs"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub fn tools_call(id: Value, tool: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    })
}

/// The text of a tool result in a response body of the client. Panics when
/// the body is not a successful tool result.
pub fn tool_text(response: &Value) -> &str {
    assert_eq!(
        response["resp_type"],
        json!("jsonrpc_response"),
        "{response}"
    );
    assert_eq!(response["resp_code"], json!(200), "{response}");
    let result = &response["resp_json"]["result"];
    assert_eq!(result["isError"], json!(false), "{response}");
    result["content"][0]["text"]
        .as_str()
        .expect("a text result")
}
