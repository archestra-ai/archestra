use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, BigInt, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    id: Uuid,
    organization_id: String,
    viewer: Viewer,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Viewer {
    Administrator,
    Owner { user_id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListScope {
    organization_id: String,
    user_id: Option<String>,
    profile_id: Option<Uuid>,
    external_agent_id: Option<String>,
    session_id: Option<String>,
    ungrouped_id: Option<Uuid>,
    start_date: Option<String>,
    end_date: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

#[derive(QueryableByName, Serialize)]
pub struct Page {
    #[diesel(sql_type = BigInt)]
    total: i64,
    #[diesel(sql_type = Array<Text>)]
    rows: Vec<String>,
}

pub async fn list(connection: &mut AsyncPgConnection, scope: ListScope) -> QueryResult<Page> {
    sql_query(include_str!("mcp_interaction_page.sql"))
        .bind::<Text, _>(scope.organization_id)
        .bind::<Nullable<Text>, _>(scope.user_id)
        .bind::<Nullable<SqlUuid>, _>(scope.profile_id)
        .bind::<Nullable<Text>, _>(scope.external_agent_id)
        .bind::<Nullable<Text>, _>(scope.session_id)
        .bind::<Nullable<SqlUuid>, _>(scope.ungrouped_id)
        .bind::<Nullable<Text>, _>(scope.start_date)
        .bind::<Nullable<Text>, _>(scope.end_date)
        .bind::<BigInt, _>(scope.limit)
        .bind::<BigInt, _>(scope.offset)
        .get_result(connection)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLogsScope {
    organization_id: String,
    viewer: Viewer,
    session_id: String,
    ungrouped_id: Option<Uuid>,
    pub limit: i64,
    pub offset: i64,
}

const ROW_JSON: &str = "(to_jsonb(i) || jsonb_build_object(
    'profile_id', CASE WHEN a.deleted_at IS NULL THEN a.id END,
    'created_at', to_char(i.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
    'baseline_cost', i.baseline_cost::text, 'cost', i.cost::text,
    'cache_cost', i.cache_cost::text, 'cache_savings', i.cache_savings::text
))::text";

const ORGANIZATION: &str = "COALESCE(i.profile_id, i.connector_id, i.app_id) IS NOT NULL
    AND (i.profile_id IS NULL OR a.id IS NOT NULL)
    AND (i.connector_id IS NULL OR EXISTS (
        SELECT 1 FROM knowledge_base_connectors c WHERE c.id = i.connector_id AND c.organization_id = $2
    ))
    AND (i.app_id IS NULL OR EXISTS (
        SELECT 1 FROM apps p WHERE p.id = i.app_id AND p.organization_id = $2
    ))";

impl Viewer {
    fn owner(self) -> Option<String> {
        match self {
            Self::Administrator => None,
            Self::Owner { user_id } => Some(user_id),
        }
    }
}

pub async fn session_logs(
    connection: &mut AsyncPgConnection,
    scope: SessionLogsScope,
) -> QueryResult<Page> {
    sql_query(format!(
        "WITH matching AS NOT MATERIALIZED (
            SELECT i.id, i.created_at FROM interactions i
            LEFT JOIN agents a ON a.id = i.profile_id AND a.organization_id = $2
            WHERE (i.session_id = $1 OR (i.session_id IS NULL AND i.id = $4))
              AND ($3::text IS NULL OR i.user_id = $3) AND {ORGANIZATION}
         ), page AS MATERIALIZED (
            SELECT id, created_at FROM matching ORDER BY created_at ASC, id ASC LIMIT $5 OFFSET $6
         )
         SELECT (SELECT count(*) FROM matching) AS total,
             ARRAY(SELECT {ROW_JSON} FROM page
                   JOIN interactions i ON i.id = page.id
                   LEFT JOIN agents a ON a.id = i.profile_id AND a.organization_id = $2
                   ORDER BY page.created_at ASC, page.id ASC) AS rows"
    ))
    .bind::<Text, _>(scope.session_id)
    .bind::<Text, _>(scope.organization_id)
    .bind::<Nullable<Text>, _>(scope.viewer.owner())
    .bind::<Nullable<SqlUuid>, _>(scope.ungrouped_id)
    .bind::<BigInt, _>(scope.limit)
    .bind::<BigInt, _>(scope.offset)
    .get_result(connection)
    .await
}

pub async fn read(connection: &mut AsyncPgConnection, scope: Scope) -> QueryResult<Option<String>> {
    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Text)]
        data: String,
    }
    sql_query(format!(
        "SELECT {ROW_JSON} AS data
         FROM interactions i
         LEFT JOIN agents a ON a.id = i.profile_id AND a.organization_id = $2
         WHERE i.id = $1 AND ($3::text IS NULL OR i.user_id = $3) AND {ORGANIZATION}"
    ))
    .bind::<SqlUuid, _>(scope.id)
    .bind::<Text, _>(scope.organization_id)
    .bind::<Nullable<Text>, _>(scope.viewer.owner())
    .get_result::<Row>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.data))
}
