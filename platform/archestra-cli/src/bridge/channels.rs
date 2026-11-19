//! The channels of the device: one MCP server for each configured entry of
//! the config file. This module starts and stops them when the file changes,
//! starts one again when Archestra asks, and publishes the state of each.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinSet};
use tracing::{info, warn};

use crate::bridge::Timings;
use crate::bridge::config::{self, ChannelEntry, ChannelTarget, Config, RejectReason};
use crate::bridge::http_server::{self, HttpHandle};
use crate::bridge::jsonrpc::TunnelFailure;
use crate::bridge::state::{BridgeState, ServerState, ServerStatus};
use crate::bridge::stdio_server::{self, StdioHandle};
use crate::bridge::template::Variables;

/// Why a forwarded message got no answer from the MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ForwardError {
    #[error(
        "no MCP server runs for this catalog item on the device; see its state on the Device tab of Personal Settings in Archestra"
    )]
    NotRunning,
    #[error("the MCP server closed before it answered")]
    Closed,
    #[error("could not connect to the MCP server")]
    Connect,
    #[error("the MCP server answered with HTTP status {status}")]
    TargetHttp { status: u16 },
    #[error("the MCP server sent an answer that is not valid")]
    Protocol,
}

impl ForwardError {
    pub(crate) fn tunnel_failure(self) -> TunnelFailure {
        let (source, upstream_response_received, upstream_status) = match self {
            Self::NotRunning | Self::Closed => ("transport_closed", false, None),
            Self::Connect => ("connect", false, None),
            Self::TargetHttp { status } => ("target_http", true, Some(status)),
            Self::Protocol => ("protocol", true, None),
        };
        TunnelFailure {
            source,
            upstream_response_received,
            upstream_status,
        }
    }
}

/// The answer of an MCP server to a forwarded request.
#[derive(Debug)]
pub(crate) struct Forwarded {
    /// The HTTP status of the MCP server; `200` for stdio.
    pub status: u16,
    /// The JSON-RPC response, with the id of the caller.
    pub message: Value,
}

/// The way to one MCP server. A clone is cheap.
#[derive(Debug, Clone)]
pub(crate) enum ChannelHandle {
    Stdio(StdioHandle),
    Http(HttpHandle),
}

impl ChannelHandle {
    /// `true` when the MCP server is initialized and in operation.
    pub(crate) fn is_ready(&self) -> bool {
        self.initialize_result().is_some()
    }

    pub(crate) fn state(&self) -> ServerState {
        match self {
            Self::Stdio(handle) => handle.state(),
            Self::Http(handle) => handle.state(),
        }
    }

    /// The last lines that the MCP server wrote to stderr. The client does
    /// not start an HTTP MCP server, so it has no log of one.
    pub(crate) fn log_lines(&self) -> Vec<String> {
        match self {
            Self::Stdio(handle) => handle.log_lines(),
            Self::Http(_) => Vec::new(),
        }
    }

    /// The `InitializeResult` that the MCP server gave to the client. `None`
    /// when no MCP server is in operation. It is shared: this is called for
    /// each forwarded message.
    pub(crate) fn initialize_result(&self) -> Option<Arc<Value>> {
        match self {
            Self::Stdio(handle) => handle.initialize_result(),
            Self::Http(handle) => handle.initialize_result(),
        }
    }

    /// Forwards a request with a new id and waits for its answer.
    pub(crate) async fn request(&self, message: Value) -> Result<Forwarded, ForwardError> {
        match self {
            Self::Stdio(handle) => handle.request(message).await,
            Self::Http(handle) => handle.request(message).await,
        }
    }

    /// Forwards a notification.
    pub(crate) async fn notify(&self, message: Value) -> Result<(), ForwardError> {
        match self {
            Self::Stdio(handle) => handle.notify(message).await,
            Self::Http(handle) => handle.notify(message).await,
        }
    }
}

/// Channel id → the way to its MCP server. Channels with no command and no
/// URL are not in the map.
pub(crate) type ChannelMap = HashMap<String, ChannelHandle>;

/// Why the tunnel client did not start an MCP server again.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RestartError {
    #[error("the config file of the device has no MCP server for the channel {channel}")]
    UnknownChannel { channel: String },
    #[error("the MCP server has no command and no URL")]
    NoCommand,
    #[error("the MCP server is stopped; start it first")]
    Stopped,
    #[error("the entry of the MCP server has an error: {0}")]
    Rejected(RejectReason),
}

/// Asks the supervisor to stop one MCP server and start it again.
#[derive(Debug)]
pub(crate) struct RestartRequest {
    pub channel: String,
    pub reply: oneshot::Sender<Result<(), RestartError>>,
}

struct RunningChannel {
    target: ChannelTarget,
    handle: ChannelHandle,
    task: AbortHandle,
}

/// The MCP servers of the device and what starts them.
pub(crate) struct Supervisor {
    local_http: reqwest::Client,
    timings: Timings,
    variables: Variables,
    /// The tasks of the MCP servers. A task that is aborted or dropped kills
    /// its child process.
    tasks: JoinSet<()>,
    /// The channels of the config file, as of the last time it was read.
    entries: Vec<ChannelEntry>,
    running: HashMap<String, RunningChannel>,
    /// Each MCP server tells this when its state changes.
    state_changed: Arc<Notify>,
}

impl Supervisor {
    pub(crate) fn new(local_http: reqwest::Client, timings: Timings, variables: Variables) -> Self {
        Self {
            local_http,
            timings,
            variables,
            tasks: JoinSet::new(),
            entries: Vec::new(),
            running: HashMap::new(),
            state_changed: Arc::new(Notify::new()),
        }
    }

    /// Keeps the MCP servers in line with the config file. It reads the file
    /// at the start and each time its modification time changes. It
    /// publishes the channels on `published` and the states in `state`. It
    /// does not return; drop it to stop all servers.
    pub(crate) async fn run(
        mut self,
        config_path: PathBuf,
        mut restarts: mpsc::Receiver<RestartRequest>,
        published: watch::Sender<Arc<ChannelMap>>,
        state: &watch::Sender<BridgeState>,
    ) {
        let state_changed = Arc::clone(&self.state_changed);
        let mut seen = None;
        let mut check = tokio::time::interval(self.timings.config_check_interval);

        loop {
            tokio::select! {
                _ = check.tick() => {
                    // Remove the results of tasks that were stopped.
                    while self.tasks.try_join_next().is_some() {}
                    let Some(config) = changed_config(&config_path, &mut seen) else {
                        continue;
                    };
                    self.apply(config.mcp.channel_entries(&self.variables));
                    published.send_replace(Arc::new(self.channel_map()));
                    state.send_modify(|state| {
                        state.config_loads += 1;
                        state.servers = self.server_statuses();
                    });
                }
                Some(request) = restarts.recv() => {
                    let restarted = self.restart(&request.channel);
                    published.send_replace(Arc::new(self.channel_map()));
                    self.publish_states(state);
                    // The one that asked can be gone (deadline).
                    let _ = request.reply.send(restarted);
                }
                () = state_changed.notified() => self.publish_states(state),
            }
        }
    }

    /// Stops the MCP servers whose entry changed or is gone, and starts
    /// those of the new entries.
    fn apply(&mut self, entries: Vec<ChannelEntry>) {
        self.running.retain(|channel, running| {
            let keep = entries
                .iter()
                .any(|entry| entry.channel == *channel && entry.target == running.target);
            if !keep {
                info!(channel, "stopping the MCP server: its entry changed");
                running.task.abort();
            }
            keep
        });

        for entry in &entries {
            if self.running.contains_key(&entry.channel) {
                continue;
            }
            // A sync can write the file again with the same entry: say an
            // error one time only.
            if let ChannelTarget::Rejected(reason) = &entry.target
                && !self.entries.contains(entry)
            {
                warn!(channel = entry.channel, %reason, "the entry of the channel has an error; nothing is started");
            }
            self.start(entry);
        }
        self.entries = entries;
    }

    /// Starts the MCP server of an entry that has a command or a URL.
    fn start(&mut self, entry: &ChannelEntry) {
        let channel = entry.channel.clone();
        let state_changed = Arc::clone(&self.state_changed);
        let (handle, task) = match &entry.target {
            ChannelTarget::Stdio { argv } => {
                let (handle, serve) = stdio_server::channel(
                    channel,
                    &entry.name,
                    argv.clone(),
                    self.timings,
                    state_changed,
                );
                (ChannelHandle::Stdio(handle), self.tasks.spawn(serve))
            }
            ChannelTarget::Http { url } => {
                let (handle, serve) = http_server::channel(
                    channel,
                    url.clone(),
                    self.local_http.clone(),
                    self.timings,
                    state_changed,
                );
                (ChannelHandle::Http(handle), self.tasks.spawn(serve))
            }
            ChannelTarget::NotConfigured | ChannelTarget::Disabled | ChannelTarget::Rejected(_) => {
                return;
            }
        };
        self.running.insert(
            entry.channel.clone(),
            RunningChannel {
                target: entry.target.clone(),
                handle,
                task,
            },
        );
    }

    /// Stops the MCP server of a channel and starts it again from its entry.
    fn restart(&mut self, channel: &str) -> Result<(), RestartError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.channel == channel)
            .cloned()
            .ok_or_else(|| RestartError::UnknownChannel {
                channel: channel.to_owned(),
            })?;
        match &entry.target {
            ChannelTarget::Stdio { .. } | ChannelTarget::Http { .. } => {}
            ChannelTarget::NotConfigured => return Err(RestartError::NoCommand),
            ChannelTarget::Disabled => return Err(RestartError::Stopped),
            ChannelTarget::Rejected(reason) => return Err(RestartError::Rejected(*reason)),
        }
        if let Some(running) = self.running.remove(channel) {
            info!(
                channel,
                "stopping the MCP server: Archestra asked for a restart"
            );
            running.task.abort();
        }
        self.start(&entry);
        Ok(())
    }

    fn channel_map(&self) -> ChannelMap {
        self.running
            .iter()
            .map(|(channel, running)| (channel.clone(), running.handle.clone()))
            .collect()
    }

    /// The state of each entry, in the order of the config file.
    fn server_statuses(&self) -> Vec<ServerStatus> {
        self.entries
            .iter()
            .map(|entry| ServerStatus {
                channel: entry.channel.clone(),
                name: entry.name.clone(),
                state: self.server_state(entry),
            })
            .collect()
    }

    fn server_state(&self, entry: &ChannelEntry) -> ServerState {
        match &entry.target {
            ChannelTarget::NotConfigured => ServerState::NoCommand,
            ChannelTarget::Disabled => ServerState::Stopped,
            ChannelTarget::Rejected(reason) => ServerState::Failed {
                error: reason.to_string(),
            },
            ChannelTarget::Stdio { .. } | ChannelTarget::Http { .. } => self
                .running
                .get(&entry.channel)
                .map_or(ServerState::Starting, |running| running.handle.state()),
        }
    }

    fn publish_states(&self, state: &watch::Sender<BridgeState>) {
        let servers = self.server_statuses();
        state.send_if_modified(|state| {
            let changed = state.servers != servers;
            state.servers = servers;
            changed
        });
    }
}

/// Reads the config file when it is not the file that `seen` is of. `None`:
/// no file, no change, or a file that is not valid.
fn changed_config(config_path: &Path, seen: &mut Option<(SystemTime, u64)>) -> Option<Config> {
    let stamp = config::file_stamp(config_path);
    if stamp.is_none() || stamp == *seen {
        return None;
    }
    *seen = stamp;
    match Config::load(config_path) {
        Ok(config) => config,
        Err(error) => {
            warn!(%error, "the config file changed but it is not valid; no change is applied");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_errors_map_to_tunnel_failures() {
        assert_eq!(
            ForwardError::NotRunning.tunnel_failure(),
            TunnelFailure {
                source: "transport_closed",
                upstream_response_received: false,
                upstream_status: None,
            }
        );
        assert_eq!(
            ForwardError::Closed.tunnel_failure().source,
            "transport_closed"
        );
        assert_eq!(ForwardError::Connect.tunnel_failure().source, "connect");
        assert_eq!(
            ForwardError::TargetHttp { status: 500 }.tunnel_failure(),
            TunnelFailure {
                source: "target_http",
                upstream_response_received: true,
                upstream_status: Some(500),
            }
        );
        assert_eq!(ForwardError::Protocol.tunnel_failure().source, "protocol");
    }
}
