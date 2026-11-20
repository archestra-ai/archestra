// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use std::collections::BTreeMap;

use diesel::{
    OptionalExtension, QueryableByName,
    result::{Error, QueryResult},
    sql_query,
    sql_types::{Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditDescription {
    id: Uuid,
    organization_id: Option<String>,
    environment_id: Option<Uuid>,
    fields: BTreeMap<Field, Option<String>>,
    labels: Option<Vec<Label>>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
enum Field {
    Icon,
    Description,
    DocsUrl,
    Repository,
    Version,
    Instructions,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Label {
    key: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Updated,
    NotFound,
    DuplicateLabel,
}

const SCOPED_ITEM: &str = "id = $1 AND organization_id IS NOT DISTINCT FROM $2
    AND environment_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deploy {
    id: Uuid,
    catalog_id: Uuid,
    organization_id: String,
    environment_id: Option<Uuid>,
    server_type: String,
    name: String,
    deployment_name: Option<String>,
    scope: InstallScope,
    team_id: Option<String>,
    owner_id: Option<String>,
    created_by_service_account_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum InstallScope {
    Personal,
    Team,
    Org,
}

pub async fn deploy(
    connection: &mut AsyncPgConnection,
    input: Deploy,
) -> QueryResult<Option<Uuid>> {
    #[derive(QueryableByName)]
    struct Installed {
        #[diesel(sql_type = SqlUuid)]
        id: Uuid,
    }
    sql_query(
        "WITH eligible AS (
             SELECT id, server_type FROM internal_mcp_catalog
             WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)
               AND environment_id IS NOT DISTINCT FROM $4 AND deleted_at IS NULL
               AND server_type = $5 AND server_type <> 'desktop_mcp'
               AND NOT requires_auth AND oauth_config IS NULL
             FOR SHARE
         ), installed AS (
             INSERT INTO mcp_server
                 (id, catalog_id, server_type, name, deployment_name, scope,
                  team_id, owner_id, created_by_service_account_id)
             SELECT $1, id, server_type, $6, $7, $8, $9, $10, $11 FROM eligible
             WHERE ($8 <> 'team' AND $9 IS NULL OR $8 = 'team' AND EXISTS (
                 SELECT 1 FROM team WHERE id = $9 AND organization_id = $3 FOR SHARE
             )) AND ($11 IS NULL OR EXISTS (
                 SELECT 1 FROM service_accounts WHERE id = $11 AND organization_id = $3 FOR SHARE
             ))
             RETURNING id, owner_id
         ), linked AS (
             INSERT INTO mcp_server_user (mcp_server_id, user_id)
             SELECT id, owner_id FROM installed WHERE owner_id IS NOT NULL
         )
         SELECT id FROM installed",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<SqlUuid, _>(input.catalog_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Text, _>(input.server_type)
    .bind::<Text, _>(input.name)
    .bind::<Nullable<Text>, _>(input.deployment_name)
    .bind::<Text, _>(match input.scope {
        InstallScope::Personal => "personal",
        InstallScope::Team => "team",
        InstallScope::Org => "org",
    })
    .bind::<Nullable<Text>, _>(input.team_id)
    .bind::<Nullable<Text>, _>(input.owner_id)
    .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
    .get_result::<Installed>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCatalog {
    organization_id: String,
    environment_id: Option<Uuid>,
    author_id: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    name: String,
    metadata: BTreeMap<Field, Option<String>>,
    config: BTreeMap<ConfigField, Value>,
    labels: Vec<Label>,
    grants: Vec<Value>,
}

pub async fn create(
    connection: &mut AsyncPgConnection,
    input: CreateCatalog,
) -> QueryResult<String> {
    #[derive(QueryableByName)]
    struct Created {
        #[diesel(sql_type = SqlUuid)]
        id: Uuid,
    }
    let created = sql_query(
        "WITH created AS (
             INSERT INTO internal_mcp_catalog (
                 organization_id, environment_id, author_id, created_by_service_account_id,
                 name, scope, icon, description, docs_url, repository, version, instructions,
                 server_type, server_url, requires_auth, auth_description, auth_fields,
                 oauth_config, local_config, deployment_spec_yaml, installation_command,
                 user_config, local_config_secret_id, client_secret_id
             )
             SELECT $1, $2, $3, $4, $5, 'personal', $6->>'icon', $6->>'description', $6->>'docsUrl',
                    $6->>'repository', $6->>'version', $6->>'instructions',
                    p.server_type, p.server_url, coalesce(p.requires_auth, false), p.auth_description,
                    CASE WHEN $7 ? 'auth_fields' THEN p.auth_fields ELSE '[]'::jsonb END,
                    p.oauth_config, p.local_config, p.deployment_spec_yaml, p.installation_command,
                    CASE WHEN $7 ? 'user_config' THEN p.user_config ELSE '{}'::jsonb END,
                    p.local_config_secret_id, p.client_secret_id
             FROM jsonb_populate_record(NULL::internal_mcp_catalog, $7) p
             WHERE p.server_type IN ('local', 'remote', 'builtin')
               AND ($2 IS NULL OR EXISTS (
                   SELECT 1 FROM environments WHERE id = $2 AND organization_id = $1 FOR SHARE
               ))
               AND ($4 IS NULL OR EXISTS (
                   SELECT 1 FROM service_accounts WHERE id = $4 AND organization_id = $1 FOR SHARE
               ))
             RETURNING id
         ), policy AS (
             INSERT INTO resource_permission_policies
                 (organization_id, resource, scope, grants, legacy_sharing_migrated, legacy_organization_audience)
             SELECT $1, 'mcpRegistry', id::text, $8, true, false FROM created
         )
         SELECT id FROM created",
    )
    .bind::<Text, _>(&input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Nullable<Text>, _>(input.author_id)
    .bind::<Nullable<SqlUuid>, _>(input.created_by_service_account_id)
    .bind::<Text, _>(input.name)
    .bind::<Jsonb, _>(serde_json::json!(input.metadata))
    .bind::<Jsonb, _>(serde_json::json!(input.config))
    .bind::<Jsonb, _>(Value::Array(input.grants))
    .get_result::<Created>(connection)
    .await?;
    if !input.labels.is_empty() {
        match replace_labels(
            connection,
            created.id,
            Some(&input.organization_id),
            input.environment_id,
            input.labels,
        )
        .await?
        {
            Outcome::Updated => {}
            Outcome::NotFound | Outcome::DuplicateLabel => return Err(Error::NotFound),
        }
    }
    Ok(created.id.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditConfig {
    id: Uuid,
    organization_id: Option<String>,
    environment_id: Option<Uuid>,
    revision: String,
    fields: BTreeMap<ConfigField, Value>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
enum ConfigField {
    ServerType,
    ServerUrl,
    RequiresAuth,
    AuthDescription,
    AuthFields,
    OauthConfig,
    LocalConfig,
    DeploymentSpecYaml,
    InstallationCommand,
    UserConfig,
    LocalConfigSecretId,
    ClientSecretId,
}

pub async fn edit_config(
    connection: &mut AsyncPgConnection,
    input: EditConfig,
) -> QueryResult<bool> {
    const IMAGE_CHANGED: &str = "$4 ? 'local_config' AND
        (c.local_config->>'dockerImage') IS DISTINCT FROM (p.local_config->>'dockerImage')";
    sql_query(format!(
        "UPDATE internal_mcp_catalog c SET
             server_type = CASE WHEN $4 ? 'server_type' THEN p.server_type ELSE c.server_type END,
             server_url = CASE WHEN $4 ? 'server_url' THEN p.server_url ELSE c.server_url END,
             requires_auth = CASE WHEN $4 ? 'requires_auth' THEN p.requires_auth ELSE c.requires_auth END,
             auth_description = CASE WHEN $4 ? 'auth_description' THEN p.auth_description ELSE c.auth_description END,
             auth_fields = CASE WHEN $4 ? 'auth_fields' THEN p.auth_fields ELSE c.auth_fields END,
             oauth_config = CASE WHEN $4 ? 'oauth_config' THEN p.oauth_config ELSE c.oauth_config END,
             local_config = CASE WHEN $4 ? 'local_config' THEN p.local_config ELSE c.local_config END,
             deployment_spec_yaml = CASE WHEN $4 ? 'deployment_spec_yaml' THEN p.deployment_spec_yaml ELSE c.deployment_spec_yaml END,
             installation_command = CASE WHEN $4 ? 'installation_command' THEN p.installation_command ELSE c.installation_command END,
             user_config = CASE WHEN $4 ? 'user_config' THEN p.user_config ELSE c.user_config END,
             local_config_secret_id = CASE WHEN $4 ? 'local_config_secret_id' THEN p.local_config_secret_id ELSE c.local_config_secret_id END,
             client_secret_id = CASE WHEN $4 ? 'client_secret_id' THEN p.client_secret_id ELSE c.client_secret_id END,
             catalog_item_approval_status = CASE WHEN {IMAGE_CHANGED} THEN NULL ELSE c.catalog_item_approval_status END,
             catalog_item_approval_reason = CASE WHEN {IMAGE_CHANGED} THEN NULL ELSE c.catalog_item_approval_reason END,
             catalog_item_approval_reviewed_by = CASE WHEN {IMAGE_CHANGED} THEN NULL ELSE c.catalog_item_approval_reviewed_by END,
             catalog_item_approval_reviewed_at = CASE WHEN {IMAGE_CHANGED} THEN NULL ELSE c.catalog_item_approval_reviewed_at END,
             updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
         FROM jsonb_populate_record(NULL::internal_mcp_catalog, $4) p
         WHERE c.id = $1 AND c.organization_id IS NOT DISTINCT FROM $2
           AND c.environment_id IS NOT DISTINCT FROM $3 AND c.deleted_at IS NULL
           AND c.xmin::text = $5 AND c.server_type NOT IN ('app', 'desktop_mcp')
           AND (NOT ($4 ? 'server_type') OR p.server_type IN ('local', 'remote', 'builtin'))"
    ))
    .bind::<SqlUuid, _>(input.id)
    .bind::<Nullable<Text>, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.environment_id)
    .bind::<Jsonb, _>(serde_json::json!(input.fields))
    .bind::<Text, _>(input.revision)
    .execute(connection)
    .await
    .map(|changed| changed != 0)
}

pub async fn edit_description(
    connection: &mut AsyncPgConnection,
    input: EditDescription,
) -> QueryResult<Outcome> {
    if !input.fields.is_empty() {
        let changed = sql_query(format!(
            "UPDATE internal_mcp_catalog SET
                 icon = CASE WHEN $4 ? 'icon' THEN $4->>'icon' ELSE icon END,
                 description = CASE WHEN $4 ? 'description' THEN $4->>'description' ELSE description END,
                 docs_url = CASE WHEN $4 ? 'docsUrl' THEN $4->>'docsUrl' ELSE docs_url END,
                 repository = CASE WHEN $4 ? 'repository' THEN $4->>'repository' ELSE repository END,
                 version = CASE WHEN $4 ? 'version' THEN $4->>'version' ELSE version END,
                 instructions = CASE WHEN $4 ? 'instructions' THEN $4->>'instructions' ELSE instructions END,
                 updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
             WHERE {SCOPED_ITEM}"
        ))
        .bind::<SqlUuid, _>(input.id)
        .bind::<Nullable<Text>, _>(&input.organization_id)
        .bind::<Nullable<SqlUuid>, _>(input.environment_id)
        .bind::<Jsonb, _>(serde_json::json!(input.fields))
        .execute(connection)
        .await?;
        if changed == 0 {
            return Ok(Outcome::NotFound);
        }
    }
    let Some(labels) = input.labels else {
        return Ok(Outcome::Updated);
    };
    replace_labels(
        connection,
        input.id,
        input.organization_id.as_deref(),
        input.environment_id,
        labels,
    )
    .await
}

async fn replace_labels(
    connection: &mut AsyncPgConnection,
    id: Uuid,
    organization_id: Option<&str>,
    environment_id: Option<Uuid>,
    labels: Vec<Label>,
) -> QueryResult<Outcome> {
    // Metadata already committed on the legacy path when label replacement fails.
    let label_count = labels.len();
    let labels: BTreeMap<_, _> = labels
        .into_iter()
        .map(|label| (label.key, label.value))
        .collect();
    if labels.len() != label_count {
        return Ok(Outcome::DuplicateLabel);
    }
    connection
        .transaction(async |tx| {
            #[derive(QueryableByName)]
            struct Item {
                #[diesel(sql_type = SqlUuid)]
                id: Uuid,
            }
            let item = sql_query(format!(
                "SELECT id FROM internal_mcp_catalog WHERE {SCOPED_ITEM} FOR UPDATE"
            ))
            .bind::<SqlUuid, _>(id)
            .bind::<Nullable<Text>, _>(organization_id)
            .bind::<Nullable<SqlUuid>, _>(environment_id)
            .get_result::<Item>(tx)
            .await
            .optional()?;
            let Some(item) = item else {
                return Ok(Outcome::NotFound);
            };
            sql_query("DELETE FROM mcp_catalog_labels WHERE catalog_id = $1")
                .bind::<SqlUuid, _>(item.id)
                .execute(tx)
                .await?;
            let labels = serde_json::json!(labels);
            crate::labels::ensure_vocabulary(tx, &labels).await?;
            let inserted = sql_query(
                "INSERT INTO mcp_catalog_labels (catalog_id, key_id, value_id)
             SELECT $1, k.id, v.id FROM jsonb_each_text($2) l
             JOIN label_keys k ON k.key = l.key JOIN label_values v ON v.value = l.value",
            )
            .bind::<SqlUuid, _>(item.id)
            .bind::<Jsonb, _>(&labels)
            .execute(tx)
            .await?;
            if inserted != label_count {
                return Err(Error::NotFound);
            }
            Ok(Outcome::Updated)
        })
        .await
}
