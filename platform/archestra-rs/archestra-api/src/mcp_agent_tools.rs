// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{PgPool, mcp_agent_tools};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn assign(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent_tools::AssignTool>,
) -> Result<Json<mcp_agent_tools::AssignOutcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent_tools::assign(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn remove(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent_tools::RemoveTool>,
) -> Result<Json<mcp_agent_tools::Outcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent_tools::remove(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
