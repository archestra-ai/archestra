//! What this program is, for Archestra: the system and CPU it is built for,
//! and the SHA-256 of its file.
//!
//! The MCP bridge sends both with each request. Archestra answers a sync
//! with the program that it serves for that target, and the two checksums
//! say if they are the same program: see [`crate::bridge::update`].

use std::io;
use std::path::Path;
use std::sync::OnceLock;

/// The target of this build, as the download of Archestra names it:
/// `<system>-<cpu>`, for example `darwin-arm64`.
pub fn target() -> String {
    target_of(std::env::consts::OS, std::env::consts::ARCH)
}

/// Rust says `macos` and `aarch64`; the download says `darwin` and `arm64`.
fn target_of(os: &str, arch: &str) -> String {
    let system = match os {
        "macos" => "darwin",
        other => other,
    };
    let cpu = match arch {
        "aarch64" => "arm64",
        other => other,
    };
    format!("{system}-{cpu}")
}

/// The SHA-256 of the file of the program that runs, in lower-case hex. It
/// is read one time. `None`: the file cannot be read.
pub fn own_sha256() -> Option<&'static str> {
    static OWN: OnceLock<Option<String>> = OnceLock::new();
    OWN.get_or_init(|| {
        std::env::current_exe()
            .and_then(|program| file_sha256(&program))
            .ok()
    })
    .as_deref()
}

/// The SHA-256 of a file, in lower-case hex.
pub fn file_sha256(path: &Path) -> io::Result<String> {
    Ok(sha256_hex(&std::fs::read(path)?))
}

/// The SHA-256 of `bytes`, in lower-case hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest.as_ref() {
        // Writing to a String does not fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_have_the_names_of_the_download() {
        assert_eq!(target_of("macos", "aarch64"), "darwin-arm64");
        assert_eq!(target_of("macos", "x86_64"), "darwin-x86_64");
        assert_eq!(target_of("linux", "aarch64"), "linux-arm64");
        assert_eq!(target_of("windows", "x86_64"), "windows-x86_64");
        // The target of this build is one of the six.
        let (system, cpu) = target()
            .split_once('-')
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
            .expect("two parts");
        assert!(
            ["darwin", "linux", "windows"].contains(&system.as_str()),
            "{system}"
        );
        assert!(["arm64", "x86_64"].contains(&cpu.as_str()), "{cpu}");
    }

    #[test]
    fn sha256_is_lower_case_hex() {
        // The SHA-256 of the empty input and of "abc" (FIPS 180-2).
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let own = own_sha256().expect("the test program can read its file");
        assert_eq!(own.len(), 64);
    }
}
