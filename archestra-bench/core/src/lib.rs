//! Shared data contract for the archestra-bench harness (writer) and trajectory analyzer (reader).
//!
//! Both the harness and the analyzer read/write the same on-disk artifacts (`run.json`,
//! `trajectory.jsonl`, `lanes.toml`) and the same `experiments/<run>/<env>/<task>__<lane>` layout.
//! Defining those shapes once here keeps the two sides from silently drifting.
