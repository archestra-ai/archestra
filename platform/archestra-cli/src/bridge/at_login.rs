//! `archestra bridge enable-auto-start` and `archestra bridge
//! disable-auto-start`: turn the auto-start of the MCP bridge on and off. With
//! auto-start, the OS starts the MCP bridge at each login.
//!
//! They change only what happens at the next login. They do not start or
//! stop the MCP bridge: `archestra bridge start` and `archestra bridge stop`
//! do that. See [`super::autostart`] for each OS.

use std::process::ExitCode;

use super::autostart::{self, AutostartError};
use crate::layout;

/// Runs `archestra bridge enable-auto-start`.
pub fn enable() -> Result<ExitCode, AutostartError> {
    let home = std::env::home_dir().ok_or(AutostartError::NoHome)?;
    autostart::enable(&layout::bridge_config_path(&home))?;
    println!(
        "Auto-start is on: the MCP bridge starts at each login from now on.\n\
         This does not start it now: `archestra bridge start` does."
    );
    Ok(ExitCode::SUCCESS)
}

/// Runs `archestra bridge disable-auto-start`. Nothing to remove is a success.
pub fn disable() -> Result<ExitCode, AutostartError> {
    println!("{}", disabled_report(autostart::disable()?));
    Ok(ExitCode::SUCCESS)
}

fn disabled_report(removed: bool) -> &'static str {
    if removed {
        "Auto-start is off: the MCP bridge does not start at login any more.\n\
         This does not stop it now: `archestra bridge stop` does."
    } else {
        "Auto-start was off already."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_says_that_disable_does_not_stop() {
        assert!(disabled_report(true).contains("This does not stop it now"));
        assert!(disabled_report(false).starts_with("Auto-start was off already"));
    }
}
