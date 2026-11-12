//! The MCP bridge in the background, and its start at login.
//!
//! The program copies itself to `~/.archestra/bin/`, and the OS runs that copy
//! with `archestra bridge start --config <path> --background`.
//!
//! | OS | Runs in the background | Starts at login when |
//! | --- | --- | --- |
//! | macOS | the launchd job `ai.archestra.mcp-bridge` ([`launchd`]) | its LaunchAgent file is in `~/Library/LaunchAgents` |
//! | Windows | a process of its own ([`crate::bridge::instance`]) | the `Run` key of the user has the value `Archestra MCP bridge` ([`windows`]) |
//! | Linux | the systemd user unit `archestra-mcp-bridge.service`, or a process of its own with no systemd user session ([`linux`]) | the unit is enabled, or the XDG autostart entry is there |
//!
//! Each command does one thing:
//!
//! - [`start`] (`archestra bridge start`) starts the MCP bridge in the
//!   background now. The first start on a computer also adds the start at
//!   login; a later start keeps what the user chose.
//! - [`stop`] (`archestra bridge stop`) stops it now. The start at login stays.
//! - [`enable`] and [`disable`] (`archestra bridge enable-auto-start`, `archestra disable
//!   bridge`) add and remove the start at login. They do not start or stop.
//! - [`remove`] (`archestra uninstall`) stops it and removes all that the OS
//!   keeps for it.
//!
//! Each OS file has the part of these that is its own. The parts take the
//! home folder and a runner for the OS tool, so that a test never touches the
//! real home folder, launchd, systemd or the registry.

#[cfg(target_os = "macos")]
mod launchd;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod linux;
#[cfg(any(windows, test))]
mod windows;

#[cfg(target_os = "macos")]
use launchd as os;
#[cfg(target_os = "linux")]
use linux as os;
#[cfg(windows)]
use windows as os;

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::bridge::files;
use crate::layout;

/// The command that the OS runs: `archestra bridge start`, in the process
/// that the OS starts (`--background`), not handed over again.
const START_ARGUMENTS: [&str; 2] = ["bridge", "start"];
const CONFIG_FLAG: &str = "--config";
const BACKGROUND_FLAG: &str = "--background";

#[derive(Debug, thiserror::Error)]
pub enum AutostartError {
    #[error("cannot find the home folder")]
    NoHome,
    #[error("cannot find the program that runs: {0}")]
    NoProgram(#[source] io::Error),
    #[error(
        "the MCP bridge is not set up on this device (no config file {path}); run `archestra bridge start --url <address of Archestra>` first"
    )]
    NotSetUp { path: PathBuf },
    #[error("cannot copy the program to {path}: {source}")]
    CopyProgram { path: PathBuf, source: io::Error },
    /// `entry` is what holds the path: "a LaunchAgent", "the Run key".
    #[error("the path {path} has characters that {entry} cannot hold")]
    NotUtf8 { path: PathBuf, entry: &'static str },
    #[error("cannot stop the MCP bridge that runs: {0}")]
    StopRunning(#[source] io::Error),
    #[error("cannot start the MCP bridge in the background: {0}")]
    StartBackground(#[source] io::Error),
    #[cfg(target_os = "macos")]
    #[error(transparent)]
    Launchd(#[from] launchd::LaunchdError),
    #[cfg(any(target_os = "linux", all(test, unix)))]
    #[error(transparent)]
    Linux(#[from] linux::LinuxError),
    #[cfg(any(windows, test))]
    #[error(transparent)]
    Windows(#[from] windows::WindowsError),
}

/// What the OS says of the MCP bridge now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    /// The MCP bridge runs in the background.
    pub running: bool,
    /// It is in the start at login.
    pub auto_start: bool,
}

/// What [`remove`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Removal {
    /// The MCP bridge ran in the background and stopped.
    pub stopped: bool,
    /// The start at login was there and is gone.
    pub autostart_removed: bool,
}

/// The MCP bridge after [`start`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Started {
    /// Where the user sees it, for the message in the terminal.
    where_it_runs: &'static str,
    /// It is in the start at login.
    at_login: bool,
}

/// What a start and the start at login need. The home folder is a parameter,
/// so that a test never writes to the real one.
#[derive(Debug)]
struct Options<'a> {
    home: &'a Path,
    /// The program that runs now.
    current_program: &'a Path,
    config_path: &'a Path,
    /// The `PATH` for the program at login. launchd, systemd and the desktop
    /// give only a short `PATH`, so commands such as `npx` need the `PATH` of
    /// the shell. The `Run` key of Windows starts the program with the
    /// `PATH` of the user.
    #[cfg(unix)]
    search_path: Option<OsString>,
}

/// `archestra bridge start`: starts the MCP bridge in the background now.
/// `add_to_login` (the first start on a computer) also adds the start at
/// login; without it the start at login stays as it is. Returns true when the
/// MCP bridge runs in the background: this process can end. On a failure the
/// caller runs the MCP bridge itself, so the user is not left with nothing.
pub fn start(config_path: &Path, add_to_login: bool) -> bool {
    let (Some(home), Ok(current_program)) = (std::env::home_dir(), std::env::current_exe()) else {
        tracing::warn!("no start in the background: cannot find the home folder or the program");
        return false;
    };
    match os::start(&options(&home, &current_program, config_path), add_to_login) {
        Ok(started) => {
            println!("{}", started_message(started));
            true
        }
        Err(error) => {
            tracing::warn!(%error, "the MCP bridge runs in this terminal instead of the background");
            false
        }
    }
}

/// `archestra bridge stop`: stops the MCP bridge in the background. The start
/// at login, the config file and the device key stay. `false`: none ran.
pub fn stop() -> Result<bool, AutostartError> {
    os::stop(&home()?)
}

/// `archestra bridge enable-auto-start`: adds the MCP bridge to the start at login. It
/// does not start it now. The computer must be signed in already: the start
/// at login has no terminal to sign in from.
pub fn enable(config_path: &Path) -> Result<(), AutostartError> {
    if !config_path.is_file() {
        return Err(AutostartError::NotSetUp {
            path: config_path.to_owned(),
        });
    }
    let home = home()?;
    let current_program = std::env::current_exe().map_err(AutostartError::NoProgram)?;
    os::enable(&options(&home, &current_program, config_path))
}

/// `archestra bridge disable-auto-start`: removes the MCP bridge from the start at
/// login. An MCP bridge that runs keeps running. `false`: it was not there.
pub fn disable() -> Result<bool, AutostartError> {
    os::disable(&home()?)
}

/// For `archestra uninstall`: stops the MCP bridge in the background and
/// removes all that the OS keeps for it. Nothing to stop or remove is not an
/// error.
pub fn remove() -> Result<Removal, AutostartError> {
    os::remove(&home()?)
}

/// `archestra bridge status`: whether the MCP bridge runs in the background,
/// and whether it is in the start at login. It changes nothing.
pub fn status() -> Result<Status, AutostartError> {
    os::status(&home()?)
}

fn home() -> Result<PathBuf, AutostartError> {
    std::env::home_dir().ok_or(AutostartError::NoHome)
}

fn options<'a>(home: &'a Path, current_program: &'a Path, config_path: &'a Path) -> Options<'a> {
    Options {
        home,
        current_program,
        config_path,
        #[cfg(unix)]
        search_path: std::env::var_os("PATH"),
    }
}

/// The result of one run of an OS tool (`launchctl`, `systemctl`).
#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Runs an OS tool and keeps what it wrote.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_tool<S: AsRef<OsStr>>(
    tool: &str,
    arguments: impl IntoIterator<Item = S>,
) -> io::Result<CommandOutput> {
    use std::process::{Command, Stdio};

    let output = Command::new(tool)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;
    Ok(CommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
    })
}

/// The arguments after the program in the start at login. Each entry of the
/// start at login is written from them, and the MCP bridge that this program
/// starts itself gets them.
fn background_arguments(config_path: &Path) -> Vec<OsString> {
    let [component, action] = START_ARGUMENTS;
    [component, action, CONFIG_FLAG]
        .into_iter()
        .map(OsString::from)
        .chain([config_path.as_os_str().to_owned(), BACKGROUND_FLAG.into()])
        .collect()
}

/// The program and its arguments as text, for an entry of the start at
/// login. `entry` says what the entry is, for the error.
fn start_command<'a>(
    program: &'a Path,
    arguments: &'a [OsString],
    entry: &'static str,
) -> Result<Vec<&'a str>, AutostartError> {
    std::iter::once(program.as_os_str())
        .chain(arguments.iter().map(OsString::as_os_str))
        .map(|argument| utf8(argument, entry))
        .collect()
}

/// A path as text, for an entry of the start at login.
fn utf8<'a>(path: &'a OsStr, entry: &'static str) -> Result<&'a str, AutostartError> {
    path.to_str().ok_or_else(|| AutostartError::NotUtf8 {
        path: path.into(),
        entry,
    })
}

/// The MCP bridge in the background on Windows and with the XDG autostart:
/// a process that this program starts and stops by itself, as no service
/// manager does it. [`SystemBackground`] is the real one; a test gives a
/// recorder.
#[cfg(any(target_os = "linux", windows, test))]
trait Background {
    /// Stops the MCP bridge in the background. `false`: none ran.
    fn stop(&mut self) -> io::Result<bool>;
    /// Starts `program` with `arguments` as a process of its own, and waits
    /// until it runs.
    fn start(&mut self, program: &Path, arguments: &[OsString]) -> io::Result<()>;
}

/// The real MCP bridge in the background, through
/// [`crate::bridge::instance`].
#[cfg(any(target_os = "linux", windows))]
struct SystemBackground<'a> {
    home: &'a Path,
}

#[cfg(any(target_os = "linux", windows))]
impl SystemBackground<'_> {
    /// How long a stop and a start may take.
    const WAIT: std::time::Duration = std::time::Duration::from_secs(10);
    /// How often `start` looks if the new MCP bridge runs.
    const START_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
}

#[cfg(any(target_os = "linux", windows))]
impl Background for SystemBackground<'_> {
    fn stop(&mut self) -> io::Result<bool> {
        crate::bridge::instance::stop_running(self.home, Self::WAIT)
    }

    fn start(&mut self, program: &Path, arguments: &[OsString]) -> io::Result<()> {
        use crate::bridge::instance::is_running;
        use crate::bridge::wait::wait_until;

        let mut child = spawn_detached(program, arguments)?;
        let started = wait_until(Self::WAIT, Self::START_CHECK_INTERVAL, || {
            if is_running(self.home)? {
                return Ok(Some(()));
            }
            match child.try_wait()? {
                Some(status) => Err(io::Error::other(format!(
                    "the MCP bridge in the background ended at once ({status}); see its log file"
                ))),
                None => Ok(None),
            }
        })?;
        started.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "the MCP bridge in the background did not start",
            )
        })
    }
}

/// Starts a process that outlives this one and the terminal: no console and
/// no standard streams (it writes its own log file).
#[cfg(any(target_os = "linux", windows))]
pub(crate) fn spawn_detached(
    program: &Path,
    arguments: &[OsString],
) -> io::Result<std::process::Child> {
    use std::process::{Command, Stdio};

    let command = || {
        let mut command = Command::new(program);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    };
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // A process group of its own: the hangup of the terminal and its
        // Ctrl-C do not reach it.
        command().process_group(0).spawn()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
        };
        // No console, and not in the Ctrl-C group of the terminal. Out of the
        // job of the terminal where it allows that (an SSH session ends its
        // job at the end); else in it.
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        command()
            .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| command().creation_flags(flags).spawn())
    }
}

/// Copies the program to `~/.archestra/bin/`, unless it runs from there
/// already, and returns where the copy is. The copy is put in place with a
/// rename: the file of a running program is not written. On Windows a
/// running program cannot be replaced at all, so the caller stops the MCP
/// bridge first.
fn install_program(home: &Path, current_program: &Path) -> Result<PathBuf, AutostartError> {
    let program = layout::program_path(home);
    match copy_program(current_program, &program) {
        Ok(()) => Ok(program),
        Err(source) => Err(AutostartError::CopyProgram {
            path: program,
            source,
        }),
    }
}

/// The program for an entry of the start at login: the copy in
/// `~/.archestra/bin/` when it is there, else a new copy. The copy that is
/// there is not replaced: it may be the program of an MCP bridge that runs.
fn installed_program(home: &Path, current_program: &Path) -> Result<PathBuf, AutostartError> {
    let program = layout::program_path(home);
    if program.is_file() {
        return Ok(program);
    }
    install_program(home, current_program)
}

fn copy_program(from: &Path, to: &Path) -> io::Result<()> {
    if let (Ok(from), Ok(to)) = (fs::canonicalize(from), fs::canonicalize(to))
        && from == to
    {
        return Ok(());
    }
    files::replace_file(to, |temporary| {
        fs::copy(from, temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temporary, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })
}

/// Writes a file of the start at login, and makes its folder when it is
/// missing.
#[cfg(unix)]
fn write_entry(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, text)
}

/// Removes a file of the start at login. `false`: it was not there.
#[cfg(unix)]
fn remove_if_present(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// What the terminal shows when the MCP bridge runs in the background: a
/// short line for each fact, in plain words, with no paths and no commands.
fn started_message(started: Started) -> String {
    let at_login = if started.at_login {
        ""
    } else {
        "It does not start again when you log in.\n"
    };
    format!(
        "Setup is done. The MCP bridge runs in the background.\n\
         {}\n\
         {at_login}\
         To check it later, open a new terminal and run: archestra bridge status\n\
         You can go back to Archestra.",
        started.where_it_runs,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_start_at_login_runs_a_background_start_bridge() {
        assert_eq!(
            background_arguments(Path::new("/h/config.yaml")),
            [
                "bridge",
                "start",
                "--config",
                "/h/config.yaml",
                "--background"
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn copy_program_copies_once_and_keeps_a_running_copy() {
        let home = tempfile::tempdir().expect("temp home");
        let downloaded = home.path().join("download");
        fs::write(&downloaded, b"program").expect("write");
        let target = layout::program_path(home.path());

        copy_program(&downloaded, &target).expect("copy");
        assert_eq!(fs::read(&target).expect("read"), b"program");
        // From the copy itself: nothing to do.
        copy_program(&target, &target).expect("copy onto itself");
        assert_eq!(fs::read(&target).expect("read"), b"program");
    }

    #[test]
    fn installed_program_keeps_the_copy_that_is_there() {
        let home = tempfile::tempdir().expect("temp home");
        let downloaded = home.path().join("download");
        fs::write(&downloaded, b"new").expect("write");
        let target = layout::program_path(home.path());

        // No copy yet: it makes one.
        assert_eq!(
            installed_program(home.path(), &downloaded).expect("install"),
            target
        );
        assert_eq!(fs::read(&target).expect("read"), b"new");
        // A copy is there: it stays as it is.
        fs::write(&downloaded, b"newer").expect("write");
        installed_program(home.path(), &downloaded).expect("keep");
        assert_eq!(fs::read(&target).expect("read"), b"new");
    }

    #[test]
    fn enable_needs_a_computer_that_is_set_up() {
        let home = tempfile::tempdir().expect("temp home");
        let config_path = layout::bridge_config_path(home.path());
        let error = enable(&config_path).expect_err("no config file");
        assert!(matches!(error, AutostartError::NotSetUp { path } if path == config_path));
    }

    #[test]
    fn the_message_is_short_names_no_path_and_names_the_status_command() {
        let message = started_message(Started {
            where_it_runs: "Its icon in the menu bar shows its status.",
            at_login: true,
        });
        assert_eq!(
            message,
            "Setup is done. The MCP bridge runs in the background.\n\
             Its icon in the menu bar shows its status.\n\
             To check it later, open a new terminal and run: archestra bridge status\n\
             You can go back to Archestra."
        );
        assert!(!message.contains(".archestra"));

        let message = started_message(Started {
            where_it_runs: "Its icon in the menu bar shows its status.",
            at_login: false,
        });
        assert!(message.contains("\nIt does not start again when you log in.\n"));
    }
}
