use archestra_db::{PgPool, mcp_projects};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn link_app(
    State(pool): State<PgPool>,
    Json(link): Json<mcp_projects::AppLink>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_projects::link_app(&mut connection, link)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn unlink_app(
    State(pool): State<PgPool>,
    Json(link): Json<mcp_projects::AppUnlink>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_projects::unlink_app(&mut connection, link)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_projects::ListScope>,
) -> Result<Json<mcp_projects::Page>, StatusCode> {
    if !(1..=100).contains(&scope.limit) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_projects::list(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_projects::Scope>,
) -> Result<Json<Option<mcp_projects::Project>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_projects::read(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
