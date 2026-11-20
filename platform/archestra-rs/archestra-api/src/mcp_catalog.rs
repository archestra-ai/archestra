// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{PgPool, mcp_catalog, mcp_reload};
use axum::{Json, extract::State, http::StatusCode};
use diesel::result::{DatabaseErrorKind, Error};

pub(crate) async fn reload_write(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_reload::ReloadWrite>,
) -> Result<Json<Option<Vec<serde_json::Value>>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match mcp_reload::write(&mut connection, input).await {
        Ok(rows) => Ok(Json(Some(rows))),
        Err(Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)) => Ok(Json(None)),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn deploy(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_catalog::Deploy>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_catalog::deploy(&mut connection, input)
        .await
        .map(|id| Json(id.map(|id| id.to_string())))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_catalog::CreateCatalog>,
) -> Result<Json<String>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_catalog::create(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn edit_config(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_catalog::EditConfig>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_catalog::edit_config(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn edit_description(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_catalog::EditDescription>,
) -> Result<Json<mcp_catalog::Outcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_catalog::edit_description(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
