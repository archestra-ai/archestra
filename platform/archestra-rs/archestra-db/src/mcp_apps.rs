// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use std::collections::BTreeMap;

use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, Bool, Integer, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scaffold {
    organization_id: String,
    author_id: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    name: String,
    slug: String,
    description: Option<String>,
    template_id: String,
    enabled: bool,
    locked: bool,
    creation_grace_session_key: Option<String>,
    authoring_session_id: Option<String>,
    grants: Vec<serde_json::Value>,
    html: String,
    ui_permissions: Option<serde_json::Value>,
    content_hash: String,
}

#[derive(QueryableByName, Serialize)]
pub struct Scaffolded {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    description: Option<String>,
}

pub async fn scaffold(
    connection: &mut AsyncPgConnection,
    input: Scaffold,
) -> QueryResult<Scaffolded> {
    connection.transaction(async |tx| {
        sql_query(
            "WITH app AS (
                 INSERT INTO apps (organization_id, author_id, created_by_service_account_id, name,
                     slug, description, template_id, enabled, locked, lock_grace_session_key,
                     authoring_session_id, latest_version)
                 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1
                 WHERE $3 IS NULL OR EXISTS (
                     SELECT 1 FROM service_accounts WHERE id = $3 AND organization_id = $1 FOR SHARE
                 )
                 RETURNING id, organization_id, name, description, spec
             ), policy AS (
                 INSERT INTO resource_permission_policies
                     (organization_id, resource, scope, grants, legacy_sharing_migrated)
                 SELECT organization_id, 'app', id::text, $12, true FROM app
                 RETURNING scope
             ), version AS (
                 INSERT INTO app_versions (app_id, version, html, ui_permissions, content_hash, spec)
                 SELECT app.id, 1, $13, $14, $15, app.spec FROM app
                 JOIN policy ON policy.scope = app.id::text
                 RETURNING app_id
             )
             SELECT app.id::text, app.name, app.description FROM app JOIN version ON version.app_id = app.id",
        )
        .bind::<Text, _>(input.organization_id)
        .bind::<Nullable<Text>, _>(input.author_id)
        .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
        .bind::<Text, _>(input.name)
        .bind::<Text, _>(input.slug)
        .bind::<Nullable<Text>, _>(input.description)
        .bind::<Text, _>(input.template_id)
        .bind::<Bool, _>(input.enabled)
        .bind::<Bool, _>(input.locked)
        .bind::<Nullable<Text>, _>(input.creation_grace_session_key)
        .bind::<Nullable<Text>, _>(input.authoring_session_id)
        .bind::<Jsonb, _>(serde_json::Value::Array(input.grants))
        .bind::<Text, _>(input.html)
        .bind::<Nullable<Jsonb>, _>(input.ui_permissions)
        .bind::<Text, _>(input.content_hash)
        .get_result(tx).await
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishApp {
    app_id: Uuid,
    organization_id: String,
    revision: i32,
    grants: Vec<serde_json::Value>,
}

pub async fn publish_app(
    connection: &mut AsyncPgConnection,
    input: PublishApp,
) -> QueryResult<Option<i32>> {
    #[derive(QueryableByName)]
    struct Revision {
        #[diesel(sql_type = Integer)]
        revision: i32,
    }

    sql_query(
        "WITH app AS MATERIALIZED (
             SELECT id, organization_id FROM apps
             WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND enabled
             FOR UPDATE
         ), created AS (
             INSERT INTO resource_permission_policies (organization_id, resource, scope, grants)
             SELECT organization_id, 'app', id::text, $4 FROM app WHERE $3 = 0
             ON CONFLICT DO NOTHING
             RETURNING revision
         ), updated AS (
             UPDATE resource_permission_policies p
             SET grants = $4, legacy_organization_audience = false, revision = p.revision + 1,
                 updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
             FROM app
             WHERE p.organization_id = app.organization_id AND p.resource = 'app'
               AND p.scope = app.id::text AND $3 > 0 AND p.revision = $3
             RETURNING p.revision
         )
         SELECT revision FROM created UNION ALL SELECT revision FROM updated",
    )
    .bind::<SqlUuid, _>(input.app_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Integer, _>(input.revision)
    .bind::<Jsonb, _>(serde_json::Value::Array(input.grants))
    .get_result::<Revision>(connection)
    .await
    .optional()
    .map(|result| result.map(|row| row.revision))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefineApp {
    id: Uuid,
    organization_id: String,
    session_key: Option<String>,
    spec: serde_json::Map<String, serde_json::Value>,
}

pub async fn refine_app(connection: &mut AsyncPgConnection, input: RefineApp) -> QueryResult<bool> {
    sql_query(
        "UPDATE apps SET spec = $4,
            updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           AND ((enabled AND NOT locked) OR lock_grace_session_key = $3)
         RETURNING id",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<Text>, _>(input.session_key)
    .bind::<Jsonb, _>(serde_json::Value::Object(input.spec))
    .get_result::<ScopedId>(connection)
    .await
    .optional()
    .map(|row| row.is_some())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditApp {
    id: Uuid,
    organization_id: String,
    session_key: Option<String>,
    expected_latest_version: i64,
    html: String,
    ui_permissions: Option<serde_json::Value>,
    content_hash: String,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditOutcome {
    NotFound,
    Conflict { latest_version: i32 },
    Applied,
}

pub async fn edit_app(
    connection: &mut AsyncPgConnection,
    input: EditApp,
) -> QueryResult<EditOutcome> {
    #[derive(QueryableByName)]
    struct Head {
        #[diesel(sql_type = Integer)]
        latest_version: i32,
    }
    connection
        .transaction(async |tx| {
            let app = sql_query(
                "SELECT latest_version FROM apps
            WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
              AND ((enabled AND NOT locked) OR lock_grace_session_key = $3)
            FOR UPDATE",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Text, _>(&input.organization_id)
            .bind::<Nullable<Text>, _>(&input.session_key)
            .get_result::<Head>(tx)
            .await
            .optional()?;
            let Some(Head { latest_version }) = app else {
                return Ok(EditOutcome::NotFound);
            };
            if i64::from(latest_version) != input.expected_latest_version {
                return Ok(EditOutcome::Conflict { latest_version });
            }
            #[derive(QueryableByName)]
            struct Hash {
                #[diesel(sql_type = Text)]
                content_hash: String,
            }
            let head = sql_query(
                "SELECT content_hash FROM app_versions WHERE app_id = $1 AND version = $2",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Integer, _>(latest_version)
            .get_result::<Hash>(tx)
            .await
            .optional()?;
            if head.is_some_and(|head| head.content_hash == input.content_hash) {
                return Ok(EditOutcome::Applied);
            }

            sql_query(
                "WITH version AS (
                INSERT INTO app_versions (app_id, version, html, ui_permissions, content_hash, spec)
                SELECT id, latest_version + 1, $2, $3, $4, spec FROM apps WHERE id = $1
                RETURNING app_id, version
            )
            UPDATE apps SET latest_version = version.version,
                updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
            FROM version WHERE apps.id = version.app_id
            RETURNING apps.latest_version",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Text, _>(input.html)
            .bind::<Nullable<Jsonb>, _>(input.ui_permissions)
            .bind::<Text, _>(input.content_hash)
            .get_result::<Head>(tx)
            .await?;
            Ok(EditOutcome::Applied)
        })
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteApp {
    id: Uuid,
    organization_id: String,
    session_key: Option<String>,
}

pub async fn delete_app(connection: &mut AsyncPgConnection, input: DeleteApp) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Outcome {
        #[diesel(sql_type = Bool)]
        deleted: bool,
    }
    sql_query(
        "WITH stamp AS (
             SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS at
         ), app AS (
             UPDATE apps SET deleted_at = stamp.at, updated_at = stamp.at FROM stamp
             WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
               AND ((enabled AND NOT locked) OR lock_grace_session_key = $3)
             RETURNING id, organization_id
         ), policy AS (
             DELETE FROM resource_permission_policies p USING app
             WHERE p.organization_id = app.organization_id AND p.resource = 'app'
               AND p.scope = app.id::text
         )
         SELECT EXISTS (SELECT 1 FROM app) AS deleted",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<Text>, _>(input.session_key)
    .get_result::<Outcome>(connection)
    .await
    .map(|row| row.deleted)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceTools {
    id: Uuid,
    organization_id: String,
    session_key: Option<String>,
    environment_id: Option<Uuid>,
    tool_ids: Vec<Uuid>,
    archestra_catalog_id: Uuid,
    playwright_catalog_id: Uuid,
}

#[derive(QueryableByName)]
struct ScopedId {
    #[diesel(sql_type = SqlUuid, column_name = id)]
    _id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceLabels {
    id: Uuid,
    organization_id: String,
    session_key: Option<String>,
    labels: BTreeMap<String, String>,
}

pub async fn replace_labels(
    connection: &mut AsyncPgConnection,
    input: ReplaceLabels,
) -> QueryResult<bool> {
    connection
        .transaction(async |tx| {
            let app = sql_query(
                "SELECT id FROM apps
            WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
              AND ((enabled AND NOT locked) OR lock_grace_session_key = $3)
            FOR UPDATE",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Text, _>(&input.organization_id)
            .bind::<Nullable<Text>, _>(&input.session_key)
            .get_result::<ScopedId>(tx)
            .await
            .optional()?;
            if app.is_none() {
                return Ok(false);
            }
            sql_query("DELETE FROM app_labels WHERE app_id = $1")
                .bind::<SqlUuid, _>(input.id)
                .execute(tx)
                .await?;
            if input.labels.is_empty() {
                return Ok(true);
            }
            let expected = input.labels.len();
            let labels = serde_json::json!(input.labels);
            crate::labels::ensure_vocabulary(tx, &labels).await?;
            let written = sql_query(
                "INSERT INTO app_labels (app_id, key_id, value_id)
            SELECT $1, k.id, v.id FROM jsonb_each_text($2) l
            JOIN label_keys k ON k.key = l.key JOIN label_values v ON v.value = l.value",
            )
            .bind::<SqlUuid, _>(input.id)
            .bind::<Jsonb, _>(&labels)
            .execute(tx)
            .await?;
            if written != expected {
                return Err(diesel::result::Error::NotFound);
            }
            Ok(true)
        })
        .await
}

pub async fn replace_tools(
    connection: &mut AsyncPgConnection,
    input: ReplaceTools,
) -> QueryResult<bool> {
    connection.transaction(async |tx| {
        let app = sql_query("SELECT a.id FROM apps a JOIN mcp_server s ON s.id = a.mcp_server_id
            JOIN internal_mcp_catalog c ON c.id = s.catalog_id
            WHERE a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL
              AND s.deleted_at IS NULL AND c.deleted_at IS NULL AND c.environment_id IS NOT DISTINCT FROM $4
              AND ((a.enabled AND NOT a.locked) OR a.lock_grace_session_key = $3)
            FOR UPDATE OF a FOR SHARE OF s, c")
            .bind::<SqlUuid, _>(input.id).bind::<Text, _>(&input.organization_id)
            .bind::<Nullable<Text>, _>(&input.session_key)
            .bind::<Nullable<SqlUuid>, _>(input.environment_id)
            .get_result::<ScopedId>(tx).await.optional()?;
        if app.is_none() {
            return Ok(false);
        }
        let available = sql_query("SELECT t.id FROM tools t
            JOIN internal_mcp_catalog c ON c.id = t.catalog_id
            WHERE t.id = ANY($1) AND c.id <> $4 AND NOT t.cloned_pending_discovery
              AND t.deleted_at IS NULL AND c.deleted_at IS NULL
              AND (c.organization_id = $2 OR c.organization_id IS NULL)
              AND (c.environment_id IS NULL OR c.environment_id = $3 OR c.id = $5
                  OR t.delegate_to_agent_id IS NOT NULL)
            ORDER BY t.id FOR SHARE OF t, c")
            .bind::<Array<SqlUuid>, _>(&input.tool_ids).bind::<Text, _>(&input.organization_id)
            .bind::<Nullable<SqlUuid>, _>(input.environment_id)
            .bind::<SqlUuid, _>(input.archestra_catalog_id)
            .bind::<SqlUuid, _>(input.playwright_catalog_id)
            .load::<ScopedId>(tx).await?;
        if available.len() != input.tool_ids.len() {
            return Ok(false);
        }
        sql_query("DELETE FROM app_tools WHERE app_id = $1 AND NOT (tool_id = ANY($2))")
            .bind::<SqlUuid, _>(input.id).bind::<Array<SqlUuid>, _>(&input.tool_ids)
            .execute(tx).await?;
        if !input.tool_ids.is_empty() {
            sql_query("INSERT INTO app_tools (app_id, tool_id, credential_resolution_mode)
                SELECT $1, id, 'dynamic' FROM unnest($2::uuid[]) AS tool(id)
                ON CONFLICT (app_id, tool_id) DO UPDATE SET
                    mcp_server_id = NULL, credential_resolution_mode = 'dynamic', updated_at = now()")
                .bind::<SqlUuid, _>(input.id).bind::<Array<SqlUuid>, _>(&input.tool_ids)
                .execute(tx).await?;
        }
        Ok(true)
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetLock {
    id: Uuid,
    organization_id: String,
    locked: bool,
    session_key: Option<String>,
}

#[derive(QueryableByName, Serialize)]
pub struct LockState {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Bool)]
    locked: bool,
}

pub async fn set_lock(
    connection: &mut AsyncPgConnection,
    input: SetLock,
) -> QueryResult<Option<LockState>> {
    sql_query(
        "UPDATE apps SET locked = $3,
             lock_grace_session_key = CASE WHEN $3 OR enabled THEN NULL ELSE lock_grace_session_key END,
             updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           AND (enabled OR lock_grace_session_key = $4)
         RETURNING id::text, name, locked",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Bool, _>(input.locked)
    .bind::<Nullable<Text>, _>(input.session_key)
    .get_result(connection)
    .await
    .optional()
}
