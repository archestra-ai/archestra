// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{
    PgPool,
    mcp_knowledge::{self, Details},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorRequest {
    organization_id: String,
    id: String,
    environment_id: Option<String>,
}

pub(crate) async fn connector(
    State(pool): State<PgPool>,
    Json(request): Json<ConnectorRequest>,
) -> Result<Json<Option<String>>, StatusCode> {
    let Json(mut rows) = connectors(
        State(pool),
        Json(ConnectorsRequest {
            organization_id: request.organization_id,
            ids: vec![request.id],
            environment_id: request.environment_id,
        }),
    )
    .await?;
    Ok(Json(rows.pop()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectorsRequest {
    organization_id: String,
    ids: Vec<String>,
    environment_id: Option<String>,
}

pub(crate) async fn connectors(
    State(pool): State<PgPool>,
    Json(request): Json<ConnectorsRequest>,
) -> Result<Json<Vec<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::connectors(
        &mut connection,
        &request.organization_id,
        request.ids,
        request.environment_id.as_deref(),
    )
    .await
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListRequest {
    organization_id: String,
    ids: Vec<String>,
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(request): Json<ListRequest>,
) -> Result<Json<Vec<mcp_knowledge::KnowledgeBase>>, StatusCode> {
    if request.ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::list(&mut connection, &request.organization_id, request.ids)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    organization_id: String,
    id: String,
}

pub(crate) async fn read(
    State(pool): State<PgPool>,
    Json(request): Json<Request>,
) -> Result<Json<Option<Details>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::read(&mut connection, &request.organization_id, &request.id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn delete(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::DeleteKnowledgeBase>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::delete(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn delete_connector(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::DeleteConnector>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::delete_connector(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn assign_connector(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::ConnectorAssignment>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::assign_connector(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn unassign_connector(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::ConnectorAssignment>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::unassign_connector(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn assign_knowledge_base_to_agent(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::AgentKnowledgeBaseAssignment>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::assign_knowledge_base_to_agent(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn unassign_knowledge_base_from_agent(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::AgentKnowledgeBaseAssignment>,
) -> Result<Json<Option<bool>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::unassign_knowledge_base_from_agent(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn assign_connector_to_agent(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::AgentConnectorAssignment>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::assign_connector_to_agent(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn unassign_connector_from_agent(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::AgentConnectorRemoval>,
) -> Result<Json<Option<bool>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::unassign_connector_from_agent(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn update_connector(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::UpdateConnector>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::update_connector(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create_connector(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::CreateConnector>,
) -> Result<Json<String>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::create_connector(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn update(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::UpdateKnowledgeBase>,
) -> Result<Json<Option<mcp_knowledge::KnowledgeBase>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::update(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_knowledge::CreateKnowledgeBase>,
) -> Result<Json<mcp_knowledge::KnowledgeBase>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_knowledge::create(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
