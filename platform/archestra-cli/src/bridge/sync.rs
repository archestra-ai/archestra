//! The sync: get the config of the device from Archestra and write the
//! config file from it.
//!
//! The tunnel client syncs when it starts, when Archestra says that the
//! config changed, when the user asks in the tray menu, and at a regular
//! interval. A sync writes the file only when Archestra has other MCP entries
//! than the file; the supervisor of the MCP servers reads the file after each
//! write. If a sync fails, the file and the MCP servers stay as they are.

use std::path::Path;
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, oneshot, watch};
use tracing::{debug, info, warn};

use crate::bridge::config::{Config, ConfigError, ControlPlaneConfig};
use crate::bridge::control_plane::{ControlPlane, ControlPlaneError};
use crate::bridge::state::{BridgeState, SyncState, Update};
use crate::bridge::update::update_of;

#[derive(Debug, thiserror::Error)]
pub(crate) enum SyncError {
    #[error("could not get the config from Archestra: {0}")]
    ControlPlane(#[from] ControlPlaneError),
    #[error(transparent)]
    Config(#[from] ConfigError),
}

/// Asks the sync loop for a sync now.
#[derive(Debug)]
pub(crate) struct SyncRequest {
    /// Gets the result of the sync. `None`: nobody waits for it.
    pub reply: Option<oneshot::Sender<Result<(), SyncError>>>,
}

/// What one sync did.
#[derive(Debug)]
pub(crate) struct Synced {
    /// The config that is in the file now.
    pub config: Config,
    /// The time of this sync, in whole seconds as `synced_at` of the file
    /// has a time.
    pub synced_at: Option<SystemTime>,
    /// The sync wrote the file.
    pub wrote_file: bool,
    /// Archestra serves another program than the one that runs.
    pub update: Option<Update>,
}

/// Does one sync. The file gets the entries that Archestra lists and no
/// other entry. A file that has them already stays as it is, with its
/// `synced_at`: so the supervisor does not read the file again, and no state
/// report follows.
pub(crate) async fn sync(
    control_plane: &ControlPlane,
    sign_in: &ControlPlaneConfig,
    config_path: &Path,
) -> Result<Synced, SyncError> {
    let metadata = control_plane.tunnel_metadata().await?;
    let fresh =
        Config::from_catalog_items(sign_in.clone(), &metadata.catalog_items, SystemTime::now());
    let synced_at = fresh.last_sync();
    let update = update_of(metadata.program, crate::program::own_sha256());
    // A file that is missing or not valid is not up to date: the sync
    // writes it again.
    let current = Config::load(config_path).ok().flatten();
    Ok(match current {
        Some(current) if is_up_to_date(&current, &fresh) => Synced {
            config: current,
            synced_at,
            wrote_file: false,
            update,
        },
        _ => {
            fresh.save(config_path)?;
            Synced {
                config: fresh,
                synced_at,
                wrote_file: true,
                update,
            }
        }
    })
}

/// `true` when a sync has nothing to write: the file has the sign-in and the
/// MCP entries of `fresh`, and the time of a sync. A file with no such time
/// (no sync was done yet) gets the time of its first sync.
fn is_up_to_date(current: &Config, fresh: &Config) -> bool {
    current.control_plane == fresh.control_plane
        && current.mcp == fresh.mcp
        && current.last_sync().is_some()
}

/// Syncs each time a request comes, and when `interval` passed with no sync.
/// It writes the result of each sync into `state`. It does not return.
pub(crate) async fn sync_loop(
    control_plane: &ControlPlane,
    sign_in: &ControlPlaneConfig,
    config_path: &Path,
    interval: Duration,
    requests: &mut mpsc::Receiver<SyncRequest>,
    state: &watch::Sender<BridgeState>,
) {
    loop {
        let reply = tokio::select! {
            () = tokio::time::sleep(interval) => None,
            Some(request) = requests.recv() => request.reply,
        };
        let synced = sync(control_plane, sign_in, config_path).await;
        let sync_state = match &synced {
            Ok(synced) => {
                if synced.wrote_file {
                    info!("synced from Archestra: wrote the config file");
                } else {
                    debug!("synced from Archestra: the config file is up to date");
                }
                SyncState {
                    synced_at: synced.synced_at,
                    failed: false,
                }
            }
            Err(error) => {
                warn!(%error, "the sync failed; the config file stays as it is");
                SyncState {
                    synced_at: state.borrow().sync.synced_at,
                    failed: true,
                }
            }
        };
        // A sync that failed says nothing of the program: what the last good
        // sync said stays.
        let update = synced.as_ref().ok().map(|synced| synced.update.clone());
        state.send_if_modified(|state| {
            let mut changed = state.sync != sync_state;
            state.sync = sync_state;
            if let Some(update) = update
                && state.update != update
            {
                state.update = update;
                changed = true;
            }
            changed
        });
        if let Some(reply) = reply {
            // The one that asked can be gone (deadline).
            let _ = reply.send(synced.map(|_synced| ()));
        }
    }
}
