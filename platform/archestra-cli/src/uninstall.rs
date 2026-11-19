//! `archestra uninstall`: removes Archestra from this computer.
//!
//! 1. Stops the MCP bridge and removes it from the start at login. If that
//!    fails, nothing is removed.
//! 2. Asks Archestra to remove the device of this computer, so that the
//!    Device tab does not show it any more. If Archestra does not answer,
//!    the uninstall goes on and says how to remove the device by hand.
//! 3. Deletes the folder of the MCP bridge (its config file with the device
//!    key, and its log files), then the program in `~/.archestra/bin/`.
//! 4. Takes the program off the `PATH` of the user ([`crate::shell_path`]).
//!
//! `~/.archestra` itself is removed only when it is empty: other Archestra
//! tools can keep files there. There is no `archestra uninstall bridge`: the
//! MCP bridge goes with the program.

use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::bridge::autostart::{self, AutostartError, Removal};
use crate::bridge::remove::{self, DeviceRemoval};
use crate::{layout, shell_path};

#[derive(Debug, thiserror::Error)]
pub enum UninstallError {
    #[error("cannot find the home folder")]
    NoHome,
    #[error("{0}\nNothing was removed.")]
    Bridge(#[from] AutostartError),
    #[error("cannot start the runtime: {0}")]
    Runtime(#[source] io::Error),
    #[error("cannot delete the files of the MCP bridge in {path}: {source}")]
    BridgeFiles { path: PathBuf, source: io::Error },
    #[error("cannot delete the program {path}: {source}")]
    Program { path: PathBuf, source: io::Error },
    #[error("the files are deleted, but the `archestra` command is still on the PATH: {0}")]
    ShellPath(#[source] io::Error),
}

/// Runs `archestra uninstall`. Nothing to remove is a success.
pub fn run() -> Result<ExitCode, UninstallError> {
    let home = std::env::home_dir().ok_or(UninstallError::NoHome)?;
    let bridge = autostart::remove()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(UninstallError::Runtime)?;
    let device = runtime
        .block_on(remove::forget_device(&home))
        .map_err(|source| UninstallError::BridgeFiles {
            path: layout::bridge_dir(&home),
            source,
        })?;
    let program = remove_program(&home).map_err(|source| UninstallError::Program {
        path: layout::program_path(&home),
        source,
    })?;
    let off_the_path = shell_path::remove(&home).map_err(UninstallError::ShellPath)?;
    println!("{}", report(&home, bridge, &device, program, off_the_path));
    Ok(ExitCode::SUCCESS)
}

/// What happened to the program in `~/.archestra/bin/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgramRemoval {
    Removed,
    NotThere,
    /// Windows cannot delete the file of a program that runs: it goes away a
    /// few seconds after this command ends.
    #[cfg(windows)]
    AfterExit,
}

/// Deletes the program, then its folder and `~/.archestra` when they are
/// empty.
fn remove_program(home: &Path) -> io::Result<ProgramRemoval> {
    let program = layout::program_path(home);
    let folders = [layout::bin_dir(home), layout::archestra_dir(home)];
    #[cfg(windows)]
    if is_this_program(&program) {
        delete_after_exit(home, &program, &folders)?;
        return Ok(ProgramRemoval::AfterExit);
    }
    let removed = match std::fs::remove_file(&program) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    for folder in &folders {
        // A folder with other files stays: that is not an error.
        let _ = std::fs::remove_dir(folder);
    }
    Ok(if removed {
        ProgramRemoval::Removed
    } else {
        ProgramRemoval::NotThere
    })
}

/// This process runs from `program`.
#[cfg(windows)]
fn is_this_program(program: &Path) -> bool {
    let (Ok(current), Ok(program)) = (
        std::env::current_exe().and_then(std::fs::canonicalize),
        std::fs::canonicalize(program),
    ) else {
        return false;
    };
    current == program
}

/// Starts a hidden `cmd` that waits a few seconds, until this process ended,
/// and then deletes the program and the empty folders.
#[cfg(windows)]
fn delete_after_exit(home: &Path, program: &Path, folders: &[PathBuf]) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    // `ping` is the wait that works with no console.
    let mut script = format!(
        "ping -n 4 127.0.0.1 >nul & del /f /q \"{}\"",
        program.display()
    );
    for folder in folders {
        script.push_str(&format!(" & rmdir \"{}\"", folder.display()));
    }
    Command::new("cmd")
        // `/s` with the whole script in one more pair of quotes: `cmd` takes
        // the text between them as it is.
        .raw_arg(format!("/d /s /c \"{script}\""))
        // Not in a folder that it deletes.
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(())
}

/// What the terminal shows after the uninstall.
fn report(
    home: &Path,
    bridge: Removal,
    device: &DeviceRemoval,
    program: ProgramRemoval,
    off_the_path: bool,
) -> String {
    let mut lines = vec!["Removed Archestra from this device.".to_owned()];
    lines.push(
        match (bridge.stopped, bridge.autostart_removed) {
            (true, true) => "- Stopped the MCP bridge and turned its auto-start off.",
            (true, false) => "- Stopped the MCP bridge. Its auto-start was off.",
            (false, true) => "- Turned the auto-start of the MCP bridge off. It did not run.",
            (false, false) => "- The MCP bridge did not run, and its auto-start was off.",
        }
        .to_owned(),
    );
    lines.push(match device {
        DeviceRemoval::Removed => "- Archestra unlinked this device.".to_owned(),
        DeviceRemoval::NotSignedIn => "- This device was not linked to Archestra.".to_owned(),
        DeviceRemoval::Failed { base_url, reason } => {
            let devices_page = match base_url {
                Some(base_url) => format!("{base_url}/account/devices"),
                None => "the Device tab of Personal Settings in Archestra".to_owned(),
            };
            format!(
                "- Archestra did not unlink this device ({reason}).\n  \
                 Unlink it by hand: {devices_page}"
            )
        }
    });
    let bridge_dir = layout::bridge_dir(home);
    let program_path = layout::program_path(home);
    lines.push(format!(
        "- Deleted {} (the config file with the device key, and the log files).",
        bridge_dir.display()
    ));
    lines.push(match program {
        ProgramRemoval::Removed => format!("- Deleted the program {}.", program_path.display()),
        ProgramRemoval::NotThere => {
            format!("- The program was not in {}.", program_path.display())
        }
        #[cfg(windows)]
        ProgramRemoval::AfterExit => format!(
            "- The program {} goes away in a few seconds.",
            program_path.display()
        ),
    });
    if off_the_path {
        lines.push("- Took the `archestra` command off your PATH.".to_owned());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write(path: &Path) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, "text").expect("write");
    }

    #[test]
    fn remove_program_deletes_the_program_and_the_empty_folders() {
        let home = tempfile::tempdir().expect("temp home");
        let program = layout::program_path(home.path());
        write(&program);

        assert_eq!(
            remove_program(home.path()).expect("remove"),
            ProgramRemoval::Removed
        );

        assert!(!layout::archestra_dir(home.path()).exists());
        // A second uninstall has nothing to do.
        assert_eq!(
            remove_program(home.path()).expect("remove again"),
            ProgramRemoval::NotThere
        );
    }

    #[test]
    fn remove_program_keeps_the_files_of_other_tools() {
        let home = tempfile::tempdir().expect("temp home");
        write(&layout::program_path(home.path()));
        let other_tool = layout::archestra_dir(home.path()).join("skill-marketplace-cache/x");
        let beside_the_program = layout::bin_dir(home.path()).join("other-program");
        write(&other_tool);
        write(&beside_the_program);

        remove_program(home.path()).expect("remove");

        assert!(!layout::program_path(home.path()).exists());
        assert!(other_tool.exists());
        assert!(beside_the_program.exists());
    }

    #[test]
    fn report_says_what_went_and_how_to_remove_the_device_by_hand() {
        let home = Path::new("/h");
        let stopped = Removal {
            stopped: true,
            autostart_removed: true,
        };
        let report_text = report(
            home,
            stopped,
            &DeviceRemoval::Removed,
            ProgramRemoval::Removed,
            true,
        );
        assert!(report_text.ends_with("- Took the `archestra` command off your PATH."));
        assert!(report_text.starts_with("Removed Archestra from this device.\n"));
        assert!(report_text.contains("Stopped the MCP bridge and turned its auto-start off."));
        assert!(report_text.contains("Archestra unlinked this device."));
        assert!(report_text.contains(&format!(
            "Deleted the program {}.",
            layout::program_path(home).display()
        )));

        let nothing = Removal {
            stopped: false,
            autostart_removed: false,
        };
        let report_text = report(
            home,
            nothing,
            &DeviceRemoval::Failed {
                base_url: Some("https://archestra.example.com".to_owned()),
                reason: "Archestra answered with HTTP status 503".to_owned(),
            },
            ProgramRemoval::NotThere,
            false,
        );
        assert!(!report_text.contains("off your PATH"));
        assert!(report_text.contains("The MCP bridge did not run, and its auto-start was off."));
        assert!(report_text.contains(
            "Archestra did not unlink this device (Archestra answered with HTTP status 503).\n  \
             Unlink it by hand: https://archestra.example.com/account/devices"
        ));
    }
}
