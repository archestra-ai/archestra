//! The state of the tunnel client: what the tray menu shows and what the
//! tunnel client reports to Archestra.

use std::time::SystemTime;

/// The connection to Archestra.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeStatus {
    /// No poll has an answer yet.
    Starting,
    /// The last poll was successful.
    Connected,
    /// The last poll failed. The client tries again.
    Disconnected,
    /// Archestra rejected the device key. The client does not poll.
    SignedOut,
}

/// The sync of the config file from Archestra.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncState {
    /// The time of the last good sync. `None`: no sync was successful yet.
    pub synced_at: Option<SystemTime>,
    /// The last sync failed. The config file is as the last good sync left
    /// it.
    pub failed: bool,
}

/// The state of one MCP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerState {
    /// The entry has no command and no URL.
    NoCommand,
    /// The process started, or the client connects. `initialize` has no
    /// answer yet.
    Starting,
    /// `initialize` has an answer.
    Running,
    /// The last try to start failed, or the MCP server stopped. The tunnel
    /// client tries again.
    Failed { error: String },
    /// The MCP server is turned off in Archestra.
    Stopped,
}

impl ServerState {
    /// The name of the state in the report to Archestra.
    pub fn wire_name(&self) -> &'static str {
        match self {
            Self::NoCommand => "no_command",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Failed { .. } => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Failed { error } => Some(error),
            Self::NoCommand | Self::Starting | Self::Running | Self::Stopped => None,
        }
    }
}

/// One entry of the config file with the state of its MCP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerStatus {
    /// The id of the catalog item.
    pub channel: String,
    pub name: String,
    pub state: ServerState,
}

/// Archestra serves another `archestra` program than the one that runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    /// The version of the program that Archestra serves, when it knows it.
    pub version: Option<String>,
    /// The SHA-256 of that program, in lower-case hex.
    pub sha256: String,
    /// Archestra lets the MCP bridge update itself.
    pub auto: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeState {
    pub status: BridgeStatus,
    pub sync: SyncState,
    /// `None`: this program is the one that Archestra serves, or Archestra
    /// serves none for this computer.
    pub update: Option<Update>,
    /// The entries of the config file, in the order of the file.
    pub servers: Vec<ServerStatus>,
    /// How many times the tunnel client applied the config file. `0`: the
    /// states of the MCP servers are not known yet.
    pub(crate) config_loads: u64,
}

impl BridgeState {
    pub(crate) fn new(sync: SyncState) -> Self {
        Self {
            status: BridgeStatus::Starting,
            sync,
            update: None,
            servers: Vec::new(),
            config_loads: 0,
        }
    }
}
