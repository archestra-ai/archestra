//! The MCP bridge part of `archestra uninstall`, after the MCP bridge is
//! stopped and out of the start at login ([`super::autostart::remove`]):
//! Archestra removes the device, and the folder of the MCP bridge goes away.

use std::io;
use std::path::Path;

use super::config::Config;
use super::control_plane::{self, ControlPlane};
use crate::layout;

/// What Archestra knows about this computer after the uninstall.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceRemoval {
    /// Archestra removed the device, or does not know its key any more: the
    /// Device tab does not show this computer.
    Removed,
    /// No config file: this computer was not signed in.
    NotSignedIn,
    /// Archestra did not remove the device. The Device tab still shows this
    /// computer, as offline, until the user removes it there.
    Failed {
        /// The address of Archestra, when the config file gave it.
        base_url: Option<String>,
        reason: String,
    },
}

/// Asks Archestra to remove the device of this computer, then deletes the
/// folder of the MCP bridge: the config file with the device key, and the log
/// files. Archestra is asked first, because the device key is in that folder.
/// A failure of that call does not stop the uninstall: the user can remove
/// the device on the Device tab.
pub async fn forget_device(home: &Path) -> io::Result<DeviceRemoval> {
    let device = remove_device(home).await;
    match std::fs::remove_dir_all(layout::bridge_dir(home)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Ok(device)
}

async fn remove_device(home: &Path) -> DeviceRemoval {
    let config = match Config::load(&layout::bridge_config_path(home)) {
        Ok(Some(config)) => config,
        Ok(None) => return DeviceRemoval::NotSignedIn,
        Err(error) => {
            return DeviceRemoval::Failed {
                base_url: None,
                reason: error.to_string(),
            };
        }
    };
    let failed = |reason: String| DeviceRemoval::Failed {
        base_url: Some(config.control_plane.base_url.clone()),
        reason,
    };
    let http = match control_plane::http_client() {
        Ok(http) => http,
        Err(error) => return failed(error.to_string()),
    };
    match ControlPlane::new(http, &config.control_plane)
        .remove_device()
        .await
    {
        Ok(()) => DeviceRemoval::Removed,
        // Archestra does not know the key: the user removed the device there.
        Err(error) if error.is_auth() => DeviceRemoval::Removed,
        Err(error) => failed(error.to_string()),
    }
}
