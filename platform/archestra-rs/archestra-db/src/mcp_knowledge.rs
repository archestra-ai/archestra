// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, Bool, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteKnowledgeBase {
    id: Uuid,
    organization_id: String,
}

pub async fn delete(
    connection: &mut AsyncPgConnection,
    input: DeleteKnowledgeBase,
) -> QueryResult<bool> {
    sql_query(
        "UPDATE knowledge_bases
         SET deleted_at = stamp.deleted_at, updated_at = stamp.deleted_at
         FROM (SELECT date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC') AS deleted_at) stamp
         WHERE id = $1 AND organization_id = $2 AND knowledge_bases.deleted_at IS NULL",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .execute(connection)
    .await
    .map(|count| count != 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteConnector {
    id: Uuid,
    organization_id: String,
    environment_id: Option<Uuid>,
}

pub async fn delete_connector(
    connection: &mut AsyncPgConnection,
    input: DeleteConnector,
) -> QueryResult<bool> {
    sql_query(
        "UPDATE knowledge_base_connectors c
         SET deleted_at = stamp.at, updated_at = stamp.at
         FROM (SELECT date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC') AS at) stamp
         WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL
           AND c.environment_id IS NOT DISTINCT FROM $3",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .execute(connection)
    .await
    .map(|count| count != 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorAssignment {
    organization_id: String,
    connector_id: Uuid,
    knowledge_base_id: Uuid,
}

const LIVE_CONNECTOR_PAIR: &str = "SELECT c.id AS connector_id, k.id AS knowledge_base_id
    FROM knowledge_base_connectors c
    JOIN knowledge_bases k ON k.organization_id = c.organization_id
    WHERE c.organization_id = $1 AND c.id = $2 AND k.id = $3
      AND c.deleted_at IS NULL AND k.deleted_at IS NULL
    FOR SHARE OF c, k";

pub async fn assign_connector(
    connection: &mut AsyncPgConnection,
    input: ConnectorAssignment,
) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Eligible {
        #[diesel(sql_type = Bool)]
        eligible: bool,
    }
    sql_query(format!(
        "WITH eligible AS ({LIVE_CONNECTOR_PAIR}), inserted AS (
             INSERT INTO knowledge_base_connector_assignment (connector_id, knowledge_base_id)
             SELECT connector_id, knowledge_base_id FROM eligible
             ON CONFLICT DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM eligible) AS eligible"
    ))
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.connector_id)
    .bind::<SqlUuid, _>(input.knowledge_base_id)
    .get_result::<Eligible>(connection)
    .await
    .map(|row| row.eligible)
}

pub async fn unassign_connector(
    connection: &mut AsyncPgConnection,
    input: ConnectorAssignment,
) -> QueryResult<bool> {
    sql_query(format!(
        "WITH eligible AS ({LIVE_CONNECTOR_PAIR})
         DELETE FROM knowledge_base_connector_assignment a USING eligible e
         WHERE a.connector_id = e.connector_id AND a.knowledge_base_id = e.knowledge_base_id"
    ))
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.connector_id)
    .bind::<SqlUuid, _>(input.knowledge_base_id)
    .execute(connection)
    .await
    .map(|count| count != 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentKnowledgeBaseAssignment {
    organization_id: String,
    agent_id: Uuid,
    knowledge_base_id: Uuid,
}

const LIVE_AGENT_KB_PAIR: &str = "SELECT a.id AS agent_id, k.id AS knowledge_base_id
    FROM agents a JOIN knowledge_bases k ON k.organization_id = a.organization_id
    WHERE a.organization_id = $1 AND a.id = $2 AND k.id = $3
      AND a.deleted_at IS NULL AND k.deleted_at IS NULL
    FOR SHARE OF a, k";

pub async fn assign_knowledge_base_to_agent(
    connection: &mut AsyncPgConnection,
    input: AgentKnowledgeBaseAssignment,
) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Eligible {
        #[diesel(sql_type = Bool)]
        eligible: bool,
    }
    sql_query(format!(
        "WITH eligible AS ({LIVE_AGENT_KB_PAIR}), inserted AS (
             INSERT INTO agent_knowledge_base (agent_id, knowledge_base_id)
             SELECT agent_id, knowledge_base_id FROM eligible
             ON CONFLICT DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM eligible) AS eligible"
    ))
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<SqlUuid, _>(input.knowledge_base_id)
    .get_result::<Eligible>(connection)
    .await
    .map(|row| row.eligible)
}

// None means a parent is no longer eligible; Some(false) means the link was already removed.
pub async fn unassign_knowledge_base_from_agent(
    connection: &mut AsyncPgConnection,
    input: AgentKnowledgeBaseAssignment,
) -> QueryResult<Option<bool>> {
    #[derive(QueryableByName)]
    struct Removal {
        #[diesel(sql_type = Bool)]
        removed: bool,
    }
    sql_query(format!(
        "WITH eligible AS ({LIVE_AGENT_KB_PAIR}), removed AS (
             DELETE FROM agent_knowledge_base link USING eligible e
             WHERE link.agent_id = e.agent_id AND link.knowledge_base_id = e.knowledge_base_id
             RETURNING 1
         )
         SELECT EXISTS (SELECT 1 FROM removed) AS removed FROM eligible"
    ))
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<SqlUuid, _>(input.knowledge_base_id)
    .get_result::<Removal>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.removed))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConnectorAssignment {
    organization_id: String,
    agent_id: Uuid,
    connector_id: Uuid,
    environment_id: Option<Uuid>,
}

pub async fn assign_connector_to_agent(
    connection: &mut AsyncPgConnection,
    input: AgentConnectorAssignment,
) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Eligible {
        #[diesel(sql_type = Bool)]
        eligible: bool,
    }
    sql_query(
        "WITH eligible AS (
             SELECT a.id AS agent_id, c.id AS connector_id
             FROM agents a
             JOIN knowledge_base_connectors c ON c.organization_id = a.organization_id
             WHERE a.organization_id = $1 AND a.id = $2 AND c.id = $3
               AND a.deleted_at IS NULL AND c.deleted_at IS NULL
               AND a.environment_id IS NOT DISTINCT FROM $4
               AND c.environment_id IS NOT DISTINCT FROM $4
             FOR SHARE OF a, c
         ), inserted AS (
             INSERT INTO agent_connector_assignment (agent_id, connector_id)
             SELECT agent_id, connector_id FROM eligible
             ON CONFLICT DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM eligible) AS eligible",
    )
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<SqlUuid, _>(input.connector_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .get_result::<Eligible>(connection)
    .await
    .map(|row| row.eligible)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConnectorRemoval {
    organization_id: String,
    agent_id: Uuid,
    connector_id: Uuid,
}

pub async fn unassign_connector_from_agent(
    connection: &mut AsyncPgConnection,
    input: AgentConnectorRemoval,
) -> QueryResult<Option<bool>> {
    #[derive(QueryableByName)]
    struct Removal {
        #[diesel(sql_type = Bool)]
        removed: bool,
    }
    // Unlike assignment, removal must also clean up links across environments.
    sql_query(
        "WITH eligible AS (
             SELECT a.id AS agent_id, c.id AS connector_id
             FROM agents a JOIN knowledge_base_connectors c ON c.organization_id = a.organization_id
             WHERE a.organization_id = $1 AND a.id = $2 AND c.id = $3
               AND a.deleted_at IS NULL AND c.deleted_at IS NULL
             FOR SHARE OF a, c
         ), removed AS (
             DELETE FROM agent_connector_assignment link USING eligible e
             WHERE link.agent_id = e.agent_id AND link.connector_id = e.connector_id
             RETURNING 1
         )
         SELECT EXISTS (SELECT 1 FROM removed) AS removed FROM eligible",
    )
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<SqlUuid, _>(input.connector_id)
    .get_result::<Removal>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.removed))
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    organization_id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    description: Option<String>,
    #[diesel(sql_type = Text)]
    visibility: String,
    #[diesel(sql_type = Jsonb)]
    team_ids: Value,
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = Nullable<Text>)]
    created_by: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    created_by_service_account_id: Option<String>,
    #[diesel(sql_type = Text)]
    created_at: String,
    #[diesel(sql_type = Text)]
    updated_at: String,
    #[diesel(sql_type = Nullable<Text>)]
    deleted_at: Option<String>,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    #[diesel(embed)]
    base: KnowledgeBase,
    #[diesel(sql_type = Bool)]
    has_upload_connector: bool,
    #[diesel(sql_type = Nullable<Text>)]
    uploaded_files_environment_id: Option<String>,
}

const BASE_COLUMNS: &str = "k.id::text, k.organization_id, k.name, k.description,
    k.visibility, k.team_ids, k.status, k.created_by, k.created_by_service_account_id::text,
    to_char(k.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
    to_char(k.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at,
    NULL::text AS deleted_at";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateKnowledgeBase {
    organization_id: String,
    name: String,
    description: Option<String>,
    created_by: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    grants: Vec<Value>,
}

pub async fn create(
    connection: &mut AsyncPgConnection,
    input: CreateKnowledgeBase,
) -> QueryResult<KnowledgeBase> {
    connection.transaction(async |tx| {
        sql_query(format!(
            "WITH k AS (
                 INSERT INTO knowledge_bases
                     (organization_id, name, description, created_by, created_by_service_account_id)
                 SELECT $1, $2, $3, $4, $5
                 WHERE $5 IS NULL OR EXISTS (
                     SELECT 1 FROM service_accounts WHERE id = $5 AND organization_id = $1
                 )
                 RETURNING *
             ), policy AS (
                 INSERT INTO resource_permission_policies
                     (organization_id, resource, scope, grants, legacy_sharing_migrated, legacy_organization_audience)
                 SELECT organization_id, 'knowledgeBase', id::text, $6, true, false FROM k
                 RETURNING scope
             )
             SELECT {BASE_COLUMNS} FROM k JOIN policy ON policy.scope = k.id::text"
        ))
        .bind::<Text, _>(input.organization_id)
        .bind::<Text, _>(input.name)
        .bind::<Nullable<Text>, _>(input.description)
        .bind::<Nullable<Text>, _>(input.created_by)
        .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
        .bind::<Jsonb, _>(Value::Array(input.grants))
        .get_result(tx)
        .await
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateKnowledgeBase {
    id: Uuid,
    organization_id: String,
    name: Option<String>,
    description: Option<NullableChange<String>>,
    uploaded_files_environment: Option<NullableChange<Uuid>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NullableChange<T> {
    value: Option<T>,
}

pub async fn update(
    connection: &mut AsyncPgConnection,
    input: UpdateKnowledgeBase,
) -> QueryResult<Option<KnowledgeBase>> {
    connection.transaction(async |tx| {
        let updating_connector = input.uploaded_files_environment.is_some();
        if let Some(change) = input.uploaded_files_environment {
            #[derive(QueryableByName)]
            struct LockedBase {
                #[diesel(sql_type = SqlUuid)]
                id: Uuid,
            }
            let locked = sql_query(
                "SELECT id FROM knowledge_bases
                 WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Text, _>(&input.organization_id)
            .get_result::<LockedBase>(tx)
            .await
            .optional()?;
            let Some(locked) = locked else { return Ok(None) };
            let changed = sql_query(
                "UPDATE knowledge_base_connectors c SET environment_id = $3,
                    updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
                 FROM kb_upload_connector l
                 WHERE l.knowledge_base_id = $1 AND l.connector_id = c.id
                   AND c.organization_id = $2 AND c.connector_type = 'file_upload' AND c.deleted_at IS NULL
                   AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM environments WHERE id = $3 AND organization_id = $2
                   ))",
            )
            .bind::<SqlUuid, _>(locked.id)
            .bind::<Text, _>(&input.organization_id)
            .bind::<Nullable<SqlUuid>, _>(change.value)
            .execute(tx)
            .await?;
            if changed == 0 {
                return Ok(None);
            }
        }

        let result = sql_query(format!(
            "UPDATE knowledge_bases k SET name = coalesce($3, k.name),
                description = CASE WHEN $4 THEN $5 ELSE k.description END,
                updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
             WHERE k.id = $1 AND k.organization_id = $2 AND k.deleted_at IS NULL
             RETURNING {BASE_COLUMNS}"
        ))
        .bind::<SqlUuid, _>(input.id)
        .bind::<Text, _>(input.organization_id)
        .bind::<Nullable<Text>, _>(input.name)
        .bind::<Bool, _>(input.description.is_some())
        .bind::<Nullable<Text>, _>(input.description.and_then(|change| change.value))
        .get_result(tx)
        .await;
        if updating_connector {
            result.map(Some)
        } else {
            result.optional()
        }
    }).await
}

pub async fn read(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    id: &str,
) -> QueryResult<Option<Details>> {
    sql_query(format!(
        "SELECT {BASE_COLUMNS}, c.id IS NOT NULL AS has_upload_connector,
            c.environment_id::text AS uploaded_files_environment_id
         FROM knowledge_bases k
         LEFT JOIN kb_upload_connector l ON l.knowledge_base_id = k.id
         LEFT JOIN knowledge_base_connectors c ON c.id = l.connector_id AND c.deleted_at IS NULL
         WHERE k.organization_id = $1 AND k.id = $2::uuid AND k.deleted_at IS NULL"
    ))
    .bind::<Text, _>(organization_id)
    .bind::<Text, _>(id)
    .get_result(connection)
    .await
    .optional()
}

pub async fn list(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    ids: Vec<String>,
) -> QueryResult<Vec<KnowledgeBase>> {
    sql_query(format!(
        "SELECT {BASE_COLUMNS} FROM knowledge_bases k
         WHERE k.organization_id = $1 AND k.id = ANY($2::text[]::uuid[]) AND k.deleted_at IS NULL
         ORDER BY k.created_at DESC, k.id DESC"
    ))
    .bind::<Text, _>(organization_id)
    .bind::<Array<Text>, _>(ids)
    .load(connection)
    .await
}

#[derive(QueryableByName)]
struct ConnectorRow {
    #[diesel(sql_type = Text)]
    data: String,
}

const CONNECTOR_JSON: &str = "jsonb_build_object(
            'id', c.id, 'organizationId', c.organization_id, 'name', c.name, 'description', c.description,
            'visibility', c.visibility, 'teamIds', c.team_ids, 'syncPermissionsFromSource', c.sync_permissions_from_source,
            'connectorType', c.connector_type, 'config', c.config, 'secretId', c.secret_id, 'environmentId', c.environment_id,
            'schedule', c.schedule, 'ftsLanguage', c.fts_language,
            'permissionSyncIntervalSeconds', c.permission_sync_interval_seconds, 'enabled', c.enabled,
            'lastSyncAt', to_char(c.last_sync_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
            'lastSyncStatus', c.last_sync_status, 'lastSyncError', c.last_sync_error,
            'lastPermissionSyncAt', to_char(c.last_permission_sync_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
            'lastPermissionSyncStatus', c.last_permission_sync_status, 'checkpoint', c.checkpoint,
            'permissionSyncState', c.permission_sync_state, 'aclConfigEpoch', c.acl_config_epoch,
            'createdBy', c.created_by, 'createdByServiceAccountId', c.created_by_service_account_id,
            'createdAt', to_char(c.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
            'updatedAt', to_char(c.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'deletedAt', NULL
         )::text AS data";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateConnector {
    organization_id: String,
    agent_id: Uuid,
    environment_id: Option<Uuid>,
    name: String,
    description: Option<String>,
    connector_type: String,
    config: serde_json::Map<String, Value>,
    sync_permissions_from_source: bool,
    created_by: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    grants: Vec<Value>,
}

pub async fn create_connector(
    connection: &mut AsyncPgConnection,
    input: CreateConnector,
) -> QueryResult<String> {
    connection.transaction(async |tx| {
        sql_query(format!(
            "WITH c AS (
                 INSERT INTO knowledge_base_connectors
                     (organization_id, environment_id, name, description, connector_type, config,
                      sync_permissions_from_source, created_by, created_by_service_account_id)
                 SELECT a.organization_id, a.environment_id, $4, $5, $6, $7, $8, $9, $10
                 FROM agents a WHERE a.organization_id = $1 AND a.id = $2 AND a.deleted_at IS NULL
                   AND a.environment_id IS NOT DISTINCT FROM $3
                   AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM environments WHERE id = $3 AND organization_id = $1
                   ))
                   AND ($10 IS NULL OR EXISTS (
                       SELECT 1 FROM service_accounts WHERE id = $10 AND organization_id = $1
                   ))
                 RETURNING *
             ), policy AS (
                 INSERT INTO resource_permission_policies
                     (organization_id, resource, scope, grants, legacy_sharing_migrated, legacy_organization_audience)
                 SELECT organization_id, 'knowledgeConnector', id::text, $11, true, false FROM c
                 RETURNING scope
             )
             SELECT {CONNECTOR_JSON} FROM c JOIN policy ON policy.scope = c.id::text"
        ))
        .bind::<Text, _>(input.organization_id)
        .bind::<SqlUuid, _>(input.agent_id)
        .bind::<Nullable<SqlUuid>, _>(input.environment_id)
        .bind::<Text, _>(input.name)
        .bind::<Nullable<Text>, _>(input.description)
        .bind::<Text, _>(input.connector_type)
        .bind::<Jsonb, _>(Value::Object(input.config))
        .bind::<Bool, _>(input.sync_permissions_from_source)
        .bind::<Nullable<Text>, _>(input.created_by)
        .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
        .bind::<Jsonb, _>(Value::Array(input.grants))
        .get_result::<ConnectorRow>(tx)
        .await
        .map(|row| row.data)
    }).await
}

pub async fn connectors(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    ids: Vec<String>,
    environment_id: Option<&str>,
) -> QueryResult<Vec<String>> {
    let rows: Vec<ConnectorRow> = sql_query(format!(
        "SELECT {CONNECTOR_JSON} FROM knowledge_base_connectors c
         WHERE c.organization_id = $1 AND c.id = ANY($2::text[]::uuid[])
           AND c.deleted_at IS NULL AND c.environment_id IS NOT DISTINCT FROM $3::uuid
          ORDER BY c.created_at DESC, c.id DESC"
    ))
    .bind::<Text, _>(organization_id)
    .bind::<Array<Text>, _>(ids)
    .bind::<Nullable<Text>, _>(environment_id)
    .load(connection)
    .await?;
    Ok(rows.into_iter().map(|row| row.data).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateConnector {
    id: Uuid,
    organization_id: String,
    environment_id: Option<Uuid>,
    expected: ConnectorSettings,
    patch: ConnectorPatch,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorSettings {
    connector_type: String,
    config: serde_json::Map<String, Value>,
    visibility: String,
    team_ids: Vec<String>,
    enabled: bool,
    sync_permissions_from_source: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectorPatch {
    name: Option<String>,
    description: Option<NullableChange<String>>,
    config: Option<serde_json::Map<String, Value>>,
    visibility: Option<String>,
    team_ids: Option<Vec<String>>,
    enabled: Option<bool>,
    sync_permissions_from_source: Option<bool>,
    clear_checkpoint: bool,
}

pub async fn update_connector(
    connection: &mut AsyncPgConnection,
    input: UpdateConnector,
) -> QueryResult<Option<String>> {
    let patch = input.patch;
    sql_query(format!(
        "UPDATE knowledge_base_connectors c SET
             name = coalesce($5, c.name),
             description = CASE WHEN $6 THEN $7 ELSE c.description END,
             config = coalesce($8, c.config),
             visibility = coalesce($9, c.visibility),
             team_ids = coalesce($10, c.team_ids),
             enabled = coalesce($11, c.enabled),
             sync_permissions_from_source = coalesce($12, c.sync_permissions_from_source),
             checkpoint = CASE WHEN $13 THEN NULL ELSE c.checkpoint END,
             updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
         WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL
           AND c.environment_id IS NOT DISTINCT FROM $3
           AND jsonb_build_object('connectorType', c.connector_type, 'config', c.config,
               'visibility', c.visibility, 'teamIds', c.team_ids, 'enabled', c.enabled,
               'syncPermissionsFromSource', c.sync_permissions_from_source) = $4
         RETURNING {CONNECTOR_JSON}"
    ))
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Jsonb, _>(serde_json::json!(input.expected))
    .bind::<Nullable<Text>, _>(patch.name)
    .bind::<Bool, _>(patch.description.is_some())
    .bind::<Nullable<Text>, _>(patch.description.and_then(|change| change.value))
    .bind::<Nullable<Jsonb>, _>(patch.config.map(Value::Object))
    .bind::<Nullable<Text>, _>(patch.visibility)
    .bind::<Nullable<Jsonb>, _>(patch.team_ids.map(|ids| serde_json::json!(ids)))
    .bind::<Nullable<Bool>, _>(patch.enabled)
    .bind::<Nullable<Bool>, _>(patch.sync_permissions_from_source)
    .bind::<Bool, _>(patch.clear_checkpoint)
    .get_result::<ConnectorRow>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.data))
}
