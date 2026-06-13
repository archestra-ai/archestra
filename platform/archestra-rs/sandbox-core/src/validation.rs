//! input validation for the sandbox boundary. all checks run at the public core
//! entry points (`crate::run_sandbox` / `read_artifact`) over untrusted JS input;
//! replayed history is trusted on reuse (validated when first accepted).
//!
//! the TS adapter (`backend/src/skills-sandbox/skill-sandbox-runtime-service.ts`)
//! runs twin checks before persistence for early, friendlier errors; this module
//! is the trust boundary and stays authoritative regardless of what the TS layer
//! accepts. the mirrored test vectors below and in the TS test twin keep the two
//! implementations from drifting silently.

use crate::{Result, SandboxError};

pub(crate) const SKILL_SANDBOX_ROOT: &str = "/skills";
pub(crate) const SKILL_SANDBOX_HOME: &str = "/home/sandbox";
pub(crate) const SKILL_SANDBOX_USER: &str = "1000:1000";

/// validate a skill-relative snapshot file path. rejects absolute paths and
/// traversal only — intentionally narrower than [`validate_upload_path`] /
/// [`validate_artifact_path`], and that asymmetry is load-bearing. snapshot
/// paths are persisted, authored skill content that the upstream skill
/// validators gate solely on traversal/absolute, so rejecting anything more here
/// would strand an already-persisted mount as permanently unreplayable. there is
/// no injection surface to harden: the utf8 branch writes via the Dagger API (no
/// shell) and the base64 branch shell-quotes the path.
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
        // contract: this boundary is intentionally narrower than the
        // upload/artifact validators. shell metacharacters and control chars are
        // accepted here because snapshot paths are persisted skill content gated
        // upstream — rejecting more would strand a persisted mount — and the
        // downstream writers (Dagger API / shell-quoting) neutralise them.
        assert!(validate_snapshot_file_path("weights/$MODEL.bin").is_ok());
        assert!(validate_snapshot_file_path("a\tb").is_ok());
    }

    // mirrored with "path validation vectors (mirrored with sandbox-core)" in
    // backend/src/skills-sandbox/skill-sandbox-runtime-service.test.ts — keep
    // the two tables in sync when adding cases. the third column documents the
    // TS layer's verdict on the same string so divergences are explicit:
    // the TS layer resolves relative paths against the sandbox cwd before this
    // layer sees them, and rejects uploads onto a root directory itself, while
    // this layer alone rejects shell metacharacters in artifact paths.
    //
    // (path, accepted_here, accepted_by_ts)
    const UPLOAD_PATH_VECTORS: &[(&str, bool, bool)] = &[
        ("/home/sandbox/input.csv", true, true),
        ("/skills/alpha/data/in.bin", true, true),
        // relative: TS resolves against defaultCwd before this layer runs
        ("input.csv", false, true),
        // outside roots
        ("/etc/passwd", false, false),
        // traversal
        ("/home/sandbox/../etc/passwd", false, false),
        // directory, not a file
        ("/home/sandbox/", false, false),
        // a root itself: replay would fail on the existing directory, so the
        // TS layer rejects it before it is persisted as an unreplayable event
        ("/home/sandbox", true, false),
        // shell metacharacters / control chars / null
        ("/home/sandbox/a\"b", false, false),
        ("/home/sandbox/a$b", false, false),
        ("/home/sandbox/a`b", false, false),
        ("/home/sandbox/a\\b", false, false),
        ("/home/sandbox/a\nb", false, false),
        ("/home/sandbox/a\rb", false, false),
        ("/home/sandbox/a\0b", false, false),
    ];

    // (path, accepted_here, accepted_by_ts)
    const ARTIFACT_PATH_VECTORS: &[(&str, bool, bool)] = &[
        ("/skills/alpha/result.txt", true, true),
        // relative artifact paths are resolved against cwd downstream
        ("out/report.txt", true, true),
        // outside roots
        ("/etc/passwd", false, false),
        // traversal
        ("a/../b.txt", false, false),
        // null byte
        ("a\0b.txt", false, false),
        // shell metacharacters: only this boundary rejects them; the TS layer
        // passes them through and relies on the rejection here
        ("/skills/alpha/foo\"bar", false, true),
        ("/skills/alpha/foo$bar", false, true),
        ("/skills/alpha/foo`bar", false, true),
        ("/skills/alpha/foo\\bar", false, true),
        ("/skills/alpha/foo\nbar", false, true),
        ("/skills/alpha/foo\rbar", false, true),
    ];

    #[test]
    fn validate_upload_path_matches_mirrored_vectors() {
        for (path, accepted, _ts) in UPLOAD_PATH_VECTORS {
            assert_eq!(
                validate_upload_path(path).is_ok(),
                *accepted,
                "upload path: {path:?}"
            );
        }
    }

    #[test]
    fn validate_artifact_path_matches_mirrored_vectors() {
        for (path, accepted, _ts) in ARTIFACT_PATH_VECTORS {
            assert_eq!(
                validate_artifact_path(path).is_ok(),
                *accepted,
                "artifact path: {path:?}"
            );
        }
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
