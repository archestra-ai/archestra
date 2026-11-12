//! `archestra bridge status`: says what the MCP bridge on this device does
//! now. It changes nothing.
//!
//! - Whether the MCP bridge runs in the background, and whether it starts at
//!   each login: from the OS ([`super::autostart::status`]).
//! - Which Archestra this device is linked to: from the config file.
//! - The version of this program, and where the log file is.

use std::path::Path;
use std::process::ExitCode;

use super::autostart::{self, AutostartError, Status};
use super::config::Config;
use crate::layout;

/// Runs `archestra bridge status`.
pub fn run() -> Result<ExitCode, AutostartError> {
    let home = std::env::home_dir().ok_or(AutostartError::NoHome)?;
    let status = autostart::status()?;
    // A config file that is missing or not valid: this device is not linked.
    let archestra = Config::load(&layout::bridge_config_path(&home))
        .ok()
        .flatten()
        .map(|config| config.control_plane.base_url);
    println!(
        "{}",
        report(
            status,
            archestra.as_deref(),
            &layout::bridge_log_path(&home)
        )
    );
    Ok(ExitCode::SUCCESS)
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
}
