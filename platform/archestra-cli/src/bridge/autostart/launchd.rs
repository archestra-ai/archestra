//! The MCP bridge on macOS: a copy of the program in `~/.archestra/bin/` that
//! launchd runs as the job `ai.archestra.mcp-bridge`.
//!
//! launchd starts a job from a LaunchAgent file. Where that file is decides
//! the start at login:
//!
//! - In `~/Library/LaunchAgents`, launchd also starts the job at each login.
//! - In `~/.archestra/mcp-bridge/`, launchd knows the job only until the user
//!   logs out.
//!
//! So [`install_and_start`] writes the file to one of the two places and makes
//! launchd start it at once, [`add_to_login`] and [`remove_agent`] write and
//! remove the file of the start at login, and [`stop_job`] makes launchd stop
//! the job and keeps the files.
//!
//! launchd runs the MCP bridge in each case, also with no start at login. That
//! matters on macOS: the OS gives its permissions to the process at the top
//! of the chain. Started from a terminal, that is the terminal application;
//! started by launchd, it is `archestra`.
//!
//! The functions take the home folder and a [`Launchctl`], so that a test
//! never writes to the real home folder or talks to the real launchd.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{
    AutostartError, CommandOutput, Options, Removal, Started, Status, background_arguments,
    install_program, installed_program, remove_if_present, run_tool, start_command, utf8,
    write_entry,
};
use crate::bridge::files;
use crate::bridge::wait::wait_until;
use crate::layout;

/// The name of the launchd job. It names the service, not the program.
const LABEL: &str = "ai.archestra.mcp-bridge";
/// What holds the paths, for the error of a path that is not UTF-8.
const ENTRY: &str = "a LaunchAgent";

/// How long [`start_now`] tries, and the pause between two tries.
const START_WAIT: Duration = Duration::from_secs(3);
const START_RETRY_PAUSE: Duration = Duration::from_millis(300);

#[derive(Debug, thiserror::Error)]
pub enum LaunchdError {
    #[error("cannot write the LaunchAgent {path}: {source}")]
    WriteAgent { path: PathBuf, source: io::Error },
    #[error("cannot remove the LaunchAgent {path}: {source}")]
    RemoveAgent { path: PathBuf, source: io::Error },
    #[error("cannot run launchctl: {0}")]
    Launchctl(#[source] io::Error),
    #[error("launchd did not start the LaunchAgent {path}: {reason}")]
    StartAgent { path: PathBuf, reason: String },
    #[error("launchd did not stop the MCP bridge: {reason}")]
    StopAgent { reason: String },
}

/// `archestra bridge start` on macOS.
pub(super) fn start(options: &Options<'_>, add_to_login: bool) -> Result<Started, AutostartError> {
    let at_login = install_and_start(options, add_to_login, &mut SystemLaunchctl)?;
    Ok(Started {
        where_it_runs: "The Device tab in Archestra shows its status.",
        at_login,
    })
}

/// `archestra bridge stop` on macOS.
pub(super) fn stop(_home: &Path) -> Result<bool, AutostartError> {
    stop_job(&mut SystemLaunchctl)
}

/// `archestra bridge enable-auto-start` on macOS.
pub(super) fn enable(options: &Options<'_>) -> Result<(), AutostartError> {
    add_to_login(options)
}

/// `archestra bridge disable-auto-start` on macOS.
pub(super) fn disable(home: &Path) -> Result<bool, AutostartError> {
    remove_agent(&login_agent_path(home))
}

/// `archestra bridge status` on macOS.
pub(super) fn status(home: &Path) -> Result<Status, AutostartError> {
    job_status(&mut SystemLaunchctl, home)
}

/// The MCP bridge part of `archestra uninstall` on macOS.
pub(super) fn remove(home: &Path) -> Result<Removal, AutostartError> {
    stop_and_remove(&mut SystemLaunchctl, home)
}

/// The `launchctl` of the user. [`SystemLaunchctl`] runs the real one; a
/// test gives a recorder.
trait Launchctl {
    /// The launchd domain of the user, for example `gui/501`.
    fn domain(&self) -> String;
    /// Runs `launchctl` with these arguments.
    fn run(&mut self, arguments: &[&OsStr]) -> io::Result<CommandOutput>;
}

/// The real `launchctl`, in the GUI domain of the user who runs the program.
struct SystemLaunchctl;

impl Launchctl for SystemLaunchctl {
    fn domain(&self) -> String {
        format!("gui/{}", rustix::process::getuid().as_raw())
    }

    fn run(&mut self, arguments: &[&OsStr]) -> io::Result<CommandOutput> {
        run_tool("launchctl", arguments)
    }
}

/// Copies the program to `~/.archestra/bin/archestra`, writes the LaunchAgent
/// and makes launchd start it now. The LaunchAgent goes to the start at login
/// when `add_to_login` says so or when it is there already; else to the
/// folder of the MCP bridge. Returns whether it is in the start at login.
fn install_and_start(
    options: &Options<'_>,
    add_to_login: bool,
    launchctl: &mut impl Launchctl,
) -> Result<bool, AutostartError> {
    let program = install_program(options.home, options.current_program)?;
    let login_agent = login_agent_path(options.home);
    let session_agent = session_agent_path(options.home);
    let at_login = add_to_login || login_agent.exists();
    let agent_path = if at_login {
        // The start at login takes the place of a start for this login only.
        remove_agent(&session_agent)?;
        login_agent
    } else {
        session_agent
    };
    write_agent(&agent_path, options, &program)?;
    // launchd opens the log file when it starts the job, so a large file is
    // put aside here, before that. A start at login does not come here: its
    // log file waits for the next `archestra bridge start`.
    let log_path = layout::bridge_log_path(options.home);
    if let Err(error) = files::rotate_log_file(&log_path, files::MAX_LOG_FILE_LEN) {
        tracing::warn!(%error, path = %log_path.display(), "cannot put the large log file aside");
    }
    start_now(launchctl, &agent_path)?;
    Ok(at_login)
}

/// Writes the LaunchAgent of the start at login. launchd reads it at the
/// next login: the MCP bridge is not started or stopped now.
fn add_to_login(options: &Options<'_>) -> Result<(), AutostartError> {
    let program = installed_program(options.home, options.current_program)?;
    write_agent(&login_agent_path(options.home), options, &program)
}

/// Writes a LaunchAgent that runs `program`. It is safe to call at each
/// start.
fn write_agent(
    agent_path: &Path,
    options: &Options<'_>,
    program: &Path,
) -> Result<(), AutostartError> {
    let arguments = background_arguments(options.config_path);
    let log_path = layout::bridge_log_path(options.home);
    let plist = launch_agent_plist(&LaunchAgent {
        command: start_command(program, &arguments, ENTRY)?,
        log_path: utf8(log_path.as_os_str(), ENTRY)?,
        search_path: match &options.search_path {
            Some(search_path) => Some(utf8(search_path, ENTRY)?),
            None => None,
        },
    });
    write_entry(agent_path, &plist).map_err(|source| LaunchdError::WriteAgent {
        path: agent_path.to_owned(),
        source,
    })?;
    Ok(())
}

/// Removes a LaunchAgent file. launchd keeps a job that runs. `false`: the
/// file was not there.
fn remove_agent(agent_path: &Path) -> Result<bool, AutostartError> {
    Ok(
        remove_if_present(agent_path).map_err(|source| LaunchdError::RemoveAgent {
            path: agent_path.to_owned(),
            source,
        })?,
    )
}

/// Makes launchd start the LaunchAgent now, as it does at login. An MCP
/// bridge that an earlier LaunchAgent started is stopped first.
fn start_now(launchctl: &mut impl Launchctl, agent_path: &Path) -> Result<(), AutostartError> {
    let domain = launchctl.domain();
    let service = format!("{domain}/{LABEL}");
    // No such job is the usual case; the result does not matter.
    launchctl
        .run(&[OsStr::new("bootout"), OsStr::new(&service)])
        .map_err(LaunchdError::Launchctl)?;

    // launchd takes a moment to forget a job that it just stopped, and
    // refuses the new one until then.
    let mut reason = String::new();
    let started = wait_until(START_WAIT, START_RETRY_PAUSE, || {
        let started = launchctl
            .run(&[
                OsStr::new("bootstrap"),
                OsStr::new(&domain),
                agent_path.as_os_str(),
            ])
            .map_err(LaunchdError::Launchctl)?;
        if started.success {
            return Ok::<_, LaunchdError>(Some(()));
        }
        reason = started.stderr;
        Ok(None)
    })?;
    started.ok_or_else(|| {
        AutostartError::from(LaunchdError::StartAgent {
            path: agent_path.to_owned(),
            reason,
        })
    })
}

/// Makes launchd stop the MCP bridge. The LaunchAgent files stay, so the
/// start at login stays as it is. `false`: launchd did not have the job.
fn stop_job(launchctl: &mut impl Launchctl) -> Result<bool, AutostartError> {
    let service = format!("{}/{LABEL}", launchctl.domain());
    let is_loaded = |launchctl: &mut _| -> Result<bool, AutostartError> {
        Ok(run(launchctl, &["print", &service])?.success)
    };

    let stopped = is_loaded(launchctl)?;
    if stopped {
        let bootout = run(launchctl, &["bootout", &service])?;
        // A job that ends by itself in the meantime is stopped as well.
        if !bootout.success && is_loaded(launchctl)? {
            return Err(LaunchdError::StopAgent {
                reason: bootout.stderr,
            }
            .into());
        }
    }
    Ok(stopped)
}

/// Reads what launchd says of the job. launchd keeps a job that ended, so
/// that it knows the job is not enough: `launchctl print` names its state.
fn job_status(launchctl: &mut impl Launchctl, home: &Path) -> Result<Status, AutostartError> {
    let service = format!("{}/{LABEL}", launchctl.domain());
    let printed = run(launchctl, &["print", &service])?;
    let running = printed.success
        && printed
            .stdout
            .lines()
            .any(|line| line.trim() == "state = running");
    Ok(Status {
        running,
        auto_start: login_agent_path(home).exists(),
    })
}

/// Stops the MCP bridge that launchd runs and removes both LaunchAgent
/// files. Nothing to stop or remove is not an error. When launchd does not
/// stop the job, the files stay, so that the user sees what launchd still
/// has.
fn stop_and_remove(launchctl: &mut impl Launchctl, home: &Path) -> Result<Removal, AutostartError> {
    let stopped = stop_job(launchctl)?;
    let autostart_removed = remove_agent(&login_agent_path(home))?;
    remove_agent(&session_agent_path(home))?;
    Ok(Removal {
        stopped,
        autostart_removed,
    })
}

fn run(
    launchctl: &mut impl Launchctl,
    arguments: &[&str],
) -> Result<CommandOutput, AutostartError> {
    let arguments: Vec<&OsStr> = arguments.iter().map(OsStr::new).collect();
    Ok(launchctl.run(&arguments).map_err(LaunchdError::Launchctl)?)
}

/// The LaunchAgent of the start at login: launchd reads this folder at each
/// login.
fn login_agent_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// The LaunchAgent of an MCP bridge that is not in the start at login.
fn session_agent_path(home: &Path) -> PathBuf {
    layout::bridge_dir(home).join(format!("{LABEL}.plist"))
}

struct LaunchAgent<'a> {
    /// The program and its arguments.
    command: Vec<&'a str>,
    log_path: &'a str,
    search_path: Option<&'a str>,
}

fn launch_agent_plist(agent: &LaunchAgent<'_>) -> String {
    let environment = match agent.search_path {
        Some(search_path) => format!(
            "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>{}</string>\n  </dict>\n",
            xml_escape(search_path)
        ),
        None => String::new(),
    };
    let arguments: String = agent
        .command
        .iter()
        .map(|argument| format!("    <string>{}</string>\n", xml_escape(argument)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log_path}</string>
  <key>StandardErrorPath</key>
  <string>{log_path}</string>
{environment}</dict>
</plist>
"#,
        log_path = xml_escape(agent.log_path),
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// Records the `launchctl` calls and answers each with the next prepared
    /// result (success when none is left).
    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        answers: VecDeque<bool>,
        /// What a successful call writes to stdout.
        stdout: String,
    }

    impl Recorder {
        fn answering(answers: &[bool]) -> Self {
            Self {
                calls: Vec::new(),
                answers: answers.iter().copied().collect(),
                stdout: String::new(),
            }
        }
    }

    impl Launchctl for Recorder {
        fn domain(&self) -> String {
            "gui/501".to_owned()
        }

        fn run(&mut self, arguments: &[&OsStr]) -> io::Result<CommandOutput> {
            let call: Vec<String> = arguments
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            self.calls.push(call.join(" "));
            let success = self.answers.pop_front().unwrap_or(true);
            Ok(CommandOutput {
                success,
                stdout: if success {
                    self.stdout.clone()
                } else {
                    String::new()
                },
                stderr: if success {
                    String::new()
                } else {
                    "refused".to_owned()
                },
            })
        }
    }

    /// A home folder with a downloaded program, and the options of a start.
    struct Fixture {
        home: tempfile::TempDir,
        downloaded: PathBuf,
        config_path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let home = tempfile::tempdir().expect("temp home");
            let downloaded = home.path().join("archestra-download");
            fs::write(&downloaded, b"program bytes").expect("write");
            let config_path = layout::bridge_config_path(home.path());
            Self {
                home,
                downloaded,
                config_path,
            }
        }

        fn options(&self) -> Options<'_> {
            Options {
                home: self.home.path(),
                current_program: &self.downloaded,
                config_path: &self.config_path,
                search_path: Some(OsString::from("/opt/homebrew/bin:/usr/bin:/bin")),
            }
        }
    }

    #[test]
    fn the_first_start_copies_the_program_and_adds_the_start_at_login() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut launchctl = Recorder::default();

        let at_login = install_and_start(&fixture.options(), true, &mut launchctl).expect("start");

        assert!(at_login);
        let program = home.join(".archestra/bin/archestra");
        assert_eq!(fs::read(&program).expect("read"), b"program bytes");
        let mode = fs::metadata(&program)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);

        let agent_path = home.join("Library/LaunchAgents/ai.archestra.mcp-bridge.plist");
        assert_eq!(
            launchctl.calls,
            [
                "bootout gui/501/ai.archestra.mcp-bridge".to_owned(),
                format!("bootstrap gui/501 {}", agent_path.display()),
            ]
        );
        assert!(!session_agent_path(home).exists());
        let plist = fs::read_to_string(&agent_path).expect("read");
        assert!(plist.contains("<string>ai.archestra.mcp-bridge</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));

        // The file is a property list that a plist parser accepts, with the
        // values in the right places.
        let check = r#"
import plistlib, sys
with open(sys.argv[1], "rb") as file:
    agent = plistlib.load(file)
assert agent["Label"] == "ai.archestra.mcp-bridge", agent
assert agent["ProgramArguments"] == [sys.argv[2], "bridge", "start", "--config", sys.argv[3], "--background"], agent
assert agent["RunAtLoad"] is True, agent
assert agent["EnvironmentVariables"] == {"PATH": "/opt/homebrew/bin:/usr/bin:/bin"}, agent
assert agent["StandardOutPath"] == sys.argv[4], agent
assert agent["StandardErrorPath"] == sys.argv[4], agent
"#;
        let parsed = std::process::Command::new("python3")
            .args(["-c", check])
            .args([&agent_path, &program, &fixture.config_path])
            .arg(home.join(".archestra/mcp-bridge/mcp-bridge.log"))
            .status()
            .expect("python3 starts");
        assert!(parsed.success(), "the LaunchAgent is not a valid plist");

        // A later start, now from the copy: it stays in the start at login,
        // and nothing breaks.
        let options = Options {
            current_program: &program,
            ..fixture.options()
        };
        let at_login = install_and_start(&options, false, &mut launchctl).expect("start again");
        assert!(at_login);
        assert_eq!(fs::read(&program).expect("read"), b"program bytes");
        assert!(agent_path.exists());
    }

    #[test]
    fn a_later_start_keeps_a_start_at_login_that_the_user_removed() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut launchctl = Recorder::default();

        // Not the first start, and no LaunchAgent in the start at login.
        let at_login = install_and_start(&fixture.options(), false, &mut launchctl).expect("start");

        assert!(!at_login);
        assert!(!login_agent_path(home).exists());
        // launchd still runs it, from a LaunchAgent that it does not read at
        // login.
        let session_agent = home.join(".archestra/mcp-bridge/ai.archestra.mcp-bridge.plist");
        assert_eq!(
            launchctl.calls,
            [
                "bootout gui/501/ai.archestra.mcp-bridge".to_owned(),
                format!("bootstrap gui/501 {}", session_agent.display()),
            ]
        );
        assert!(
            fs::read_to_string(&session_agent)
                .expect("read")
                .contains("<string>--background</string>")
        );
    }

    #[test]
    fn enable_and_disable_change_only_the_start_at_login() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut launchctl = Recorder::default();
        install_and_start(&fixture.options(), false, &mut launchctl).expect("start");
        let calls_of_the_start = launchctl.calls.len();
        // A newer download does not replace the program that runs.
        fs::write(&fixture.downloaded, b"newer program").expect("write");

        add_to_login(&fixture.options()).expect("enable");

        let login_agent = login_agent_path(home);
        assert!(login_agent.exists());
        assert_eq!(
            fs::read(layout::program_path(home)).expect("read"),
            b"program bytes"
        );
        // The next start sees it, and needs the other LaunchAgent no more.
        let at_login = install_and_start(&fixture.options(), false, &mut launchctl).expect("start");
        assert!(at_login);
        assert!(!session_agent_path(home).exists());

        assert!(remove_agent(&login_agent).expect("disable"));
        assert!(!login_agent.exists());
        assert!(!remove_agent(&login_agent).expect("disable again"));
        // Enable and disable did not talk to launchd: two starts only.
        assert_eq!(launchctl.calls.len(), calls_of_the_start * 2);
    }

    #[test]
    fn a_large_log_file_is_put_aside_before_launchd_starts_the_job() {
        let fixture = Fixture::new();
        let log_path = layout::bridge_log_path(fixture.home.path());
        fs::create_dir_all(log_path.parent().expect("parent")).expect("mkdir");
        let log = fs::File::create(&log_path).expect("create");
        log.set_len(files::MAX_LOG_FILE_LEN + 1).expect("set_len");

        let mut launchctl = Recorder::default();
        install_and_start(&fixture.options(), true, &mut launchctl).expect("start");

        // launchd makes a new log file when it starts the job.
        assert!(!log_path.exists());
        let aside = log_path.with_file_name("mcp-bridge.log.1");
        assert_eq!(
            fs::metadata(aside).expect("metadata").len(),
            files::MAX_LOG_FILE_LEN + 1
        );
        assert_eq!(launchctl.calls.len(), 2, "{:?}", launchctl.calls);
    }

    #[test]
    fn start_now_stops_the_old_job_and_bootstraps_the_agent() {
        let mut launchctl = Recorder::answering(&[false, false, true]);
        start_now(&mut launchctl, Path::new("/h/agent.plist")).expect("start");
        assert_eq!(
            launchctl.calls,
            [
                "bootout gui/501/ai.archestra.mcp-bridge",
                "bootstrap gui/501 /h/agent.plist",
                "bootstrap gui/501 /h/agent.plist",
            ]
        );
    }

    /// Writes both LaunchAgent files and the config file.
    fn write_files(home: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let login_agent = login_agent_path(home);
        let session_agent = session_agent_path(home);
        let config_path = layout::bridge_config_path(home);
        for path in [&login_agent, &session_agent, &config_path] {
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, "text").expect("write");
        }
        (login_agent, session_agent, config_path)
    }

    #[test]
    fn stop_boots_out_the_job_and_keeps_the_start_at_login() {
        let home = tempfile::tempdir().expect("temp home");
        let (login_agent, session_agent, config_path) = write_files(home.path());

        let mut launchctl = Recorder::answering(&[true, true]);
        assert!(stop_job(&mut launchctl).expect("stop"));

        assert_eq!(
            launchctl.calls,
            [
                "print gui/501/ai.archestra.mcp-bridge",
                "bootout gui/501/ai.archestra.mcp-bridge",
            ]
        );
        assert!(login_agent.exists());
        assert!(session_agent.exists());
        assert!(config_path.exists());

        // Not loaded: no bootout, and not an error.
        let mut launchctl = Recorder::answering(&[false]);
        assert!(!stop_job(&mut launchctl).expect("stop"));
        assert_eq!(launchctl.calls, ["print gui/501/ai.archestra.mcp-bridge"]);
    }

    #[test]
    fn status_reads_the_state_of_the_job_and_the_start_at_login() {
        let home = tempfile::tempdir().expect("temp home");
        // launchd does not have the job.
        let mut launchctl = Recorder::answering(&[false]);
        assert_eq!(
            job_status(&mut launchctl, home.path()).expect("status"),
            Status {
                running: false,
                auto_start: false
            }
        );
        assert_eq!(launchctl.calls, ["print gui/501/ai.archestra.mcp-bridge"]);

        let (_login_agent, _, _) = write_files(home.path());
        // The job runs.
        let mut launchctl = Recorder {
            stdout: "gui/501/ai.archestra.mcp-bridge = {\n\tstate = running\n\tpid = 4242\n}\n"
                .to_owned(),
            ..Recorder::default()
        };
        assert_eq!(
            job_status(&mut launchctl, home.path()).expect("status"),
            Status {
                running: true,
                auto_start: true
            }
        );
        // launchd has the job, but its process ended.
        let mut launchctl = Recorder {
            stdout: "gui/501/ai.archestra.mcp-bridge = {\n\tstate = not running\n}\n".to_owned(),
            ..Recorder::default()
        };
        assert!(
            !job_status(&mut launchctl, home.path())
                .expect("status")
                .running
        );
    }

    #[test]
    fn stop_and_remove_boots_out_the_job_and_removes_the_agents() {
        let home = tempfile::tempdir().expect("temp home");
        let (login_agent, session_agent, config_path) = write_files(home.path());

        let mut launchctl = Recorder::answering(&[true, true]);
        let removal = stop_and_remove(&mut launchctl, home.path()).expect("remove");

        assert_eq!(
            removal,
            Removal {
                stopped: true,
                autostart_removed: true
            }
        );
        assert_eq!(
            launchctl.calls,
            [
                "print gui/501/ai.archestra.mcp-bridge",
                "bootout gui/501/ai.archestra.mcp-bridge",
            ]
        );
        assert!(!login_agent.exists());
        assert!(!session_agent.exists());
        // The files of the MCP bridge are not the business of this function.
        assert!(config_path.exists());
    }

    #[test]
    fn stop_and_remove_with_nothing_running_is_not_an_error() {
        let home = tempfile::tempdir().expect("temp home");
        let mut launchctl = Recorder::answering(&[false]);
        let removal = stop_and_remove(&mut launchctl, home.path()).expect("remove");

        assert_eq!(
            removal,
            Removal {
                stopped: false,
                autostart_removed: false
            }
        );
        // Not loaded: no bootout.
        assert_eq!(launchctl.calls, ["print gui/501/ai.archestra.mcp-bridge"]);
    }

    #[test]
    fn stop_and_remove_fails_when_the_job_stays() {
        let home = tempfile::tempdir().expect("temp home");
        let (login_agent, session_agent, _) = write_files(home.path());

        // Loaded, bootout refused, still loaded.
        let mut launchctl = Recorder::answering(&[true, false, true]);
        let error = stop_and_remove(&mut launchctl, home.path()).expect_err("stays");

        assert!(matches!(
            error,
            AutostartError::Launchd(LaunchdError::StopAgent { reason }) if reason == "refused"
        ));
        // The LaunchAgents stay, so that the user sees what launchd still has.
        assert!(login_agent.exists());
        assert!(session_agent.exists());
    }

    #[test]
    fn stop_accepts_a_job_that_ended_meanwhile() {
        // Loaded, bootout refused, no longer loaded.
        let mut launchctl = Recorder::answering(&[true, false, false]);
        assert!(stop_job(&mut launchctl).expect("stop"));
    }

    #[test]
    fn plist_escapes_xml_and_can_have_no_path() {
        let plist = launch_agent_plist(&LaunchAgent {
            command: vec!["/Users/a&b/<x>/archestra", "bridge", "start"],
            log_path: "/l.log",
            search_path: None,
        });
        assert!(plist.contains("<string>/Users/a&amp;b/&lt;x&gt;/archestra</string>"));
        assert!(!plist.contains("EnvironmentVariables"));
        assert!(plist.ends_with("</dict>\n</plist>\n"));
    }
}
