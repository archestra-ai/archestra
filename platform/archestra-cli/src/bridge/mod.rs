//! The MCP bridge: the Archestra tunnel client.
//!
//! It runs on the computer of a user. It asks Archestra for MCP requests (a
//! long poll), sends each to an MCP server on the computer (a stdio process
//! or a local streamable HTTP server), and posts the MCP response.
//!
//! Archestra has the config of the MCP servers: the command or the URL of
//! each, and whether it is on. The tunnel client keeps a
//! copy in the config file and brings it up to date with a sync.
//!
//! [`prepare`] signs the device in and does the first sync. [`Bridge::run`]
//! does the work until Archestra rejects the device key. [`start`] and
//! [`stop`] are the commands `archestra bridge start` and
//! `archestra bridge stop`; [`at_login`] has `archestra bridge enable-auto-start` and
//! `archestra bridge disable-auto-start`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

pub mod at_login;
pub mod autostart;
mod backoff;
mod channels;
mod command_line;
pub mod config;
mod control;
pub mod control_plane;
mod dispatcher;
mod files;
mod http_server;
#[cfg(any(target_os = "linux", windows, test))]
mod instance;
mod jsonrpc;
mod open_url;
mod process_tree;
pub mod remove;
mod report;
pub mod sign_in;
pub mod start;
pub mod state;
mod stdio_server;
pub mod stop;
mod sync;
mod template;
mod timestamp;
#[cfg(any(target_os = "macos", windows))]
pub mod tray;
pub mod update;
mod wait;
#[cfg(windows)]
pub(crate) mod win32;

pub use backoff::Backoff;
pub use state::{BridgeState, BridgeStatus, ServerState, ServerStatus, SyncState, Update};
pub use update::AutoUpdate;

use channels::{ChannelMap, Supervisor};
use config::{Config, ConfigError, ControlPlaneConfig};
use control::Control;
use control_plane::{ControlPlane, ControlPlaneError};
use sign_in::SignInError;
use sync::{SyncError, SyncRequest, Synced};
use template::Variables;

/// Sync requests that wait for the sync loop. A request that finds the queue
/// full is dropped: a sync that did not start yet gets the same config.
const SYNC_QUEUE: usize = 8;
/// Restart requests that wait for the supervisor. It takes them at once.
const RESTART_QUEUE: usize = 8;

/// The waits of the client. [`Timings::default`] has the values for normal
/// operation; tests use short ones.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    /// The hold that the client asks for with each poll (`timeout_ms`).
    pub poll_wait: Duration,
    /// The poll request gives up this long after `poll_wait`.
    pub poll_guard: Duration,
    /// How often the client looks at the modification time of the config file.
    pub config_check_interval: Duration,
    /// The client syncs the config file when this time passed with no sync.
    pub sync_interval: Duration,
    /// The wait between a change of the state and its report to Archestra.
    /// Changes that come in this time make one report.
    pub state_report_delay: Duration,
    /// Retries of polls and response POSTs.
    pub control_plane_backoff: Backoff,
    /// Restarts of stdio MCP servers and reconnects to HTTP MCP servers.
    pub mcp_server_backoff: Backoff,
    /// The longest wait for the `initialize` answer of an MCP server.
    pub initialize_timeout: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            // The values of the OpenAI client: 30 s poll wait, 5 s guard.
            poll_wait: Duration::from_secs(30),
            poll_guard: Duration::from_secs(5),
            config_check_interval: Duration::from_secs(2),
            sync_interval: Duration::from_secs(5 * 60),
            state_report_delay: Duration::from_millis(500),
            control_plane_backoff: Backoff {
                initial: Duration::from_millis(500),
                max: Duration::from_secs(30),
            },
            mcp_server_backoff: Backoff {
                initial: Duration::from_secs(1),
                max: Duration::from_secs(30),
            },
            initialize_timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    SignIn(#[from] SignInError),
    #[error("cannot make the HTTP client: {0}")]
    HttpClient(#[source] ControlPlaneError),
    #[error("cannot make the HTTP client for the local MCP servers: {0}")]
    LocalHttpClient(#[source] reqwest::Error),
    #[error("no config file at {path}: give the address of Archestra with --url")]
    UrlRequired { path: PathBuf },
    #[error("--url must be an http:// or https:// address")]
    InvalidUrl,
}

/// How [`prepare`] starts.
#[derive(Debug, Clone)]
pub struct StartOptions {
    /// The address of Archestra. Necessary only when no config file exists.
    pub url: Option<String>,
    pub config_path: PathBuf,
    /// Open the approval page in the browser. The URL is printed always.
    pub open_browser: bool,
}

/// What [`prepare`] made ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    /// The config that is in the config file.
    pub config: Config,
    /// How the sync at the start went.
    pub sync: SyncState,
    /// Archestra serves another program than the one that runs.
    pub update: Option<Update>,
}

/// Makes the device ready to run:
///
/// 1. No config file: sign in and write the file.
/// 2. Sync: get the config of the device from Archestra and, when it has
///    other MCP entries than the file, write the file from it.
/// 3. If Archestra rejects the device key in step 2: sign in again and do
///    step 2 again.
///
/// If Archestra cannot be reached in step 2, the file stays as it is: the
/// tunnel client runs the MCP servers of the last sync.
pub async fn prepare(options: &StartOptions) -> Result<Prepared, BridgeError> {
    let http = control_plane::http_client().map_err(BridgeError::HttpClient)?;
    let path = options.config_path.as_path();

    let mut config = match Config::load(path)? {
        Some(config) => {
            let other_url = options
                .url
                .as_deref()
                .map(config::normalize_base_url)
                .filter(|url| *url != config.control_plane.base_url);
            if let Some(url) = other_url {
                warn!(
                    url,
                    base_url = config.control_plane.base_url,
                    "--url has no effect: the config file has the address of Archestra"
                );
            }
            config
        }
        None => {
            let url = options
                .url
                .as_deref()
                .ok_or_else(|| BridgeError::UrlRequired {
                    path: path.to_owned(),
                })?;
            let base_url = config::normalize_base_url(url);
            if !config::is_http_url(&base_url) {
                return Err(BridgeError::InvalidUrl);
            }
            let control_plane = sign_in::sign_in(&http, &base_url, options.open_browser).await?;
            let config = Config::new(control_plane);
            config.save(path)?;
            info!(path = %path.display(), "signed in; wrote the config file");
            config
        }
    };

    let mut synced = sync_at_start(&http, &config.control_plane, path).await?;
    if matches!(synced, StartSync::KeyRejected) {
        warn!("Archestra rejected the device key; signing in again");
        config.control_plane =
            sign_in::sign_in(&http, &config.control_plane.base_url, options.open_browser).await?;
        config.save(path)?;
        synced = sync_at_start(&http, &config.control_plane, path).await?;
    }
    Ok(match synced {
        StartSync::Synced(synced) => Prepared {
            sync: SyncState {
                synced_at: synced.synced_at,
                failed: false,
            },
            update: synced.update,
            config: synced.config,
        },
        // The time in the file is the best that is known of the last good
        // sync: the time of the last one that changed the MCP entries.
        StartSync::Failed | StartSync::KeyRejected => Prepared {
            sync: SyncState {
                synced_at: config.last_sync(),
                failed: true,
            },
            update: None,
            config,
        },
    })
}

/// How the sync of [`prepare`] ended.
enum StartSync {
    /// The sync was successful.
    Synced(Box<Synced>),
    /// The config file stays as it is.
    Failed,
    KeyRejected,
}

async fn sync_at_start(
    http: &reqwest::Client,
    sign_in: &ControlPlaneConfig,
    path: &Path,
) -> Result<StartSync, ConfigError> {
    let control_plane = ControlPlane::new(http.clone(), sign_in);
    match sync::sync(&control_plane, sign_in, path).await {
        Ok(synced) => {
            info!(path = %path.display(), "synced the config file from Archestra");
            Ok(StartSync::Synced(Box::new(synced)))
        }
        Err(SyncError::ControlPlane(error)) if error.is_auth() => Ok(StartSync::KeyRejected),
        Err(SyncError::ControlPlane(error)) => {
            warn!(%error, "could not sync from Archestra; the config file stays as it is");
            Ok(StartSync::Failed)
        }
        Err(SyncError::Config(error)) => Err(error),
    }
}

/// The error of [`served_program`].
pub type ServedProgramError = ControlPlaneError;

/// The HTTP client for the calls to Archestra.
pub fn http_client() -> Result<reqwest::Client, ControlPlaneError> {
    control_plane::http_client()
}

/// Asks Archestra which `archestra` program it serves for this computer.
/// `None`: it serves none.
pub async fn served_program(
    sign_in: &ControlPlaneConfig,
) -> Result<Option<control_plane::ServedProgram>, ControlPlaneError> {
    let control_plane = ControlPlane::new(control_plane::http_client()?, sign_in);
    Ok(control_plane.tunnel_metadata().await?.program)
}

/// How a [`Bridge`] runs.
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub config_path: PathBuf,
    /// The sign-in of the device, from the config file.
    pub control_plane: ControlPlaneConfig,
    pub timings: Timings,
    /// How the sync of [`prepare`] went.
    pub sync: SyncState,
    /// What the sync of [`prepare`] said of the program.
    pub update: Option<Update>,
    /// `Some`: the MCP bridge updates itself. Only the MCP bridge that the
    /// OS runs from `~/.archestra/bin/` gets it; a run in a terminal and a
    /// test never replace a program.
    pub auto_update: Option<AutoUpdate>,
}

/// The tunnel client.
#[derive(Debug)]
pub struct Bridge {
    options: RunOptions,
    state: watch::Sender<BridgeState>,
    sync_requests: mpsc::Receiver<SyncRequest>,
    /// The sender for the sync requests of Archestra.
    sync_sender: mpsc::Sender<SyncRequest>,
}

/// What the tray menu has of a [`Bridge`]: its state, and the way to ask for
/// a sync. A clone is cheap.
#[derive(Debug, Clone)]
pub struct BridgeHandle {
    /// Closes when the [`Bridge`] is dropped.
    pub state: watch::Receiver<BridgeState>,
    sync_requests: mpsc::Sender<SyncRequest>,
}

impl BridgeHandle {
    /// Asks for a sync from Archestra now. It does not wait for the sync:
    /// `state` shows the result.
    pub fn sync_now(&self) {
        let _ = self.sync_requests.try_send(SyncRequest { reply: None });
    }
}

impl Bridge {
    pub fn new(options: RunOptions) -> (Self, BridgeHandle) {
        let mut state = BridgeState::new(options.sync);
        state.update = options.update.clone();
        let (state_tx, state_rx) = watch::channel(state);
        let (sync_tx, sync_rx) = mpsc::channel(SYNC_QUEUE);
        let handle = BridgeHandle {
            state: state_rx,
            sync_requests: sync_tx.clone(),
        };
        let bridge = Self {
            options,
            state: state_tx,
            sync_requests: sync_rx,
            sync_sender: sync_tx,
        };
        (bridge, handle)
    }

    /// Runs the tunnel client: keeps the MCP servers of the config file in
    /// operation, polls Archestra, answers the commands, syncs the config
    /// file, and reports the state to Archestra.
    ///
    /// It returns only when Archestra rejects the device key (the status is
    /// then [`BridgeStatus::SignedOut`]). Dropping the future stops the MCP
    /// servers.
    pub async fn run(&mut self) -> Result<(), BridgeError> {
        let options = &self.options;
        let timings = options.timings;
        let state = &self.state;
        let http = control_plane::http_client().map_err(BridgeError::HttpClient)?;
        // The MCP servers are on this computer: no proxy.
        let local_http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(BridgeError::LocalHttpClient)?;
        let control_plane = Arc::new(ControlPlane::new(http, &options.control_plane));
        let (channels_tx, channels_rx) = watch::channel(Arc::new(ChannelMap::new()));
        let (restarts_tx, restarts_rx) = mpsc::channel(RESTART_QUEUE);
        let control = Control {
            sync_requests: self.sync_sender.clone(),
            restarts: restarts_tx,
            channels: channels_rx.clone(),
        };
        let supervisor = Supervisor::new(local_http, timings, Variables::of_this_device());
        // How many commands of Archestra are in work: an update waits for none.
        let in_flight = std::sync::atomic::AtomicUsize::new(0);

        // All parts run in this one task. Only the poll loop ends: when the
        // device is signed out. That stops the other parts and the MCP
        // servers.
        tokio::select! {
            () = supervisor.run(options.config_path.clone(), restarts_rx, channels_tx, state) => {}
            () = dispatcher::poll_loop(Arc::clone(&control_plane), channels_rx, control, timings, state, &in_flight) => {}
            () = sync::sync_loop(
                &control_plane,
                &options.control_plane,
                &options.config_path,
                timings.sync_interval,
                &mut self.sync_requests,
                state,
            ) => {}
            () = report::report_loop(&control_plane, state.subscribe(), timings.state_report_delay) => {}
            () = update::auto_update_loop(
                options.auto_update.as_ref(),
                &options.control_plane.base_url,
                &options.config_path,
                state.subscribe(),
                &in_flight,
                timings.sync_interval,
            ) => {}
        }
        // No MCP server runs any more.
        state.send_modify(|state| state.servers.clear());
        Ok(())
    }
}
