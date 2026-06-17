use std::path::{Path, PathBuf};
use std::process::Command;

use archestra_bench::config::{load_envs, load_lanes};

fn bench_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is archestra-bench/runner; the benchmark root is its parent.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn copy_bench_to_temp(tmp: &Path) -> PathBuf {
    std::fs::create_dir_all(tmp).expect("create temp dir");
    let dst = tmp.join("archestra-bench");
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

#[test]
fn test_load_real_envs() {
    let tmp = std::env::temp_dir().join(format!("archestra_bench_integ_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let dst = copy_bench_to_temp(&tmp);
    generate_fixtures(&dst);

    let envs = load_envs(&dst.join("envs")).expect("should load envs");
    assert!(envs.contains_key("basic"));
    assert!(envs.contains_key("archestra-api"));
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
