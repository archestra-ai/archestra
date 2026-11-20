use archestra_db::{PgPool, mcp_interaction, mcp_sessions};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn session_logs(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_interaction::SessionLogsScope>,
) -> Result<Json<mcp_interaction::Page>, StatusCode> {
    if !(1..=100).contains(&scope.limit) || scope.offset < 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_interaction::session_logs(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn sessions(
    State(pool): State<PgPool>,
    Json(query): Json<mcp_sessions::Query>,
) -> Result<Json<mcp_sessions::Page>, StatusCode> {
    if !(1..=100).contains(&query.limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_sessions::list(&mut connection, query)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_interaction::ListScope>,
) -> Result<Json<mcp_interaction::Page>, StatusCode> {
    if !(1..=100).contains(&scope.limit) || scope.offset < 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_interaction::list(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_interaction::Scope>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_interaction::read(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
