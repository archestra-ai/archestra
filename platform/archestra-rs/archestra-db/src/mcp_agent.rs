use std::collections::{BTreeMap, BTreeSet};

use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, BigInt, Bool, Integer, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayDelegation {
    agent_id: Uuid,
    organization_id: String,
    target_agent_id: Uuid,
}

pub async fn assign_gateway_delegation(
    connection: &mut AsyncPgConnection,
    assignment: GatewayDelegation,
) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Checked {
        #[diesel(sql_type = Bool)]
        ok: bool,
    }
    #[derive(QueryableByName)]
    struct Source {
        #[diesel(sql_type = SqlUuid)]
        id: Uuid,
    }
    let tool_id = find_or_create_delegation_tool(connection, assignment.target_agent_id).await?;
    connection
        .transaction(async |tx| {
            let source = sql_query(
                "SELECT id FROM agents WHERE id = $1 AND organization_id = $2
               AND agent_type = 'mcp_gateway' AND deleted_at IS NULL FOR NO KEY UPDATE",
            )
            .bind::<SqlUuid, _>(assignment.agent_id)
            .bind::<Text, _>(&assignment.organization_id)
            .get_result::<Source>(tx)
            .await?;
            sql_query(
                "WITH eligible AS (
                SELECT t.id FROM tools t JOIN agents target ON target.id = t.delegate_to_agent_id
                WHERE t.id = $2 AND target.id = $3 AND target.agent_type = 'agent'
                  AND target.deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_tools a JOIN tools other ON other.id = a.tool_id
                    WHERE a.agent_id = $1 AND other.name = t.name AND other.id <> t.id
                  )
             ), inserted AS (
                INSERT INTO agent_tools (agent_id, tool_id)
                SELECT $1, id FROM eligible
                ON CONFLICT (agent_id, tool_id) DO NOTHING RETURNING id
             )
             SELECT EXISTS(SELECT 1 FROM inserted) AS ok FROM eligible",
            )
            .bind::<SqlUuid, _>(source.id)
            .bind::<SqlUuid, _>(tool_id)
            .bind::<SqlUuid, _>(assignment.target_agent_id)
            .get_result::<Checked>(tx)
            .await
            .map(|row| row.ok)
        })
        .await
}

async fn find_or_create_delegation_tool(
    connection: &mut AsyncPgConnection,
    target_id: Uuid,
) -> QueryResult<Uuid> {
    #[derive(QueryableByName)]
    struct Target {
        #[diesel(sql_type = Text)]
        name: String,
    }
    #[derive(QueryableByName)]
    struct ToolId {
        #[diesel(sql_type = SqlUuid)]
        id: Uuid,
    }
    connection
        .transaction(async |tx| {
            let target = sql_query(
                "SELECT name FROM agents
                 WHERE id = $1 AND agent_type = 'agent' AND deleted_at IS NULL FOR UPDATE",
            )
            .bind::<SqlUuid, _>(target_id)
            .get_result::<Target>(tx)
            .await?;
            // Read after locking the target, in a separate statement so we see
            // a tool committed by the previous holder of the same lock.
            let existing =
                sql_query("SELECT id FROM tools WHERE delegate_to_agent_id = $1 LIMIT 1")
                    .bind::<SqlUuid, _>(target_id)
                    .get_result::<ToolId>(tx)
                    .await
                    .optional()?;
            if let Some(tool) = existing {
                return Ok(tool.id);
            }
            sql_query(
                "INSERT INTO tools (delegate_to_agent_id, name, description, parameters)
                 VALUES ($1, $2, $3, $4) RETURNING id",
            )
            .bind::<SqlUuid, _>(target_id)
            .bind::<Text, _>(delegation_tool_name(&target.name))
            .bind::<Text, _>(format!("Delegate task to agent: {}", target.name))
            .bind::<Jsonb, _>(serde_json::json!({
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The task or message to send to the agent"
                    }
                },
                "required": ["message"]
            }))
            .get_result::<ToolId>(tx)
            .await
            .map(|tool| tool.id)
        })
        .await
}

fn delegation_tool_name(name: &str) -> String {
    let slug = name
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    format!("agent__{slug}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayVersion {
    agent_id: Uuid,
    organization_id: String,
    row_revision: String,
    expected_version: i32,
    retain: std::num::NonZeroU16,
    snapshot: serde_json::Value,
    content_hash: String,
}

pub async fn persist_gateway_version(
    connection: &mut AsyncPgConnection,
    input: GatewayVersion,
) -> QueryResult<Option<i32>> {
    #[derive(QueryableByName)]
    struct Head {
        #[diesel(sql_type = Integer)]
        version: i32,
    }
    sql_query(include_str!("mcp_gateway_version.sql"))
        .bind::<SqlUuid, _>(input.agent_id)
        .bind::<Text, _>(input.organization_id)
        .bind::<Text, _>(input.row_revision)
        .bind::<Jsonb, _>(input.snapshot)
        .bind::<Text, _>(input.content_hash)
        .bind::<Integer, _>(input.expected_version)
        .bind::<Integer, _>(i32::from(input.retain.get()))
        .get_result::<Head>(connection)
        .await
        .optional()
        .map(|head| head.map(|head| head.version))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayWrite {
    organization_id: String,
    author_id: String,
    slugs: [String; 3],
    name: String,
    environment_id: Option<Uuid>,
    tool_exposure_mode: Option<String>,
    access_all_subagents: Option<bool>,
    subagent_load_balancing: Option<serde_json::Value>,
    grants: Vec<serde_json::Value>,
    labels: BTreeMap<String, String>,
    knowledge_base_ids: BTreeSet<Uuid>,
    connector_ids: BTreeSet<Uuid>,
    default_tool_ids: BTreeSet<Uuid>,
}

#[derive(QueryableByName)]
struct Created {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Text)]
    agent: String,
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgent {
    organization_id: String,
    author_id: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    name: String,
    environment_id: Option<Uuid>,
    system_prompt: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    tool_exposure_mode: Option<String>,
    access_all_subagents: Option<bool>,
    subagent_load_balancing: Option<serde_json::Value>,
    runtime: Option<serde_json::Value>,
    network_policy: Option<serde_json::Value>,
    llm_api_key_id: Option<Uuid>,
    model_id: Option<Uuid>,
    grants: Vec<serde_json::Value>,
}

pub async fn create_agent(
    connection: &mut AsyncPgConnection,
    input: CreateAgent,
) -> QueryResult<String> {
    sql_query(
        "WITH agent AS (
             INSERT INTO agents (organization_id, author_id, created_by_service_account_id,
                 name, agent_type, scope, access_all_tools, environment_id, system_prompt, description, icon,
                 tool_exposure_mode, access_all_subagents, subagent_load_balancing,
                 runtime, network_policy, llm_api_key_id, model_id)
             SELECT $1, $2, $3, $4, 'agent', 'personal', false, $5, $6, $7, $8,
                    coalesce($9, 'search_and_run_only'), coalesce($10, false),
                    $11, $12, $13, $14, $15
             WHERE ($3 IS NULL OR EXISTS (
                 SELECT 1 FROM service_accounts WHERE id = $3 AND organization_id = $1 FOR SHARE
             )) AND ($5 IS NULL OR EXISTS (
                 SELECT 1 FROM environments WHERE id = $5 AND organization_id = $1 FOR SHARE
             ))
             RETURNING *
         ), policy AS (
             INSERT INTO resource_permission_policies
                 (organization_id, resource, scope, grants, legacy_sharing_migrated)
             SELECT organization_id, 'agent', id::text, $16, true FROM agent
             RETURNING scope
         )
         SELECT agent.id, row_to_json(agent)::text AS agent FROM agent JOIN policy
             ON policy.scope = agent.id::text",
    )
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<Text>, _>(input.author_id)
    .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
    .bind::<Text, _>(input.name)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Nullable<Text>, _>(input.system_prompt)
    .bind::<Nullable<Text>, _>(input.description)
    .bind::<Nullable<Text>, _>(input.icon)
    .bind::<Nullable<Text>, _>(input.tool_exposure_mode)
    .bind::<Nullable<Bool>, _>(input.access_all_subagents)
    .bind::<Nullable<Jsonb>, _>(input.subagent_load_balancing)
    .bind::<Nullable<Jsonb>, _>(input.runtime)
    .bind::<Nullable<Jsonb>, _>(input.network_policy)
    .bind::<Nullable<SqlUuid>, _>(input.llm_api_key_id)
    .bind::<Nullable<SqlUuid>, _>(input.model_id)
    .bind::<Jsonb, _>(serde_json::Value::Array(input.grants))
    .get_result::<Created>(connection)
    .await
    .map(|row| row.agent)
}
// SPDX-SnippetEnd

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnableGatewayAllTools {
    id: Uuid,
    organization_id: String,
    catalog_id: Uuid,
    exempt_names: Vec<String>,
}

pub async fn enable_gateway_all_tools(
    connection: &mut AsyncPgConnection,
    input: EnableGatewayAllTools,
) -> QueryResult<Option<String>> {
    apply_agent_patch(
        connection,
        AgentEdit {
            id: input.id,
            organization_id: input.organization_id,
            catalog_id: input.catalog_id,
            exempt_names: input.exempt_names,
            is_personal_gateway: false,
            patch: serde_json::Map::from_iter([("access_all_tools".into(), true.into())]),
        },
        EditTarget::Gateway {
            require_custom: true,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEdit {
    id: Uuid,
    organization_id: String,
    catalog_id: Uuid,
    exempt_names: Vec<String>,
    is_personal_gateway: bool,
    patch: serde_json::Map<String, serde_json::Value>,
}

pub async fn edit_gateway(
    connection: &mut AsyncPgConnection,
    edit: AgentEdit,
) -> QueryResult<Option<String>> {
    apply_agent_patch(
        connection,
        edit,
        EditTarget::Gateway {
            require_custom: false,
        },
    )
    .await
}

pub async fn edit_agent(
    connection: &mut AsyncPgConnection,
    edit: AgentEdit,
) -> QueryResult<Option<String>> {
    apply_agent_patch(connection, edit, EditTarget::Agent).await
}

enum EditTarget {
    Agent,
    Gateway { require_custom: bool },
}

async fn apply_agent_patch(
    connection: &mut AsyncPgConnection,
    edit: AgentEdit,
    target: EditTarget,
) -> QueryResult<Option<String>> {
    let (agent_type, require_custom) = match target {
        EditTarget::Agent => ("agent", false),
        EditTarget::Gateway { require_custom } => ("mcp_gateway", require_custom),
    };
    sql_query(include_str!("mcp_agent_edit.sql"))
        .bind::<SqlUuid, _>(edit.id)
        .bind::<Text, _>(edit.organization_id)
        .bind::<SqlUuid, _>(edit.catalog_id)
        .bind::<Array<Text>, _>(edit.exempt_names)
        .bind::<Bool, _>(edit.is_personal_gateway)
        .bind::<Jsonb, _>(serde_json::Value::Object(edit.patch))
        .bind::<Bool, _>(require_custom)
        .bind::<Text, _>(agent_type)
        .get_result::<Created>(connection)
        .await
        .optional()
        .map(|row| row.map(|row| row.agent))
}

pub async fn create_gateway(
    connection: &mut AsyncPgConnection,
    write: GatewayWrite,
) -> QueryResult<Option<String>> {
    connection
        .transaction(async move |tx| {
            let Some(row) = insert_gateway(tx, &write).await? else {
                return Ok(None);
            };
            insert_gateway_assignments(
                tx,
                row.id,
                &write.organization_id,
                GatewayAssignments {
                    labels: write.labels,
                    knowledge_base_ids: write.knowledge_base_ids,
                    connector_ids: write.connector_ids,
                    default_tool_ids: write.default_tool_ids,
                },
            )
            .await?;
            Ok(Some(row.agent))
        })
        .await
}

async fn insert_gateway(
    connection: &mut AsyncPgConnection,
    write: &GatewayWrite,
) -> QueryResult<Option<Created>> {
    let grants = serde_json::json!(write.grants);
    for slug in &write.slugs {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        let row = sql_query(
            "WITH gateway AS (
                 INSERT INTO agents (organization_id, author_id, slug, name, agent_type,
                     environment_id, tool_exposure_mode, access_all_subagents, subagent_load_balancing)
                 VALUES ($1, $2, $3, $4, 'mcp_gateway', $5,
                     coalesce($6, 'search_and_run_only'), coalesce($7, false), $8)
                 ON CONFLICT (slug) WHERE slug IS NOT NULL AND deleted_at IS NULL DO NOTHING
                 RETURNING *
             ), policy AS (
                 INSERT INTO resource_permission_policies
                     (organization_id, resource, scope, grants, legacy_sharing_migrated)
                 SELECT organization_id, 'mcpGateway', id::text, $9, true FROM gateway
                 RETURNING scope
             )
             SELECT gateway.id, row_to_json(gateway)::text AS agent FROM gateway JOIN policy
                 ON policy.scope = gateway.id::text",
        )
        .bind::<Text, _>(&write.organization_id)
        .bind::<Text, _>(&write.author_id)
        .bind::<Text, _>(slug)
        .bind::<Text, _>(&write.name)
        .bind::<Nullable<SqlUuid>, _>(write.environment_id)
        .bind::<Nullable<Text>, _>(&write.tool_exposure_mode)
        .bind::<Nullable<Bool>, _>(write.access_all_subagents)
        .bind::<Nullable<Jsonb>, _>(&write.subagent_load_balancing)
        .bind::<Jsonb, _>(&grants)
        .get_result::<Created>(connection)
        .await
        .optional()?;
        // SPDX-SnippetEnd
        if let Some(row) = row {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

#[derive(Default)]
struct GatewayAssignments {
    labels: BTreeMap<String, String>,
    knowledge_base_ids: BTreeSet<Uuid>,
    connector_ids: BTreeSet<Uuid>,
    default_tool_ids: BTreeSet<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayAssignmentEdit {
    id: Uuid,
    organization_id: String,
    labels: Option<BTreeMap<String, String>>,
    knowledge_base_ids: Option<BTreeSet<Uuid>>,
    connector_ids: Option<BTreeSet<Uuid>>,
}

pub async fn replace_gateway_assignments(
    connection: &mut AsyncPgConnection,
    edit: GatewayAssignmentEdit,
) -> QueryResult<bool> {
    connection
        .transaction(async move |tx| {
            #[derive(QueryableByName)]
            struct Target {
                #[diesel(sql_type = SqlUuid)]
                id: Uuid,
            }
            let target = sql_query(
                "SELECT id FROM agents WHERE id = $1 AND organization_id = $2
             AND agent_type = 'mcp_gateway' AND deleted_at IS NULL FOR UPDATE",
            )
            .bind::<SqlUuid, _>(edit.id)
            .bind::<Text, _>(&edit.organization_id)
            .get_result::<Target>(tx)
            .await
            .optional()?;
            let Some(Target { id }) = target else {
                return Ok(false);
            };
            sql_query(
                "WITH labels AS (DELETE FROM agent_labels WHERE agent_id = $1 AND $2),
                  bases AS (DELETE FROM agent_knowledge_base WHERE agent_id = $1 AND $3)
             DELETE FROM agent_connector_assignment WHERE agent_id = $1 AND $4",
            )
            .bind::<SqlUuid, _>(id)
            .bind::<Bool, _>(edit.labels.is_some())
            .bind::<Bool, _>(edit.knowledge_base_ids.is_some())
            .bind::<Bool, _>(edit.connector_ids.is_some())
            .execute(tx)
            .await?;
            insert_gateway_assignments(
                tx,
                id,
                &edit.organization_id,
                GatewayAssignments {
                    labels: edit.labels.unwrap_or_default(),
                    knowledge_base_ids: edit.knowledge_base_ids.unwrap_or_default(),
                    connector_ids: edit.connector_ids.unwrap_or_default(),
                    ..GatewayAssignments::default()
                },
            )
            .await?;
            Ok(true)
        })
        .await
}

async fn insert_gateway_assignments(
    tx: &mut AsyncPgConnection,
    id: Uuid,
    organization_id: &str,
    write: GatewayAssignments,
) -> QueryResult<()> {
    #[derive(QueryableByName)]
    struct Count {
        #[diesel(sql_type = BigInt)]
        added: i64,
    }
    let labels = serde_json::json!(write.labels);
    if !write.labels.is_empty() {
        crate::labels::ensure_vocabulary(tx, &labels).await?;
    }
    let expected = write.labels.len()
        + write.knowledge_base_ids.len()
        + write.connector_ids.len()
        + write.default_tool_ids.len();
    if expected == 0 {
        return Ok(());
    }
    let count = sql_query(include_str!("mcp_gateway_assignments.sql"))
        .bind::<SqlUuid, _>(id)
        .bind::<Text, _>(organization_id)
        .bind::<Jsonb, _>(labels)
        .bind::<Array<SqlUuid>, _>(write.knowledge_base_ids.iter().copied().collect::<Vec<_>>())
        .bind::<Array<SqlUuid>, _>(write.connector_ids.iter().copied().collect::<Vec<_>>())
        .bind::<Array<SqlUuid>, _>(write.default_tool_ids.iter().copied().collect::<Vec<_>>())
        .get_result::<Count>(tx)
        .await?;
    if usize::try_from(count.added) != Ok(expected) {
        return Err(diesel::result::Error::NotFound);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    id: Uuid,
    organization_id: String,
    author_id: Option<String>,
    agent_type: DetailType,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum DetailType {
    Agent,
    McpGateway,
}

impl DetailType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::McpGateway => "mcp_gateway",
        }
    }
}

#[derive(QueryableByName, Serialize)]
pub struct Detail {
    #[diesel(sql_type = Text)]
    agent: String,
    #[diesel(sql_type = Array<Text>)]
    tools: Vec<String>,
}

pub async fn read(connection: &mut AsyncPgConnection, scope: Scope) -> QueryResult<Option<Detail>> {
    sql_query(
        "SELECT row_to_json(a)::text AS agent,
            ARRAY(SELECT row_to_json(t)::text FROM agent_tools at
                  JOIN tools t ON t.id = at.tool_id WHERE at.agent_id = a.id) AS tools
         FROM agents a WHERE a.id = $1 AND a.organization_id = $2
           AND a.author_id IS NOT DISTINCT FROM $3::text
           AND a.agent_type = $4 AND a.deleted_at IS NULL",
    )
    .bind::<SqlUuid, _>(scope.id)
    .bind::<Text, _>(scope.organization_id)
    .bind::<Nullable<Text>, _>(scope.author_id)
    .bind::<Text, _>(scope.agent_type.as_str())
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NameScope {
    organization_id: String,
    agent_type: DetailType,
    pattern: String,
    candidate_ids: Vec<Uuid>,
    personal_ids: Vec<Uuid>,
}

pub async fn find_name(
    connection: &mut AsyncPgConnection,
    scope: NameScope,
) -> QueryResult<Option<String>> {
    #[derive(QueryableByName)]
    struct Id {
        #[diesel(sql_type = Text)]
        id: String,
    }
    sql_query(
        "SELECT id::text FROM agents
         WHERE organization_id = $1 AND agent_type = $5 AND deleted_at IS NULL
           AND name ILIKE $2 AND id = ANY($3)
         ORDER BY (id = ANY($4)) DESC, created_at DESC, agents.id DESC LIMIT 1",
    )
    .bind::<Text, _>(scope.organization_id)
    .bind::<Text, _>(scope.pattern)
    .bind::<Array<SqlUuid>, _>(scope.candidate_ids)
    .bind::<Array<SqlUuid>, _>(scope.personal_ids)
    .bind::<Text, _>(scope.agent_type.as_str())
    .get_result::<Id>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.id))
}
