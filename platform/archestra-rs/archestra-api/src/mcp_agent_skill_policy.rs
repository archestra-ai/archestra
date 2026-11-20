// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{PgPool, mcp_agent_skill_policy};
use axum::{Json, extract::State, http::StatusCode};

pub(crate) async fn patch(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent_skill_policy::PatchPolicy>,
) -> Result<Json<mcp_agent_skill_policy::Outcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent_skill_policy::patch(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
