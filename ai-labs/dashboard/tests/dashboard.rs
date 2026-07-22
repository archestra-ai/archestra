//! Loader and route tests over the real fixture experiments dir (no mocks: real files on disk).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use bench_dashboard::load::{ReduceSource, RubricKey, RubricStatus, list_runs, load_run};

fn fixtures() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/experiments");
    // Checkouts flatten mtimes, so pin the ordering the loader is supposed to observe: run_a's
    // newer rubric file really is newer, and run_a's dir is more recent than run_b's.
    let now = filetime::FileTime::from_system_time(SystemTime::now());
    let older = filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(3600));
    filetime::set_file_mtime(dir.join("run_a/trajectory_rubrics_20260101-000000.jsonl"), older).unwrap();
    filetime::set_file_mtime(dir.join("run_a/trajectory_rubrics_20260701-120000.jsonl"), now).unwrap();
    filetime::set_file_mtime(dir.join("run_b"), older).unwrap();
    filetime::set_file_mtime(dir.join("run_a"), now).unwrap();
    dir
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

#[test]
fn list_runs_finds_run_dirs_newest_first() {
    let runs = list_runs(&fixtures()).unwrap();
    let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["run_a", "run_b"], "run dirs only, newest first");

    let run_a = &runs[0];
    assert_eq!(run_a.envs, ["basic"]);
    assert_eq!(run_a.lanes, ["kimi", "glm"]);
    // Counts come from aggregate.json when present.
    assert_eq!(run_a.counts.passed, 2);
    assert_eq!(run_a.counts.failed, 1);
    assert!((run_a.pass_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    assert_eq!(run_a.rubric_status, RubricStatus::Partial { present: 2, total: 3 });
}

#[test]
fn run_without_aggregate_counts_outcomes_from_rollouts() {
    let runs = list_runs(&fixtures()).unwrap();
    let run_b = runs.iter().find(|r| r.id == "run_b").unwrap();
    assert_eq!(run_b.counts.passed, 1);
    assert_eq!(run_b.counts.total(), 1);
    assert_eq!(run_b.pass_rate, Some(1.0));
}

#[test]
fn rollout_identity_comes_from_run_json_not_dir_name() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    assert_eq!(run.rollouts.len(), 3);
    let tricky = run.rollouts.get("basic/tricky__part__kimi").unwrap();
    assert_eq!(tricky.id.env, "basic");
    assert_eq!(tricky.id.task, "tricky__part");
    assert_eq!(tricky.id.lane, "kimi");
    assert!(tricky.dir.ends_with("run_a/basic/tricky__part__kimi"));
}

#[test]
fn malformed_rollout_dir_is_skipped_with_a_warning() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    assert!(!run.rollouts.keys().any(|k| k.contains("broken")));
    let dir_warnings: Vec<&String> = run.warnings.iter().filter(|w| w.contains("broken__kimi")).collect();
    assert_eq!(dir_warnings.len(), 1, "one warning for the malformed dir");
}

#[test]
fn latest_rubric_file_by_mtime_wins() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    assert_eq!(run.rubrics.len(), 2);
    // The stale file grades alpha's knowledge 1; the newer one grades it 4.
    let alpha = run.rubrics.get("basic/alpha__kimi").unwrap();
    assert_eq!(alpha.rubrics.knowledge.grade.value(), 4);
    assert!(alpha.reward_hacking.suspected);
}

#[test]
fn partial_rubrics_average_only_over_present_records() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    assert_eq!(run.rubric_status, RubricStatus::Partial { present: 2, total: 3 });
    // kimi has two records: knowledge grades 4 (alpha) and 2 (tricky__part) -> mean 3.0.
    assert_eq!(run.lane_rubric_avg("kimi", RubricKey::Knowledge), Some(3.0));
    assert_eq!(run.lane_rubric_avg("kimi", RubricKey::EnvErgonomics), Some(3.5));
    // glm's only rollout has no record -> no average, not 0.
    assert_eq!(run.lane_rubric_avg("glm", RubricKey::Knowledge), None);
}

#[test]
fn rubric_avg_averages_over_all_records_across_lanes() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    // Two records (both kimi): knowledge 4/2, reasoning 3/4, if 5/3, ergonomics 2/5.
    assert_eq!(run.rubric_avg(RubricKey::Knowledge), Some(3.0));
    assert_eq!(run.rubric_avg(RubricKey::Reasoning), Some(3.5));
    assert_eq!(run.rubric_avg(RubricKey::InstructionFollowing), Some(4.0));
    assert_eq!(run.rubric_avg(RubricKey::EnvErgonomics), Some(3.5));

    // A run with no rubric records has no averages, not zeros.
    let run_b = load_run(&fixtures(), "run_b").unwrap().unwrap();
    assert_eq!(run_b.rubric_avg(RubricKey::Knowledge), None);
}

#[test]
fn reduce_reports_load_latest_per_source_in_order() {
    let run = load_run(&fixtures(), "run_a").unwrap().unwrap();
    let sources: Vec<ReduceSource> = run.reports.iter().map(|r| r.source).collect();
    assert_eq!(sources, [ReduceSource::Analyzer, ReduceSource::Claude]);
    assert_eq!(run.reports[0].filename, "trajectory_analysis_20260701-120000.md");
    assert_eq!(run.reports[1].filename, "trajectory_analysis_claude_20260701-120000.md");

    // A run with no reduce report has no reports.
    let run_b = load_run(&fixtures(), "run_b").unwrap().unwrap();
    assert!(run_b.reports.is_empty());
}

#[test]
fn malformed_rubric_file_degrades_to_rubric_less_with_warning() {
    let run = load_run(&fixtures(), "run_b").unwrap().unwrap();
    assert_eq!(run.rubric_status, RubricStatus::None);
    assert!(run.rubrics.is_empty());
    assert!(
        run.warnings.iter().any(|w| w.contains("trajectory_rubrics")),
        "warnings: {:?}",
        run.warnings
    );
    // Outcomes are still available.
    assert_eq!(run.rollouts.len(), 1);
}

#[test]
fn unknown_run_id_is_none() {
    assert!(load_run(&fixtures(), "nope").unwrap().is_none());
    assert!(load_run(&fixtures(), "not_a_run").unwrap().is_none());
    assert!(load_run(&fixtures(), "../run_a").unwrap().is_none());
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn get(uri: &str) -> (StatusCode, String) {
    let app = bench_dashboard::router(fixtures());
    let response = app
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&body).to_string())
}

#[tokio::test]
async fn index_renders() {
    let (status, body) = get("/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("href=\"/runs/run_a\""));
    assert!(body.contains("href=\"/runs/run_b\""));
    // run_a has both reduce reports, so its row carries the report chips.
    assert!(body.contains("report-chip"), "report chips on run list");
    // A pass rate present -> a rendered rate bar.
    assert!(body.contains("rate-fill"), "pass-rate bar on run list");
}

#[tokio::test]
async fn run_page_renders_with_opaque_rollout_links() {
    let (status, body) = get("/runs/run_a").await;
    assert_eq!(status, StatusCode::OK);
    // Grid cells link to the percent-encoded opaque rollout id, `__` in the task and all.
    assert!(body.contains("/runs/run_a/rollouts/basic%2Ftricky__part__kimi"));
}

#[tokio::test]
async fn run_page_renders_reduce_reports_and_avg_columns() {
    let (status, body) = get("/runs/run_a").await;
    assert_eq!(status, StatusCode::OK);
    // Both reduce reports render as collapsible sections labelled by source.
    assert!(body.contains("class=\"report\""), "report section present");
    assert!(body.contains("Analyzer report"), "analyzer report labelled");
    assert!(body.contains("Claude report"), "claude report labelled");
    // Aggregate "avg" columns exist on the grid and the rubric-by-lane table.
    assert!(body.contains("class=\"avg-col\""), "avg column rendered");
}

#[tokio::test]
async fn grid_shows_per_task_average() {
    // basic/alpha's only graded rollout (kimi) has mean grade 3.5, so the row avg is 3.5.
    let (status, body) = get("/runs/run_a/grid?lane=kimi").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(">3.5</span>"), "per-task avg chip: {body}");
}

#[tokio::test]
async fn unknown_run_is_404() {
    let (status, _) = get("/runs/definitely_not_a_run").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rollout_page_resolves_encoded_id_with_double_underscore_task() {
    let (status, _) = get("/runs/run_a/rollouts/basic%2Ftricky__part__kimi").await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_rollout_is_404() {
    let (status, _) = get("/runs/run_a/rollouts/basic%2Fnope__kimi").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn grid_fragment_filters_server_side() {
    let (status, body) = get("/runs/run_a/grid?outcome=failed").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("id=\"grid\""), "stable wrapper id for morphing");
    // Only beta (failed) survives the filter; the passed rollouts drop out.
    assert!(body.contains("basic%2Fbeta__glm"));
    assert!(!body.contains("basic%2Falpha__kimi"));
}
