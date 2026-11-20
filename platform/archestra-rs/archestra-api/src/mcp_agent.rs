use archestra_db::{PgPool, mcp_agent};
use axum::{Json, extract::State, http::StatusCode};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
pub(crate) async fn create_agent(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent::CreateAgent>,
) -> Result<Json<Option<String>>, StatusCode> {
    use diesel::result::{DatabaseErrorKind, Error};
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match mcp_agent::create_agent(&mut connection, input).await {
        Ok(agent) => Ok(Json(Some(agent))),
        Err(Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)) => Ok(Json(None)),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}
// SPDX-SnippetEnd

pub(crate) async fn assign_gateway_delegation(
    State(pool): State<PgPool>,
    Json(assignment): Json<mcp_agent::GatewayDelegation>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::assign_gateway_delegation(&mut connection, assignment)
        .await
        .map(Json)
        .map_err(|error| match error {
            diesel::result::Error::NotFound => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })
}

pub(crate) async fn replace_gateway_assignments(
    State(pool): State<PgPool>,
    Json(edit): Json<mcp_agent::GatewayAssignmentEdit>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::replace_gateway_assignments(&mut connection, edit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn edit_gateway(
    State(pool): State<PgPool>,
    Json(edit): Json<mcp_agent::AgentEdit>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::edit_gateway(&mut connection, edit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
pub(crate) async fn edit_agent(
    State(pool): State<PgPool>,
    Json(edit): Json<mcp_agent::AgentEdit>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::edit_agent(&mut connection, edit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
// SPDX-SnippetEnd

pub(crate) async fn enable_gateway_all_tools(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent::EnableGatewayAllTools>,
) -> Result<Json<String>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::enable_gateway_all_tools(&mut connection, input)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::CONFLICT)
}

pub(crate) async fn persist_gateway_version(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_agent::GatewayVersion>,
) -> Result<Json<Option<i32>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::persist_gateway_version(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create_gateway(
    State(pool): State<PgPool>,
    Json(write): Json<mcp_agent::GatewayWrite>,
) -> Result<Json<String>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::create_gateway(&mut connection, write)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::CONFLICT)
}

pub(crate) async fn find_name(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_agent::NameScope>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::find_name(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(scope): Json<mcp_agent::Scope>,
) -> Result<Json<Option<mcp_agent::Detail>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_agent::read(&mut connection, scope)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
