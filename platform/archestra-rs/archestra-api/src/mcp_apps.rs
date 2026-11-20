// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{PgPool, mcp_apps};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn publish_app(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::PublishApp>,
) -> Result<Json<Option<i32>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::publish_app(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn refine_app(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::RefineApp>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::refine_app(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn edit_app(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::EditApp>,
) -> Result<Json<mcp_apps::EditOutcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::edit_app(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn scaffold(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::Scaffold>,
) -> Result<Json<Option<mcp_apps::Scaffolded>>, StatusCode> {
    use diesel::result::{DatabaseErrorKind, Error};
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match mcp_apps::scaffold(&mut connection, input).await {
        Ok(app) => Ok(Json(Some(app))),
        Err(Error::DatabaseError(DatabaseErrorKind::UniqueViolation, error))
            if error.constraint_name() == Some("apps_org_author_name_uidx") =>
        {
            Ok(Json(None))
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn replace_labels(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::ReplaceLabels>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::replace_labels(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn delete_app(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::DeleteApp>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::delete_app(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn replace_tools(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::ReplaceTools>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::replace_tools(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn set_lock(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_apps::SetLock>,
) -> Result<Json<Option<mcp_apps::LockState>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_apps::set_lock(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
