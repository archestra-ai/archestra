// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use std::collections::BTreeSet;

use diesel::{
    QueryResult, QueryableByName, sql_query,
    sql_types::{Array, Bool, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReloadWrite {
    organization_id: String,
    catalog_id: Uuid,
    server_id: Uuid,
    write: Write,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Write {
    Adopt {
        names: Vec<String>,
    },
    Update {
        id: Uuid,
        tool: ToolFields,
        restore: bool,
    },
    Insert {
        tools: Vec<ToolFields>,
    },
    Transfer {
        assignment: Assignment,
    },
    Delete {
        ids: Vec<Uuid>,
    },
    Descriptions {
        descriptions: Vec<Description>,
    },
    AttachDeploymentTools {
        agent_ids: BTreeSet<Uuid>,
        tool_ids: BTreeSet<Uuid>,
        environment_id: Option<Uuid>,
        phase: AttachPhase,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum AttachPhase {
    Insert,
    Repin,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolFields {
    name: String,
    raw_name: String,
    description: Option<String>,
    parameters: Value,
    meta: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assignment {
    agent_id: Uuid,
    tool_id: Uuid,
    mcp_server_id: Option<Uuid>,
    credential_resolution_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Description {
    tool_id: Uuid,
    description: Option<String>,
}

#[derive(QueryableByName)]
struct ToolRow {
    #[diesel(sql_type = Jsonb)]
    row: Value,
}

impl ToolFields {
    fn record(self) -> Value {
        json!({ "name": self.name, "raw_name": self.raw_name,
            "description": self.description, "parameters": self.parameters, "meta": self.meta })
    }
}

pub async fn write(
    connection: &mut AsyncPgConnection,
    input: ReloadWrite,
) -> QueryResult<Vec<Value>> {
    let ReloadWrite {
        organization_id,
        catalog_id,
        server_id,
        write,
    } = input;
    // Each request preserves one legacy commit boundary.
    connection.transaction(async |tx| {
        sql_query("SELECT s.id FROM mcp_server s JOIN internal_mcp_catalog c ON c.id = s.catalog_id
                   WHERE s.id = $1 AND c.id = $2 AND (c.organization_id = $3 OR c.organization_id IS NULL)
                   AND c.deleted_at IS NULL AND s.deleted_at IS NULL
                   AND s.server_type IN ('local', 'remote') AND s.server_type = c.server_type
                   FOR SHARE OF c, s")
            .bind::<SqlUuid, _>(server_id).bind::<SqlUuid, _>(catalog_id)
            .bind::<Text, _>(&organization_id)
             .get_result::<ScopedId>(tx).await?;

        match write {
            Write::Adopt { names } => {
                sql_query("UPDATE tools SET catalog_id = $1, updated_at = now()
                           WHERE catalog_id IS NULL AND agent_id IS NULL AND delegate_to_agent_id IS NULL
                           AND name = ANY($2)")
                    .bind::<SqlUuid, _>(catalog_id).bind::<Array<Text>, _>(names).execute(tx).await?;
            }
            Write::Update { id, tool, restore } => {
                return sql_query("UPDATE tools SET name = CASE WHEN $4 THEN t.name ELSE tools.name END, raw_name = t.raw_name,
                         description = t.description, parameters = t.parameters, meta = t.meta,
                         deleted_at = CASE WHEN $4 THEN NULL ELSE tools.deleted_at END, updated_at = now()
                         FROM jsonb_populate_record(NULL::tools, $3) t
                         WHERE tools.catalog_id = $1 AND tools.id = $2 AND tools.agent_id IS NULL
                         RETURNING to_jsonb(tools) AS row")
                    .bind::<SqlUuid, _>(catalog_id).bind::<SqlUuid, _>(id)
                    .bind::<Jsonb, _>(tool.record()).bind::<Bool, _>(restore)
                    .load::<ToolRow>(tx).await
                    .map(|rows| rows.into_iter().map(|row| row.row).collect());
            }
            Write::Insert { tools } => {
                let records = Value::Array(tools.into_iter().map(ToolFields::record).collect());
                return sql_query("INSERT INTO tools (catalog_id, name, raw_name, description, parameters, meta)
                         SELECT $1, name, raw_name, description, parameters, meta
                         FROM jsonb_populate_recordset(NULL::tools, $2)
                         ON CONFLICT DO NOTHING RETURNING to_jsonb(tools) AS row")
                    .bind::<SqlUuid, _>(catalog_id).bind::<Jsonb, _>(records)
                    .load::<ToolRow>(tx).await.map(|rows| rows.into_iter().map(|row| row.row).collect());
            }
            Write::Transfer { assignment: a } => {
                sql_query("INSERT INTO agent_tools (agent_id, tool_id, mcp_server_id, credential_resolution_mode)
                           SELECT $2, id, $4, $5 FROM tools WHERE id = $3 AND catalog_id = $1 AND agent_id IS NULL")
                    .bind::<SqlUuid, _>(catalog_id).bind::<SqlUuid, _>(a.agent_id)
                    .bind::<SqlUuid, _>(a.tool_id).bind::<diesel::sql_types::Nullable<SqlUuid>, _>(a.mcp_server_id)
                    .bind::<Text, _>(a.credential_resolution_mode).execute(tx).await?;
            }
            Write::Delete { ids } => {
                sql_query("DELETE FROM tools WHERE catalog_id = $1 AND agent_id IS NULL AND id = ANY($2)")
                    .bind::<SqlUuid, _>(catalog_id).bind::<Array<SqlUuid>, _>(ids).execute(tx).await?;
            }
            Write::Descriptions { descriptions } => {
                let ids: Vec<_> = descriptions.iter().map(|entry| entry.tool_id).collect();
                sql_query("DELETE FROM mcp_server_tool_descriptions WHERE mcp_server_id = $1 AND NOT (tool_id = ANY($2))")
                    .bind::<SqlUuid, _>(server_id).bind::<Array<SqlUuid>, _>(ids).execute(tx).await?;
                if descriptions.is_empty() {
                    return Ok(Vec::new());
                }
                let entries = Value::Array(descriptions.into_iter().map(|entry|
                    json!({ "tool_id": entry.tool_id, "description": entry.description })).collect());
                sql_query("INSERT INTO mcp_server_tool_descriptions (mcp_server_id, tool_id, description)
                           SELECT $1, (SELECT id FROM tools WHERE id = t.tool_id AND catalog_id = $2), t.description
                           FROM jsonb_populate_recordset(NULL::mcp_server_tool_descriptions, $3) t
                           ON CONFLICT (mcp_server_id, tool_id) DO UPDATE SET description = excluded.description, updated_at = now()")
                    .bind::<SqlUuid, _>(server_id).bind::<SqlUuid, _>(catalog_id)
                    .bind::<Jsonb, _>(entries).execute(tx).await?;
            }
            Write::AttachDeploymentTools { agent_ids, tool_ids, environment_id, phase } => {
                let agent_ids: Vec<_> = agent_ids.into_iter().collect();
                let tool_ids: Vec<_> = tool_ids.into_iter().collect();
                let agents = sql_query("SELECT id FROM agents
                    WHERE id = ANY($1) AND organization_id = $2 AND deleted_at IS NULL
                    AND environment_id IS NOT DISTINCT FROM $3 ORDER BY id FOR SHARE")
                    .bind::<Array<SqlUuid>, _>(&agent_ids).bind::<Text, _>(&organization_id)
                    .bind::<Nullable<SqlUuid>, _>(environment_id).load::<ScopedId>(tx).await?;
                let tools = sql_query("SELECT id FROM tools WHERE id = ANY($1)
                    AND catalog_id = $2 AND agent_id IS NULL ORDER BY id FOR SHARE")
                    .bind::<Array<SqlUuid>, _>(&tool_ids).bind::<SqlUuid, _>(catalog_id)
                    .load::<ScopedId>(tx).await?;
                if agents.len() != agent_ids.len() || tools.len() != tool_ids.len() {
                    return Err(diesel::result::Error::NotFound);
                }
                sql_query(match phase {
                    AttachPhase::Insert => "INSERT INTO agent_tools (agent_id, tool_id, mcp_server_id)
                        SELECT a.id, t.id, $3 FROM unnest($1::uuid[]) a(id) CROSS JOIN unnest($2::uuid[]) t(id)
                        WHERE NOT EXISTS (SELECT 1 FROM agent_tools e WHERE e.agent_id = a.id AND e.tool_id = t.id)
                        ON CONFLICT DO NOTHING",
                    AttachPhase::Repin => "UPDATE agent_tools SET mcp_server_id = $3, updated_at = now()
                        WHERE agent_id = ANY($1) AND tool_id = ANY($2)",
                })
                    .bind::<Array<SqlUuid>, _>(agent_ids).bind::<Array<SqlUuid>, _>(tool_ids)
                    .bind::<SqlUuid, _>(server_id).execute(tx).await?;
            }
        }
        Ok(Vec::new())
    }).await
}

#[derive(QueryableByName)]
struct ScopedId {
    #[diesel(sql_type = SqlUuid, column_name = id)]
    _id: Uuid,
}
