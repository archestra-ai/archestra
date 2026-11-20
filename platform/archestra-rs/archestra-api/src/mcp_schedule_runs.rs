use archestra_db::{
    PgPool,
    mcp_schedule_runs::{self, PageQuery, PageRow, RunSummary},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;

pub(crate) async fn create_trigger(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_schedule_runs::CreateTrigger>,
) -> Result<Json<Option<mcp_schedule_runs::CreatedTrigger>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::create_trigger(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn update_trigger(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_schedule_runs::UpdateTrigger>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::update_trigger(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn delete_trigger(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_schedule_runs::ScheduleTarget>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::delete_trigger(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create_manual_run(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_schedule_runs::CreateManualRun>,
) -> Result<Json<Option<mcp_schedule_runs::CreatedManualRun>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::create_manual_run(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn trigger(
    State(pool): State<PgPool>,
    Json(query): Json<mcp_schedule_runs::TriggerQuery>,
) -> Result<Json<Option<mcp_schedule_runs::TriggerDetail>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::trigger(&mut connection, query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn triggers(
    State(pool): State<PgPool>,
    Json(query): Json<mcp_schedule_runs::TriggerPageQuery>,
) -> Result<Json<Vec<mcp_schedule_runs::TriggerPageRow>>, StatusCode> {
    if !(2..=101).contains(&query.limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::list_triggers(&mut connection, query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    organization_id: String,
    trigger_id: String,
    run_id: String,
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(query): Json<PageQuery>,
) -> Result<Json<Vec<PageRow>>, StatusCode> {
    if !(2..=101).contains(&query.limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::list(&mut connection, query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(request): Json<Request>,
) -> Result<Json<Option<RunSummary>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_schedule_runs::read(
        &mut connection,
        &request.organization_id,
        &request.trigger_id,
        &request.run_id,
    )
    .await
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
