//! The MCP bridge on Linux: a copy of the program in
//! `~/.archestra/bin/archestra` that runs in one of two ways:
//!
//! - With a systemd user session (most desktops): the user unit
//!   `~/.config/systemd/user/archestra-mcp-bridge.service`. systemd starts and
//!   stops it with all its processes, and starts it at login when the unit is
//!   enabled (`systemctl --user enable`).
//! - With no systemd user session: a process of its own
//!   ([`super::Background`]). It starts at the next graphical login when the
//!   XDG autostart entry `~/.config/autostart/archestra-mcp-bridge.desktop`
//!   is there.
//!
//! Linux has no tray icon: the Device tab shows the state.
//!
//! [`install_and_start`] and [`stop_bridge`] start and stop the MCP bridge,
//! [`add_to_login`] and [`remove_from_login`] change only the start at login,
//! and [`stop_and_remove`] removes all of it. The parts take the home folder,
//! a [`Systemctl`] and a [`Background`], so that a test never writes to the
//! real home folder or talks to the real systemd.

use std::io;
use std::path::{Path, PathBuf};

use super::{
    AutostartError, Background, CommandOutput, Options, Removal, background_arguments,
    install_program, installed_program, start_command, utf8,
};

/// The name of the systemd user unit and of the XDG autostart entry.
const UNIT: &str = "archestra-mcp-bridge.service";
const DESKTOP_ENTRY: &str = "archestra-mcp-bridge.desktop";
const NAME: &str = "Archestra MCP bridge";
/// What holds the paths, for the error of a path that is not UTF-8.
const ENTRY: &str = "a unit file";

#[derive(Debug, thiserror::Error)]
pub enum LinuxError {
    #[error("cannot write {path}: {source}")]
    WriteEntry { path: PathBuf, source: io::Error },
    #[error("cannot remove {path}: {source}")]
    RemoveEntry { path: PathBuf, source: io::Error },
    #[error("cannot run systemctl: {0}")]
    Systemctl(#[source] io::Error),
    #[error("`systemctl --user {command}` failed: {reason}")]
    SystemctlFailed { command: String, reason: String },
}

/// `systemctl --user`. [`SystemSystemctl`] runs the real one; a test gives a
/// recorder.
trait Systemctl {
    /// Runs `systemctl --user` with these arguments. An [`io::ErrorKind::NotFound`]
    /// error: there is no `systemctl`.
    fn run(&mut self, arguments: &[&str]) -> io::Result<CommandOutput>;
}

/// What runs the MCP bridge, and which entry starts it at login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    SystemdUnit,
    XdgAutostart,
}

/// `archestra bridge start` on Linux.
#[cfg(target_os = "linux")]
pub(super) fn start(
    options: &Options<'_>,
    add_to_login: bool,
) -> Result<super::Started, AutostartError> {
    let mut background = super::SystemBackground { home: options.home };
    let (entry, at_login) =
        install_and_start(options, add_to_login, &mut SystemSystemctl, &mut background)?;
    Ok(super::Started {
        where_it_runs: match entry {
            Entry::SystemdUnit => {
                "Check its status with: systemctl --user status archestra-mcp-bridge"
            }
            Entry::XdgAutostart => "The Device tab in Archestra shows its status.",
        },
        at_login,
    })
}

/// `archestra bridge stop` on Linux.
#[cfg(target_os = "linux")]
pub(super) fn stop(home: &Path) -> Result<bool, AutostartError> {
    stop_bridge(
        home,
        &mut SystemSystemctl,
        &mut super::SystemBackground { home },
    )
}

/// `archestra bridge enable-auto-start` on Linux.
#[cfg(target_os = "linux")]
pub(super) fn enable(options: &Options<'_>) -> Result<(), AutostartError> {
    add_to_login(options, &mut SystemSystemctl)
}

/// `archestra bridge disable-auto-start` on Linux.
#[cfg(target_os = "linux")]
pub(super) fn disable(home: &Path) -> Result<bool, AutostartError> {
    remove_from_login(home, &mut SystemSystemctl)
}

/// The MCP bridge part of `archestra uninstall` on Linux.
#[cfg(target_os = "linux")]
pub(super) fn remove(home: &Path) -> Result<Removal, AutostartError> {
    stop_and_remove(
        home,
        &mut SystemSystemctl,
        &mut super::SystemBackground { home },
    )
}

/// Copies the program and starts the MCP bridge in the background now. It
/// adds the start at login when `add_to_login` says so, and brings an entry
/// that is there up to date. Returns what runs it and whether it is in the
/// start at login.
fn install_and_start(
    options: &Options<'_>,
    add_to_login: bool,
    systemctl: &mut impl Systemctl,
    background: &mut impl Background,
) -> Result<(Entry, bool), AutostartError> {
    let home = options.home;
    let program = install_program(home, options.current_program)?;
    let arguments = background_arguments(options.config_path);
    let command = exec_command(options, &program, &arguments)?;
    // An MCP bridge that an earlier start made a process of its own would
    // keep the lock, and the new one would end at once.
    background.stop().map_err(AutostartError::StopRunning)?;

    let desktop_entry_path = desktop_entry_path(home);
    if has_user_session(systemctl) {
        // An entry of an earlier start with no systemd: the unit takes its
        // place, or the MCP bridge would start two times at login.
        let had_desktop_entry = remove_entry(&desktop_entry_path)?;
        write_entry(&unit_path(home), &unit_file(&command))?;
        run_checked(systemctl, &["daemon-reload"])?;
        let at_login = if add_to_login || had_desktop_entry {
            run_checked(systemctl, &["enable", UNIT])?;
            true
        } else {
            is_enabled(systemctl)?
        };
        // A unit that runs gets the new program and config.
        run_checked(systemctl, &["restart", UNIT])?;
        Ok((Entry::SystemdUnit, at_login))
    } else {
        let at_login = add_to_login || desktop_entry_path.exists();
        if at_login {
            write_entry(&desktop_entry_path, &desktop_entry(&command))?;
        }
        background
            .start(&program, &arguments)
            .map_err(AutostartError::StartBackground)?;
        Ok((Entry::XdgAutostart, at_login))
    }
}

/// Stops the MCP bridge. Both entries stay, so the start at login stays as
/// it is. `false`: none ran.
fn stop_bridge(
    home: &Path,
    systemctl: &mut impl Systemctl,
    background: &mut impl Background,
) -> Result<bool, AutostartError> {
    let mut stopped = false;
    if unit_path(home).exists() {
        match systemctl.run(&["is-active", "--quiet", UNIT]) {
            Ok(output) => {
                stopped = output.success;
                if stopped {
                    run_checked(systemctl, &["stop", UNIT])?;
                }
            }
            // No systemctl: no systemd started it.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(LinuxError::Systemctl(error).into()),
        }
    }
    stopped |= background.stop().map_err(AutostartError::StopRunning)?;
    Ok(stopped)
}

/// Adds the start at login: enables the unit, or writes the XDG autostart
/// entry with no systemd user session. The MCP bridge is not started or
/// stopped now.
fn add_to_login(
    options: &Options<'_>,
    systemctl: &mut impl Systemctl,
) -> Result<(), AutostartError> {
    let home = options.home;
    let program = installed_program(home, options.current_program)?;
    let arguments = background_arguments(options.config_path);
    let command = exec_command(options, &program, &arguments)?;
    if has_user_session(systemctl) {
        remove_entry(&desktop_entry_path(home))?;
        write_entry(&unit_path(home), &unit_file(&command))?;
        run_checked(systemctl, &["daemon-reload"])?;
        run_checked(systemctl, &["enable", UNIT])?;
    } else {
        write_entry(&desktop_entry_path(home), &desktop_entry(&command))?;
    }
    Ok(())
}

/// Removes the start at login: disables the unit and removes the XDG
/// autostart entry. The unit file stays (systemd runs the MCP bridge from
/// it), and an MCP bridge that runs keeps running. `false`: it was not in
/// the start at login.
fn remove_from_login(home: &Path, systemctl: &mut impl Systemctl) -> Result<bool, AutostartError> {
    let mut removed = false;
    if unit_path(home).exists() {
        match systemctl.run(&["is-enabled", "--quiet", UNIT]) {
            Ok(output) => {
                removed = output.success;
                if removed {
                    run_checked(systemctl, &["disable", UNIT])?;
                }
            }
            // No systemctl: no systemd starts it.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(LinuxError::Systemctl(error).into()),
        }
    }
    removed |= remove_entry(&desktop_entry_path(home))?;
    Ok(removed)
}

/// Stops the MCP bridge and removes the unit and both entries. Nothing to
/// stop or remove is not an error.
fn stop_and_remove(
    home: &Path,
    systemctl: &mut impl Systemctl,
    background: &mut impl Background,
) -> Result<Removal, AutostartError> {
    let unit_path = unit_path(home);
    let mut stopped = false;
    let mut autostart_removed = false;
    if unit_path.exists() {
        match systemctl.run(&["is-active", "--quiet", UNIT]) {
            Ok(output) => {
                stopped = output.success;
                run_checked(systemctl, &["disable", "--now", UNIT])?;
            }
            // No systemctl: no systemd started it.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(LinuxError::Systemctl(error).into()),
        }
        autostart_removed |= remove_entry(&unit_path)?;
        // Not important: systemd forgets the removed unit at its next reload.
        let _ = systemctl.run(&["daemon-reload"]);
    }
    stopped |= background.stop().map_err(AutostartError::StopRunning)?;
    autostart_removed |= remove_entry(&desktop_entry_path(home))?;
    Ok(Removal {
        stopped,
        autostart_removed,
    })
}

/// A systemd user manager answers: the session has one.
fn has_user_session(systemctl: &mut impl Systemctl) -> bool {
    systemctl
        .run(&["show-environment"])
        .is_ok_and(|output| output.success)
}

/// systemd starts the unit at login.
fn is_enabled(systemctl: &mut impl Systemctl) -> Result<bool, AutostartError> {
    Ok(systemctl
        .run(&["is-enabled", "--quiet", UNIT])
        .map_err(LinuxError::Systemctl)?
        .success)
}

fn run_checked(systemctl: &mut impl Systemctl, arguments: &[&str]) -> Result<(), AutostartError> {
    let output = systemctl.run(arguments).map_err(LinuxError::Systemctl)?;
    if output.success {
        return Ok(());
    }
    Err(LinuxError::SystemctlFailed {
        command: arguments.join(" "),
        reason: output.stderr,
    }
    .into())
}

fn unit_path(home: &Path) -> PathBuf {
    home.join(".config/systemd/user").join(UNIT)
}

fn desktop_entry_path(home: &Path) -> PathBuf {
    home.join(".config/autostart").join(DESKTOP_ENTRY)
}

fn write_entry(path: &Path, text: &str) -> Result<(), LinuxError> {
    super::write_entry(path, text).map_err(|source| LinuxError::WriteEntry {
        path: path.to_owned(),
        source,
    })
}

fn remove_entry(path: &Path) -> Result<bool, LinuxError> {
    super::remove_if_present(path).map_err(|source| LinuxError::RemoveEntry {
        path: path.to_owned(),
        source,
    })
}

/// The command of the start at login, before the quoting of each format.
struct ExecCommand<'a> {
    /// The program and its arguments.
    argv: Vec<&'a str>,
    search_path: Option<&'a str>,
}

fn exec_command<'a>(
    options: &'a Options<'_>,
    program: &'a Path,
    arguments: &'a [std::ffi::OsString],
) -> Result<ExecCommand<'a>, AutostartError> {
    Ok(ExecCommand {
        argv: start_command(program, arguments, ENTRY)?,
        search_path: match &options.search_path {
            Some(search_path) => Some(utf8(search_path, ENTRY)?),
            None => None,
        },
    })
}

/// The systemd user unit. No `Restart=`: as with launchd, an MCP bridge that
/// was signed out ends and waits for the user, instead of a sign-in each few
/// seconds.
fn unit_file(command: &ExecCommand<'_>) -> String {
    let exec_start: Vec<String> = command.argv.iter().copied().map(systemd_quote).collect();
    let environment = match command.search_path {
        Some(search_path) => format!(
            "Environment={}\n",
            systemd_quote_environment(&format!("PATH={search_path}"))
        ),
        None => String::new(),
    };
    format!(
        "[Unit]\n\
         Description={NAME}\n\
         \n\
         [Service]\n\
         ExecStart={}\n\
         {environment}\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exec_start.join(" ")
    )
}

/// One word of `ExecStart=`: in double quotes, with `\` and `"` escaped, `%`
/// (a specifier) as `%%`, and `$` (a variable) as `$$`.
fn systemd_quote(word: &str) -> String {
    let escaped = word
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// The value of `Environment=`: as [`systemd_quote`], but `$` stays: it is not
/// a variable there.
fn systemd_quote_environment(assignment: &str) -> String {
    let escaped = assignment
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// The XDG autostart entry. `Exec` has no environment, so `env` sets the
/// `PATH`.
fn desktop_entry(command: &ExecCommand<'_>) -> String {
    let mut exec: Vec<String> = Vec::new();
    if let Some(search_path) = command.search_path {
        exec.push("env".to_owned());
        exec.push(desktop_quote(&format!("PATH={search_path}")));
    }
    exec.extend(command.argv.iter().copied().map(desktop_quote));
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={NAME}\n\
         Exec={}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-GNOME-Autostart-enabled=true\n",
        exec.join(" ")
    )
}

/// One argument of `Exec=` (Desktop Entry Specification, "The Exec key"): in
/// double quotes, with `"`, `` ` ``, `$` and `\` escaped by a backslash, `%`
/// (a field code) as `%%`. Then the backslashes are doubled once more: the
/// file format unescapes `\\` before the `Exec` quoting applies.
fn desktop_quote(argument: &str) -> String {
    let mut quoted = String::with_capacity(argument.len() + 2);
    for c in argument.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            c => quoted.push(c),
        }
    }
    format!("\"{}\"", quoted.replace('\\', "\\\\"))
}

/// The real `systemctl --user` of the user who runs the program.
#[cfg(target_os = "linux")]
struct SystemSystemctl;

#[cfg(target_os = "linux")]
impl Systemctl for SystemSystemctl {
    fn run(&mut self, arguments: &[&str]) -> io::Result<CommandOutput> {
        super::run_tool("systemctl", ["--user"].iter().chain(arguments))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::fs;

    use super::*;
    use crate::layout;

    /// Records the `systemctl --user` calls and answers each with the next
    /// prepared result (success when none is left). `missing`: there is no
    /// `systemctl`.
    #[derive(Default)]
    struct SystemctlRecorder {
        calls: Vec<String>,
        answers: VecDeque<bool>,
        missing: bool,
    }

    impl SystemctlRecorder {
        fn answering(answers: &[bool]) -> Self {
            Self {
                answers: answers.iter().copied().collect(),
                ..Self::default()
            }
        }
    }

    impl Systemctl for SystemctlRecorder {
        fn run(&mut self, arguments: &[&str]) -> io::Result<CommandOutput> {
            if self.missing {
                return Err(io::ErrorKind::NotFound.into());
            }
            self.calls.push(arguments.join(" "));
            let success = self.answers.pop_front().unwrap_or(true);
            Ok(CommandOutput {
                success,
                stderr: if success {
                    String::new()
                } else {
                    "refused".to_owned()
                },
            })
        }
    }

    #[derive(Default)]
    struct BackgroundRecorder {
        calls: Vec<String>,
        running: bool,
    }

    impl Background for BackgroundRecorder {
        fn stop(&mut self) -> io::Result<bool> {
            self.calls.push("stop".to_owned());
            Ok(std::mem::take(&mut self.running))
        }

        fn start(&mut self, program: &Path, arguments: &[OsString]) -> io::Result<()> {
            let mut call = vec![program.to_string_lossy().into_owned()];
            call.extend(arguments.iter().map(|a| a.to_string_lossy().into_owned()));
            self.calls.push(format!("start {}", call.join(" ")));
            self.running = true;
            Ok(())
        }
    }

    struct Fixture {
        home: tempfile::TempDir,
        downloaded: PathBuf,
        config_path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let home = tempfile::tempdir().expect("temp home");
            let downloaded = home.path().join("archestra");
            fs::write(&downloaded, b"program").expect("write");
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
                search_path: Some(OsString::from("/home/anna/.nvm/bin:/usr/bin:/bin")),
            }
        }
    }

    #[test]
    fn the_first_start_with_systemd_writes_enables_and_restarts_the_unit() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        // An entry of an earlier start with no systemd.
        write_entry(&desktop_entry_path(home), "old").expect("write");
        let mut systemctl = SystemctlRecorder::default();
        let mut background = BackgroundRecorder::default();

        let started = install_and_start(&fixture.options(), true, &mut systemctl, &mut background)
            .expect("start");

        assert_eq!(started, (Entry::SystemdUnit, true));
        assert_eq!(
            systemctl.calls,
            [
                "show-environment",
                "daemon-reload",
                "enable archestra-mcp-bridge.service",
                "restart archestra-mcp-bridge.service",
            ]
        );
        assert_eq!(background.calls, ["stop"]);
        assert!(!desktop_entry_path(home).exists());
        let program = layout::program_path(home);
        assert_eq!(fs::read(&program).expect("read"), b"program");
        let unit = fs::read_to_string(unit_path(home)).expect("read");
        assert_eq!(
            unit,
            format!(
                "[Unit]\nDescription=Archestra MCP bridge\n\n[Service]\nExecStart=\"{}\" \"bridge\" \"start\" \"--config\" \"{}\" \"--background\"\nEnvironment=\"PATH=/home/anna/.nvm/bin:/usr/bin:/bin\"\n\n[Install]\nWantedBy=default.target\n",
                program.display(),
                fixture.config_path.display()
            )
        );
    }

    #[test]
    fn a_later_start_with_systemd_keeps_the_start_at_login_as_it_is() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        // show-environment and daemon-reload work; the unit is not enabled.
        let mut systemctl = SystemctlRecorder::answering(&[true, true, false]);
        let mut background = BackgroundRecorder::default();

        let started = install_and_start(&fixture.options(), false, &mut systemctl, &mut background)
            .expect("start");

        // It runs, and it is still not in the start at login.
        assert_eq!(started, (Entry::SystemdUnit, false));
        assert_eq!(
            systemctl.calls,
            [
                "show-environment",
                "daemon-reload",
                "is-enabled --quiet archestra-mcp-bridge.service",
                "restart archestra-mcp-bridge.service",
            ]
        );
        assert!(unit_path(home).exists());

        // An enabled unit stays enabled.
        let mut systemctl = SystemctlRecorder::default();
        let started = install_and_start(&fixture.options(), false, &mut systemctl, &mut background)
            .expect("start");
        assert_eq!(started, (Entry::SystemdUnit, true));
        assert!(
            !systemctl
                .calls
                .iter()
                .any(|call| call.starts_with("enable"))
        );
    }

    #[test]
    fn with_no_systemd_session_it_starts_a_process_of_its_own() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut systemctl = SystemctlRecorder::answering(&[false]);
        let mut background = BackgroundRecorder::default();

        let started = install_and_start(&fixture.options(), true, &mut systemctl, &mut background)
            .expect("start");

        assert_eq!(started, (Entry::XdgAutostart, true));
        assert_eq!(systemctl.calls, ["show-environment"]);
        let program = layout::program_path(home);
        assert_eq!(
            background.calls,
            [
                "stop".to_owned(),
                format!(
                    "start {} bridge start --config {} --background",
                    program.display(),
                    fixture.config_path.display()
                ),
            ]
        );
        assert!(!unit_path(home).exists());
        let entry_text = fs::read_to_string(desktop_entry_path(home)).expect("read");
        assert!(entry_text.starts_with("[Desktop Entry]\nType=Application\n"));
        assert!(entry_text.contains(&format!(
            "Exec=env \"PATH=/home/anna/.nvm/bin:/usr/bin:/bin\" \"{}\" \"bridge\" \"start\" \"--config\" \"{}\" \"--background\"\n",
            program.display(),
            fixture.config_path.display()
        )));

        // No systemctl at all, and not the first start: it runs, with no
        // entry in the start at login.
        let fixture = Fixture::new();
        let mut systemctl = SystemctlRecorder {
            missing: true,
            ..SystemctlRecorder::default()
        };
        let mut background = BackgroundRecorder::default();
        let started = install_and_start(&fixture.options(), false, &mut systemctl, &mut background)
            .expect("start");
        assert_eq!(started, (Entry::XdgAutostart, false));
        assert!(!desktop_entry_path(fixture.home.path()).exists());
        assert!(background.running);
    }

    #[test]
    fn a_failed_systemctl_is_an_error() {
        let fixture = Fixture::new();
        // show-environment works, daemon-reload works, enable fails.
        let mut systemctl = SystemctlRecorder::answering(&[true, true, false]);
        let error = install_and_start(
            &fixture.options(),
            true,
            &mut systemctl,
            &mut BackgroundRecorder::default(),
        )
        .expect_err("enable failed");
        assert!(matches!(
            error,
            AutostartError::Linux(LinuxError::SystemctlFailed { command, reason })
                if command == "enable archestra-mcp-bridge.service" && reason == "refused"
        ));
    }

    #[test]
    fn stop_stops_the_unit_and_keeps_the_start_at_login() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        write_entry(&unit_path(home), "unit").expect("write");
        let mut systemctl = SystemctlRecorder::default();
        let mut background = BackgroundRecorder::default();

        assert!(stop_bridge(home, &mut systemctl, &mut background).expect("stop"));

        assert_eq!(
            systemctl.calls,
            [
                "is-active --quiet archestra-mcp-bridge.service",
                "stop archestra-mcp-bridge.service",
            ]
        );
        assert!(unit_path(home).exists());

        // A unit that does not run is not stopped again.
        let mut systemctl = SystemctlRecorder::answering(&[false]);
        assert!(!stop_bridge(home, &mut systemctl, &mut background).expect("stop"));
        assert_eq!(
            systemctl.calls,
            ["is-active --quiet archestra-mcp-bridge.service"]
        );
    }

    #[test]
    fn stop_finds_the_process_of_its_own_and_keeps_the_autostart_entry() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        write_entry(&desktop_entry_path(home), "entry").expect("write");
        let mut systemctl = SystemctlRecorder::default();
        let mut background = BackgroundRecorder {
            running: true,
            ..BackgroundRecorder::default()
        };

        assert!(stop_bridge(home, &mut systemctl, &mut background).expect("stop"));

        // No unit: systemd is not asked.
        assert!(systemctl.calls.is_empty());
        assert!(desktop_entry_path(home).exists());
    }

    #[test]
    fn enable_and_disable_change_only_the_start_at_login() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut systemctl = SystemctlRecorder::default();

        add_to_login(&fixture.options(), &mut systemctl).expect("enable");

        // No start and no restart.
        assert_eq!(
            systemctl.calls,
            [
                "show-environment",
                "daemon-reload",
                "enable archestra-mcp-bridge.service",
            ]
        );
        assert!(unit_path(home).exists());

        let mut systemctl = SystemctlRecorder::default();
        assert!(remove_from_login(home, &mut systemctl).expect("disable"));
        assert_eq!(
            systemctl.calls,
            [
                "is-enabled --quiet archestra-mcp-bridge.service",
                "disable archestra-mcp-bridge.service",
            ]
        );
        // systemd still runs the MCP bridge from the unit file.
        assert!(unit_path(home).exists());

        // Not enabled: nothing to remove.
        let mut systemctl = SystemctlRecorder::answering(&[false]);
        assert!(!remove_from_login(home, &mut systemctl).expect("disable again"));
    }

    #[test]
    fn enable_and_disable_with_no_systemd_session_use_the_autostart_entry() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        let mut systemctl = SystemctlRecorder {
            missing: true,
            ..SystemctlRecorder::default()
        };

        add_to_login(&fixture.options(), &mut systemctl).expect("enable");
        assert!(desktop_entry_path(home).exists());
        assert!(!unit_path(home).exists());

        assert!(remove_from_login(home, &mut systemctl).expect("disable"));
        assert!(!desktop_entry_path(home).exists());
        assert!(!remove_from_login(home, &mut systemctl).expect("disable again"));
    }

    #[test]
    fn remove_disables_the_unit_and_removes_both_entries() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        write_entry(&unit_path(home), "unit").expect("write");
        write_entry(&desktop_entry_path(home), "entry").expect("write");
        fs::create_dir_all(fixture.config_path.parent().expect("parent")).expect("mkdir");
        fs::write(&fixture.config_path, "config").expect("write");
        let mut systemctl = SystemctlRecorder::default();
        let mut background = BackgroundRecorder::default();

        let removal = stop_and_remove(home, &mut systemctl, &mut background).expect("stop");

        assert_eq!(
            removal,
            Removal {
                stopped: true,
                autostart_removed: true
            }
        );
        assert_eq!(
            systemctl.calls,
            [
                "is-active --quiet archestra-mcp-bridge.service",
                "disable --now archestra-mcp-bridge.service",
                "daemon-reload",
            ]
        );
        assert_eq!(background.calls, ["stop"]);
        assert!(!unit_path(home).exists());
        assert!(!desktop_entry_path(home).exists());
        // The files of the MCP bridge are not the business of this function.
        assert!(fixture.config_path.exists());
    }

    #[test]
    fn remove_finds_the_bridge_of_the_autostart_entry() {
        let fixture = Fixture::new();
        let home = fixture.home.path();
        write_entry(&desktop_entry_path(home), "entry").expect("write");
        let mut systemctl = SystemctlRecorder::default();
        let mut background = BackgroundRecorder {
            running: true,
            ..BackgroundRecorder::default()
        };

        let removal = stop_and_remove(home, &mut systemctl, &mut background).expect("stop");

        assert_eq!(
            removal,
            Removal {
                stopped: true,
                autostart_removed: true
            }
        );
        // No unit: systemd is not asked.
        assert!(systemctl.calls.is_empty());

        let again = stop_and_remove(home, &mut systemctl, &mut background).expect("again");
        assert_eq!(
            again,
            Removal {
                stopped: false,
                autostart_removed: false
            }
        );
    }

    #[test]
    fn quoting_escapes_specifiers_variables_and_quotes() {
        assert_eq!(
            systemd_quote(r#"/home/a b/100%/$x/"q"\"#),
            r#""/home/a b/100%%/$$x/\"q\"\\""#
        );
        assert_eq!(
            systemd_quote_environment("PATH=/opt/50%/$bin"),
            r#""PATH=/opt/50%%/$bin""#
        );
        assert_eq!(
            desktop_quote(r#"/home/a b/100%/$x/"q"`\"#),
            r#""/home/a b/100%%/\\$x/\\"q\\"\\`\\\\""#
        );
    }

    #[test]
    fn no_search_path_no_environment() {
        let command = ExecCommand {
            argv: vec!["/h/archestra", "bridge", "start"],
            search_path: None,
        };
        assert!(!unit_file(&command).contains("Environment="));
        assert!(desktop_entry(&command).contains("Exec=\"/h/archestra\" \"bridge\""));
    }
}
