use std::path::{Path, PathBuf};
use std::process::Command;

use archestra_bench::config::{load_envs, load_lanes};

fn bench_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is ai-labs/runner; the benchmark root is its parent.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn copy_bench_to_temp(tmp: &Path) -> PathBuf {
    std::fs::create_dir_all(tmp).expect("create temp dir");
    let dst = tmp.join("ai-labs");
    let status = Command::new("cp")
        .args(["-R", bench_dir().to_str().unwrap(), dst.to_str().unwrap()])
        .status()
        .expect("cp should be available");
    assert!(status.success(), "copying benchmark fixtures failed");
    dst
}

fn generate_fixtures(dst: &Path) {
    for entry in walkdir::WalkDir::new(dst) {
        let entry = entry.unwrap();
        if entry.file_name() == "generate.py" {
            let dir = entry.path().parent().unwrap();
            let status = Command::new("uv")
                .args(["run", "generate.py"])
                .current_dir(dir)
                .status()
                .expect("uv should be available to generate fixtures");
            assert!(status.success(), "fixture generation failed in {dir:?}");
        }
    }
}

/// Text fixtures are byte-reproducible from their generator; binary ones (xlsx/zip/sqlite) embed
/// nondeterministic container metadata, so they cannot be byte-compared.
fn is_text_fixture(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("csv" | "json" | "jsonl" | "txt")
    )
}

fn dir_has_generator(dir: &Path) -> bool {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .any(|e| e.file_name() == "generate.py")
}

/// Binary fixtures a generator writes: under a generator task's `inputs/`/`expected/`, plus skill
/// `assets/` (e.g. `sales-ledger/assets/ledger.xlsx`, written by xlsx-live's generator -- the binary
/// the agent actually reads). They cannot be byte-compared (container metadata varies), so the guard
/// deletes them before regeneration and asserts the generator put them back -- a smoke check that
/// actually exercises the generator, unlike an existence test on the copied-in file. Assumes such
/// binaries are always generator output; add a carve-out here if a hand-authored binary is committed
/// under one of these paths.
fn generated_binaries(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for task in std::fs::read_dir(root.join("tasks")).expect("read tasks dir") {
        let task = task.expect("task entry").path();
        if !task.is_dir() || !dir_has_generator(&task) {
            continue;
        }
        collect_binaries(&task, &["inputs", "expected"], &mut out);
    }
    let skills = root.join("skills");
    if skills.is_dir() {
        collect_binaries(&skills, &["assets"], &mut out);
    }
    out
}

fn collect_binaries(base: &Path, fixture_dirs: &[&str], out: &mut Vec<PathBuf>) {
    for entry in walkdir::WalkDir::new(base).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        // A generated binary is a data artefact, never a script (a generator may itself live under
        // expected/, e.g. median-salary/expected/generate.py).
        let is_script = path.extension().and_then(|e| e.to_str()) == Some("py");
        let in_fixture_dir = path
            .components()
            .any(|c| fixture_dirs.iter().any(|d| c.as_os_str() == *d));
        if path.is_file() && in_fixture_dir && !is_script && !is_text_fixture(path) {
            out.push(path.to_path_buf());
        }
    }
}

/// Drift guard: assert every committed *text* fixture under a task with a generator is byte-identical
/// to its freshly regenerated version, so a fixture that drifted from its generator (generator edited,
/// fixture not re-run) fails CI. `regenerated_binaries` were deleted before regeneration, so asserting
/// they exist now proves the generator actually wrote them.
fn assert_no_fixture_drift(generated: &Path, regenerated_binaries: &[PathBuf]) {
    let committed_root = bench_dir();
    let mut text_checked = 0usize;
    for task in std::fs::read_dir(generated.join("tasks")).expect("read tasks dir") {
        let task = task.expect("task entry").path();
        if !task.is_dir() || !dir_has_generator(&task) {
            continue;
        }
        for entry in walkdir::WalkDir::new(&task).into_iter().filter_map(Result::ok) {
            let path = entry.path();
            let in_fixture_dir = path
                .components()
                .any(|c| matches!(c.as_os_str().to_str(), Some("inputs" | "expected")));
            if !path.is_file() || !in_fixture_dir || !is_text_fixture(path) {
                continue;
            }
            let rel = path.strip_prefix(generated).expect("path under generated root");
            let regenerated = std::fs::read(path).expect("read regenerated fixture");
            let committed_bytes = std::fs::read(committed_root.join(rel))
                .unwrap_or_else(|e| panic!("committed fixture {rel:?} missing: {e}"));
            assert!(
                regenerated == committed_bytes,
                "committed fixture {rel:?} is stale -- rerun its generate.py and commit the result"
            );
            text_checked += 1;
        }
    }
    assert!(
        text_checked > 0,
        "fixture drift guard checked no text fixtures -- generator discovery is broken"
    );
    for path in regenerated_binaries {
        let rel = path.strip_prefix(generated).expect("path under generated root");
        assert!(
            path.is_file(),
            "binary fixture {rel:?} was not regenerated -- its generate.py did not write it"
        );
    }
}

#[test]
fn test_load_real_envs() {
    let tmp = std::env::temp_dir().join(format!("archestra_bench_integ_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let dst = copy_bench_to_temp(&tmp);
    // Delete generated binaries from the copy first, so regenerating them proves the generator ran.
    let binaries = generated_binaries(&dst);
    for path in &binaries {
        std::fs::remove_file(path).expect("clear generated binary before regeneration");
    }
    generate_fixtures(&dst);
    assert_no_fixture_drift(&dst, &binaries);

    let envs = load_envs(&dst.join("envs")).expect("should load envs");
    assert!(envs.contains_key("basic"));
    assert!(envs.contains_key("archestra-api"));
    assert!(envs.contains_key("apps"));
    for env in envs.values() {
        assert!(!env.id.is_empty());
        assert!(!env.tasks.is_empty());
    }

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn test_load_real_lanes() {
    let lanes = load_lanes(&bench_dir().join("lanes.toml"), None).expect("should load lanes");
    assert!(!lanes.is_empty());
    for lane in &lanes {
        assert!(!lane.name.is_empty());
        assert!(!lane.provider.as_str().is_empty());
        assert!(!lane.model.is_empty());
    }
}

#[test]
fn test_load_real_lanes_filtered() {
    // Derive the filter target from the actual catalog rather than hard-coding a lane name (the local
    // lanes.toml is edited per experiment). Loading unfiltered must preserve declaration order, so the
    // first catalog lane is well-defined.
    let all = load_lanes(&bench_dir().join("lanes.toml"), None).expect("load all");
    let first = all.first().expect("at least one lane").name.clone();
    let lanes = load_lanes(&bench_dir().join("lanes.toml"), Some(&first)).expect("filter ok");
    assert_eq!(lanes.len(), 1);
    assert_eq!(lanes[0].name, first);
}
