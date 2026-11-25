//! The update of the `archestra` program from the Archestra that it is
//! connected to.
//!
//! Each sync says which program Archestra serves for this computer, with the
//! SHA-256 of its file. Another checksum than the one of the program that
//! runs is an update: [`update_of`]. The checksum decides, not the version,
//! so the computer also follows an Archestra that went back to an older
//! program.
//!
//! The update has two parts that are kept apart:
//!
//! 1. [`download_verified`] downloads the new program next to the installed
//!    one, as `~/.archestra/bin/archestra-update`, and checks its SHA-256.
//!    Nothing is touched before the checksum is right.
//! 2. The new program installs itself: it runs as `archestra bridge start`,
//!    which copies it over the installed one and starts the MCP bridge again.
//!    That is the same path as a start by the user, on each OS.
//!
//! `archestra update` ([`crate::update`]) does the two in a terminal.
//! [`auto_update_loop`] does them in the MCP bridge that the OS runs, on each
//! OS, when Archestra allows it and no command is in work. How the MCP
//! bridge starts the downloaded program is the part of each OS:
//! [`super::autostart::start_downloaded_program`].
//!
//! - macOS: a release is signed, so each build is the same application to
//!   the privacy settings of macOS, and an update keeps the permissions that
//!   the MCP servers got.
//! - The MCP bridge tries one program two times at most, and the second
//!   time only after a new start ([`MAX_TRIES`]). So an install that ended
//!   midway gets one more try at the next login, and a program that cannot
//!   install itself does not start the MCP bridge again at each sync.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::watch;
use tracing::{info, warn};

use super::control_plane::{self, ControlPlaneError, ServedProgram};
use super::files;
use super::state::{BridgeState, Update};
use crate::{layout, program};

/// How often the loop looks if a command is still in work.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(2);
/// After this long with commands in work, the update goes on: one command is
/// never in work for longer than two minutes.
const IDLE_WAIT_MAX: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("cannot download the program from Archestra: {0}")]
    Download(#[from] ControlPlaneError),
    #[error(
        "the downloaded program is not the one that Archestra named (SHA-256 {actual}, not {expected}); nothing was changed"
    )]
    WrongChecksum { expected: String, actual: String },
    #[error("cannot write the downloaded program to {path}: {source}")]
    Write { path: PathBuf, source: io::Error },
}

/// The automatic update of the MCP bridge that the OS runs.
#[derive(Debug, Clone)]
pub struct AutoUpdate {
    /// The home folder: the program is downloaded to its `.archestra/bin`.
    pub home: PathBuf,
    /// Starts the downloaded program (the first path), which installs
    /// itself and starts the MCP bridge again with the config file (the
    /// second path). The MCP bridge that calls it ends soon after.
    pub install: fn(&Path, &Path) -> io::Result<()>,
}

/// The update that a sync shows: Archestra serves a program with another
/// checksum than `own_sha256`. `None`: the same program, no program for this
/// computer, or the checksum of this program is not known.
pub fn update_of(served: Option<ServedProgram>, own_sha256: Option<&str>) -> Option<Update> {
    let served = served?;
    let own_sha256 = own_sha256?;
    (!served.sha256.eq_ignore_ascii_case(own_sha256)).then_some(Update {
        version: served.version,
        sha256: served.sha256,
        auto: served.auto_update,
    })
}

/// The arguments that make a downloaded program install itself: a start of
/// the MCP bridge with the config file that it has.
pub fn install_arguments(config_path: &Path) -> Vec<std::ffi::OsString> {
    ["bridge", "start", "--config"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .chain([config_path.as_os_str().to_owned()])
        .collect()
}

/// Where a downloaded program waits until it installs itself.
pub fn downloaded_program_path(home: &Path) -> PathBuf {
    layout::bin_dir(home).join(format!("archestra-update{}", std::env::consts::EXE_SUFFIX))
}

/// Downloads the program that Archestra serves for this computer and checks
/// that its SHA-256 is `expected_sha256`. Only then it writes the file, in
/// one step, and returns where it is.
pub async fn download_verified(
    http: &reqwest::Client,
    base_url: &str,
    expected_sha256: &str,
    home: &Path,
) -> Result<PathBuf, UpdateError> {
    let bytes = control_plane::download_program(http, base_url, &program::target()).await?;
    let actual = program::sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(UpdateError::WrongChecksum {
            expected: expected_sha256.to_owned(),
            actual,
        });
    }
    let path = downloaded_program_path(home);
    files::replace_file(&path, |temporary| {
        std::fs::write(temporary, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(temporary, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })
    .map_err(|source| UpdateError::Write {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

/// Removes a downloaded program that installed itself already. Best effort:
/// on Windows it can still run for a moment, and the next start removes it.
pub fn remove_downloaded_program(home: &Path) {
    let path = downloaded_program_path(home);
    // Not the file of this program: the downloaded program runs this code
    // too, while it installs itself.
    let is_this_program = std::env::current_exe()
        .ok()
        .and_then(|current| std::fs::canonicalize(current).ok())
        .zip(std::fs::canonicalize(&path).ok())
        .is_some_and(|(current, downloaded)| current == downloaded);
    if !is_this_program {
        let _ = std::fs::remove_file(path);
    }
}

/// How many times the MCP bridge tries one program by itself. The second try
/// is for an install that ended midway: it comes only after a new start of
/// the MCP bridge, for example at the next login.
const MAX_TRIES: u32 = 2;

/// The last program that the MCP bridge tried to install by itself, as
/// `<SHA-256> <number of tries>`. A program that Archestra still serves
/// after [`MAX_TRIES`] tries is not tried again: without this, a program that
/// cannot install itself would start the MCP bridge again at each sync.
fn tried_path(home: &Path) -> PathBuf {
    layout::bridge_dir(home).join("update-tried")
}

/// How many times the MCP bridge tried to install this program. The file of
/// a program before version 0.1.9 has the SHA-256 only: that is one try.
fn tries_of(home: &Path, sha256: &str) -> u32 {
    let Ok(text) = std::fs::read_to_string(tried_path(home)) else {
        return 0;
    };
    let mut words = text.split_whitespace();
    match words.next() {
        Some(tried) if tried.eq_ignore_ascii_case(sha256) => words
            .next()
            .and_then(|tries| tries.parse().ok())
            .unwrap_or(1),
        _ => 0,
    }
}

fn record_try(home: &Path, sha256: &str) -> io::Result<()> {
    let tries = tries_of(home, sha256).saturating_add(1);
    std::fs::write(tried_path(home), format!("{sha256} {tries}\n"))
}

/// Installs each update that the state shows, when Archestra allows it. It
/// does not return. With no `auto_update` it does nothing.
pub(crate) async fn auto_update_loop(
    auto_update: Option<&AutoUpdate>,
    base_url: &str,
    config_path: &Path,
    mut state: watch::Receiver<BridgeState>,
    in_flight: &AtomicUsize,
    retry_delay: Duration,
) {
    let Some(auto_update) = auto_update else {
        return std::future::pending().await;
    };
    let home = auto_update.home.as_path();
    // The program that this run of the MCP bridge tried already: the next
    // try of the same program is for a new start.
    let mut tried_in_this_run: Option<String> = None;
    loop {
        let wanted = |state: &BridgeState| {
            state.update.as_ref().is_some_and(|update| {
                update.auto
                    && !tried_in_this_run
                        .as_deref()
                        .is_some_and(|tried| tried.eq_ignore_ascii_case(&update.sha256))
                    && tries_of(home, &update.sha256) < MAX_TRIES
            })
        };
        // The borrow of the state ends with this statement: it is not held
        // over a wait.
        let update = state
            .wait_for(wanted)
            .await
            .map(|current| current.update.clone())
            .ok();
        let Some(update) = update else {
            // The MCP bridge ended.
            return std::future::pending().await;
        };
        let Some(update) = update else {
            continue;
        };

        wait_until_idle(in_flight).await;
        // A download that fails is tried again later: it is not a try of
        // the program.
        match download(base_url, &update, home).await {
            Ok(downloaded) => {
                tried_in_this_run = Some(update.sha256.clone());
                match install(auto_update, config_path, &update, &downloaded) {
                    Ok(()) => info!(
                        version = update.version.as_deref().unwrap_or("unknown"),
                        "the new program installs itself; this MCP bridge ends soon"
                    ),
                    Err(error) => warn!(%error, "the update of the program failed"),
                }
            }
            Err(error) => warn!(%error, "the update of the program failed"),
        }
        // After a good start of the new program this MCP bridge is stopped.
        // After a failure: not at once again.
        tokio::time::sleep(retry_delay).await;
    }
}

async fn wait_until_idle(in_flight: &AtomicUsize) {
    let deadline = tokio::time::Instant::now() + IDLE_WAIT_MAX;
    while in_flight.load(Ordering::Relaxed) > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(IDLE_CHECK_INTERVAL).await;
    }
}

#[derive(Debug, thiserror::Error)]
enum AutoUpdateError {
    #[error(transparent)]
    Update(#[from] UpdateError),
    #[error("cannot make the HTTP client: {0}")]
    HttpClient(#[source] ControlPlaneError),
    #[error("cannot write {path}: {source}")]
    RecordTry { path: PathBuf, source: io::Error },
    #[error("cannot start the downloaded program {path}: {source}")]
    Start { path: PathBuf, source: io::Error },
}

async fn download(
    base_url: &str,
    update: &Update,
    home: &Path,
) -> Result<PathBuf, AutoUpdateError> {
    let http = control_plane::http_client().map_err(AutoUpdateError::HttpClient)?;
    Ok(download_verified(&http, base_url, &update.sha256, home).await?)
}

/// Records the try, then starts the downloaded program. The try is recorded
/// first: the start of the program can end this MCP bridge at once.
fn install(
    auto_update: &AutoUpdate,
    config_path: &Path,
    update: &Update,
    downloaded: &Path,
) -> Result<(), AutoUpdateError> {
    let home = auto_update.home.as_path();
    record_try(home, &update.sha256).map_err(|source| AutoUpdateError::RecordTry {
        path: tried_path(home),
        source,
    })?;
    (auto_update.install)(downloaded, config_path).map_err(|source| AutoUpdateError::Start {
        path: downloaded.to_owned(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn served(sha256: &str, auto_update: bool) -> ServedProgram {
        ServedProgram {
            version: Some("0.2.0".to_owned()),
            sha256: sha256.to_owned(),
            auto_update,
        }
    }

    #[test]
    fn another_checksum_is_an_update_and_the_same_one_is_not() {
        assert_eq!(
            update_of(Some(served("bb", true)), Some("aa")),
            Some(Update {
                version: Some("0.2.0".to_owned()),
                sha256: "bb".to_owned(),
                auto: true,
            })
        );
        assert_eq!(update_of(Some(served("AA", true)), Some("aa")), None);
        // Archestra has no program for this computer, or the checksum of
        // this program is not known: no update.
        assert_eq!(update_of(None, Some("aa")), None);
        assert_eq!(update_of(Some(served("bb", true)), None), None);
        // Archestra does not let the MCP bridge update itself: the update is
        // still shown.
        assert_eq!(
            update_of(Some(served("bb", false)), Some("aa")).map(|update| update.auto),
            Some(false)
        );
    }

    #[test]
    fn the_tries_of_a_program_are_counted() {
        let home = tempfile::tempdir().expect("temp home");
        std::fs::create_dir_all(layout::bridge_dir(home.path())).expect("mkdir");
        assert_eq!(tries_of(home.path(), "aa"), 0);
        record_try(home.path(), "aa").expect("record");
        assert_eq!(tries_of(home.path(), "aa"), 1);
        assert_eq!(tries_of(home.path(), "AA"), 1);
        record_try(home.path(), "aa").expect("record");
        assert_eq!(tries_of(home.path(), "aa"), MAX_TRIES);
        // Another program starts at no tries, and takes the place of the
        // one before.
        assert_eq!(tries_of(home.path(), "bb"), 0);
        record_try(home.path(), "bb").expect("record");
        assert_eq!(tries_of(home.path(), "bb"), 1);
        assert_eq!(tries_of(home.path(), "aa"), 0);
    }

    #[test]
    fn the_file_of_an_older_program_is_one_try() {
        let home = tempfile::tempdir().expect("temp home");
        std::fs::create_dir_all(layout::bridge_dir(home.path())).expect("mkdir");
        // A program before version 0.1.9 wrote the SHA-256 only.
        std::fs::write(tried_path(home.path()), "aa\n").expect("write");
        assert_eq!(tries_of(home.path(), "aa"), 1);
        record_try(home.path(), "aa").expect("record");
        assert_eq!(tries_of(home.path(), "aa"), 2);
    }

    #[test]
    fn the_downloaded_program_waits_next_to_the_installed_one() {
        let home = Path::new("/h");
        assert_eq!(
            downloaded_program_path(home),
            layout::bin_dir(home).join(format!("archestra-update{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(
            downloaded_program_path(home).parent(),
            layout::program_path(home).parent()
        );
    }
}
