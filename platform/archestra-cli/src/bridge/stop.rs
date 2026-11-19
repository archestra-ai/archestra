//! `archestra bridge stop`: stops the MCP bridge that runs in the background.
//!
//! Nothing else changes: the start at login stays as it is (`archestra
//! bridge disable-auto-start` removes it), and the config file and the device key stay,
//! so a later `archestra bridge start` continues with no sign-in. An MCP
//! bridge that runs in a terminal (`--foreground`) is not in the background:
//! stop it there with Ctrl-C.

use std::process::ExitCode;

use super::autostart::{self, AutostartError};

/// Runs `archestra bridge stop`. Nothing to stop is a success.
pub fn run() -> Result<ExitCode, AutostartError> {
    println!("{}", report(autostart::stop()?));
    Ok(ExitCode::SUCCESS)
}

fn report(stopped: bool) -> &'static str {
    if stopped {
        "Stopped the MCP bridge. `archestra bridge start` starts it again.\n\
         Auto-start did not change: `archestra bridge disable-auto-start` turns it off."
    } else {
        "The MCP bridge does not run in the background."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_says_what_stop_did_and_that_the_start_at_login_stays() {
        assert!(report(false).starts_with("The MCP bridge does not run"));
        let stopped = report(true);
        assert!(stopped.starts_with("Stopped the MCP bridge"));
        assert!(stopped.contains("Auto-start did not change"));
    }
}
