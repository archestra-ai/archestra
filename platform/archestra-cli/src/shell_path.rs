//! The `archestra` command on the `PATH` of the user, so that `archestra
//! bridge stop` works in any terminal, with no `~/.archestra/bin/` before it.
//!
//! [`add`] runs at the first start on a computer, and [`remove`] at
//! `archestra uninstall`.
//!
//! - macOS and Linux: two lines in the startup file of the shell of the user
//!   (`$SHELL`): `~/.zshrc`, `~/.bashrc` (`~/.bash_profile` on macOS),
//!   `~/.profile` for another shell, or a file of its own for fish. A
//!   terminal that is open already does not see the change.
//! - Windows: the folder of the program in the `Path` value of the user
//!   (`HKEY_CURRENT_USER\Environment`), with no administrator rights. A
//!   terminal that is open already does not see the change.
//!
//! The parts take the home folder and the environment, so that a test never
//! writes to the real home folder.

use std::io;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

use crate::layout;

/// What [`add`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Added {
    /// The folder of the program is on the `PATH` already: nothing changed.
    AlreadyOnPath,
    /// A startup file of the shell has the lines now (or had them already).
    #[cfg(unix)]
    StartupFile(PathBuf),
    /// The `Path` value of the user has the folder now.
    #[cfg(windows)]
    UserPath,
}

impl Added {
    /// What the terminal shows after the first start.
    pub fn message(&self) -> String {
        match self {
            Self::AlreadyOnPath => "The `archestra` command is on your PATH.".to_owned(),
            // No path: the terminal says it in plain words. The file is in
            // the log of the MCP bridge.
            #[cfg(unix)]
            Self::StartupFile(path) => {
                tracing::info!(file = %path.display(), "put the `archestra` command on the PATH");
                "The `archestra` command works in each new terminal.".to_owned()
            }
            #[cfg(windows)]
            Self::UserPath => "The `archestra` command works in each new terminal.".to_owned(),
        }
    }
}

/// Puts the folder of the program on the `PATH` of the user.
pub fn add(home: &Path) -> io::Result<Added> {
    #[cfg(unix)]
    {
        unix::add(home, &unix::Environment::of_this_process())
    }
    #[cfg(windows)]
    {
        windows::add(home)
    }
}

/// Takes the folder of the program off the `PATH` of the user. `false`:
/// nothing was there.
pub fn remove(home: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        unix::remove(home, &unix::Environment::of_this_process())
    }
    #[cfg(windows)]
    {
        windows::remove(home)
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::OsString;
    use std::fs;

    use super::{Added, Path, PathBuf, io, layout};

    /// The first line: it says who added the lines, and how they go away.
    const MARKER: &str = "# Added by archestra: the `archestra` command. `archestra uninstall` removes these two lines.";
    const SH_LINE: &str = "export PATH=\"$HOME/.archestra/bin:$PATH\"";
    const FISH_LINE: &str = "set -gx PATH \"$HOME/.archestra/bin\" $PATH";

    /// What decides the startup file. [`Environment::of_this_process`] is the
    /// real one; a test gives its own.
    #[derive(Debug, Default)]
    pub(super) struct Environment {
        /// `$PATH`.
        pub path: Option<OsString>,
        /// `$SHELL`: the shell of the user.
        pub shell: Option<OsString>,
        /// `$ZDOTDIR`: where zsh reads `.zshrc` from, when it is not the
        /// home folder.
        pub zdotdir: Option<OsString>,
        /// Terminals on macOS start a login shell: bash then reads
        /// `~/.bash_profile`, not `~/.bashrc`.
        pub macos: bool,
    }

    impl Environment {
        pub(super) fn of_this_process() -> Self {
            Self {
                path: std::env::var_os("PATH"),
                shell: std::env::var_os("SHELL"),
                zdotdir: std::env::var_os("ZDOTDIR").filter(|value| !value.is_empty()),
                macos: cfg!(target_os = "macos"),
            }
        }
    }

    pub(super) fn add(home: &Path, environment: &Environment) -> io::Result<Added> {
        let bin_dir = layout::bin_dir(home);
        let on_path = environment
            .path
            .as_deref()
            .is_some_and(|path| std::env::split_paths(path).any(|folder| folder == bin_dir));
        if on_path {
            return Ok(Added::AlreadyOnPath);
        }
        let (path, line) = startup_file(home, environment);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error),
        };
        if !text.lines().any(|existing| existing == line) {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, with_lines(&text, line))?;
        }
        Ok(Added::StartupFile(path))
    }

    /// Removes the lines from each startup file that [`add`] can write to:
    /// the shell of the user can be another one now.
    pub(super) fn remove(home: &Path, environment: &Environment) -> io::Result<bool> {
        let mut removed = false;
        let mut sh_files = vec![
            home.join(".zshrc"),
            home.join(".bashrc"),
            home.join(".bash_profile"),
            home.join(".profile"),
        ];
        if let Some(zdotdir) = &environment.zdotdir {
            sh_files.push(PathBuf::from(zdotdir).join(".zshrc"));
        }
        for path in sh_files {
            let text = match fs::read_to_string(&path) {
                Ok(text) => text,
                // No such file, or one that is not text: not ours.
                Err(_) => continue,
            };
            if let Some(without) = without_lines(&text, SH_LINE) {
                fs::write(&path, without)?;
                removed = true;
            }
        }
        // The fish file has only our lines.
        match fs::remove_file(fish_file(home)) {
            Ok(()) => removed = true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(removed)
    }

    /// The startup file of the shell of the user, and the line for it.
    fn startup_file(home: &Path, environment: &Environment) -> (PathBuf, &'static str) {
        let shell = environment
            .shell
            .as_deref()
            .map(Path::new)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str());
        match shell {
            Some("zsh") => {
                let folder = environment
                    .zdotdir
                    .as_ref()
                    .map_or_else(|| home.to_owned(), PathBuf::from);
                (folder.join(".zshrc"), SH_LINE)
            }
            Some("bash") if environment.macos => (home.join(".bash_profile"), SH_LINE),
            Some("bash") => (home.join(".bashrc"), SH_LINE),
            Some("fish") => (fish_file(home), FISH_LINE),
            _ => (home.join(".profile"), SH_LINE),
        }
    }

    /// fish reads each file of this folder at its start.
    fn fish_file(home: &Path) -> PathBuf {
        home.join(".config/fish/conf.d/archestra.fish")
    }

    /// `text` with the two lines at its end, after an empty line when the
    /// file has other text.
    fn with_lines(text: &str, line: &str) -> String {
        let mut text = text.to_owned();
        if !text.is_empty() {
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text.push('\n');
        }
        text.push_str(MARKER);
        text.push('\n');
        text.push_str(line);
        text.push('\n');
        text
    }

    /// `text` with no marker line, no `line`, and no empty line that
    /// [`with_lines`] put before them. Each other byte stays. `None`: the
    /// text has no such lines.
    fn without_lines(text: &str, line: &str) -> Option<String> {
        let mut kept: Vec<&str> = Vec::new();
        let mut removed = false;
        for part in text.split_inclusive('\n') {
            let content = part.trim_end_matches(['\n', '\r']);
            if content == MARKER {
                removed = true;
                if kept.last().is_some_and(|last| last.trim().is_empty()) {
                    kept.pop();
                }
            } else if content == line {
                removed = true;
            } else {
                kept.push(part);
            }
        }
        removed.then(|| kept.concat())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn environment(shell: &str) -> Environment {
            Environment {
                path: Some(OsString::from("/usr/bin:/bin")),
                shell: Some(OsString::from(shell)),
                ..Environment::default()
            }
        }

        #[test]
        fn add_appends_two_lines_to_the_startup_file_of_the_shell_one_time() {
            let home = tempfile::tempdir().expect("temp home");
            let zshrc = home.path().join(".zshrc");
            fs::write(&zshrc, "alias ll='ls -l'").expect("write");

            let added = add(home.path(), &environment("/bin/zsh")).expect("add");

            assert_eq!(added, Added::StartupFile(zshrc.clone()));
            let expected = format!("alias ll='ls -l'\n\n{MARKER}\n{SH_LINE}\n");
            assert_eq!(fs::read_to_string(&zshrc).expect("read"), expected);
            // A second install does not add the lines again.
            add(home.path(), &environment("/bin/zsh")).expect("add again");
            assert_eq!(fs::read_to_string(&zshrc).expect("read"), expected);
        }

        #[test]
        fn add_does_nothing_when_the_folder_is_on_the_path() {
            let home = tempfile::tempdir().expect("temp home");
            let environment = Environment {
                path: Some(
                    std::env::join_paths([PathBuf::from("/usr/bin"), layout::bin_dir(home.path())])
                        .expect("join"),
                ),
                shell: Some(OsString::from("/bin/zsh")),
                ..Environment::default()
            };

            assert_eq!(
                add(home.path(), &environment).expect("add"),
                Added::AlreadyOnPath
            );
            assert!(!home.path().join(".zshrc").exists());
        }

        #[test]
        fn each_shell_has_its_startup_file() {
            let home = Path::new("/h");
            let file_of = |environment: &Environment| startup_file(home, environment).0;
            assert_eq!(file_of(&environment("/bin/zsh")), home.join(".zshrc"));
            assert_eq!(
                file_of(&Environment {
                    zdotdir: Some(OsString::from("/h/.config/zsh")),
                    ..environment("/usr/local/bin/zsh")
                }),
                PathBuf::from("/h/.config/zsh/.zshrc")
            );
            assert_eq!(file_of(&environment("/bin/bash")), home.join(".bashrc"));
            assert_eq!(
                file_of(&Environment {
                    macos: true,
                    ..environment("/bin/bash")
                }),
                home.join(".bash_profile")
            );
            assert_eq!(
                startup_file(home, &environment("/usr/bin/fish")),
                (home.join(".config/fish/conf.d/archestra.fish"), FISH_LINE)
            );
            // Another shell, or none: the file that each POSIX shell reads.
            assert_eq!(file_of(&environment("/bin/dash")), home.join(".profile"));
            assert_eq!(file_of(&Environment::default()), home.join(".profile"));
        }

        #[test]
        fn remove_gives_the_startup_files_back_as_they_were() {
            let home = tempfile::tempdir().expect("temp home");
            let zshrc = home.path().join(".zshrc");
            let original = "export EDITOR=vim\n\n# my aliases\nalias ll='ls -l'\n";
            fs::write(&zshrc, original).expect("write");
            add(home.path(), &environment("/bin/zsh")).expect("add zsh");
            // The user changed the shell later, and has more lines after ours.
            add(home.path(), &environment("/bin/bash")).expect("add bash");
            let bashrc = home.path().join(".bashrc");
            let with_more = format!(
                "{}alias g=git\n",
                fs::read_to_string(&bashrc).expect("read")
            );
            fs::write(&bashrc, with_more).expect("write");
            add(home.path(), &environment("/usr/bin/fish")).expect("add fish");

            assert!(remove(home.path(), &Environment::default()).expect("remove"));

            assert_eq!(fs::read_to_string(&zshrc).expect("read"), original);
            assert_eq!(fs::read_to_string(&bashrc).expect("read"), "alias g=git\n");
            assert!(
                !home
                    .path()
                    .join(".config/fish/conf.d/archestra.fish")
                    .exists()
            );
            // Nothing is left to remove.
            assert!(!remove(home.path(), &Environment::default()).expect("remove again"));
            assert_eq!(fs::read_to_string(&zshrc).expect("read"), original);
        }

        #[test]
        fn remove_leaves_a_file_with_no_lines_of_ours_untouched() {
            assert_eq!(
                without_lines("export PATH=\"$HOME/bin:$PATH\"\n", SH_LINE),
                None
            );
            // A file with Windows line ends keeps them.
            let text = format!("a\r\n\r\n{MARKER}\r\n{SH_LINE}\r\nb\r\n");
            assert_eq!(without_lines(&text, SH_LINE).as_deref(), Some("a\r\nb\r\n"));
        }

        #[test]
        fn zsh_puts_the_program_on_its_path_from_the_lines() {
            if !Path::new("/bin/zsh").exists() {
                return;
            }
            // A real zsh that reads only the `.zshrc` of a temp folder.
            let home = tempfile::tempdir().expect("temp home");
            let environment = Environment {
                zdotdir: Some(home.path().as_os_str().to_owned()),
                ..environment("/bin/zsh")
            };
            add(home.path(), &environment).expect("add");

            let output = std::process::Command::new("/bin/zsh")
                .args(["-i", "-c", "print -r -- $PATH"])
                .env_clear()
                .env("HOME", home.path())
                .env("ZDOTDIR", home.path())
                .env("PATH", "/usr/bin:/bin")
                .output()
                .expect("zsh runs");
            let path = String::from_utf8_lossy(&output.stdout);
            let expected = format!("{}:/usr/bin:/bin", layout::bin_dir(home.path()).display());
            assert_eq!(path.trim(), expected, "{output:?}");
        }
    }
}

/// The text of the `Path` value: its folders, with `;` between them. Kept
/// apart from the registry calls, so that a test on each OS covers it.
#[cfg(any(windows, test))]
mod path_value {
    /// `value` with `folder` at its end. `None`: it has the folder already.
    pub(super) fn with_folder(value: &str, folder: &str) -> Option<String> {
        if value
            .split(';')
            .any(|existing| same_folder(existing, folder))
        {
            return None;
        }
        let value = value.trim_end_matches(';');
        Some(if value.is_empty() {
            folder.to_owned()
        } else {
            format!("{value};{folder}")
        })
    }

    /// `value` with no `folder`. Each other folder stays, in its order and
    /// as it is written. `None`: it does not have the folder.
    pub(super) fn without_folder(value: &str, folder: &str) -> Option<String> {
        let kept: Vec<&str> = value
            .split(';')
            .filter(|existing| !same_folder(existing, folder))
            .collect();
        (kept.len() != value.split(';').count()).then(|| kept.join(";"))
    }

    /// Windows paths: no difference between upper and lower case, and a `\`
    /// at the end means the same folder.
    fn same_folder(a: &str, b: &str) -> bool {
        let clean = |folder: &str| folder.trim().trim_end_matches('\\').to_lowercase();
        !a.trim().is_empty() && clean(a) == clean(b)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const FOLDER: &str = r"C:\Users\Anna Maria\.archestra\bin";

        #[test]
        fn with_folder_adds_it_one_time_at_the_end() {
            assert_eq!(with_folder("", FOLDER).as_deref(), Some(FOLDER));
            assert_eq!(
                with_folder(r"%USERPROFILE%\bin;C:\Tools;", FOLDER).as_deref(),
                Some(r"%USERPROFILE%\bin;C:\Tools;C:\Users\Anna Maria\.archestra\bin")
            );
            // It is there, written in another way.
            assert_eq!(
                with_folder(r"C:\Tools;c:\users\anna maria\.ARCHESTRA\bin\", FOLDER),
                None
            );
        }

        #[test]
        fn without_folder_removes_only_it() {
            assert_eq!(
                without_folder(
                    r"%USERPROFILE%\bin;C:\Users\Anna Maria\.archestra\bin;C:\Tools",
                    FOLDER
                )
                .as_deref(),
                Some(r"%USERPROFILE%\bin;C:\Tools")
            );
            assert_eq!(without_folder(FOLDER, FOLDER).as_deref(), Some(""));
            assert_eq!(without_folder(r"%USERPROFILE%\bin;C:\Tools", FOLDER), None);
            // A folder that only starts with the same text stays.
            assert_eq!(
                without_folder(r"C:\Users\Anna Maria\.archestra\bin2", FOLDER),
                None
            );
        }
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_EXPAND_SZ, REG_VALUE_TYPE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ, RegGetValueW, RegSetKeyValueW,
    };

    use super::{Added, Path, io, layout, path_value};
    use crate::bridge::win32::wide;

    const SUBKEY: &str = "Environment";
    const VALUE: &str = "Path";

    pub(super) fn add(home: &Path) -> io::Result<Added> {
        let folder = folder_text(home)?;
        let (value, kind) = read_user_path()?;
        match path_value::with_folder(&value, &folder) {
            None => Ok(Added::AlreadyOnPath),
            Some(value) => {
                write_user_path(&value, kind)?;
                Ok(Added::UserPath)
            }
        }
    }

    pub(super) fn remove(home: &Path) -> io::Result<bool> {
        let folder = folder_text(home)?;
        let (value, kind) = read_user_path()?;
        match path_value::without_folder(&value, &folder) {
            None => Ok(false),
            Some(value) => {
                write_user_path(&value, kind)?;
                Ok(true)
            }
        }
    }

    fn folder_text(home: &Path) -> io::Result<String> {
        layout::bin_dir(home)
            .into_os_string()
            .into_string()
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the folder of the program has characters that the Path value cannot hold",
                )
            })
    }

    /// The `Path` value of the user as it is written, with its `%NAME%`
    /// parts not replaced, and its type. No value: empty text, and the type
    /// that a new value gets.
    fn read_user_path() -> io::Result<(String, REG_VALUE_TYPE)> {
        let subkey = wide(SUBKEY);
        let name = wide(VALUE);
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        let mut kind: REG_VALUE_TYPE = 0;
        let mut size: u32 = 0;
        // SAFETY: the strings are NUL-terminated UTF-16 that live for the
        // call. With no buffer the call gives the size of the value in bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => {}
            ERROR_FILE_NOT_FOUND => return Ok((String::new(), REG_EXPAND_SZ)),
            _ => return Err(io::Error::from_raw_os_error(status as i32)),
        }
        // One more unit than the size: the call adds a NUL to text that has
        // none.
        let mut buffer = vec![0u16; size as usize / size_of::<u16>() + 1];
        let mut size = u32::try_from(buffer.len() * size_of::<u16>()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "the Path value is too long")
        })?;
        // SAFETY: as above; the buffer has `size` bytes. A value that grew
        // between the two calls gives an error, not a short read.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let length = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        let value = String::from_utf16(&buffer[..length]).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the Path value is not valid UTF-16",
            )
        })?;
        Ok((value, kind))
    }

    /// Writes the `Path` value with the type that it had, and tells the open
    /// programs that the environment changed: a terminal that starts after
    /// this gets the new `Path`.
    fn write_user_path(value: &str, kind: REG_VALUE_TYPE) -> io::Result<()> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
        };

        let subkey = wide(SUBKEY);
        let name = wide(VALUE);
        let data = wide(value);
        let size = u32::try_from(data.len() * size_of::<u16>())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the value is too long"))?;
        // SAFETY: the strings are NUL-terminated UTF-16 that live for the
        // call; the value is its UTF-16 text with the NUL, and `size` is its
        // length in bytes.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                kind,
                data.as_ptr().cast(),
                size,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let area = wide(SUBKEY);
        // SAFETY: the string is NUL-terminated UTF-16 that lives for the
        // call, and the call returns in 5 seconds at most. A program that
        // does not answer is not important: the value is written.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                area.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5_000,
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }
}
