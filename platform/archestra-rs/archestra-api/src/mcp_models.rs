use archestra_db::{PgPool, mcp_models};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_models::ModelScope>,
) -> Result<Json<Vec<mcp_models::LinkedModel>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_models::list(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
