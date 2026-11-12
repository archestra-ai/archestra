//! Two file operations of the MCP bridge: put a file in place in one step,
//! and put a log file that grew large aside.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A log file that is larger than this is put aside when the MCP bridge
/// starts in the background.
pub(crate) const MAX_LOG_FILE_LEN: u64 = 5 * 1024 * 1024;

/// Puts a file in place in one step. `write` makes the file under a
/// temporary name in the same folder (the folder is made when it is
/// missing), then a rename gives it the name `path`. So a reader never sees
/// half of the file, and the file of a running program is not written.
///
/// The temporary name has the id of this process, so two processes do not
/// write the same one. It is removed when a step fails.
pub(crate) fn replace_file(
    path: &Path,
    write: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let temporary = with_suffix(path, &format!(".{}.tmp", std::process::id()));
    let replaced = write(&temporary).and_then(|()| fs::rename(&temporary, path));
    if replaced.is_err() {
        // Best effort: the error of the step is the one to report.
        let _ = fs::remove_file(&temporary);
    }
    replaced
}

/// Puts a log file that is larger than `max_len` aside: it gets the name
/// `<name>.1`, in place of an older file of that name, and the next writer
/// starts a new file. So the two files together stay near two times
/// `max_len`. `true`: the file was put aside. No file is not an error.
///
/// A process that has the file open writes on to the file that was put
/// aside, so call this before the writer opens the file.
pub(crate) fn rotate_log_file(path: &Path, max_len: u64) -> io::Result<bool> {
    let len = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if len <= max_len {
        return Ok(false);
    }
    fs::rename(path, with_suffix(path, ".1"))?;
    Ok(true)
}

/// `path` with `suffix` after its file name.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .into_string()
                    .expect("a name")
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replace_file_makes_the_folder_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("nested").join("file.txt");

        replace_file(&path, |temporary| fs::write(temporary, "first")).expect("write");
        replace_file(&path, |temporary| fs::write(temporary, "second")).expect("replace");

        assert_eq!(fs::read_to_string(&path).expect("read"), "second");
        assert_eq!(names(path.parent().expect("parent")), ["file.txt"]);
    }

    #[test]
    fn replace_file_keeps_the_file_when_the_write_fails() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("file.txt");
        fs::write(&path, "kept").expect("write");

        let failed = replace_file(&path, |temporary| {
            fs::write(temporary, "half")?;
            Err(io::Error::other("the disk is full"))
        });

        assert_eq!(failed.expect_err("fails").to_string(), "the disk is full");
        assert_eq!(fs::read_to_string(&path).expect("read"), "kept");
        assert_eq!(names(dir.path()), ["file.txt"]);
    }

    #[test]
    fn a_log_file_over_the_limit_is_put_aside_in_place_of_the_older_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let log = dir.path().join("mcp-bridge.log");
        let aside = dir.path().join("mcp-bridge.log.1");

        // No file, and a file at the limit: nothing to do.
        assert!(!rotate_log_file(&log, 10).expect("no file"));
        fs::write(&log, "0123456789").expect("write");
        assert!(!rotate_log_file(&log, 10).expect("at the limit"));
        assert_eq!(names(dir.path()), ["mcp-bridge.log"]);

        fs::write(&aside, "an older log").expect("write");
        fs::write(&log, "0123456789a").expect("write");
        assert!(rotate_log_file(&log, 10).expect("over the limit"));
        assert_eq!(names(dir.path()), ["mcp-bridge.log.1"]);
        assert_eq!(fs::read_to_string(&aside).expect("read"), "0123456789a");
    }
}
