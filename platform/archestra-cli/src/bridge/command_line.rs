//! The command of a catalog item, as the tunnel client runs it: split into
//! arguments, and on Windows the program found on `PATH`.
//!
//! An admin writes one command for every system. `matlab-mcp-server`,
//! `npx -y some-mcp-server` and `uvx some-mcp-server` work everywhere.
//!
//! - The split is shell-like: spaces separate arguments, and single or double
//!   quotes keep spaces in one argument. On Windows a backslash is a part of
//!   the path, not an escape, so `C:\Users\$USER\bin\mcp.exe` stays whole.
//! - Windows finds a program with no extension through `PATHEXT`, so `npx`
//!   is `npx.cmd` and `uvx` is `uvx.exe`.

/// Splits a command into arguments. `None`: a quote is not closed.
pub(crate) fn split(command: &str) -> Option<Vec<String>> {
    if cfg!(windows) {
        split_keeping_backslashes(command)
    } else {
        shlex::split(command)
    }
}

/// The split on Windows: as `shlex`, but a backslash is a normal character.
/// Inside double quotes `\"` is a quote, so a quote can still be written.
fn split_keeping_backslashes(command: &str) -> Option<Vec<String>> {
    let mut arguments = Vec::new();
    let mut current: Option<String> = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                arguments.extend(current.take());
            }
            '\'' => {
                let argument = current.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => argument.push(c),
                    }
                }
            }
            '"' => {
                let argument = current.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' if chars.peek() == Some(&'"') => {
                            chars.next();
                            argument.push('"');
                        }
                        c => argument.push(c),
                    }
                }
            }
            c => current.get_or_insert_with(String::new).push(c),
        }
    }
    arguments.extend(current);
    Some(arguments)
}

/// The program to start for the first argument of a command. On Windows a
/// bare name (no folder, no extension) is looked up in `PATH` with each
/// extension of `PATHEXT`; a name that is not found stays as it is, and the
/// start then fails with "not found". Elsewhere the OS looks up the name.
pub(crate) fn program(name: &str) -> std::path::PathBuf {
    if !cfg!(windows) {
        return std::path::PathBuf::from(name);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.to_owned());
    find_on_path(name, &path, &extensions, |candidate| candidate.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from(name))
}

/// `PATHEXT` when the variable is not set: the value of a new Windows.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Looks for `name` with each extension in each folder of `path`, in order:
/// the first folder that has one wins, as in `cmd.exe`. A name with a folder
/// or with an extension is not looked up.
fn find_on_path(
    name: &str,
    path: &std::ffi::OsStr,
    extensions: &str,
    is_file: impl Fn(&std::path::Path) -> bool,
) -> Option<std::path::PathBuf> {
    let has_folder = name.contains(['/', '\\', ':']);
    let has_extension = std::path::Path::new(name).extension().is_some();
    if name.is_empty() || has_folder || has_extension {
        return None;
    }
    let extensions: Vec<&str> = extensions
        .split(';')
        .map(str::trim)
        .filter(|extension| extension.starts_with('.') && extension.len() > 1)
        .collect();
    std::env::split_paths(path)
        .filter(|folder| !folder.as_os_str().is_empty())
        .find_map(|folder| {
            extensions
                .iter()
                .map(|extension| folder.join(format!("{name}{}", extension.to_ascii_lowercase())))
                .find(|candidate| is_file(candidate))
        })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    use super::*;

    fn strings(arguments: &[&str]) -> Option<Vec<String>> {
        Some(
            arguments
                .iter()
                .map(|argument| (*argument).to_owned())
                .collect(),
        )
    }

    #[test]
    fn windows_split_keeps_backslashes() {
        assert_eq!(
            split_keeping_backslashes(r"C:\Users\$USER\bin\mcp.exe --root C:\data"),
            strings(&[r"C:\Users\$USER\bin\mcp.exe", "--root", r"C:\data"])
        );
        assert_eq!(
            split_keeping_backslashes(r#""C:\Program Files\MATLAB\mcp.exe" serve"#),
            strings(&[r"C:\Program Files\MATLAB\mcp.exe", "serve"])
        );
        assert_eq!(
            split_keeping_backslashes(r"'%USERPROFILE%\my bins\mcp.exe'  -v"),
            strings(&[r"%USERPROFILE%\my bins\mcp.exe", "-v"])
        );
        // A path that ends with a backslash, and a quote inside double quotes.
        assert_eq!(
            split_keeping_backslashes(r#"mcp --dir C:\data\ --name "a \"b\"""#),
            strings(&["mcp", "--dir", r"C:\data\", "--name", r#"a "b""#])
        );
    }

    #[test]
    fn windows_split_is_shell_like_for_the_rest() {
        for command in [
            "npx -y @scope/some-mcp-server@1.2.3",
            "uvx some-mcp-server --flag 'two words'",
            "  spaces   around  ",
            "a'b c'd",
            "",
        ] {
            assert_eq!(
                split_keeping_backslashes(command),
                shlex::split(command),
                "{command:?}"
            );
        }
        assert_eq!(split_keeping_backslashes("mcp 'open"), None);
        assert_eq!(split_keeping_backslashes(r#"mcp "open"#), None);
    }

    /// A `PATH` of two folders and a file check that knows a fixed set of
    /// files, so that the test needs no real files.
    fn find(name: &str, existing: &[&str]) -> Option<PathBuf> {
        let first = Path::new("first");
        let second = Path::new("second");
        let path: OsString = std::env::join_paths([first, Path::new(""), second]).expect("join");
        let existing: Vec<PathBuf> = existing.iter().map(PathBuf::from).collect();
        find_on_path(name, &path, ".COM;.EXE;.BAT;.CMD", |candidate| {
            existing.iter().any(|file| file == candidate)
        })
    }

    #[test]
    fn finds_a_cmd_and_an_exe_through_pathext() {
        let npx = Path::new("second").join("npx.cmd");
        assert_eq!(
            find("npx", &[npx.to_str().expect("utf-8")]),
            Some(npx.clone())
        );
        let uvx = Path::new("first").join("uvx.exe");
        assert_eq!(find("uvx", &[uvx.to_str().expect("utf-8")]), Some(uvx));
        // The first folder wins; in one folder, the first extension wins.
        let first_cmd = Path::new("first").join("tool.cmd");
        let first_exe = Path::new("first").join("tool.exe");
        let second_exe = Path::new("second").join("tool.exe");
        assert_eq!(
            find(
                "tool",
                &[
                    second_exe.to_str().expect("utf-8"),
                    first_cmd.to_str().expect("utf-8"),
                    first_exe.to_str().expect("utf-8"),
                ]
            ),
            Some(first_exe)
        );
    }

    #[test]
    fn does_not_look_up_a_path_an_extension_or_a_missing_program() {
        let npx = Path::new("second").join("npx.cmd");
        let existing = [npx.to_str().expect("utf-8")];
        assert_eq!(find("npx.cmd", &existing), None);
        assert_eq!(find(r"C:\tools\npx", &existing), None);
        assert_eq!(find("./npx", &existing), None);
        assert_eq!(find("matlab-mcp-server", &existing), None);
        assert_eq!(find("", &existing), None);
    }
}
