//! Local read-only dashboard over archestra-bench run artifacts: run list, per-run rubric grids,
//! and rollout detail pages. Everything is loaded from disk per request — no database, no cache.

pub mod load;
mod views;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use askama::Template;
use axum::{
    Router,
    extract::{Path as AxumPath, Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use eyre::WrapErr;
use tower_http::trace::TraceLayer;

use crate::load::{Run, load_run};
use crate::views::{
    GridFilters, GridTemplate, IndexTemplate, RolloutTemplate, RunTemplate, build_grid,
    build_index, build_rollout, build_run,
};

#[derive(Debug, Clone)]
pub struct DashboardConfig {
    pub experiments_dir: PathBuf,
    pub port: u16,
}

#[derive(Clone)]
struct AppState {
    experiments_dir: Arc<PathBuf>,
}

/// Handler-level failure. `NotFound` is a routing outcome (unknown run/rollout id); `Internal`
/// wraps any loader/render error, logs it, and answers 500 — handlers never unwrap.
#[derive(Debug)]
pub enum AppError {
    NotFound(String),
    Internal(eyre::Report),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            AppError::Internal(err) => {
                tracing::error!("handler error: {err:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("internal error: {err}"),
                )
                    .into_response()
            }
        }
    }
}

impl From<eyre::Report> for AppError {
    fn from(err: eyre::Report) -> Self {
        AppError::Internal(err)
    }
}

impl From<askama::Error> for AppError {
    fn from(err: askama::Error) -> Self {
        AppError::Internal(eyre::Report::new(err))
    }
}

/// Build the app router over an experiments directory. Public so tests can drive it with
/// `tower::ServiceExt::oneshot`.
pub fn router(experiments_dir: PathBuf) -> Router {
    let state = AppState {
        experiments_dir: Arc::new(experiments_dir),
    };
    Router::new()
        .route("/", get(index))
        .route("/runs/{run_id}", get(run_page))
        .route("/runs/{run_id}/grid", get(run_grid))
        .route("/runs/{run_id}/rollouts/{*rollout}", get(rollout_page))
        .route("/static/styles.css", get(styles))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Serve the dashboard on `127.0.0.1:<port>` until the process is stopped.
pub async fn serve(cfg: DashboardConfig) -> eyre::Result<()> {
    let addr = format!("127.0.0.1:{}", cfg.port);
    let app = router(cfg.experiments_dir.clone());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .wrap_err_with(|| format!("failed to bind {addr}"))?;
    tracing::info!(
        "dashboard listening on http://{addr} (experiments dir: {})",
        cfg.experiments_dir.display()
    );
    axum::serve(listener, app).await.wrap_err("server error")
}

/// Default experiments dir: `<git toplevel>/ai-labs/experiments` when a `.git` ancestor
/// exists (nearest ancestor wins, same walk as the analyzer's explore-root autodetection),
/// otherwise `./experiments` relative to the cwd.
pub fn default_experiments_dir() -> PathBuf {
    let fallback = PathBuf::from("experiments");
    let Ok(cwd) = std::env::current_dir() else {
        return fallback;
    };
    for dir in cwd.ancestors() {
        if dir.join(".git").exists() {
            return dir.join("ai-labs").join("experiments");
        }
    }
    fallback
}

fn load_run_or_404(experiments_dir: &std::path::Path, run_id: &str) -> Result<Run, AppError> {
    load_run(experiments_dir, run_id)?
        .ok_or_else(|| AppError::NotFound(format!("no such run: {run_id}")))
}

#[tracing::instrument(skip(state))]
async fn index(State(state): State<AppState>) -> Result<Html<String>, AppError> {
    let runs = load::list_runs(&state.experiments_dir)?;
    let template: IndexTemplate = build_index(&state.experiments_dir, runs);
    Ok(Html(template.render()?))
}

#[tracing::instrument(skip(state))]
async fn run_page(
    State(state): State<AppState>,
    AxumPath(run_id): AxumPath<String>,
) -> Result<Html<String>, AppError> {
    let run = load_run_or_404(&state.experiments_dir, &run_id)?;
    let grid = build_grid(&run, &GridFilters::default());
    let grid_html = GridTemplate { grid }.render()?;
    let template: RunTemplate = build_run(&run, grid_html);
    Ok(Html(template.render()?))
}

/// Grid fragment for DataStar `@get` refreshes. Filters arrive either as DataStar's `datastar`
/// JSON query param (the signal bag) or as plain query params (curl-friendly); the server does all
/// the filtering, the client expression stays a bare `@get`.
#[tracing::instrument(skip(state, query))]
async fn run_grid(
    State(state): State<AppState>,
    AxumPath(run_id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Html<String>, AppError> {
    let run = load_run_or_404(&state.experiments_dir, &run_id)?;
    let filters = GridFilters::from_query(&query);
    let grid = build_grid(&run, &filters);
    Ok(Html(GridTemplate { grid }.render()?))
}

#[tracing::instrument(skip(state))]
async fn rollout_page(
    State(state): State<AppState>,
    AxumPath((run_id, rollout)): AxumPath<(String, String)>,
) -> Result<Html<String>, AppError> {
    let run = load_run_or_404(&state.experiments_dir, &run_id)?;
    // `rollout` is the percent-decoded opaque `<env>/<task>__<lane>` key; it is only ever used as
    // a map lookup — never split, never joined into a filesystem path.
    let Some(found) = run.rollouts.get(&rollout) else {
        return Err(AppError::NotFound(format!(
            "no such rollout in run {run_id}: {rollout}"
        )));
    };
    let template: RolloutTemplate = build_rollout(&run, found);
    Ok(Html(template.render()?))
}

async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/styles.css"),
    )
}
