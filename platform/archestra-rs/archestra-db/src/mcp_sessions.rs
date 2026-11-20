use diesel::{
    QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, BigInt, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    organization_id: String,
    user_id: Option<String>,
    profile_id: Option<Uuid>,
    session_id: Option<String>,
    ungrouped_id: Option<Uuid>,
    start_date: Option<String>,
    end_date: Option<String>,
    before: Option<Position>,
    stored_heads: bool,
    pub limit: i64,
}

#[derive(Deserialize)]
struct Position {
    value: String,
    id: String,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    #[diesel(sql_type = Nullable<Text>)]
    session_id: Option<String>,
    #[diesel(sql_type = Text)]
    head_id: String,
    #[diesel(sql_type = Text)]
    head_created_at: String,
}

#[derive(Serialize)]
pub struct Page {
    heads: Vec<Head>,
    summaries: Vec<String>,
}

// Scalar owner lookups keep the head scan from walking the organization roster.
const SCOPE: &str = "
    COALESCE(i.profile_id, i.connector_id, i.app_id) IS NOT NULL
    AND (i.profile_id IS NULL OR (SELECT a.organization_id FROM agents a WHERE a.id = i.profile_id) = $1)
    AND (i.connector_id IS NULL OR (SELECT c.organization_id FROM knowledge_base_connectors c WHERE c.id = i.connector_id) = $1)
    AND (i.app_id IS NULL OR (SELECT a.organization_id FROM apps a WHERE a.id = i.app_id) = $1)
    AND ($2::text IS NULL OR i.user_id = $2)
    AND ($3::uuid IS NULL OR i.profile_id = $3)
    AND ($4::text IS NULL OR i.session_id = $4 OR (i.session_id IS NULL AND i.id = $5))
    AND ($6::text IS NULL OR i.created_at >= $6::timestamp)
    AND ($7::text IS NULL OR i.created_at <= $7::timestamp)";

pub async fn list(connection: &mut AsyncPgConnection, query: Query) -> QueryResult<Page> {
    let (source, head_filter, created, id) = if query.stored_heads {
        (
            "interaction_session_heads h JOIN interactions i ON i.id = h.last_interaction_id",
            "($2::text IS NULL OR h.user_id = $2) AND ($4::text IS NULL OR h.session_key = $4)",
            "h.last_created_at",
            "h.last_interaction_id",
        )
    } else {
        (
            "interactions i",
            "(i.session_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM interactions newer WHERE newer.session_id = i.session_id
                  AND (newer.created_at, newer.id) > (i.created_at, i.id)
            ))",
            "i.created_at",
            "i.id",
        )
    };
    let heads: Vec<Head> = sql_query(format!(
        "SELECT i.session_id, {id}::text AS head_id,
            to_char({created}, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS head_created_at
         FROM {source} WHERE {SCOPE} AND {head_filter}
           AND ($8::text IS NULL OR ({created}, {id}) < ($8::timestamp, $9::uuid))
         ORDER BY {created} DESC NULLS LAST, {id} DESC NULLS LAST LIMIT $10"
    ))
    .bind::<Text, _>(&query.organization_id)
    .bind::<Nullable<Text>, _>(&query.user_id)
    .bind::<Nullable<SqlUuid>, _>(query.profile_id)
    .bind::<Nullable<Text>, _>(&query.session_id)
    .bind::<Nullable<SqlUuid>, _>(query.ungrouped_id)
    .bind::<Nullable<Text>, _>(&query.start_date)
    .bind::<Nullable<Text>, _>(&query.end_date)
    .bind::<Nullable<Text>, _>(query.before.as_ref().map(|p| &p.value))
    .bind::<Nullable<Text>, _>(query.before.as_ref().map(|p| &p.id))
    .bind::<BigInt, _>(query.limit + 1)
    .load(connection)
    .await?;

    #[derive(QueryableByName)]
    struct Summary {
        #[diesel(sql_type = Text)]
        data: String,
    }
    let mut session_ids = Vec::new();
    let mut interaction_ids = Vec::new();
    for head in heads.iter().take(query.limit as usize) {
        match &head.session_id {
            Some(id) if !id.is_empty() => session_ids.push(id),
            _ => interaction_ids.push(&head.head_id),
        }
    }
    let rows: Vec<Summary> = if heads.is_empty() {
        Vec::new()
    } else {
        sql_query(include_str!("mcp_sessions_summary.sql").replace("{scope}", SCOPE))
            .bind::<Text, _>(query.organization_id)
            .bind::<Nullable<Text>, _>(query.user_id)
            .bind::<Nullable<SqlUuid>, _>(query.profile_id)
            .bind::<Nullable<Text>, _>(query.session_id)
            .bind::<Nullable<SqlUuid>, _>(query.ungrouped_id)
            .bind::<Nullable<Text>, _>(query.start_date)
            .bind::<Nullable<Text>, _>(query.end_date)
            .bind::<Array<Text>, _>(session_ids)
            .bind::<Array<Text>, _>(interaction_ids)
            .load(connection)
            .await?
    };
    Ok(Page {
        heads,
        summaries: rows.into_iter().map(|row| row.data).collect(),
    })
}
