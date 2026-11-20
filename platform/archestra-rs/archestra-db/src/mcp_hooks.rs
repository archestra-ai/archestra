use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, Bool, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookScope {
    organization_id: String,
    agent_id: String,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    agent_id: String,
    #[diesel(sql_type = Text)]
    event: String,
    #[diesel(sql_type = Text)]
    file_name: String,
    #[diesel(sql_type = Text)]
    content: String,
    #[diesel(sql_type = Array<Text>)]
    requirements: Vec<String>,
    #[diesel(sql_type = Bool)]
    enabled: bool,
    #[diesel(sql_type = Text)]
    created_at: String,
    #[diesel(sql_type = Text)]
    updated_at: String,
}

const HOOK_COLUMNS: &str =
    "h.id::text, h.agent_id::text, h.event, h.file_name, h.content,
             h.requirements, h.enabled,
             to_char(h.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
             to_char(h.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at";

pub async fn list(connection: &mut AsyncPgConnection, scope: HookScope) -> QueryResult<Vec<Hook>> {
    sql_query(format!(
        "SELECT {HOOK_COLUMNS}
         FROM hook_files h
         WHERE h.organization_id = $1 AND h.agent_id = $2::uuid
         ORDER BY h.event, h.file_name"
    ))
    .bind::<Text, _>(scope.organization_id)
    .bind::<Text, _>(scope.agent_id)
    .load(connection)
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateHook {
    agent_id: Uuid,
    organization_id: String,
    event: String,
    file_name: String,
    content: String,
    requirements: Vec<String>,
    enabled: bool,
}

pub async fn create(
    connection: &mut AsyncPgConnection,
    input: CreateHook,
) -> QueryResult<Option<Hook>> {
    sql_query(format!(
        "INSERT INTO hook_files AS h
             (agent_id, organization_id, event, file_name, content, requirements, enabled)
         SELECT a.id, a.organization_id, $3, $4, $5, $6, $7
         FROM agents a WHERE a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL
         RETURNING {HOOK_COLUMNS}"
    ))
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Text, _>(input.event)
    .bind::<Text, _>(input.file_name)
    .bind::<Text, _>(input.content)
    .bind::<Array<Text>, _>(input.requirements)
    .bind::<Bool, _>(input.enabled)
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookTarget {
    id: Uuid,
    agent_id: Uuid,
    organization_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateHook {
    target: HookTarget,
    data: HookPatch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookPatch {
    event: Option<String>,
    file_name: Option<String>,
    content: Option<String>,
    requirements: Option<Vec<String>>,
    enabled: Option<bool>,
}

const TARGET_SCOPE: &str = "h.id = $1 AND h.agent_id = $2 AND h.organization_id = $3
    AND a.id = h.agent_id AND a.organization_id = $3 AND a.deleted_at IS NULL";

pub async fn update(
    connection: &mut AsyncPgConnection,
    input: UpdateHook,
) -> QueryResult<Option<Hook>> {
    let UpdateHook { target, data } = input;
    sql_query(format!(
        "UPDATE hook_files h SET
            event = coalesce($4, h.event), file_name = coalesce($5, h.file_name),
            content = coalesce($6, h.content), requirements = coalesce($7, h.requirements),
            enabled = coalesce($8, h.enabled),
            updated_at = date_trunc('milliseconds', clock_timestamp())
         FROM agents a WHERE {TARGET_SCOPE}
         RETURNING {HOOK_COLUMNS}"
    ))
    .bind::<SqlUuid, _>(target.id)
    .bind::<SqlUuid, _>(target.agent_id)
    .bind::<Text, _>(target.organization_id)
    .bind::<Nullable<Text>, _>(data.event)
    .bind::<Nullable<Text>, _>(data.file_name)
    .bind::<Nullable<Text>, _>(data.content)
    .bind::<Nullable<Array<Text>>, _>(data.requirements)
    .bind::<Nullable<Bool>, _>(data.enabled)
    .get_result(connection)
    .await
    .optional()
}

pub async fn delete(connection: &mut AsyncPgConnection, input: HookTarget) -> QueryResult<bool> {
    sql_query(format!(
        "DELETE FROM hook_files h USING agents a WHERE {TARGET_SCOPE}"
    ))
    .bind::<SqlUuid, _>(input.id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Text, _>(input.organization_id)
    .execute(connection)
    .await
    .map(|count| count != 0)
}
