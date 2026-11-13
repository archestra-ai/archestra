//! The files that `archestra` keeps in the home folder of the user:
//!
//! ```text
//! ~/.archestra/bin/archestra               the program
//! ~/.archestra/mcp-bridge/config.yaml      the config file of the MCP bridge
//! ~/.archestra/mcp-bridge/mcp-bridge.log   the log file of the MCP bridge
//! ~/.archestra/mcp-bridge/mcp-bridge.log.1 the log file before it, put aside when it grew large
//! ~/.archestra/mcp-bridge/mcp-bridge.lock  held by the MCP bridge in the background
//! ~/.archestra/mcp-bridge/mcp-bridge.pid   its process id
//! ```
//!
//! On Windows the home folder is `%USERPROFILE%` and the program is
//! `archestra.exe`.
//!
//! Each function takes the home folder, so that a test never uses the real
//! one.

use std::path::{Path, PathBuf};

/// The program in the home folder: the copy that runs in the background.
pub fn program_path(home: &Path) -> PathBuf {
    bin_dir(home).join(format!("archestra{}", std::env::consts::EXE_SUFFIX))
}

/// The folder of the program.
pub fn bin_dir(home: &Path) -> PathBuf {
    archestra_dir(home).join("bin")
}

/// The folder of the MCP bridge: its config file and its log file.
pub fn bridge_dir(home: &Path) -> PathBuf {
    archestra_dir(home).join("mcp-bridge")
}

pub fn bridge_config_path(home: &Path) -> PathBuf {
    bridge_dir(home).join("config.yaml")
}

/// The log file of the MCP bridge that runs in the background.
pub fn bridge_log_path(home: &Path) -> PathBuf {
    bridge_dir(home).join("mcp-bridge.log")
}

/// The MCP bridge in the background holds a lock on this file while it runs
/// (Windows and Linux; launchd knows its job on macOS).
pub fn bridge_lock_path(home: &Path) -> PathBuf {
    bridge_dir(home).join("mcp-bridge.lock")
}

/// The process id of the MCP bridge that holds the lock.
pub fn bridge_pid_path(home: &Path) -> PathBuf {
    bridge_dir(home).join("mcp-bridge.pid")
}

/// The folder of all the files above. Other Archestra tools can keep files
/// in it too, so `archestra uninstall` removes it only when it is empty.
pub fn archestra_dir(home: &Path) -> PathBuf {
    home.join(".archestra")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_in_the_archestra_folder_of_the_home_folder() {
        let home = Path::new("/Users/someone");
        assert_eq!(
            program_path(home),
            PathBuf::from(format!(
                "/Users/someone/.archestra/bin/archestra{}",
                std::env::consts::EXE_SUFFIX
            ))
        );
        assert_eq!(
            bridge_config_path(home),
            PathBuf::from("/Users/someone/.archestra/mcp-bridge/config.yaml")
        );
        assert_eq!(
            bridge_log_path(home),
            PathBuf::from("/Users/someone/.archestra/mcp-bridge/mcp-bridge.log")
        );
        assert_eq!(
            bridge_lock_path(home),
            PathBuf::from("/Users/someone/.archestra/mcp-bridge/mcp-bridge.lock")
        );
        assert_eq!(
            bridge_pid_path(home),
            PathBuf::from("/Users/someone/.archestra/mcp-bridge/mcp-bridge.pid")
        );
    }
}
