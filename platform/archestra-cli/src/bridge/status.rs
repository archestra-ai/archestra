//! `archestra bridge status`: says what the MCP bridge on this device does
//! now. It changes nothing.
//!
//! - Whether the MCP bridge runs in the background, and whether it starts at
//!   each login: from the OS ([`super::autostart::status`]).
//! - Which Archestra this device is linked to: from the config file.
//! - The version of this program, and where the log file is.
//! - While the MCP bridge runs: the state of each MCP server, from the state
//!   file that it writes ([`super::state_file`]).

use std::path::Path;
use std::process::ExitCode;

use super::autostart::{self, AutostartError, Status};
use super::config::Config;
use super::state_file::{self, ServerLine, StateFile};
use crate::layout;

/// Runs `archestra bridge status`.
pub fn run() -> Result<ExitCode, AutostartError> {
    let home = std::env::home_dir().ok_or(AutostartError::NoHome)?;
    let status = autostart::status()?;
    // A config file that is missing or not valid: this device is not linked.
    let config_path = layout::bridge_config_path(&home);
    let archestra = Config::load(&config_path)
        .ok()
        .flatten()
        .map(|config| config.control_plane.base_url);
    // The file of an MCP bridge that does not run any more says nothing.
    let servers = status
        .running
        .then(|| state_file::read(&state_file::path_beside(&config_path)));
    let mut text = report(
        status,
        archestra.as_deref(),
        &layout::bridge_log_path(&home),
    );
    if let Some(file) = servers {
        text.push('\n');
        text.push_str(&servers_report(file.as_ref()));
    }
    println!("{text}");
    Ok(ExitCode::SUCCESS)
}

/// The MCP servers of the MCP bridge that runs. `None`: it wrote no state
/// file yet.
fn servers_report(file: Option<&StateFile>) -> String {
    let Some(servers) = file.and_then(|file| file.servers.as_ref()) else {
        return "MCP servers: starting".to_owned();
    };
    if servers.is_empty() {
        return "MCP servers: none. Add one from the MCP registry in Archestra".to_owned();
    }
    let running = servers
        .iter()
        .filter(|server| server.state == "running")
        .count();
    let width = servers
        .iter()
        .map(|server| server.name.chars().count())
        .max()
        .unwrap_or(0);
    let mut text = format!("MCP servers: {running} of {} running", servers.len());
    for server in servers {
        text.push_str(&format!(
            "\n  {:width$}  {}",
            server.name,
            server_state(server)
        ));
    }
    text
}

fn server_state(server: &ServerLine) -> String {
    match server.state.as_str() {
        "running" => "running".to_owned(),
        "starting" => "starting".to_owned(),
        "failed" => match &server.error {
            Some(error) => format!("failed: {error}"),
            None => "failed".to_owned(),
        },
        "no_command" => "no command: set it in Archestra".to_owned(),
        "stopped" => "turned off in Archestra".to_owned(),
        other => other.to_owned(),
    }
}

fn report(status: Status, archestra: Option<&str>, log_path: &Path) -> String {
    let running = if status.running {
        "running in the background"
    } else {
        "not running. Start it with: archestra bridge start"
    };
    let auto_start = if status.auto_start {
        "on: it starts at each login"
    } else {
        "off: it does not start at login"
    };
    let archestra = match archestra {
        Some(base_url) => format!("linked to {base_url}"),
        None => {
            "not linked. Link this device from the Device tab of Personal Settings in Archestra"
                .to_owned()
        }
    };
    format!(
        "MCP bridge:  {running}\n\
         Auto-start:  {auto_start}\n\
         Archestra:   {archestra}\n\
         Version:     {}\n\
         Log file:    {}",
        env!("CARGO_PKG_VERSION"),
        log_path.display(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_says_what_runs_and_what_to_do_when_nothing_does() {
        let text = report(
            Status {
                running: true,
                auto_start: true,
            },
            Some("https://archestra.example.com"),
            Path::new("/h/.archestra/mcp-bridge/mcp-bridge.log"),
        );
        assert_eq!(
            text,
            format!(
                "MCP bridge:  running in the background\n\
                 Auto-start:  on: it starts at each login\n\
                 Archestra:   linked to https://archestra.example.com\n\
                 Version:     {}\n\
                 Log file:    /h/.archestra/mcp-bridge/mcp-bridge.log",
                env!("CARGO_PKG_VERSION")
            )
        );

        let text = report(
            Status {
                running: false,
                auto_start: false,
            },
            None,
            Path::new("/l.log"),
        );
        assert!(text.contains("not running. Start it with: archestra bridge start"));
        assert!(text.contains("off: it does not start at login"));
        assert!(text.contains("not linked. Link this device from the Device tab"));
    }

    fn line(name: &str, state: &str, error: Option<&str>) -> ServerLine {
        ServerLine {
            name: name.to_owned(),
            state: state.to_owned(),
            error: error.map(str::to_owned),
        }
    }

    #[test]
    fn servers_report_lists_each_mcp_server_with_its_state() {
        let file = StateFile {
            servers: Some(vec![
                line("local-chrome", "running", None),
                line(
                    "matlab",
                    "failed",
                    Some("cannot start the program: file not found"),
                ),
                line("notes", "stopped", None),
                line("eda", "no_command", None),
            ]),
        };
        assert_eq!(
            servers_report(Some(&file)),
            "MCP servers: 1 of 4 running\n\
             \x20 local-chrome  running\n\
             \x20 matlab        failed: cannot start the program: file not found\n\
             \x20 notes         turned off in Archestra\n\
             \x20 eda           no command: set it in Archestra"
        );
    }

    #[test]
    fn servers_report_before_the_states_are_known_and_with_none() {
        assert_eq!(servers_report(None), "MCP servers: starting");
        assert_eq!(
            servers_report(Some(&StateFile { servers: None })),
            "MCP servers: starting"
        );
        assert_eq!(
            servers_report(Some(&StateFile {
                servers: Some(Vec::new())
            })),
            "MCP servers: none. Add one from the MCP registry in Archestra"
        );
    }
}
