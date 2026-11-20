use archestra_db::{
    PgPool,
    mcp_usage::{TokenUsage, agent_token_usage},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    agent_id: String,
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(request): Json<Request>,
) -> Result<Json<TokenUsage>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    agent_token_usage(&mut connection, &request.agent_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
