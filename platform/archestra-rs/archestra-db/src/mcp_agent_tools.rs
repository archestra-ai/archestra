// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use diesel::{
    OptionalExtension, QueryableByName,
    result::{DatabaseErrorKind, Error, QueryResult},
    sql_query,
    sql_types::{Array, Bool, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignTool {
    organization_id: String,
    agent_id: Uuid,
    agent_type: String,
    environment_id: Option<Uuid>,
    tool_id: Uuid,
    mcp_server_id: Option<Uuid>,
    credential_resolution_mode: CredentialMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CredentialMode {
    Static,
    Dynamic,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssignOutcome {
    Changed,
    Unchanged,
    ScopeChanged,
}

pub async fn assign(
    connection: &mut AsyncPgConnection,
    input: AssignTool,
) -> QueryResult<AssignOutcome> {
    #[derive(QueryableByName)]
    struct ResultRow {
        #[diesel(sql_type = Bool)]
        eligible: bool,
        #[diesel(sql_type = Bool)]
        changed: bool,
    }
    sql_query(
        "WITH eligible AS (
             SELECT id FROM agents
             WHERE id = $1 AND organization_id = $2 AND environment_id IS NOT DISTINCT FROM $3
               AND agent_type = $4 AND deleted_at IS NULL FOR SHARE
         ), written AS (
             INSERT INTO agent_tools AS assignment (agent_id, tool_id, mcp_server_id, credential_resolution_mode)
             SELECT id, $5, $6, $7 FROM eligible
             ON CONFLICT (agent_id, tool_id) DO UPDATE SET
                 mcp_server_id = excluded.mcp_server_id,
                 credential_resolution_mode = excluded.credential_resolution_mode,
                 updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
             WHERE (assignment.mcp_server_id, assignment.credential_resolution_mode)
                 IS DISTINCT FROM (excluded.mcp_server_id, excluded.credential_resolution_mode)
             RETURNING 1
         )
         SELECT EXISTS (SELECT 1 FROM eligible) AS eligible,
                EXISTS (SELECT 1 FROM written) AS changed",
    )
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Text, _>(input.agent_type)
    .bind::<SqlUuid, _>(input.tool_id)
    .bind::<Nullable<SqlUuid>, _>(input.mcp_server_id)
    .bind::<Text, _>(match input.credential_resolution_mode {
        CredentialMode::Static => "static",
        CredentialMode::Dynamic => "dynamic",
    })
    .get_result::<ResultRow>(connection)
    .await
    .map(|row| match (row.eligible, row.changed) {
        (_, true) => AssignOutcome::Changed,
        (true, false) => AssignOutcome::Unchanged,
        (false, false) => AssignOutcome::ScopeChanged,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTool {
    organization_id: String,
    agent_id: Uuid,
    agent_type: String,
    environment_id: Option<Uuid>,
    tool_id: Uuid,
    mode: Mode,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Auto,
    Custom,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Removed,
    ScopeChanged,
    ToolGone,
}

pub async fn remove(connection: &mut AsyncPgConnection, input: RemoveTool) -> QueryResult<Outcome> {
    #[derive(QueryableByName)]
    struct Agent {
        #[diesel(sql_type = Bool)]
        access_all_tools: bool,
    }
    #[derive(QueryableByName)]
    struct Exclusion {
        #[diesel(sql_type = SqlUuid)]
        tool_id: Uuid,
    }
    let auto = matches!(input.mode, Mode::Auto);
    let result = connection
        .transaction(async |tx| {
            let agent = sql_query(
                "SELECT access_all_tools FROM agents
             WHERE id = $1 AND organization_id = $2 AND environment_id IS NOT DISTINCT FROM $3
               AND agent_type = $4 AND deleted_at IS NULL FOR UPDATE",
            )
            .bind::<SqlUuid, _>(input.agent_id)
            .bind::<Text, _>(input.organization_id)
            .bind::<Nullable<SqlUuid>, _>(input.environment_id)
            .bind::<Text, _>(input.agent_type)
            .get_result::<Agent>(tx)
            .await
            .optional()?;
            if agent.is_none_or(|agent| agent.access_all_tools != auto) {
                return Ok(Outcome::ScopeChanged);
            }

            match input.mode {
                Mode::Auto => {
                    let existing = sql_query(
                        "DELETE FROM agent_excluded_tools WHERE agent_id = $1 RETURNING tool_id",
                    )
                    .bind::<SqlUuid, _>(input.agent_id)
                    .load::<Exclusion>(tx)
                    .await?;
                    let ids: Vec<_> = existing
                        .into_iter()
                        .map(|row| row.tool_id)
                        .chain([input.tool_id])
                        .collect();
                    sql_query(
                        "INSERT INTO agent_excluded_tools (agent_id, tool_id)
                     SELECT $1, id FROM unnest($2) AS ids(id) ON CONFLICT DO NOTHING",
                    )
                    .bind::<SqlUuid, _>(input.agent_id)
                    .bind::<Array<SqlUuid>, _>(ids)
                    .execute(tx)
                    .await?;
                }
                Mode::Custom => {
                    sql_query("DELETE FROM agent_tools WHERE agent_id = $1 AND tool_id = $2")
                        .bind::<SqlUuid, _>(input.agent_id)
                        .bind::<SqlUuid, _>(input.tool_id)
                        .execute(tx)
                        .await?;
                }
            }
            Ok(Outcome::Removed)
        })
        .await;
    match result {
        Err(Error::DatabaseError(DatabaseErrorKind::ForeignKeyViolation, _)) if auto => {
            Ok(Outcome::ToolGone)
        }
        result => result,
    }
}
