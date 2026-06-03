//! input validation for the sandbox boundary. all checks run at the public core
//! entry points (`crate::run_sandbox` / `read_artifact`) over untrusted JS input;
//! replayed history is trusted on reuse (validated when first accepted).

use crate::{Result, SandboxError};

pub(crate) const SKILL_SANDBOX_ROOT: &str = "/skills";
pub(crate) const SKILL_SANDBOX_HOME: &str = "/home/sandbox";
pub(crate) const SKILL_SANDBOX_USER: &str = "1000:1000";

pub(crate) fn validate_snapshot_file_path(path: &str) -> Result<()> {
    if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!(
            "invalid snapshot file path: {path:?}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_artifact_path(path: &str) -> Result<()> {
    if path.contains('\0') || path.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!(
            "invalid artifact path: {path:?}"
        )));
    }
    if path
        .chars()
        .any(|ch| matches!(ch, '"' | '$' | '`' | '\\' | '\n' | '\r'))
    {
        return Err(SandboxError::InvalidInput(format!(
            "invalid artifact path: {path:?}"
        )));
    }
    if path.starts_with('/') && !within_sandbox_roots(path) {
        return Err(SandboxError::InvalidInput(format!(
            "artifact path must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {path:?}"
        )));
    }
    Ok(())
}

/// validate an upload target path. uploaded files become part of the replay
/// recipe and are written via a shell-quoted `bash -c`, so the path must be an
/// absolute file under the sandbox roots, free of traversal, null bytes, and
/// shell metacharacters (defense in depth on top of the single-quoting).
pub(crate) fn validate_upload_path(path: &str) -> Result<()> {
    if path.contains('\0') || path.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!(
            "invalid upload path: {path:?}"
        )));
    }
    if path
        .chars()
        .any(|ch| matches!(ch, '"' | '$' | '`' | '\\' | '\n' | '\r'))
    {
        return Err(SandboxError::InvalidInput(format!(
            "invalid upload path: {path:?}"
        )));
    }
    if !path.starts_with('/') {
        return Err(SandboxError::InvalidInput(format!(
            "upload path must be an absolute path: {path:?}"
        )));
    }
    if path.ends_with('/') {
        return Err(SandboxError::InvalidInput(format!(
            "upload path must be a file, not a directory: {path:?}"
        )));
    }
    if !within_sandbox_roots(path) {
        return Err(SandboxError::InvalidInput(format!(
            "upload path must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {path:?}"
        )));
    }
    Ok(())
}

/// uploads carry their bytes as either raw utf8 or base64; reject anything else
/// before it reaches the materialize shell snippet.
pub(crate) fn validate_file_encoding(encoding: &str) -> Result<()> {
    match encoding {
        "utf8" | "base64" => Ok(()),
        other => Err(SandboxError::InvalidInput(format!(
            "unsupported upload encoding: {other:?}"
        ))),
    }
}

pub(crate) fn validate_pythonpath(pythonpath: &str) -> Result<()> {
    // PYTHONPATH is passed straight to `with_env_variable`, but the model can
    // smuggle additional roots via `:` separators; bound each entry to the
    // sandbox-allowed roots so it can't escape into `/etc` etc.
    if pythonpath.is_empty() {
        return Err(SandboxError::InvalidInput(
            "pythonpath must not be empty".to_string(),
        ));
    }
    for entry in pythonpath.split(':') {
        if entry.is_empty()
            || entry.contains('\0')
            || entry.split('/').any(|segment| segment == "..")
        {
            return Err(SandboxError::InvalidInput(format!(
                "invalid pythonpath entry: {entry:?}"
            )));
        }
        if !entry.starts_with('/') {
            return Err(SandboxError::InvalidInput(format!(
                "pythonpath entries must be absolute: {entry:?}"
            )));
        }
        if !within_sandbox_roots(entry) {
            return Err(SandboxError::InvalidInput(format!(
                "pythonpath entries must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {entry:?}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_cwd(cwd: &str) -> Result<()> {
    if cwd.contains('\0') || cwd.split('/').any(|segment| segment == "..") {
        return Err(SandboxError::InvalidInput(format!("invalid cwd: {cwd:?}")));
    }
    if !cwd.starts_with('/') {
        return Err(SandboxError::InvalidInput(format!(
            "cwd must be an absolute path: {cwd:?}"
        )));
    }
    if !within_sandbox_roots(cwd) {
        return Err(SandboxError::InvalidInput(format!(
            "cwd must be under {SKILL_SANDBOX_ROOT} or {SKILL_SANDBOX_HOME}: {cwd:?}"
        )));
    }
    Ok(())
}

pub(crate) fn skill_root_path(skill_name: &str) -> Result<String> {
    if skill_name.contains('/') || skill_name.contains("..") {
        return Err(SandboxError::InvalidInput(format!(
            "invalid skill name: {skill_name:?}"
        )));
    }
    Ok(format!("{SKILL_SANDBOX_ROOT}/{skill_name}"))
}

pub(crate) fn format_artifact_error(prefix: &str, path: &str, stderr: &str) -> String {
    match stderr.trim() {
        "" => format!("{prefix} at {path}: unknown error"),
        detail => format!("{prefix} at {path}: {detail}"),
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// true when `path` is exactly one of the sandbox roots or nested beneath it.
/// the single source of truth for the artifact/cwd/pythonpath allowlist checks.
fn within_sandbox_roots(path: &str) -> bool {
    [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME]
        .iter()
        .any(|root| path == *root || path.strip_prefix(root).is_some_and(|r| r.starts_with('/')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_single_quotes_and_escapes_quotes() {
        assert_eq!(shell_quote("simple"), "'simple'");
        assert_eq!(shell_quote("a 'b' c"), "'a '\\''b'\\'' c'");
    }

    #[test]
    fn snapshot_path_validation_rejects_traversal_and_absolute_paths() {
        assert!(validate_snapshot_file_path("scripts/run.sh").is_ok());
        assert!(validate_snapshot_file_path("/etc/passwd").is_err());
        assert!(validate_snapshot_file_path("../etc/passwd").is_err());
        assert!(validate_snapshot_file_path("a/../../etc/passwd").is_err());
    }

    #[test]
    fn validate_artifact_path_rejects_shell_metacharacters() {
        assert!(validate_artifact_path("/skills/alpha/result.txt").is_ok());
        assert!(validate_artifact_path("/skills/alpha/foo\"bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo$bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo`bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo\\bar").is_err());
        assert!(validate_artifact_path("/skills/alpha/foo\nbar").is_err());
    }

    #[test]
    fn validate_pythonpath_enforces_sandbox_roots() {
        assert!(validate_pythonpath("/skills/alpha").is_ok());
        assert!(validate_pythonpath("/skills/alpha:/home/sandbox/lib").is_ok());
        assert!(validate_pythonpath("/home/sandbox").is_ok());
        assert!(validate_pythonpath("").is_err());
        assert!(validate_pythonpath("/etc").is_err());
        assert!(validate_pythonpath("relative/path").is_err());
        assert!(validate_pythonpath("/skills/../etc").is_err());
        assert!(validate_pythonpath("/skills/alpha:").is_err());
        assert!(validate_pythonpath("/skills/alpha:/etc").is_err());
    }

    #[test]
    fn validate_upload_path_requires_absolute_file_under_roots() {
        assert!(validate_upload_path("/home/sandbox/input.csv").is_ok());
        assert!(validate_upload_path("/skills/alpha/data/in.bin").is_ok());
        // not absolute
        assert!(validate_upload_path("input.csv").is_err());
        // outside roots
        assert!(validate_upload_path("/etc/passwd").is_err());
        // traversal
        assert!(validate_upload_path("/home/sandbox/../etc/passwd").is_err());
        // directory, not a file
        assert!(validate_upload_path("/home/sandbox/").is_err());
        // shell metacharacters / null
        assert!(validate_upload_path("/home/sandbox/a$b").is_err());
        assert!(validate_upload_path("/home/sandbox/a`b").is_err());
        assert!(validate_upload_path("/home/sandbox/a\0b").is_err());
    }

    #[test]
    fn validate_file_encoding_accepts_known_encodings_only() {
        assert!(validate_file_encoding("utf8").is_ok());
        assert!(validate_file_encoding("base64").is_ok());
        assert!(validate_file_encoding("hex").is_err());
        assert!(validate_file_encoding("").is_err());
    }

    #[test]
    fn validate_cwd_enforces_sandbox_roots() {
        assert!(validate_cwd("/skills/alpha").is_ok());
        assert!(validate_cwd("/home/sandbox").is_ok());
        assert!(validate_cwd("/home/sandbox/work").is_ok());
        assert!(validate_cwd("/etc").is_err());
        assert!(validate_cwd("/proc/self").is_err());
        assert!(validate_cwd("relative/path").is_err());
        assert!(validate_cwd("/skills/../etc").is_err());
    }
}
