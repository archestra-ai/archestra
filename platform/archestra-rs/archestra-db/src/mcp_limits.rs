use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, Integer, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::throughput_counter::{self, CounterRule};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    organization_id: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
    limit_type: Option<String>,
}

#[derive(QueryableByName)]
struct Row {
    #[diesel(sql_type = Jsonb)]
    data: Value,
}

const LIMIT_JSON: &str = "jsonb_build_object(
            'id', l.id, 'entityType', l.entity_type, 'entityId', l.entity_id,
            'limitType', l.limit_type, 'limitValue', l.limit_value, 'behavior', l.behavior,
            'mcpServerName', l.mcp_server_name, 'toolName', l.tool_name, 'model', l.model,
            'reason', l.reason, 'teamManaged', l.team_managed, 'cleanupInterval', l.cleanup_interval,
            'lastCleanup', to_char(l.last_cleanup, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
            'createdAt', to_char(l.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
            'updatedAt', to_char(l.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
        )";

const IN_ORGANIZATION: &str = "CASE l.entity_type
            WHEN 'organization' THEN l.entity_id = $1
            WHEN 'team' THEN EXISTS (SELECT 1 FROM team WHERE id = l.entity_id AND organization_id = $1)
            WHEN 'agent' THEN EXISTS (SELECT 1 FROM agents WHERE id::text = lower(l.entity_id) AND organization_id = $1 AND deleted_at IS NULL)
            WHEN 'user' THEN EXISTS (SELECT 1 FROM member WHERE user_id = l.entity_id AND organization_id = $1)
            WHEN 'virtual_key' THEN EXISTS (SELECT 1 FROM virtual_api_keys WHERE id::text = lower(l.entity_id) AND organization_id = $1)
            WHEN 'environment' THEN EXISTS (SELECT 1 FROM environments WHERE id::text = lower(l.entity_id) AND organization_id = $1)
            WHEN 'llm_oauth_client' THEN EXISTS (SELECT 1 FROM oauth_client WHERE id = l.entity_id
              AND metadata->>'type' IN ('llm_oauth_client', 'managed_oauth_client') AND metadata->>'organizationId' = $1)
            ELSE false
          END";

pub async fn list(connection: &mut AsyncPgConnection, query: Query) -> QueryResult<Vec<Value>> {
    let rows: Vec<Row> = sql_query(format!(
        "SELECT {LIMIT_JSON} AS data FROM limits l
        WHERE ($2::text IS NULL OR l.entity_type = $2)
          AND ($3::text IS NULL OR l.entity_id = $3)
          AND ($4::text IS NULL OR l.limit_type = $4)
          AND {IN_ORGANIZATION}"
    ))
    .bind::<Text, _>(query.organization_id)
    .bind::<Nullable<Text>, _>(query.entity_type)
    .bind::<Nullable<Text>, _>(query.entity_id)
    .bind::<Nullable<Text>, _>(query.limit_type)
    .load(connection)
    .await?;
    Ok(rows.into_iter().map(|row| row.data).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    organization_id: String,
    entity_type: String,
    entity_id: String,
    limit_type: String,
    limit_value: i32,
    behavior: String,
    model: Option<Vec<String>>,
    cleanup_interval: String,
    mcp_server_name: Option<String>,
    tool_name: Option<String>,
    reason: Option<String>,
}

pub async fn create(
    connection: &mut AsyncPgConnection,
    input: Create,
) -> QueryResult<Option<Value>> {
    let id = Uuid::new_v4();
    let row = sql_query(format!(
        "WITH target AS (
             SELECT $2::text AS entity_type, $3::text AS entity_id
         ), inserted AS (
             INSERT INTO limits (id, entity_type, entity_id, limit_type, limit_value, behavior,
                model, cleanup_interval, mcp_server_name, tool_name, reason)
             SELECT $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
             FROM target l WHERE {IN_ORGANIZATION}
             RETURNING *
         )
         SELECT {LIMIT_JSON} AS data FROM inserted l"
    ))
    .bind::<Text, _>(input.organization_id)
    .bind::<Text, _>(input.entity_type)
    .bind::<Text, _>(input.entity_id)
    .bind::<Text, _>(&input.limit_type)
    .bind::<Integer, _>(input.limit_value)
    .bind::<Text, _>(input.behavior)
    .bind::<Nullable<Jsonb>, _>(input.model.as_ref().map(|models| serde_json::json!(models)))
    .bind::<Text, _>(input.cleanup_interval)
    .bind::<Nullable<Text>, _>(input.mcp_server_name)
    .bind::<Nullable<Text>, _>(input.tool_name)
    .bind::<Nullable<Text>, _>(input.reason)
    .bind::<SqlUuid, _>(id)
    .get_result::<Row>(connection)
    .await
    .optional()?;
    if row.is_some()
        && input.limit_type == "token_cost"
        && let Some(models) = input.model
    {
        sql_query(
            "INSERT INTO limit_model_usage (limit_id, model)
             SELECT $1, model FROM unnest($2::text[]) AS model",
        )
        .bind::<SqlUuid, _>(id)
        .bind::<Array<Text>, _>(models)
        .execute(connection)
        .await?;
    }
    Ok(row.map(|row| row.data))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    id: Uuid,
    organization_id: String,
    revision: String,
    patch: serde_json::Map<String, Value>,
}

pub async fn update(
    connection: &mut AsyncPgConnection,
    input: Update,
) -> QueryResult<Option<Value>> {
    #[derive(QueryableByName)]
    struct Updated {
        #[diesel(sql_type = Jsonb)]
        data: Value,
        #[diesel(embed)]
        rule: CounterRule,
    }

    connection.transaction(async |tx| {
        lock_throughput(tx, input.id).await?;
        let updated = sql_query(format!(
            "WITH updated AS (
                UPDATE limits AS saved SET
                    limit_type = coalesce($4->>'limitType', saved.limit_type),
                    limit_value = coalesce(($4->>'limitValue')::integer, saved.limit_value),
                    behavior = coalesce($4->>'behavior', saved.behavior),
                    cleanup_interval = coalesce($4->>'cleanupInterval', saved.cleanup_interval),
                    model = CASE WHEN $4 ? 'model' THEN nullif($4->'model', 'null'::jsonb) ELSE saved.model END,
                    reason = CASE WHEN $4 ? 'reason' THEN $4->>'reason' ELSE saved.reason END,
                    last_cleanup = CASE WHEN $4->>'cleanupInterval' <> saved.cleanup_interval
                        THEN greatest(clock_timestamp(), saved.last_cleanup + interval '1 millisecond')
                        ELSE saved.last_cleanup END,
                    updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
                FROM limits l
                WHERE saved.id = $2 AND l.id = saved.id AND saved.xmin::text = $3
                    AND {IN_ORGANIZATION}
                    AND (coalesce($4->>'limitType', saved.limit_type) = saved.limit_type
                         OR (saved.limit_type = 'requests_per_minute' AND $4->>'limitType' = 'requests')
                         OR (saved.limit_type = 'tokens_per_minute' AND $4->>'limitType' = 'tokens'))
                RETURNING saved.*, saved.cleanup_interval <> l.cleanup_interval AS reset_usage
             ), billing AS (
                DELETE FROM limit_billing_usage b USING updated u
                WHERE b.limit_id = u.id AND u.reset_usage
             ), model_usage AS (
                UPDATE limit_model_usage m SET current_usage_tokens_in = 0, current_usage_tokens_out = 0,
                    updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
                FROM updated u WHERE m.limit_id = u.id AND u.reset_usage
             )
             SELECT {LIMIT_JSON} AS data, l.limit_type, l.cleanup_interval, l.limit_value,
                    to_char(l.last_cleanup, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS epoch,
                    (extract(epoch FROM date_trunc('milliseconds', coalesce(l.last_cleanup, l.created_at))) * 1000)::float8 AS anchor
             FROM updated l"
        ))
        .bind::<Text, _>(input.organization_id)
        .bind::<SqlUuid, _>(input.id)
        .bind::<Text, _>(input.revision)
        .bind::<Jsonb, _>(Value::Object(input.patch))
        .get_result::<Updated>(tx)
        .await
        .optional()?;
        let Some(updated) = updated else { return Ok(None) };
        throughput_counter::reconfigure(tx, input.id, updated.rule).await?;
        Ok(Some(updated.data))
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delete {
    id: Uuid,
    organization_id: String,
}

pub async fn delete(connection: &mut AsyncPgConnection, input: Delete) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct DeletedLimit {
        #[diesel(sql_type = Text)]
        limit_type: String,
    }

    connection
        .transaction(async |tx| {
            lock_throughput(tx, input.id).await?;
            let deleted = sql_query(format!(
                "DELETE FROM limits l WHERE l.id = $2 AND {IN_ORGANIZATION} RETURNING limit_type"
            ))
            .bind::<Text, _>(input.organization_id)
            .bind::<SqlUuid, _>(input.id)
            .get_result::<DeletedLimit>(tx)
            .await
            .optional()?;
            let Some(deleted) = deleted else {
                return Ok(false);
            };
            sql_query("DELETE FROM keyv_cache WHERE key = $1")
                .bind::<Text, _>(throughput_counter::counter_key(
                    input.id,
                    &deleted.limit_type,
                ))
                .execute(tx)
                .await?;
            Ok(true)
        })
        .await
}

async fn lock_throughput(connection: &mut AsyncPgConnection, id: Uuid) -> QueryResult<()> {
    sql_query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind::<Text, _>(format!("cache-entry:llm-throughput:{id}"))
        .execute(connection)
        .await
        .map(|_| ())
}
