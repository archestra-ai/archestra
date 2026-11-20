// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Integer, Jsonb, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchPolicy {
    agent_id: Uuid,
    organization_id: String,
    expected_revision: i64,
    replacement: Option<Replacement>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replacement {
    mode: Mode,
    rules: Vec<Rule>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    All,
    Manual,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    disposition: Disposition,
    reference: Reference,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Disposition {
    Allow,
    Exclude,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Reference {
    Native { skill_id: Uuid },
    ExternalMcp { mcp_server_id: Uuid, uri: String },
    Plugin { plugin_id: Uuid, skill_path: String },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    NotFound,
    Conflict,
    Unchanged,
    Updated,
}

pub async fn patch(connection: &mut AsyncPgConnection, input: PatchPolicy) -> QueryResult<Outcome> {
    #[derive(QueryableByName)]
    struct PolicyState {
        #[diesel(sql_type = Integer)]
        activation_skill_policy_revision: i32,
    }
    connection.transaction(async |tx| {
        let state = sql_query(
            "SELECT activation_skill_policy_revision FROM agents
             WHERE id = $1 AND organization_id = $2 AND agent_type = 'agent'
               AND deleted_at IS NULL FOR UPDATE",
        )
        .bind::<SqlUuid, _>(input.agent_id)
        .bind::<Text, _>(input.organization_id)
        .get_result::<PolicyState>(tx)
        .await
        .optional()?;
        match state {
            None => return Ok(Outcome::NotFound),
            Some(state) if i64::from(state.activation_skill_policy_revision) != input.expected_revision => {
                return Ok(Outcome::Conflict);
            }
            Some(_) => {}
        }
        let Some(replacement) = input.replacement else {
            return Ok(Outcome::Unchanged);
        };
        sql_query("DELETE FROM agent_activation_skill_rules WHERE agent_id = $1")
            .bind::<SqlUuid, _>(input.agent_id)
            .execute(tx)
            .await?;
        sql_query(
            "INSERT INTO agent_activation_skill_rules
                 (agent_id, disposition, source, skill_id, mcp_server_id, uri, plugin_id, skill_path)
             SELECT $1, disposition, reference->>'source', (reference->>'skillId')::uuid,
                    (reference->>'mcpServerId')::uuid, reference->>'uri',
                    (reference->>'pluginId')::uuid, reference->>'skillPath'
             FROM jsonb_to_recordset($2) AS r(disposition text, reference jsonb)
             ON CONFLICT DO NOTHING",
        )
        .bind::<SqlUuid, _>(input.agent_id)
        .bind::<Jsonb, _>(serde_json::json!(replacement.rules))
        .execute(tx)
        .await?;
        let mode = match replacement.mode {
            Mode::All => "all",
            Mode::Manual => "manual",
        };
        sql_query(
            "UPDATE agents SET activation_skill_mode = $2,
                 activation_skill_policy_revision = activation_skill_policy_revision + 1,
                 updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
             WHERE id = $1",
        )
        .bind::<SqlUuid, _>(input.agent_id)
        .bind::<Text, _>(mode)
        .execute(tx)
        .await?;
        Ok(Outcome::Updated)
    }).await
}
