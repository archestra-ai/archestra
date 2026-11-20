use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Bool, Integer, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTrigger {
    organization_id: String,
    project_id: Uuid,
    agent_id: Uuid,
    actor_user_id: String,
    name: String,
    message_template: String,
    cron_expression: String,
    timezone: String,
    enabled: bool,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTrigger {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Text)]
    created_at: String,
}

pub async fn create_trigger(
    connection: &mut AsyncPgConnection,
    input: CreateTrigger,
) -> QueryResult<Option<CreatedTrigger>> {
    sql_query(
        "INSERT INTO schedule_triggers
            (organization_id, project_id, agent_id, actor_user_id, name,
             message_template, cron_expression, timezone, enabled)
         SELECT p.organization_id, p.id, a.id, $4, $5, $6, $7, $8, $9
         FROM projects p
         JOIN agents a ON a.id = $3 AND a.organization_id = p.organization_id
             AND a.agent_type = 'agent' AND a.deleted_at IS NULL
         WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL
         RETURNING id,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
    )
    .bind::<Text, _>(input.organization_id)
    .bind::<SqlUuid, _>(input.project_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Text, _>(input.actor_user_id)
    .bind::<Text, _>(input.name)
    .bind::<Text, _>(input.message_template)
    .bind::<Text, _>(input.cron_expression)
    .bind::<Text, _>(input.timezone)
    .bind::<Bool, _>(input.enabled)
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTrigger {
    id: Uuid,
    organization_id: String,
    expected: TriggerUpdateScope,
    patch: TriggerPatch,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerUpdateScope {
    project_id: Option<Uuid>,
    agent_id: Uuid,
    actor_user_id: String,
    cron_expression: String,
    timezone: String,
    message_template: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerPatch {
    project_id: Option<Uuid>,
    agent_id: Option<Uuid>,
    name: Option<String>,
    cron_expression: Option<String>,
    timezone: Option<String>,
    message_template: Option<String>,
    enabled: Option<bool>,
}

pub async fn update_trigger(
    connection: &mut AsyncPgConnection,
    input: UpdateTrigger,
) -> QueryResult<Option<String>> {
    #[derive(QueryableByName)]
    struct Updated {
        #[diesel(sql_type = Text)]
        id: String,
    }
    sql_query(
        "UPDATE schedule_triggers s SET
             project_id = coalesce(p.\"projectId\", s.project_id),
             agent_id = coalesce(p.\"agentId\", s.agent_id),
             name = coalesce(p.name, s.name),
             cron_expression = coalesce(p.\"cronExpression\", s.cron_expression),
             timezone = coalesce(p.timezone, s.timezone),
             message_template = coalesce(p.\"messageTemplate\", s.message_template),
             enabled = coalesce(p.enabled, s.enabled)
         FROM jsonb_to_record($3) AS e (\"projectId\" uuid, \"agentId\" uuid, \"actorUserId\" text,
             \"cronExpression\" text, timezone text, \"messageTemplate\" text),
         jsonb_to_record($4) AS p (\"projectId\" uuid, \"agentId\" uuid, name text,
             \"cronExpression\" text, timezone text, \"messageTemplate\" text, enabled boolean)
         WHERE s.id = $1 AND s.organization_id = $2
           AND s.actor_user_id = e.\"actorUserId\"
           AND s.agent_id = e.\"agentId\" AND s.project_id IS NOT DISTINCT FROM e.\"projectId\"
           AND s.cron_expression = e.\"cronExpression\" AND s.timezone = e.timezone
           AND s.message_template = e.\"messageTemplate\"
           AND (s.project_id IS NULL OR EXISTS (
               SELECT 1 FROM projects WHERE id = s.project_id AND organization_id = $2 AND deleted_at IS NULL))
           AND (p.\"projectId\" IS NULL OR EXISTS (
               SELECT 1 FROM projects WHERE id = p.\"projectId\" AND organization_id = $2 AND deleted_at IS NULL))
           AND EXISTS (
               SELECT 1 FROM agents WHERE id = s.agent_id AND organization_id = $2 AND deleted_at IS NULL)
           AND (p.\"agentId\" IS NULL OR p.\"agentId\" = s.agent_id OR EXISTS (
               SELECT 1 FROM agents WHERE id = p.\"agentId\" AND organization_id = $2
                 AND deleted_at IS NULL AND agent_type = 'agent'))
         RETURNING s.id::text",
    )
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Jsonb, _>(serde_json::json!(input.expected))
    .bind::<Jsonb, _>(serde_json::json!(input.patch))
    .get_result::<Updated>(connection)
    .await
    .optional()
    .map(|result| result.map(|row| row.id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleTarget {
    id: Uuid,
    organization_id: String,
    project_id: Option<Uuid>,
    agent_id: Uuid,
    actor_user_id: String,
}

const LIVE_SCHEDULE_TARGET: &str = "s.id = $1 AND s.organization_id = $2
    AND s.project_id IS NOT DISTINCT FROM $3 AND s.agent_id = $4 AND s.actor_user_id = $5
    AND (s.project_id IS NULL OR EXISTS (
        SELECT 1 FROM projects WHERE id = s.project_id AND organization_id = $2 AND deleted_at IS NULL))
    AND EXISTS (
        SELECT 1 FROM agents WHERE id = s.agent_id AND organization_id = $2 AND deleted_at IS NULL)";

pub async fn delete_trigger(
    connection: &mut AsyncPgConnection,
    input: ScheduleTarget,
) -> QueryResult<bool> {
    sql_query(format!(
        "DELETE FROM schedule_triggers s WHERE {LIVE_SCHEDULE_TARGET}"
    ))
    .bind::<SqlUuid, _>(input.id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Nullable<SqlUuid>, _>(input.project_id)
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Text, _>(input.actor_user_id)
    .execute(connection)
    .await
    .map(|count| count != 0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateManualRun {
    target: ScheduleTarget,
    initiated_by_user_id: String,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedManualRun {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Text)]
    started_at: String,
    #[diesel(sql_type = Text)]
    created_at: String,
}

pub async fn create_manual_run(
    connection: &mut AsyncPgConnection,
    input: CreateManualRun,
) -> QueryResult<Option<CreatedManualRun>> {
    let target = input.target;
    sql_query(format!(
        "INSERT INTO schedule_trigger_runs
            (organization_id, trigger_id, run_kind, status, initiated_by_user_id, started_at)
         SELECT s.organization_id, s.id, 'manual', 'running', $6, date_trunc('milliseconds', now())
         FROM schedule_triggers s WHERE {LIVE_SCHEDULE_TARGET} FOR SHARE OF s
         RETURNING id,
             to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS started_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at"
    ))
    .bind::<SqlUuid, _>(target.id)
    .bind::<Text, _>(target.organization_id)
    .bind::<Nullable<SqlUuid>, _>(target.project_id)
    .bind::<SqlUuid, _>(target.agent_id)
    .bind::<Text, _>(target.actor_user_id)
    .bind::<Text, _>(input.initiated_by_user_id)
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerQuery {
    id: String,
    organization_id: String,
    project_id: Option<String>,
    actor_user_id: String,
}

#[derive(QueryableByName, Serialize)]
pub struct TriggerSummary {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    agent_id: String,
    #[diesel(sql_type = Text)]
    agent_name: String,
    #[diesel(sql_type = Nullable<Text>)]
    project_id: Option<String>,
    #[diesel(sql_type = Text)]
    cron_expression: String,
    #[diesel(sql_type = Text)]
    timezone: String,
    #[diesel(sql_type = Bool)]
    enabled: bool,
    #[diesel(sql_type = Nullable<Text>)]
    last_executed_at: Option<String>,
    #[diesel(sql_type = Text)]
    actor_user_id: String,
    #[diesel(sql_type = Nullable<Text>)]
    actor_name: Option<String>,
    #[diesel(sql_type = Text)]
    created_at: String,
}

#[derive(QueryableByName, Serialize)]
pub struct TriggerDetail {
    #[diesel(embed)]
    #[serde(flatten)]
    summary: TriggerSummary,
    #[diesel(sql_type = Text)]
    message_template: String,
}

const SELECT_TRIGGER: &str = "SELECT s.id::text, s.name, s.agent_id::text, a.name AS agent_name,
    s.project_id::text, s.cron_expression, s.timezone, s.enabled,
    to_char(s.last_executed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS last_executed_at,
    s.actor_user_id, u.name AS actor_name,
    to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at";
const TRIGGER_SOURCE: &str = "FROM schedule_triggers s
    JOIN agents a ON a.id = s.agent_id AND a.deleted_at IS NULL
    LEFT JOIN \"user\" u ON u.id = s.actor_user_id
    WHERE (s.project_id IS NULL OR EXISTS (
        SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.deleted_at IS NULL
    ))";

pub async fn trigger(
    connection: &mut AsyncPgConnection,
    query: TriggerQuery,
) -> QueryResult<Option<TriggerDetail>> {
    sql_query(format!(
        "{SELECT_TRIGGER}, s.message_template {TRIGGER_SOURCE}
         AND s.id = $1::uuid AND s.organization_id = $2
         AND s.project_id IS NOT DISTINCT FROM $3::uuid AND s.actor_user_id = $4"
    ))
    .bind::<Text, _>(query.id)
    .bind::<Text, _>(query.organization_id)
    .bind::<Nullable<Text>, _>(query.project_id)
    .bind::<Text, _>(query.actor_user_id)
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TriggerPageQuery {
    organization_id: String,
    pub limit: i32,
    enabled: Option<bool>,
    agent_id: Option<String>,
    scope: TriggerScope,
    position: Option<Position>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TriggerScope {
    Actor { user_id: String },
    Project { project_id: String },
    Organization,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPageRow {
    #[diesel(embed)]
    summary: TriggerSummary,
    #[diesel(sql_type = Text)]
    cursor_created_at: String,
}

pub async fn list_triggers(
    connection: &mut AsyncPgConnection,
    query: TriggerPageQuery,
) -> QueryResult<Vec<TriggerPageRow>> {
    let (actor, project) = match query.scope {
        TriggerScope::Actor { user_id } => (Some(user_id), None),
        TriggerScope::Project { project_id } => (None, Some(project_id)),
        TriggerScope::Organization => (None, None),
    };
    let (value, id) = cursor_parts(query.position);
    sql_query(format!(
        "{SELECT_TRIGGER}, s.created_at::text AS cursor_created_at {TRIGGER_SOURCE}
         AND s.organization_id = $1
         AND ($2::boolean IS NULL OR s.enabled = $2)
         AND ($3::text IS NULL OR s.agent_id = $3::uuid)
         AND ($4::text IS NULL OR s.actor_user_id = $4)
         AND ($5::text IS NULL OR s.project_id = $5::uuid)
         AND ($6::text IS NULL OR (s.created_at, s.id) < ($6::timestamptz, $7::uuid))
         ORDER BY s.created_at DESC, s.id DESC LIMIT $8"
    ))
    .bind::<Text, _>(query.organization_id)
    .bind::<Nullable<Bool>, _>(query.enabled)
    .bind::<Nullable<Text>, _>(query.agent_id)
    .bind::<Nullable<Text>, _>(actor)
    .bind::<Nullable<Text>, _>(project)
    .bind::<Nullable<Text>, _>(value)
    .bind::<Nullable<Text>, _>(id)
    .bind::<Integer, _>(query.limit)
    .load(connection)
    .await
}

#[derive(QueryableByName, Serialize)]
pub struct RunSummary {
    #[diesel(sql_type = Nullable<Jsonb>)]
    blocked_by: Option<Value>,
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    trigger_id: String,
    #[diesel(sql_type = Text)]
    run_kind: String,
    #[diesel(sql_type = Text)]
    status: String,
    #[diesel(sql_type = Nullable<Text>)]
    started_at: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    completed_at: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    error: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    chat_conversation_id: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    runtime_task_id: Option<String>,
    #[diesel(sql_type = Text)]
    created_at: String,
}

const SELECT_RUN: &str =
    "SELECT blocked_by, id::text, trigger_id::text, run_kind, status,
                to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS started_at,
                to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS completed_at,
                error, chat_conversation_id::text, runtime_task_id::text,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at";

pub async fn read(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    trigger_id: &str,
    run_id: &str,
) -> QueryResult<Option<RunSummary>> {
    sql_query(format!(
        "{SELECT_RUN}
         FROM schedule_trigger_runs
         WHERE organization_id = $1 AND trigger_id = $2::uuid AND id = $3::uuid"
    ))
    .bind::<Text, _>(organization_id)
    .bind::<Text, _>(trigger_id)
    .bind::<Text, _>(run_id)
    .get_result(connection)
    .await
    .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageQuery {
    organization_id: String,
    trigger_id: String,
    pub limit: i32,
    status: Option<String>,
    position: Option<Position>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    value: String,
    id: String,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRow {
    #[diesel(embed)]
    summary: RunSummary,
    #[diesel(sql_type = Text)]
    cursor_created_at: String,
}

pub async fn list(
    connection: &mut AsyncPgConnection,
    query: PageQuery,
) -> QueryResult<Vec<PageRow>> {
    let (value, id) = cursor_parts(query.position);
    sql_query(format!(
        "{SELECT_RUN}, created_at::text AS cursor_created_at
         FROM schedule_trigger_runs
         WHERE organization_id = $1 AND trigger_id = $2::uuid
           AND ($3::text IS NULL OR status = $3)
           AND ($4::text IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
         ORDER BY schedule_trigger_runs.created_at DESC, schedule_trigger_runs.id DESC
         LIMIT $6"
    ))
    .bind::<Text, _>(query.organization_id)
    .bind::<Text, _>(query.trigger_id)
    .bind::<Nullable<Text>, _>(query.status)
    .bind::<Nullable<Text>, _>(value)
    .bind::<Nullable<Text>, _>(id)
    .bind::<Integer, _>(query.limit)
    .load(connection)
    .await
}

fn cursor_parts(position: Option<Position>) -> (Option<String>, Option<String>) {
    position
        .map(|p| (Some(p.value), Some(p.id)))
        .unwrap_or_default()
}
