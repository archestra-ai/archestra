use archestra_db::{
    PgPool,
    mcp_limits::{self, Query},
};
use axum::{Json, extract::State, http::StatusCode};
use serde_json::Value;

pub(crate) async fn create(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_limits::Create>,
) -> Result<Json<Option<Value>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_limits::create(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn update(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_limits::Update>,
) -> Result<Json<Option<Value>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_limits::update(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn delete(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_limits::Delete>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_limits::delete(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(query): Json<Query>,
) -> Result<Json<Vec<Value>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_limits::list(&mut connection, query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
