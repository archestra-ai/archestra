use archestra_db::{PgPool, mcp_hooks};
use axum::{Json, extract::State, http::StatusCode};
use diesel::result::{DatabaseErrorKind, Error, QueryResult};
use serde::Serialize;

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_hooks::HookScope>,
) -> Result<Json<Vec<mcp_hooks::Hook>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_hooks::list(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum HookWriteResult {
    Hook(Option<mcp_hooks::Hook>),
    Conflict(&'static str),
}

pub(crate) async fn create(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_hooks::CreateHook>,
) -> Result<Json<HookWriteResult>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    hook_write_response(mcp_hooks::create(&mut connection, input).await)
}

pub(crate) async fn update(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_hooks::UpdateHook>,
) -> Result<Json<HookWriteResult>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    hook_write_response(mcp_hooks::update(&mut connection, input).await)
}

fn hook_write_response(
    result: QueryResult<Option<mcp_hooks::Hook>>,
) -> Result<Json<HookWriteResult>, StatusCode> {
    match result {
        Ok(hook) => Ok(Json(HookWriteResult::Hook(hook))),
        Err(Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)) => {
            Ok(Json(HookWriteResult::Conflict("unique_violation")))
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn delete(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_hooks::HookTarget>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_hooks::delete(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
