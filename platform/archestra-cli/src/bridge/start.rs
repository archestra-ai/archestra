//! `archestra bridge start`: signs in if needed, then runs the MCP bridge.
//!
//! Started by the user, the program copies itself to `~/.archestra/bin/` and
//! starts the copy in the background: the command in the terminal ends. The
//! first start on a computer (the one that signs in) also adds the copy to the
//! start at login and puts it on the `PATH` of the user
//! ([`crate::shell_path`]); a later start keeps what `archestra bridge enable-auto-start` and
//! `archestra bridge disable-auto-start` set. Started by the OS (`--background`), this
//! process is the MCP bridge. See [`super::autostart`] for each OS.

use std::path::PathBuf;
use std::process::ExitCode;

use tracing::{error, info};

use super::{Bridge, BridgeError, RunOptions, StartOptions, Timings};
use crate::layout;

/// The options of `archestra bridge start`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StartArgs {
    /// The address of Archestra. Necessary for the first run only.
    pub url: Option<String>,
    /// The config file. Default: `~/.archestra/mcp-bridge/config.yaml`.
    pub config: Option<PathBuf>,
    pub no_tray: bool,
    /// Run in this terminal, not in the background.
    pub foreground: bool,
    pub no_open: bool,
    /// From the command of a setup dialog in Archestra.
    pub setup_code: Option<String>,
    /// This process is the MCP bridge in the background: the OS sets it.
    pub background: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("cannot find the home folder; give the config file with --config")]
    NoHome,
    #[error("cannot start the runtime: {0}")]
    Runtime(std::io::Error),
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    #[cfg(any(target_os = "macos", windows))]
    #[error(transparent)]
    Tray(#[from] super::tray::TrayError),
    #[cfg(any(target_os = "linux", windows))]
    #[error("cannot take the lock of the MCP bridge in the background: {0}")]
    Lock(#[source] std::io::Error),
}

/// Runs `archestra bridge start`. It returns when the MCP bridge ends, or at
/// once when the MCP bridge runs in the background from now on.
pub fn run(args: StartArgs) -> Result<ExitCode, StartError> {
    // The MCP bridge in the background on Windows and Linux: one at a time,
    // and `bridge stop` finds it (launchd knows its job on macOS).
    #[cfg(any(target_os = "linux", windows))]
    let instance = if args.background {
        let home = std::env::home_dir().ok_or(StartError::NoHome)?;
        match super::instance::InstanceLock::acquire(&home).map_err(StartError::Lock)? {
            Some(lock) => Some(lock),
            None => {
                info!("an MCP bridge runs in the background already");
                return Ok(ExitCode::SUCCESS);
            }
        }
    } else {
        None
    };
    #[cfg(windows)]
    let stop_requests = match &instance {
        Some(_) => Some(super::instance::StopRequests::listen().map_err(StartError::Lock)?),
        None => None,
    };

    let config_path = match args.config {
        Some(path) => std::path::absolute(&path).unwrap_or(path),
        None => layout::bridge_config_path(&std::env::home_dir().ok_or(StartError::NoHome)?),
    };
    // The first start on this computer: the sign-in below writes the file.
    let first_start = !config_path.is_file();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(StartError::Runtime)?;

    // Sign in (first run) and sync the config file from Archestra.
    let prepared = runtime.block_on(super::prepare(&StartOptions {
        url: args.url,
        config_path: config_path.clone(),
        open_browser: !args.no_open,
        setup_code: args.setup_code,
    }))?;
    info!(config = %config_path.display(), "the config file is ready");

    // Started by the user: let the OS run the MCP bridge in the background
    // from now on, and add it to the start at login at the first start.
    // Started by the OS (`--background`): this is that run.
    if !args.foreground && !args.background && super::autostart::start(&config_path, first_start) {
        if first_start {
            put_the_program_on_the_path();
        }
        return Ok(ExitCode::SUCCESS);
    }

    let shutdown = Shutdown {
        #[cfg(windows)]
        stop_requests,
    };
    // For "Open Device tab" of the tray menu.
    #[cfg(any(target_os = "macos", windows))]
    let base_url = prepared.config.control_plane.base_url.clone();
    if args.background
        && let Some(home) = std::env::home_dir()
    {
        // A program that an update downloaded installed itself by now.
        super::update::remove_downloaded_program(&home);
    }
    let (bridge, handle) = Bridge::new(RunOptions {
        auto_update: auto_update_of(args.background),
        config_path,
        control_plane: prepared.config.control_plane,
        timings: Timings::default(),
        sync: prepared.sync,
        update: prepared.update,
    });
    #[cfg(any(target_os = "macos", windows))]
    if !args.no_tray {
        return run_with_tray(runtime, bridge, handle, &base_url, shutdown);
    }
    #[cfg(target_os = "linux")]
    if !args.no_tray {
        info!(
            "Linux has no tray icon: the Device tab of Personal Settings in Archestra shows the state"
        );
    }

    // No tray menu: nothing uses the handle. The sync, the requests of
    // Archestra and the state report do not need it.
    drop(handle);
    let code = runtime.block_on(run_headless(bridge, shutdown));
    // Held until the MCP bridge ended.
    #[cfg(any(target_os = "linux", windows))]
    drop(instance);
    Ok(code)
}

/// The MCP bridge that the OS runs from `~/.archestra/bin/` updates itself,
/// on Windows only. A run in a terminal never replaces a program. The user
/// runs `archestra update` on the other systems:
///
/// - macOS: the program is not signed, and each build is a new application
///   to the privacy settings (see [`super::update`]).
/// - Linux: the downloaded program would run in the systemd unit of the MCP
///   bridge. Its first step stops that MCP bridge, and systemd then ends the
///   rest of the unit, the downloaded program too, before it starts the MCP
///   bridge again.
#[cfg(windows)]
fn auto_update_of(background: bool) -> Option<super::AutoUpdate> {
    if !background {
        return None;
    }
    let home = std::env::home_dir()?;
    let installed = std::fs::canonicalize(layout::program_path(&home)).ok()?;
    let current = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    (current == installed).then_some(super::AutoUpdate {
        home,
        install: start_downloaded_program,
    })
}

#[cfg(not(windows))]
fn auto_update_of(_background: bool) -> Option<super::AutoUpdate> {
    None
}

/// Starts the downloaded program as a process of its own, as `archestra
/// bridge start`: it stops this MCP bridge, copies itself over the installed
/// program and starts the MCP bridge again.
#[cfg(windows)]
fn start_downloaded_program(
    program: &std::path::Path,
    config_path: &std::path::Path,
) -> std::io::Result<()> {
    let arguments = super::update::install_arguments(config_path);
    super::autostart::spawn_detached(program, &arguments).map(drop)
}

/// The last step of the first start on a computer: `archestra` works in each
/// new terminal. A failure is only a warning: the MCP bridge runs, and the
/// program works with its full path.
fn put_the_program_on_the_path() {
    let Some(home) = std::env::home_dir() else {
        return;
    };
    match crate::shell_path::add(&home) {
        Ok(added) => println!("{}", added.message()),
        Err(error) => {
            tracing::warn!(%error, "cannot put the `archestra` command on the PATH");
        }
    }
}

/// Runs until the device is signed out (exit code 1) or a stop comes.
async fn run_headless(mut bridge: Bridge, shutdown: Shutdown) -> ExitCode {
    tokio::select! {
        ended = bridge.run() => {
            match ended {
                Ok(()) => error!("signed out; run `archestra bridge start` again to sign in"),
                Err(error) => error!(%error, "the MCP bridge stopped"),
            }
            ExitCode::FAILURE
        }
        () = shutdown.wait() => {
            info!("stopping");
            ExitCode::SUCCESS
        }
    }
}

/// What stops the MCP bridge, besides Quit in the tray menu.
struct Shutdown {
    /// `archestra bridge stop`, for the MCP bridge in the background.
    #[cfg(windows)]
    stop_requests: Option<super::instance::StopRequests>,
}

impl Shutdown {
    /// Ctrl-C or SIGTERM. `launchctl bootout`, `systemctl --user stop` and
    /// `archestra bridge stop` send SIGTERM.
    #[cfg(unix)]
    async fn wait(self) {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate()).expect("install the SIGTERM handler");
        let mut interrupt = signal(SignalKind::interrupt()).expect("install the SIGINT handler");
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    }

    /// The stop request of `archestra bridge stop` for the MCP bridge in the
    /// background, Ctrl-C for one in a terminal. The MCP bridge in the
    /// background has no console, so it does not listen for console events.
    #[cfg(windows)]
    async fn wait(self) {
        let Some(requests) = self.stop_requests else {
            if tokio::signal::ctrl_c().await.is_err() {
                std::future::pending::<()>().await;
            }
            return;
        };
        // A thread of its own, not `spawn_blocking`: the runtime does not wait
        // for it when it shuts down.
        let (sender, receiver) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            if requests.wait().is_ok() {
                let _ = sender.send(());
            }
        });
        if receiver.await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Runs the MCP bridge on the runtime and the tray icon on this (the main)
/// thread. A signed-out MCP bridge stays, so that the tray shows the state.
#[cfg(any(target_os = "macos", windows))]
fn run_with_tray(
    runtime: tokio::runtime::Runtime,
    mut bridge: Bridge,
    handle: super::BridgeHandle,
    base_url: &str,
    shutdown: Shutdown,
) -> Result<ExitCode, StartError> {
    runtime.spawn(async move {
        let serve = async {
            match bridge.run().await {
                // Signed out: wait for Quit or a stop.
                Ok(()) => std::future::pending::<()>().await,
                Err(error) => error!(%error, "the MCP bridge stopped"),
            }
        };
        tokio::select! {
            () = serve => {}
            () = shutdown.wait() => info!("stopping"),
        }
        // Dropping `bridge` here closes its state: that tells the tray to
        // end the program.
    });
    super::tray::run(runtime, handle, base_url)?;
    Ok(ExitCode::SUCCESS)
}

/// The log file of the MCP bridge in the background on Windows and Linux.
/// launchd writes the output of the job to the log file; the start at login
/// of the other systems does not, so the program sends its own stdout and
/// stderr there. The stderr lines of the MCP servers go there as well.
/// Without it the program writes to the stderr it has.
///
/// A log file that grew large is put aside first (`mcp-bridge.log.1`), and
/// this start begins a new file. On macOS launchd opens the file, so
/// [`super::autostart::start`] puts it aside before launchd starts the job.
#[cfg(any(target_os = "linux", windows))]
pub fn write_output_to_log_file() -> std::io::Result<()> {
    use super::files;

    let home = std::env::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home folder"))?;
    let path = layout::bridge_log_path(&home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Not while an MCP bridge in the background runs: it writes to this
    // file, and this process ends at once. Best effort: a file that cannot
    // be put aside is written on.
    if !matches!(super::instance::is_running(&home), Ok(true)) {
        let _ = files::rotate_log_file(&path, files::MAX_LOG_FILE_LEN);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    #[cfg(unix)]
    {
        rustix::stdio::dup2_stdout(&file)?;
        rustix::stdio::dup2_stderr(&file)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::IntoRawHandle;
        use windows_sys::Win32::System::Console::{
            FreeConsole, GetConsoleProcessList, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
        };

        // Started by the Run key, the program got a console window of its
        // own: close it. A console that it shares (a terminal) stays.
        let mut processes = [0u32; 2];
        // SAFETY: the buffer and its length match.
        let attached = unsafe { GetConsoleProcessList(processes.as_mut_ptr(), 2) };
        if attached == 1 {
            // SAFETY: plain call.
            unsafe { FreeConsole() };
        }
        // The handle stays open for the life of the process.
        let handle = file.into_raw_handle();
        // SAFETY: the handle is a valid file handle that is never closed.
        let set = unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, handle) != 0
                && SetStdHandle(STD_ERROR_HANDLE, handle) != 0
        };
        if !set {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}
