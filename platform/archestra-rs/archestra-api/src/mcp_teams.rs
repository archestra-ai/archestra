use archestra_db::{
    PgPool,
    mcp_teams::{self, Member, Team, Visibility},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

pub(crate) async fn edit(
    State(pool): State<PgPool>,
    Json(edit): Json<mcp_teams::TeamEdit>,
) -> Result<Json<Option<Team>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::edit(&mut connection, edit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn create(
    State(pool): State<PgPool>,
    Json(team): Json<mcp_teams::TeamCreate>,
) -> Result<Json<Option<String>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::create(&mut connection, team)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    organization_id: String,
    scope: Scope,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Scope {
    Organization,
    Member { user_id: String },
    AuthorizedTeam { team_id: String },
}

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(request): Json<Request>,
) -> Result<Json<Vec<Team>>, StatusCode> {
    let visibility = match request.scope {
        Scope::Organization => Visibility::Organization,
        Scope::Member { user_id } => Visibility::Member(user_id),
        Scope::AuthorizedTeam { team_id } => Visibility::AuthorizedTeam(team_id),
    };
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::list(&mut connection, &request.organization_id, visibility)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamRequest {
    organization_id: String,
    team_id: String,
}

pub(crate) async fn delete(
    State(pool): State<PgPool>,
    Json(request): Json<TeamRequest>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::delete(&mut connection, &request.organization_id, &request.team_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum AddMemberResult {
    Membership(Option<mcp_teams::ManualMembership>),
    Conflict(&'static str),
}

pub(crate) async fn add_member(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_teams::MemberRoleWrite>,
) -> Result<Json<AddMemberResult>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match mcp_teams::add_member(&mut connection, input).await {
        Ok(row) => Ok(Json(AddMemberResult::Membership(row))),
        Err(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _,
        )) => Ok(Json(AddMemberResult::Conflict("unique_violation"))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn update_member_role(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_teams::MemberRoleWrite>,
) -> Result<Json<mcp_teams::MemberRoleUpdate>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::update_member_role(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn remove_member(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_teams::MemberRemove>,
) -> Result<Json<mcp_teams::MemberRemoval>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::remove_member(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn members(
    State(pool): State<PgPool>,
    Json(request): Json<TeamRequest>,
) -> Result<Json<Vec<Member>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::members(&mut connection, &request.organization_id, &request.team_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
pub(crate) async fn external_groups(
    State(pool): State<PgPool>,
    Json(request): Json<TeamRequest>,
) -> Result<Json<Vec<mcp_teams::ExternalGroup>>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::external_groups(&mut connection, &request.organization_id, &request.team_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum AddExternalGroupResult {
    Group(Option<mcp_teams::ExternalGroup>),
    Conflict(&'static str),
}

pub(crate) async fn add_external_group(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_teams::ExternalGroupAdd>,
) -> Result<Json<AddExternalGroupResult>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match mcp_teams::add_external_group(&mut connection, input).await {
        Ok(row) => Ok(Json(AddExternalGroupResult::Group(row))),
        Err(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _,
        )) => Ok(Json(AddExternalGroupResult::Conflict("unique_violation"))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn remove_external_group(
    State(pool): State<PgPool>,
    Json(input): Json<mcp_teams::ExternalGroupRemove>,
) -> Result<Json<bool>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    mcp_teams::remove_external_group(&mut connection, input)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
// SPDX-SnippetEnd
