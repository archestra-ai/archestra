//! The tray icon: an icon that shows if the last poll was successful, with a
//! small menu. The menu shows the time of the last sync and the state of each
//! MCP server, and has "Sync config from Archestra", "Open Device tab" and
//! "Quit".
//!
//! This file has what the menu shows; each OS draws it in a file of its own:
//! the menu bar on macOS, the notification area on Windows. Linux has no tray
//! icon.
//!
//! [`run`] takes over the main thread, which the GUI of both systems needs.
//! The tunnel client itself runs on the Tokio runtime that is passed in.

use std::time::{Duration, SystemTime};

use crate::bridge::state::{BridgeState, BridgeStatus, ServerState, SyncState};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{TrayError, run};
#[cfg(windows)]
pub use windows::{TrayError, run};

/// How often the tray looks at the state. A look is cheap: the tray draws
/// only when what it shows changed. It is also how the tray sees that the
/// tunnel client ended, so a stop waits this long at most.
const REFRESH_INTERVAL: Duration = Duration::from_secs(1);
/// How long the MCP servers get to stop when the user picks Quit.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

/// The items of the menu that do something.
const SYNC_ITEM: &str = "Sync config from Archestra";
const OPEN_DEVICES_ITEM: &str = "Open Device tab";
const QUIT_ITEM: &str = "Quit";

/// The line at the top of the menu.
fn status_text(status: BridgeStatus) -> &'static str {
    match status {
        BridgeStatus::Starting => "Archestra MCP bridge: connecting…",
        BridgeStatus::Connected => "Archestra MCP bridge: connected",
        BridgeStatus::Disconnected => "Archestra MCP bridge: cannot reach Archestra",
        BridgeStatus::SignedOut => "Archestra MCP bridge: signed out. Start it again to sign in",
    }
}

/// The address of the Device tab of Personal Settings in Archestra at `base_url`.
fn devices_url(base_url: &str) -> String {
    format!("{base_url}/account/devices")
}

/// What the menu shows. The lines of the MCP servers come and go with the
/// config of the device.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MenuModel {
    status: BridgeStatus,
    config_line: String,
    /// Archestra serves another program than this one.
    update_line: Option<String>,
    /// One line for each MCP server of the config file.
    server_lines: Vec<String>,
}

impl MenuModel {
    fn of(state: &BridgeState, now: SystemTime) -> Self {
        Self {
            status: state.status,
            config_line: config_line(state.sync, now),
            update_line: state.update.as_ref().map(update_line),
            server_lines: state
                .servers
                .iter()
                .map(|server| {
                    let name = if server.name.is_empty() {
                        &server.channel
                    } else {
                        &server.name
                    };
                    format!("{name}: {}", state_words(&server.state))
                })
                .collect(),
        }
    }
}

/// The line of an update. The MCP bridge installs it by itself on Windows,
/// when Archestra allows that; on macOS the user runs the command (Linux has
/// no tray menu).
fn update_line(update: &crate::bridge::Update) -> String {
    let version = match &update.version {
        Some(version) => format!("Update {version} available"),
        None => "Update available".to_owned(),
    };
    if update.auto && cfg!(windows) {
        format!("{version}: it installs when no tool call is running")
    } else {
        format!("{version}: run `archestra update` in a terminal")
    }
}

fn state_words(state: &ServerState) -> &'static str {
    match state {
        ServerState::NoCommand => "no command",
        ServerState::Starting => "starting",
        ServerState::Running => "running",
        ServerState::Failed { .. } => "failed",
        ServerState::Stopped => "stopped",
    }
}

/// The whole minutes since the last good sync: the number that the config
/// line is made from. `None`: no sync was successful yet.
fn sync_age_minutes(sync: SyncState, now: SystemTime) -> Option<u64> {
    // A clock that went back gives no age: the sync is "just now".
    sync.synced_at
        .map(|synced_at| now.duration_since(synced_at).unwrap_or_default().as_secs() / 60)
}

fn config_line(sync: SyncState, now: SystemTime) -> String {
    let age = sync_age_minutes(sync, now).map(age_words);
    match (age, sync.failed) {
        (Some(age), false) => format!("Config: synced {age}"),
        (Some(age), true) => format!("Config: sync failed. Last sync {age}"),
        (None, false) => "Config: not synced".to_owned(),
        (None, true) => "Config: sync failed. No sync yet".to_owned(),
    }
}

fn age_words(minutes: u64) -> String {
    let (count, unit) = match minutes {
        0 => return "just now".to_owned(),
        1..60 => (minutes, "minute"),
        60..1440 => (minutes / 60, "hour"),
        _ => (minutes / 1440, "day"),
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("{count} {unit}{plural} ago")
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use super::*;
    use crate::bridge::state::ServerStatus;

    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_794_312_000)
    }

    fn synced(seconds_ago: u64, failed: bool) -> SyncState {
        SyncState {
            synced_at: Some(now() - Duration::from_secs(seconds_ago)),
            failed,
        }
    }

    fn server(name: &str, state: ServerState) -> ServerStatus {
        ServerStatus {
            channel: format!("{name}-channel"),
            name: name.to_owned(),
            state,
        }
    }

    #[test]
    fn the_config_line_has_the_age_of_the_last_sync() {
        for (seconds_ago, line) in [
            (0, "Config: synced just now"),
            (59, "Config: synced just now"),
            (60, "Config: synced 1 minute ago"),
            (125, "Config: synced 2 minutes ago"),
            (3_599, "Config: synced 59 minutes ago"),
            (3_600, "Config: synced 1 hour ago"),
            (7_300, "Config: synced 2 hours ago"),
            (86_400, "Config: synced 1 day ago"),
            (3 * 86_400 + 5, "Config: synced 3 days ago"),
        ] {
            assert_eq!(config_line(synced(seconds_ago, false), now()), line);
        }
        assert_eq!(
            config_line(synced(125, true), now()),
            "Config: sync failed. Last sync 2 minutes ago"
        );
        assert_eq!(
            config_line(SyncState::default(), now()),
            "Config: not synced"
        );
        let failed = SyncState {
            synced_at: None,
            failed: true,
        };
        assert_eq!(
            config_line(failed, now()),
            "Config: sync failed. No sync yet"
        );
        // The clock of the computer went back.
        let later = SyncState {
            synced_at: Some(now() + Duration::from_secs(600)),
            failed: false,
        };
        assert_eq!(config_line(later, now()), "Config: synced just now");
    }

    #[test]
    fn the_menu_has_a_line_for_an_update() {
        let mut state = BridgeState::new(synced(0, false));
        assert_eq!(MenuModel::of(&state, now()).update_line, None);

        // Archestra does not let the MCP bridge update itself: the line
        // names the command, on each OS.
        state.update = Some(crate::bridge::Update {
            version: Some("0.2.0".to_owned()),
            sha256: "aa".to_owned(),
            auto: false,
        });
        assert_eq!(
            MenuModel::of(&state, now()).update_line.as_deref(),
            Some("Update 0.2.0 available: run `archestra update` in a terminal")
        );
        state.update = Some(crate::bridge::Update {
            version: None,
            sha256: "aa".to_owned(),
            auto: false,
        });
        assert_eq!(
            MenuModel::of(&state, now()).update_line.as_deref(),
            Some("Update available: run `archestra update` in a terminal")
        );
    }

    #[test]
    fn the_menu_has_a_line_for_each_server() {
        let mut state = BridgeState::new(synced(125, false));
        state.status = BridgeStatus::Connected;
        state.servers = vec![
            server("peekaboo", ServerState::Running),
            server("MATLAB", ServerState::Starting),
            server(
                "eda-agent",
                ServerState::Failed {
                    error: "cannot start the program".to_owned(),
                },
            ),
            server("Notes", ServerState::NoCommand),
            server("Paused", ServerState::Stopped),
            server("", ServerState::Running),
        ];

        assert_eq!(
            MenuModel::of(&state, now()),
            MenuModel {
                status: BridgeStatus::Connected,
                config_line: "Config: synced 2 minutes ago".to_owned(),
                update_line: None,
                // No command and no error text in the menu.
                server_lines: vec![
                    "peekaboo: running".to_owned(),
                    "MATLAB: starting".to_owned(),
                    "eda-agent: failed".to_owned(),
                    "Notes: no command".to_owned(),
                    "Paused: stopped".to_owned(),
                    "-channel: running".to_owned(),
                ],
            }
        );
    }

    #[test]
    fn the_devices_page_is_in_the_account_settings() {
        assert_eq!(
            devices_url("https://archestra.example.com"),
            "https://archestra.example.com/account/devices"
        );
    }
}
