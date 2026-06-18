//! Per-env pin of each remote MCP's tool surface. Remote MCP servers (DeepWiki, Microsoft Learn,
//! Context7, …) can add, remove, or rename tools at any time, which silently changes the agent's
//! action space, so reruns of the same config aren't comparable. A task like `letter-count` still
//! grades correctly (its verifier recomputes from the live surface), but its correct answer then
//! shifts between runs — exactly the drift this pin makes loud. A committed `envs/<id>.mcp.lock`
//! snapshots the surface; a run aborts the env's setup on drift, and `--update-mcp-lock` regenerates
//! the lock. Pinning is opt-in: an env with no lock runs unchanged.
//!
//! The lock stores the agent-facing tool short-names (`seeding::tool_name`), not response bodies —
//! live MCP responses stay live by design.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tracing::info;
use uuid::Uuid;

use crate::config::types::Mcp;
use crate::seeding::{RegisteredMcp, tool_name};

/// MCP name -> its sorted, de-duplicated tool short-names. `BTreeMap`/sorted vecs make the on-disk
/// lock and any comparison order-independent.
type Surface = BTreeMap<String, Vec<String>>;

fn lock_path(envs_dir: &Path, env_id: &str) -> PathBuf {
    envs_dir.join(format!("{env_id}.mcp.lock"))
}

/// Pair each `[[mcps]]` row with the tools the backend reported for it (seeding registers them in
/// declaration order) into a normalized surface.
fn observed_surface(mcps: &[Mcp], registered: &[RegisteredMcp]) -> Surface {
    mcps.iter()
        .zip(registered)
        .map(|(mcp, reg)| {
            let mut names: Vec<String> = reg
                .tools
                .iter()
                .filter_map(|t| tool_name(t).map(str::to_string))
                .collect();
            names.sort();
            names.dedup();
            (mcp.name.clone(), names)
        })
        .collect()
}

/// Human-readable per-MCP diff lines, empty when the surfaces match.
fn drift_lines(expected: &Surface, observed: &Surface) -> Vec<String> {
    let mut lines = Vec::new();
    let names: BTreeMap<&String, ()> = expected
        .keys()
        .chain(observed.keys())
        .map(|n| (n, ()))
        .collect();
    for name in names.into_keys() {
        match (expected.get(name), observed.get(name)) {
            (Some(_), None) => lines.push(format!("- {name}: MCP missing from this run")),
            (None, Some(_)) => lines.push(format!("- {name}: MCP not in lock")),
            (Some(want), Some(got)) if want != got => {
                let added: Vec<&String> = got.iter().filter(|t| !want.contains(t)).collect();
                let removed: Vec<&String> = want.iter().filter(|t| !got.contains(t)).collect();
                lines.push(format!("- {name}: added {added:?}, removed {removed:?}"));
            }
            _ => {}
        }
    }
    lines
}

/// Check the observed MCP surface against the env's committed lock, or (with `update`) rewrite the
/// lock from what was observed. Returns `Err` only on real drift or an I/O/parse failure; a missing
/// lock is a no-op so pinning stays opt-in.
pub fn enforce(
    envs_dir: &Path,
    env_id: &str,
    mcps: &[Mcp],
    registered: &[RegisteredMcp],
    update: bool,
) -> Result<(), String> {
    // Defensive: every declared MCP must have produced exactly one registration. A mismatch would
    // make `zip` below silently drop entries — loud here so a truncated surface is never pinned.
    if mcps.len() != registered.len() {
        return Err(format!(
            "env {env_id}: {} MCP registrations for {} declared servers",
            registered.len(),
            mcps.len()
        ));
    }
    let observed = observed_surface(mcps, registered);
    let path = lock_path(envs_dir, env_id);

    if update {
        let json = serde_json::to_string_pretty(&observed).map_err(|e| e.to_string())? + "\n";
        // Write atomically (temp + rename): with an isolated env, concurrent lanes regenerate the
        // same lock path, and a non-atomic write could interleave into a corrupt file. A unique
        // temp name avoids two writers colliding; rename within the dir is atomic, so the final
        // lock is always a complete, valid snapshot.
        let tmp = path.with_file_name(format!(
            "{}.{}.tmp",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("mcp.lock"),
            Uuid::new_v4().simple()
        ));
        std::fs::write(&tmp, json).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("renaming {}: {e}", tmp.display()))?;
        info!("wrote MCP tool-surface lock {}", path.display());
        return Ok(());
    }

    let bytes = match std::fs::read_to_string(&path) {
        Ok(bytes) => bytes,
        // Only a genuinely-absent lock is the opt-in no-op; any other read failure (e.g. an
        // unreadable lock) is loud rather than a silent skip of the drift check.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            info!(
                "no MCP lock at {}; skipping drift check (create it with --update-mcp-lock)",
                path.display()
            );
            return Ok(());
        }
        Err(e) => return Err(format!("reading {}: {e}", path.display())),
    };
    let expected: Surface =
        serde_json::from_str(&bytes).map_err(|e| format!("parsing {}: {e}", path.display()))?;

    let drift = drift_lines(&expected, &observed);
    if drift.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "MCP tool-surface drift for env {env_id} (regenerate with --update-mcp-lock):\n{}",
            drift.join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn mcp(name: &str) -> Mcp {
        Mcp {
            name: name.to_string(),
            server_url: format!("https://example.test/{name}"),
        }
    }

    fn registered(tools: &[&str]) -> RegisteredMcp {
        RegisteredMcp {
            tools: tools
                .iter()
                .map(|t| HashMap::from([("name".to_string(), serde_json::json!(t))]))
                .collect(),
        }
    }

    #[test]
    fn observed_surface_sorts_and_dedups() {
        let surface = observed_surface(
            &[mcp("deepwiki")],
            &[registered(&["b_tool", "a_tool", "a_tool"])],
        );
        assert_eq!(surface["deepwiki"], vec!["a_tool", "b_tool"]);
    }

    #[test]
    fn no_drift_when_surfaces_match() {
        let a = observed_surface(&[mcp("m")], &[registered(&["t1", "t2"])]);
        let b = observed_surface(&[mcp("m")], &[registered(&["t2", "t1"])]);
        assert!(drift_lines(&a, &b).is_empty());
    }

    #[test]
    fn drift_reports_added_and_removed() {
        let expected = observed_surface(&[mcp("m")], &[registered(&["t1", "t2"])]);
        let observed = observed_surface(&[mcp("m")], &[registered(&["t1", "t3"])]);
        let lines = drift_lines(&expected, &observed);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("added [\"t3\"]"), "{lines:?}");
        assert!(lines[0].contains("removed [\"t2\"]"), "{lines:?}");
    }

    #[test]
    fn drift_reports_missing_and_extra_mcps() {
        let expected = observed_surface(&[mcp("m1")], &[registered(&["t"])]);
        let observed = observed_surface(&[mcp("m2")], &[registered(&["t"])]);
        let lines = drift_lines(&expected, &observed);
        assert!(
            lines.iter().any(|l| l.contains("m1: MCP missing")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("m2: MCP not in lock")),
            "{lines:?}"
        );
    }

    #[test]
    fn missing_lock_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        let out = enforce(
            dir.path(),
            "basic",
            &[mcp("m")],
            &[registered(&["t"])],
            false,
        );
        assert!(out.is_ok(), "{out:?}");
    }

    #[test]
    fn update_then_check_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mcps = [mcp("m")];
        let reg = [registered(&["t1", "t2"])];
        enforce(dir.path(), "basic", &mcps, &reg, true).unwrap();
        // A matching surface passes...
        enforce(dir.path(), "basic", &mcps, &reg, false).unwrap();
        // ...and a changed one is rejected.
        let err = enforce(dir.path(), "basic", &mcps, &[registered(&["t1"])], false).unwrap_err();
        assert!(err.contains("drift"), "{err}");
        assert!(err.contains("removed [\"t2\"]"), "{err}");
    }

    #[test]
    fn registration_count_mismatch_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = enforce(
            dir.path(),
            "basic",
            &[mcp("a"), mcp("b")],
            &[registered(&["t"])],
            true,
        )
        .unwrap_err();
        assert!(err.contains("1 MCP registrations for 2"), "{err}");
    }

    #[test]
    fn malformed_lock_is_an_error_not_a_silent_pass() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("basic.mcp.lock"), "{ not json").unwrap();
        let err = enforce(
            dir.path(),
            "basic",
            &[mcp("m")],
            &[registered(&["t"])],
            false,
        )
        .unwrap_err();
        assert!(err.contains("parsing"), "{err}");
    }
}
