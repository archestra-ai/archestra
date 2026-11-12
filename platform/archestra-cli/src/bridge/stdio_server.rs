//! One stdio MCP server: a child process with line-delimited JSON-RPC on its
//! stdin and stdout. The client starts it, does `initialize`, and starts it
//! again with a backoff when it stops.
//!
//! One task owns the process, its pipes, and the table of requests that wait
//! for an answer. Other tasks talk to it through the [`StdioHandle`].
//!
//! The client reads the stderr of the process: it keeps the last lines for
//! the user, and copies each line to its own stderr (the log file).

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tracing::{debug, info, warn};

use crate::bridge::Timings;
use crate::bridge::channels::{ForwardError, Forwarded};
use crate::bridge::command_line;
use crate::bridge::jsonrpc::{self, MessageKind};
use crate::bridge::process_tree::{self, ProcessTree};
use crate::bridge::state::ServerState;

/// Messages that wait for the server task. The task takes them at once, so a
/// small queue is enough.
const OUTBOUND_QUEUE: usize = 64;
/// The number of stderr lines that the client keeps for one MCP server.
const LOG_LINES: usize = 200;
/// A longer stderr line is cut to this number of characters.
const LOG_LINE_CHARS: usize = 2000;
/// How long the client waits for the exit status of a process that closed
/// its stdout.
const EXIT_WAIT: Duration = Duration::from_millis(500);
const STOPPED: &str = "the MCP server stopped";

#[derive(Debug, thiserror::Error)]
enum StartError {
    #[error("cannot start the program: {0}")]
    Spawn(std::io::Error),
    #[error("the program has no stdin or stdout pipe")]
    NoPipes,
    #[error("the MCP server closed before it answered `initialize`")]
    Closed,
    #[error("the MCP server answered `initialize` with an error: {0}")]
    Rejected(Value),
    #[error("the MCP server did not answer `initialize` in time")]
    Timeout,
}

enum Outbound {
    Request {
        message: Value,
        reply: oneshot::Sender<Value>,
    },
    Notification {
        message: Value,
    },
}

/// Where the process of a channel is in its life.
#[derive(Debug, Clone)]
enum Lifecycle {
    /// The process starts, or it runs and `initialize` has no answer yet.
    Starting,
    Running {
        /// The kept `InitializeResult`.
        initialize_result: Arc<Value>,
    },
    /// No process is in operation. The client starts one after the backoff.
    Failed { error: String },
}

/// The last lines that a stdio MCP server wrote to stderr.
///
/// It is shared: the tasks that read stderr add lines, and the handle of the
/// channel copies them out when Archestra asks for the log. A mutex is
/// enough for that: each use is short, and no use holds the lock across an
/// `.await`.
#[derive(Debug, Clone, Default)]
struct LogBuffer {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl LogBuffer {
    fn push(&self, line: String) {
        // A poisoned lock still has valid lines.
        let mut lines = self.lines.lock().unwrap_or_else(PoisonError::into_inner);
        if lines.len() == LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    fn lines(&self) -> Vec<String> {
        let lines = self.lines.lock().unwrap_or_else(PoisonError::into_inner);
        lines.iter().cloned().collect()
    }
}

/// The way to one stdio MCP server.
#[derive(Debug, Clone)]
pub(crate) struct StdioHandle {
    outbound: mpsc::Sender<Outbound>,
    lifecycle: watch::Receiver<Lifecycle>,
    log: LogBuffer,
}

impl StdioHandle {
    pub(crate) fn state(&self) -> ServerState {
        match &*self.lifecycle.borrow() {
            Lifecycle::Starting => ServerState::Starting,
            Lifecycle::Running { .. } => ServerState::Running,
            Lifecycle::Failed { error } => ServerState::Failed {
                error: error.clone(),
            },
        }
    }

    /// The kept `InitializeResult`; `None` while no process is in operation.
    pub(crate) fn initialize_result(&self) -> Option<Arc<Value>> {
        match &*self.lifecycle.borrow() {
            Lifecycle::Running { initialize_result } => Some(Arc::clone(initialize_result)),
            Lifecycle::Starting | Lifecycle::Failed { .. } => None,
        }
    }

    /// The last lines that the MCP server wrote to stderr, the oldest first.
    pub(crate) fn log_lines(&self) -> Vec<String> {
        self.log.lines()
    }

    pub(crate) async fn request(&self, message: Value) -> Result<Forwarded, ForwardError> {
        let (reply, answer) = oneshot::channel();
        self.outbound
            .send(Outbound::Request { message, reply })
            .await
            .map_err(|_| ForwardError::NotRunning)?;
        // The server task drops `reply` when the process is not in operation
        // or stops before it answers.
        let message = answer.await.map_err(|_| ForwardError::Closed)?;
        Ok(Forwarded {
            status: 200,
            message,
        })
    }

    pub(crate) async fn notify(&self, message: Value) -> Result<(), ForwardError> {
        self.outbound
            .send(Outbound::Notification { message })
            .await
            .map_err(|_| ForwardError::NotRunning)
    }
}

/// Makes the handle of a channel and the task that serves it. The task runs
/// until it is dropped; then the process is killed. `name` is the name of
/// the entry in the config file. The task tells `state_changed` each time
/// the state of the MCP server changes.
pub(crate) fn channel(
    channel: String,
    name: &str,
    argv: Vec<String>,
    timings: Timings,
    state_changed: Arc<Notify>,
) -> (StdioHandle, impl Future<Output = ()> + Send + 'static) {
    let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_QUEUE);
    let (lifecycle_tx, lifecycle_rx) = watch::channel(Lifecycle::Starting);
    let log = LogBuffer::default();
    let handle = StdioHandle {
        outbound: outbound_tx,
        lifecycle: lifecycle_rx,
        log: log.clone(),
    };
    let server = Server {
        label: if name.is_empty() {
            channel.clone()
        } else {
            name.to_owned()
        },
        channel,
        argv,
        timings,
        lifecycle: lifecycle_tx,
        state_changed,
        log,
    };
    (handle, server.serve(outbound_rx))
}

/// What the task of one channel works with.
struct Server {
    channel: String,
    /// The start of each stderr line in the log of the tunnel client.
    label: String,
    argv: Vec<String>,
    timings: Timings,
    lifecycle: watch::Sender<Lifecycle>,
    state_changed: Arc<Notify>,
    log: LogBuffer,
}

impl Server {
    fn set(&self, lifecycle: Lifecycle) {
        self.lifecycle.send_replace(lifecycle);
        self.state_changed.notify_one();
    }

    async fn serve(self, mut outbound: mpsc::Receiver<Outbound>) {
        let channel = self.channel.as_str();
        // The tasks that read stderr. One lives until its process closes
        // stderr, so the last lines of a process that stops are not lost.
        // Dropping the set stops them.
        let mut stderr_readers = JoinSet::new();
        let mut failures = 0;
        loop {
            while stderr_readers.try_join_next().is_some() {}
            self.set(Lifecycle::Starting);
            // While no process is in operation, each request is rejected at
            // once.
            let start = Session::start(&self, &mut stderr_readers);
            let error = match reject_while(&mut outbound, start).await {
                Ok(mut session) => {
                    failures = 0;
                    info!(channel, "the MCP server is in operation");
                    self.set(Lifecycle::Running {
                        initialize_result: Arc::clone(&session.initialize_result),
                    });
                    match session.run(&mut outbound).await {
                        SessionEnd::NoHandles => return,
                        SessionEnd::ProcessStopped => {
                            // The end of the session fails the requests that
                            // still wait, as "closed".
                            let mut process = session.into_process();
                            self.set(Lifecycle::Failed {
                                error: STOPPED.to_owned(),
                            });
                            match reject_while(&mut outbound, exit_status(&mut process.child)).await
                            {
                                Some(status) => format!("{STOPPED} ({status})"),
                                None => STOPPED.to_owned(),
                            }
                        }
                    }
                }
                Err(error) => error.to_string(),
            };
            warn!(
                channel,
                error, "the MCP server is not in operation; it starts again"
            );
            self.set(Lifecycle::Failed { error });
            failures += 1;
            let delay = self.timings.mcp_server_backoff.delay(failures);
            reject_while(&mut outbound, tokio::time::sleep(delay)).await;
        }
    }
}

/// The exit status of a process that stopped. `None` when the process only
/// closed its stdout and still runs: the caller drops it, which kills it.
async fn exit_status(child: &mut Child) -> Option<ExitStatus> {
    tokio::time::timeout(EXIT_WAIT, child.wait())
        .await
        .ok()?
        .ok()
}

/// Runs `work` to its end. Each message that comes during this time gets no
/// answer: its sender sees that no MCP server is in operation.
async fn reject_while<F: Future>(outbound: &mut mpsc::Receiver<Outbound>, work: F) -> F::Output {
    tokio::pin!(work);
    loop {
        tokio::select! {
            output = &mut work => return output,
            // Dropping the message drops its `reply`: the request fails.
            Some(_rejected) = outbound.recv() => {}
        }
    }
}

enum SessionEnd {
    ProcessStopped,
    /// Nobody can send to this channel any more.
    NoHandles,
}

struct PendingRequest {
    original_id: Value,
    reply: oneshot::Sender<Value>,
}

/// The child process of an MCP server. Dropping it kills the process, and on
/// Windows also the processes that it started.
struct Process {
    child: Child,
    _tree: ProcessTree,
}

impl Process {
    fn spawn(argv: &[String]) -> std::io::Result<Self> {
        let Some((program, arguments)) = argv.split_first() else {
            return Err(std::io::ErrorKind::InvalidInput.into());
        };
        let mut command = Command::new(command_line::program(program));
        command
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process_tree::configure(&mut command);
        let child = command.spawn()?;
        let _tree = process_tree::attach(&child);
        Ok(Self { child, _tree })
    }
}

/// One run of the child process, from `initialize` to its end.
struct Session {
    process: Process,
    stdout: Lines<BufReader<ChildStdout>>,
    /// Lines for the stdin of the process. A separate task writes them, so a
    /// process that does not read its stdin cannot stop the reading of its
    /// stdout.
    stdin: mpsc::UnboundedSender<String>,
    /// Holds the writer task; dropping it stops the task.
    _writer: JoinSet<()>,
    initialize_result: Arc<Value>,
    next_id: u64,
    pending: HashMap<u64, PendingRequest>,
}

impl Session {
    /// Starts the process and does the MCP handshake: `initialize`, then
    /// `notifications/initialized`. The task that reads the stderr of the
    /// process goes into `stderr_readers`.
    async fn start(server: &Server, stderr_readers: &mut JoinSet<()>) -> Result<Self, StartError> {
        let mut process = Process::spawn(&server.argv).map_err(StartError::Spawn)?;
        let child = &mut process.child;
        if let Some(stderr) = child.stderr.take() {
            stderr_readers.spawn(copy_stderr(
                stderr,
                server.label.clone(),
                server.log.clone(),
            ));
        }
        let stdin = child.stdin.take().ok_or(StartError::NoPipes)?;
        let stdout = child.stdout.take().ok_or(StartError::NoPipes)?;

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
        let mut writer = JoinSet::new();
        writer.spawn(write_lines(stdin, stdin_rx));

        let mut session = Self {
            process,
            stdout: BufReader::new(stdout).lines(),
            stdin: stdin_tx,
            _writer: writer,
            initialize_result: Arc::new(Value::Null),
            next_id: 1,
            pending: HashMap::new(),
        };
        let handshake = session.initialize();
        let initialize_result = tokio::time::timeout(server.timings.initialize_timeout, handshake)
            .await
            .map_err(|_| StartError::Timeout)??;
        session.initialize_result = Arc::new(initialize_result);
        Ok(session)
    }

    async fn initialize(&mut self) -> Result<Value, StartError> {
        let id = self.take_id();
        self.write(&jsonrpc::initialize_request(id));
        loop {
            let line = match self.stdout.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => return Err(StartError::Closed),
            };
            let Some(mut message) = parse_line(&line) else {
                continue;
            };
            match jsonrpc::classify(&message) {
                MessageKind::Response { id: answered } if answered == id => {
                    if let Some(error) = message.get("error") {
                        return Err(StartError::Rejected(error.clone()));
                    }
                    self.write(&jsonrpc::initialized_notification());
                    return Ok(message["result"].take());
                }
                _ => self.on_server_message(message),
            }
        }
    }

    /// Forwards messages in both directions until the process stops. The
    /// caller then drops the session: the requests that still wait fail as
    /// "closed", and the process is killed if it is still there.
    async fn run(&mut self, outbound: &mut mpsc::Receiver<Outbound>) -> SessionEnd {
        loop {
            tokio::select! {
                // First read what the process wrote: when it stops, its last
                // answers must not be lost.
                biased;
                line = self.stdout.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(message) = parse_line(&line) {
                            self.on_server_message(message);
                        }
                    }
                    Ok(None) | Err(_) => return SessionEnd::ProcessStopped,
                },
                message = outbound.recv() => match message {
                    Some(Outbound::Request { message, reply }) => self.forward_request(message, reply),
                    Some(Outbound::Notification { message }) => self.write(&message),
                    None => return SessionEnd::NoHandles,
                },
                _ = self.process.child.wait() => return SessionEnd::ProcessStopped,
            }
        }
    }

    /// Ends the session and keeps only the process.
    fn into_process(self) -> Process {
        self.process
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn forward_request(&mut self, mut message: Value, reply: oneshot::Sender<Value>) {
        // A caller that hit its deadline does not wait any more: forget it.
        self.pending.retain(|_, pending| !pending.reply.is_closed());

        let MessageKind::Request {
            id: original_id, ..
        } = jsonrpc::classify(&message)
        else {
            return;
        };
        let id = self.take_id();
        jsonrpc::set_id(&mut message, Value::from(id));
        self.pending
            .insert(id, PendingRequest { original_id, reply });
        self.write(&message);
    }

    fn on_server_message(&mut self, mut message: Value) {
        match jsonrpc::classify(&message) {
            MessageKind::Response { id } => {
                let Some(pending) = id.as_u64().and_then(|id| self.pending.remove(&id)) else {
                    debug!(%id, "the MCP server answered a request that does not wait");
                    return;
                };
                jsonrpc::set_id(&mut message, pending.original_id);
                // The caller can be gone (deadline): then the answer is dropped.
                let _ = pending.reply.send(message);
            }
            MessageKind::Request { id, method } => {
                debug!(
                    method,
                    "the MCP server sent a request; the answer is 'method not found'"
                );
                self.write(&jsonrpc::method_not_found(id, &method));
            }
            MessageKind::Notification { method } => {
                debug!(method, "dropped a notification of the MCP server");
            }
            MessageKind::Invalid => {}
        }
    }

    fn write(&self, message: &Value) {
        // A failed send means that the writer task stopped because the pipe
        // closed. The read side sees the end of the process.
        let _ = self.stdin.send(format!("{message}\n"));
    }
}

async fn write_lines(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() {
            return;
        }
    }
}

/// Reads the stderr of a process to its end. Each line goes to the log
/// buffer of the channel, and to the stderr of the tunnel client with the
/// name of the entry in front.
async fn copy_stderr(stderr: ChildStderr, label: String, log: LogBuffer) {
    let mut stderr = BufReader::new(stderr);
    // Bytes, not a `String`: a line that is not UTF-8 must not end the log.
    let mut line = Vec::new();
    loop {
        line.clear();
        match stderr.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\n', '\r']);
        // Best effort: an MCP server must not stop because the log of the
        // tunnel client cannot be written.
        let _ = writeln!(std::io::stderr().lock(), "[{label}] {text}");
        log.push(text.chars().take(LOG_LINE_CHARS).collect());
    }
}

fn parse_line(line: &str) -> Option<Value> {
    if line.trim().is_empty() {
        return None;
    }
    match serde_json::from_str(line) {
        Ok(message) => Some(message),
        Err(_) => {
            debug!("ignored a stdout line of the MCP server that is not JSON");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;

    /// An MCP server that sends a request and a notification to the client
    /// after `initialize`. It answers `probe` with the error code that it got
    /// for its request, when it has that code.
    const ASKING_SERVER: &str = r#"
import json, sys

def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

seen = None
probe = None
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "asking"}}})
        send({"jsonrpc": "2.0", "id": "srv-1", "method": "roots/list"})
        send({"jsonrpc": "2.0", "method": "notifications/message", "params": {}})
    elif message.get("id") == "srv-1" and "method" not in message:
        seen = message["error"]["code"]
    elif message.get("method") == "probe":
        probe = message["id"]
    if seen is not None and probe is not None:
        send({"jsonrpc": "2.0", "id": probe, "result": {"seen": seen}})
        probe = None
"#;

    fn python(script: &str) -> Vec<String> {
        // `python` on Windows: it has no `python3` there.
        let python = if cfg!(windows) { "python" } else { "python3" };
        vec![python.to_owned(), "-c".to_owned(), script.to_owned()]
    }

    /// The handle and the running task of a channel with this program.
    fn start(argv: Vec<String>) -> (StdioHandle, JoinSet<()>) {
        let (handle, serve) = channel(
            "c".to_owned(),
            "test server",
            argv,
            Timings::default(),
            Arc::new(Notify::new()),
        );
        let mut tasks = JoinSet::new();
        tasks.spawn(serve);
        (handle, tasks)
    }

    async fn wait_for_state(handle: &StdioHandle, wanted: impl Fn(&ServerState) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !wanted(&handle.state()) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the state did not come: {:?}",
                handle.state()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_until_ready(handle: &StdioHandle) {
        wait_for_state(handle, |state| *state == ServerState::Running).await;
    }

    /// Waits until the log has this line. The task that reads stderr is not
    /// the task of the MCP session, so a line can come a moment later.
    async fn wait_for_log_line(handle: &StdioHandle, line: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !handle.log_lines().iter().any(|logged| logged == line) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the line did not come: {:?}",
                handle.log_lines()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_request_of_the_server_gets_method_not_found() {
        let (handle, _tasks) = start(python(ASKING_SERVER));
        assert_eq!(handle.state(), ServerState::Starting);
        wait_until_ready(&handle).await;

        assert_eq!(
            handle.initialize_result().as_deref(),
            Some(&json!({"serverInfo": {"name": "asking"}}))
        );
        let answer = handle
            .request(json!({"jsonrpc": "2.0", "id": "caller", "method": "probe"}))
            .await
            .expect("the server answers");
        assert_eq!(
            answer.message,
            json!({"jsonrpc": "2.0", "id": "caller", "result": {"seen": -32601}})
        );
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_gives_not_running() {
        let (handle, _tasks) = start(vec!["/nonexistent/archestra-mcp-server".to_owned()]);

        assert_eq!(handle.initialize_result(), None);
        let error = handle
            .request(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
            .await
            .expect_err("no server is in operation");
        assert_eq!(error, ForwardError::Closed);

        // The state has the reason, and stays "failed" while the client
        // waits to try again.
        wait_for_state(&handle, |state| state.error().is_some()).await;
        let state = handle.state();
        let error = state.error().expect("an error");
        assert!(error.starts_with("cannot start the program: "), "{error:?}");
        assert_eq!(handle.initialize_result(), None);
        assert_eq!(handle.log_lines(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_server_that_stops_fails_the_waiting_request() {
        // Answers `initialize`, then stops at the first request.
        let script = r#"
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
    elif "id" in message:
        sys.exit(3)
"#;
        let (handle, _tasks) = start(python(script));
        wait_until_ready(&handle).await;

        let error = handle
            .request(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
            .await
            .expect_err("the server stopped");
        assert_eq!(error, ForwardError::Closed);
        wait_for_state(&handle, |state| {
            state.error() == Some("the MCP server stopped (exit status: 3)")
        })
        .await;
    }

    #[tokio::test]
    async fn stderr_lines_are_kept_for_the_log() {
        // Writes to stderr at the start and for each request. One line is
        // not UTF-8.
        let script = r#"
import json, sys
print("ready to serve", file=sys.stderr, flush=True)
for line in sys.stdin:
    message = json.loads(line)
    if "id" in message:
        sys.stderr.buffer.write(b"got " + message["method"].encode() + b" \xff\r\n")
        sys.stderr.flush()
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
"#;
        let (handle, _tasks) = start(python(script));
        wait_until_ready(&handle).await;
        handle
            .request(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
            .await
            .expect("the server answers");

        wait_for_log_line(&handle, "got ping \u{fffd}").await;
        assert_eq!(
            handle.log_lines(),
            vec![
                "ready to serve".to_owned(),
                "got initialize \u{fffd}".to_owned(),
                "got ping \u{fffd}".to_owned(),
            ]
        );
    }

    #[tokio::test]
    async fn the_last_stderr_lines_of_a_server_that_cannot_start_are_kept() {
        let script = r#"
import sys
print("fatal: no license", file=sys.stderr, flush=True)
sys.exit(2)
"#;
        let (handle, _tasks) = start(python(script));
        wait_for_state(&handle, |state| {
            state.error() == Some("the MCP server closed before it answered `initialize`")
        })
        .await;
        wait_for_log_line(&handle, "fatal: no license").await;
    }

    #[test]
    fn the_log_keeps_the_last_200_lines() {
        let log = LogBuffer::default();
        for number in 0..250 {
            log.push(format!("line {number}"));
        }
        let lines = log.lines();
        assert_eq!(lines.len(), 200);
        assert_eq!(lines.first().map(String::as_str), Some("line 50"));
        assert_eq!(lines.last().map(String::as_str), Some("line 249"));
    }
}
