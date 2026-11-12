//! The MCP bridge on Windows: a copy of the program in
//! `%USERPROFILE%\.archestra\bin\archestra.exe` that runs as a process of its
//! own ([`super::Background`]). It starts at each login when the key
//! `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` has the
//! value `Archestra MCP bridge`. That is the start at login of the user, with
//! no administrator rights; Task Manager lists it under "Startup apps".
//!
//! [`install_and_start`] stops the MCP bridge that runs (a running `.exe`
//! cannot be replaced), copies the program, and starts the copy as a process
//! of its own: the command in the terminal then ends. [`add_to_login`] writes
//! the value, and [`stop_and_remove`] stops the MCP bridge and deletes it.
//!
//! The parts take the home folder, a [`RunKey`] and a [`Background`], so that
//! a test never writes to the real home folder or the registry.

use std::io;
use std::path::Path;

use super::{
    AutostartError, Background, Removal, background_arguments, install_program, installed_program,
    start_command,
};

/// The name of the value in the `Run` key.
const RUN_VALUE_NAME: &str = "Archestra MCP bridge";
/// What holds the paths, for the error of a path that is not UTF-8.
const ENTRY: &str = "the Run key";

#[derive(Debug, thiserror::Error)]
pub enum WindowsError {
    #[error("cannot read the Run value: {0}")]
    Read(#[source] io::Error),
    #[error("cannot write the Run value: {0}")]
    Write(#[source] io::Error),
    #[error("cannot delete the Run value: {0}")]
    Delete(#[source] io::Error),
}

/// The values of the `Run` key of the user. [`SystemRunKey`] is the real
/// key; a test gives a recorder.
trait RunKey {
    fn contains(&mut self, name: &str) -> io::Result<bool>;
    fn set(&mut self, name: &str, value: &str) -> io::Result<()>;
    /// `false`: there was no such value.
    fn delete(&mut self, name: &str) -> io::Result<bool>;
}

/// `archestra bridge start` on Windows.
#[cfg(windows)]
pub(super) fn start(
    options: &super::Options<'_>,
    add_to_login: bool,
) -> Result<super::Started, AutostartError> {
    let at_login = install_and_start(
        options,
        add_to_login,
        &mut SystemRunKey,
        &mut super::SystemBackground { home: options.home },
    )?;
    Ok(super::Started {
        where_it_runs: "Its icon in the notification area of the taskbar shows its status.",
        at_login,
    })
}

/// `archestra bridge stop` on Windows.
#[cfg(windows)]
pub(super) fn stop(home: &Path) -> Result<bool, AutostartError> {
    use super::Background as _;

    super::SystemBackground { home }
        .stop()
        .map_err(AutostartError::StopRunning)
}

/// `archestra bridge enable-auto-start` on Windows.
#[cfg(windows)]
pub(super) fn enable(options: &super::Options<'_>) -> Result<(), AutostartError> {
    add_to_login(options, &mut SystemRunKey)
}

/// `archestra bridge disable-auto-start` on Windows.
#[cfg(windows)]
pub(super) fn disable(_home: &Path) -> Result<bool, AutostartError> {
    remove_from_login(&mut SystemRunKey)
}

/// `archestra bridge status` on Windows.
#[cfg(windows)]
pub(super) fn status(home: &Path) -> Result<super::Status, AutostartError> {
    let running = crate::bridge::instance::is_running(home).unwrap_or(false);
    bridge_status(&mut SystemRunKey, running)
}

/// The MCP bridge part of `archestra uninstall` on Windows.
#[cfg(windows)]
pub(super) fn remove(home: &Path) -> Result<Removal, AutostartError> {
    stop_and_remove(&mut SystemRunKey, &mut super::SystemBackground { home })
}

/// Copies the program and starts the copy as a process of its own. It writes
/// the `Run` value when `add_to_login` says so, and brings a value that is
/// there up to date. Returns whether the MCP bridge is in the start at
/// login.
fn install_and_start(
    options: &super::Options<'_>,
    add_to_login: bool,
    run_key: &mut impl RunKey,
    background: &mut impl Background,
) -> Result<bool, AutostartError> {
    // First: the copy cannot replace the program of a running MCP bridge.
    background.stop().map_err(AutostartError::StopRunning)?;
    let program = install_program(options.home, options.current_program)?;
    let arguments = background_arguments(options.config_path);
    let at_login = add_to_login
        || run_key
            .contains(RUN_VALUE_NAME)
            .map_err(WindowsError::Read)?;
    if at_login {
        write_run_value(run_key, &program, &arguments)?;
    }
    background
        .start(&program, &arguments)
        .map_err(AutostartError::StartBackground)?;
    Ok(at_login)
}

/// Writes the `Run` value. The MCP bridge is not started or stopped now.
fn add_to_login(
    options: &super::Options<'_>,
    run_key: &mut impl RunKey,
) -> Result<(), AutostartError> {
    let program = installed_program(options.home, options.current_program)?;
    write_run_value(
        run_key,
        &program,
        &background_arguments(options.config_path),
    )
}

fn write_run_value(
    run_key: &mut impl RunKey,
    program: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<(), AutostartError> {
    run_key
        .set(
            RUN_VALUE_NAME,
            &run_value(&start_command(program, arguments, ENTRY)?),
        )
        .map_err(WindowsError::Write)?;
    Ok(())
}

/// Deletes the `Run` value. An MCP bridge that runs keeps running. `false`:
/// there was no value.
fn remove_from_login(run_key: &mut impl RunKey) -> Result<bool, AutostartError> {
    Ok(run_key
        .delete(RUN_VALUE_NAME)
        .map_err(WindowsError::Delete)?)
}

/// `running`: the MCP bridge holds its lock. It is in the start at login when
/// the `Run` value is there.
fn bridge_status(
    run_key: &mut impl RunKey,
    running: bool,
) -> Result<super::Status, AutostartError> {
    Ok(super::Status {
        running,
        auto_start: run_key
            .contains(RUN_VALUE_NAME)
            .map_err(WindowsError::Read)?,
    })
}

/// Stops the MCP bridge and deletes the `Run` value.
fn stop_and_remove(
    run_key: &mut impl RunKey,
    background: &mut impl Background,
) -> Result<Removal, AutostartError> {
    let stopped = background.stop().map_err(AutostartError::StopRunning)?;
    let autostart_removed = remove_from_login(run_key)?;
    Ok(Removal {
        stopped,
        autostart_removed,
    })
}

/// The command line in the `Run` value, from the program and its arguments.
/// A word of letters, digits and `-` stays as it is. Each other argument (the
/// two paths) is in double quotes: a path can have spaces, and a Windows path
/// cannot have a `"`.
fn run_value(command: &[&str]) -> String {
    let quoted: Vec<String> = command
        .iter()
        .map(|argument| {
            let is_word = !argument.is_empty()
                && argument
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-');
            if is_word {
                (*argument).to_owned()
            } else {
                format!("\"{argument}\"")
            }
        })
        .collect();
    quoted.join(" ")
}

/// The `Run` key of the user who runs the program, through the registry API.
#[cfg(windows)]
struct SystemRunKey;

#[cfg(windows)]
impl SystemRunKey {
    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
}

#[cfg(windows)]
impl RunKey for SystemRunKey {
    fn contains(&mut self, name: &str) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_ANY, RegGetValueW};

        use crate::bridge::win32::wide;

        let subkey = wide(Self::SUBKEY);
        let name = wide(name);
        // SAFETY: the strings are NUL-terminated UTF-16 that live for the
        // call. With no buffers the call only says if the value is there.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_ANY,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        match status {
            ERROR_SUCCESS => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            _ => Err(io::Error::from_raw_os_error(status as i32)),
        }
    }

    fn set(&mut self, name: &str, value: &str) -> io::Result<()> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};

        use crate::bridge::win32::wide;

        let subkey = wide(Self::SUBKEY);
        let name = wide(name);
        let data = wide(value);
        let size = u32::try_from(data.len() * size_of::<u16>())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the value is too long"))?;
        // SAFETY: the strings are NUL-terminated UTF-16 that live for the
        // call; a REG_SZ value is its UTF-16 text with the NUL, and `size` is
        // its length in bytes. The key is created when it is missing.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                size,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }

    fn delete(&mut self, name: &str) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
        use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RegDeleteKeyValueW};

        use crate::bridge::win32::wide;

        let subkey = wide(Self::SUBKEY);
        let name = wide(name);
        // SAFETY: the strings are NUL-terminated UTF-16 that live for the
        // call.
        let status =
            unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr()) };
        match status {
            ERROR_SUCCESS => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            _ => Err(io::Error::from_raw_os_error(status as i32)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::fs;

    use super::*;
    use crate::layout;

    /// A `Run` key in memory.
    #[derive(Default)]
    struct MemoryRunKey {
        values: BTreeMap<String, String>,
    }

    impl RunKey for MemoryRunKey {
        fn contains(&mut self, name: &str) -> io::Result<bool> {
            Ok(self.values.contains_key(name))
        }

        fn set(&mut self, name: &str, value: &str) -> io::Result<()> {
            self.values.insert(name.to_owned(), value.to_owned());
            Ok(())
        }

        fn delete(&mut self, name: &str) -> io::Result<bool> {
            Ok(self.values.remove(name).is_some())
        }
    }

    /// Records the calls; `running` says if an MCP bridge runs.
    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
        running: bool,
        /// The program file at the time of the start.
        started_program: Option<Vec<u8>>,
    }

    impl Background for Recorder {
        fn stop(&mut self) -> io::Result<bool> {
            self.calls.push("stop".to_owned());
            Ok(std::mem::take(&mut self.running))
        }

        fn start(&mut self, program: &Path, arguments: &[OsString]) -> io::Result<()> {
            let arguments: Vec<String> = arguments
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            self.calls.push(format!("start {}", arguments.join(" ")));
            self.started_program = Some(fs::read(program)?);
            self.running = true;
            Ok(())
        }
    }

    /// A home folder with a downloaded program.
    struct Fixture {
        home: tempfile::TempDir,
        downloaded: std::path::PathBuf,
        config_path: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let home = tempfile::tempdir().expect("temp home");
            let downloaded = home.path().join("Downloads").join("archestra.exe");
            fs::create_dir_all(downloaded.parent().expect("parent")).expect("mkdir");
            fs::write(&downloaded, b"new program").expect("write");
            let config_path = layout::bridge_config_path(home.path());
            Self {
                home,
                downloaded,
                config_path,
            }
        }

        fn options(&self) -> super::super::Options<'_> {
            super::super::Options {
                home: self.home.path(),
                current_program: &self.downloaded,
                config_path: &self.config_path,
                #[cfg(unix)]
                search_path: None,
            }
        }

        fn run_value(&self) -> String {
            format!(
                "\"{}\" bridge start --config \"{}\" --background",
                layout::program_path(self.home.path()).display(),
                self.config_path.display()
            )
        }
    }

    #[test]
    fn the_first_start_stops_the_old_bridge_copies_writes_the_value_and_starts() {
        let fixture = Fixture::new();
        let mut run_key = MemoryRunKey::default();
        let mut background = Recorder {
            running: true,
            ..Recorder::default()
        };

        let at_login = install_and_start(&fixture.options(), true, &mut run_key, &mut background)
            .expect("start");

        assert!(at_login);
        assert_eq!(
            background.calls,
            [
                "stop".to_owned(),
                format!(
                    "start bridge start --config {} --background",
                    fixture.config_path.display()
                ),
            ]
        );
        assert_eq!(
            background.started_program.as_deref(),
            Some(&b"new program"[..])
        );
        assert_eq!(
            run_key.values.get(RUN_VALUE_NAME),
            Some(&fixture.run_value())
        );
    }

    #[test]
    fn a_later_start_keeps_the_start_at_login_as_it_is() {
        let fixture = Fixture::new();
        let mut run_key = MemoryRunKey::default();
        let mut background = Recorder::default();

        // No value: it runs, and it is still not in the start at login.
        let at_login = install_and_start(&fixture.options(), false, &mut run_key, &mut background)
            .expect("start");
        assert!(!at_login);
        assert!(run_key.values.is_empty());
        assert!(background.running);

        // A value that is there is brought up to date.
        run_key.set(RUN_VALUE_NAME, "old").expect("set");
        let at_login = install_and_start(&fixture.options(), false, &mut run_key, &mut background)
            .expect("start");
        assert!(at_login);
        assert_eq!(
            run_key.values.get(RUN_VALUE_NAME),
            Some(&fixture.run_value())
        );
    }

    #[test]
    fn enable_and_disable_change_only_the_start_at_login() {
        let fixture = Fixture::new();
        let mut run_key = MemoryRunKey::default();

        add_to_login(&fixture.options(), &mut run_key).expect("enable");
        assert_eq!(
            run_key.values.get(RUN_VALUE_NAME),
            Some(&fixture.run_value())
        );
        // The program is there for the next login.
        assert!(layout::program_path(fixture.home.path()).is_file());

        assert!(remove_from_login(&mut run_key).expect("disable"));
        assert!(run_key.values.is_empty());
        assert!(!remove_from_login(&mut run_key).expect("disable again"));
    }

    #[test]
    fn status_reads_the_run_value() {
        let mut run_key = MemoryRunKey::default();
        assert_eq!(
            bridge_status(&mut run_key, true).expect("status"),
            crate::bridge::autostart::Status {
                running: true,
                auto_start: false
            }
        );
        run_key.set(RUN_VALUE_NAME, "value").expect("set");
        assert!(
            bridge_status(&mut run_key, false)
                .expect("status")
                .auto_start
        );
    }

    #[test]
    fn stop_and_remove_stops_and_deletes_the_value() {
        let mut run_key = MemoryRunKey::default();
        run_key
            .set(RUN_VALUE_NAME, "\"C:\\a.exe\" bridge start")
            .expect("set");
        run_key.set("Other app", "other.exe").expect("set");
        let mut background = Recorder {
            running: true,
            ..Recorder::default()
        };

        let removal = stop_and_remove(&mut run_key, &mut background).expect("stop");

        assert_eq!(
            removal,
            Removal {
                stopped: true,
                autostart_removed: true
            }
        );
        // The value of a different program stays.
        assert_eq!(run_key.values.keys().collect::<Vec<_>>(), ["Other app"]);

        let again = stop_and_remove(&mut run_key, &mut background).expect("stop again");
        assert_eq!(
            again,
            Removal {
                stopped: false,
                autostart_removed: false
            }
        );
    }

    #[test]
    fn the_run_value_quotes_paths_with_spaces() {
        let arguments = background_arguments(Path::new(
            r"C:\Users\Anna Maria\.archestra\mcp-bridge\config.yaml",
        ));
        let command = start_command(
            Path::new(r"C:\Users\Anna Maria\.archestra\bin\archestra.exe"),
            &arguments,
            ENTRY,
        )
        .expect("text");
        let value = run_value(&command);
        assert_eq!(
            value,
            r#""C:\Users\Anna Maria\.archestra\bin\archestra.exe" bridge start --config "C:\Users\Anna Maria\.archestra\mcp-bridge\config.yaml" --background"#
        );
    }
}
