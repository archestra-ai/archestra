//! The state report: the tunnel client tells Archestra the state of each MCP
//! server. The report is a `bridge/state` notification on the reserved
//! channel.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use tracing::warn;

use crate::bridge::control_plane::ControlPlane;
use crate::bridge::jsonrpc;
use crate::bridge::state::BridgeState;

const STATE: &str = "bridge/state";

/// What one report says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Report {
    servers: Vec<ServerReport>,
    /// The config file that the states are of. A sync that changes the MCP
    /// entries writes the file again, so a report follows it.
    #[serde(skip)]
    config_loads: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ServerReport {
    channel: String,
    state: &'static str,
    error: Option<String>,
}

impl Report {
    /// `None` until the tunnel client applied the config file one time:
    /// the states of the MCP servers are not known before that.
    fn of(state: &BridgeState) -> Option<Self> {
        if state.config_loads == 0 {
            return None;
        }
        let servers = state
            .servers
            .iter()
            .map(|server| ServerReport {
                channel: server.channel.clone(),
                state: server.state.wire_name(),
                error: server.state.error().map(str::to_owned),
            })
            .collect();
        Some(Self {
            servers,
            config_loads: state.config_loads,
        })
    }

    fn notification(&self) -> Value {
        jsonrpc::notification(STATE, self)
    }
}

/// Sends a report when the states are first known, after each sync that
/// wrote the config file, and each time the state of an MCP server changes.
/// It waits `delay` after a change, so that changes that come together make
/// one report. Each report has the full state. It does not return while the
/// tunnel client runs.
pub(crate) async fn report_loop(
    control_plane: &ControlPlane,
    mut state: watch::Receiver<BridgeState>,
    delay: Duration,
) {
    // What Archestra has. `None` after a failed POST: the next change of the
    // state of the tunnel client sends it again. Each good sync is such a
    // change (its time), so that is the sync interval at the latest.
    let mut reported: Option<Report> = None;
    loop {
        // A statement of its own: the borrow of the state ends before the
        // POST waits.
        let report = Report::of(&state.borrow_and_update());
        if let Some(report) = report
            && reported.as_ref() != Some(&report)
        {
            reported = match control_plane.post_notification(report.notification()).await {
                Ok(()) => Some(report),
                Err(error) => {
                    warn!(%error, "could not report the state to Archestra");
                    None
                }
            };
        }
        if state.changed().await.is_err() {
            return;
        }
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::bridge::state::{ServerState, ServerStatus, SyncState};

    fn server(channel: &str, state: ServerState) -> ServerStatus {
        ServerStatus {
            channel: channel.to_owned(),
            name: format!("{channel} name"),
            state,
        }
    }

    #[test]
    fn no_report_before_the_config_file_is_applied() {
        let state = BridgeState::new(SyncState::default());
        assert_eq!(Report::of(&state), None);
    }

    #[test]
    fn the_notification_has_each_server() {
        let mut state = BridgeState::new(SyncState::default());
        state.config_loads = 1;
        state.servers = vec![
            server("7c1e", ServerState::Running),
            server("a001", ServerState::Starting),
            server(
                "3f02",
                ServerState::Failed {
                    error: "cannot start the program: file not found".to_owned(),
                },
            ),
            server("91bd", ServerState::NoCommand),
            server("aa11", ServerState::Stopped),
        ];

        let report = Report::of(&state).expect("a report");
        assert_eq!(
            report.notification(),
            json!({
                "jsonrpc": "2.0",
                "method": "bridge/state",
                "params": {
                    "servers": [
                        {"channel": "7c1e", "state": "running", "error": null},
                        {"channel": "a001", "state": "starting", "error": null},
                        {
                            "channel": "3f02",
                            "state": "failed",
                            "error": "cannot start the program: file not found",
                        },
                        {"channel": "91bd", "state": "no_command", "error": null},
                        {"channel": "aa11", "state": "stopped", "error": null},
                    ],
                },
            })
        );
    }

    #[test]
    fn a_new_load_of_the_config_file_makes_a_new_report() {
        let mut state = BridgeState::new(SyncState::default());
        state.config_loads = 1;
        let first = Report::of(&state);
        // A change that the report does not have: no new report.
        state.status = crate::bridge::BridgeStatus::Connected;
        assert_eq!(Report::of(&state), first);
        state.config_loads = 2;
        assert_ne!(Report::of(&state), first);
    }
}
