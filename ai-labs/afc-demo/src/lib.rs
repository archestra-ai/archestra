//! # afc-demo
//!
//! Mock tools, fixtures, the checker inventory, and the scripted 8-beat scenario that proves the AFC
//! model end-to-end. Everything is local and deterministic — no network, no real LLM.

use std::path::{Path, PathBuf};

pub mod bootstrap;
pub mod fixtures;
pub mod inventory;
pub mod scenario;
pub mod suggest;
pub mod wiring;

pub use inventory::build_inventory;
pub use scenario::{Scenario, run as run_scenario};
pub use wiring::Runtime;

/// The bundled clean config directory.
pub fn default_config_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("config")
}

/// The bundled config directory with the deliberately typo'd `ArgCmp` path.
pub fn typo_config_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("config-typo")
}

/// The bundled proposals fixture for `afc bootstrap`.
pub fn proposals_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/proposals.yaml")
}
