use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, BigInt, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    id: Uuid,
    organization_id: String,
    owner_id: String,
    app_ids: Vec<Uuid>,
}

#[derive(QueryableByName, Serialize)]
pub struct Summary {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    description: Option<String>,
    #[diesel(sql_type = Nullable<Text>)]
    owner_name: Option<String>,
    #[diesel(sql_type = BigInt)]
    conversation_count: i64,
    #[diesel(sql_type = Text)]
    created_at: String,
}

#[derive(QueryableByName, Serialize)]
pub struct Project {
    #[diesel(embed)]
    #[serde(flatten)]
    summary: Summary,
    #[diesel(sql_type = Jsonb)]
    apps: serde_json::Value,
}

const SUMMARY_COLUMNS: &str = "p.id::text, p.name, p.description, u.name AS owner_name,
    to_char(p.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
    (SELECT count(*) FROM conversations c WHERE c.project_id = p.id
        AND c.deleted_at IS NULL) AS conversation_count";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListScope {
    organization_id: String,
    user_id: String,
    project_ids: Vec<Uuid>,
    owner_ids: Vec<String>,
    search: Option<String>,
    pub limit: i64,
}

#[derive(QueryableByName, Serialize)]
pub struct Page {
    #[diesel(sql_type = BigInt)]
    total: i64,
    #[diesel(sql_type = Jsonb)]
    rows: serde_json::Value,
}

pub async fn list(connection: &mut AsyncPgConnection, scope: ListScope) -> QueryResult<Page> {
    sql_query(format!(
        "WITH matching AS NOT MATERIALIZED (
             SELECT p.* FROM projects p
             JOIN unnest($3::uuid[], $4::text[]) AS allowed(id, owner_id)
                ON p.id = allowed.id AND p.user_id = allowed.owner_id
             WHERE p.organization_id = $1 AND p.deleted_at IS NULL
                AND ($5::text IS NULL OR position($5 IN lower(p.name)) > 0
                     OR position($5 IN lower(coalesce(p.description, ''))) > 0)
         ), page AS MATERIALIZED (
             SELECT * FROM matching ORDER BY (user_id = $2) DESC, created_at DESC, id LIMIT $6
         )
         SELECT (SELECT count(*) FROM matching) AS total,
             coalesce((SELECT jsonb_agg(to_jsonb(s) - 'owned' - 'at'
                 ORDER BY s.owned DESC, s.at DESC, s.id)
               FROM (SELECT {SUMMARY_COLUMNS}, (p.user_id = $2) AS owned, p.created_at AS at
                     FROM page p LEFT JOIN \"user\" u ON u.id = p.user_id) s), '[]'::jsonb) AS rows"
    ))
    .bind::<Text, _>(scope.organization_id)
    .bind::<Text, _>(scope.user_id)
    .bind::<Array<SqlUuid>, _>(scope.project_ids)
    .bind::<Array<Text>, _>(scope.owner_ids)
    .bind::<Nullable<Text>, _>(scope.search)
    .bind::<BigInt, _>(scope.limit)
    .get_result(connection)
    .await
}

pub async fn read(
    connection: &mut AsyncPgConnection,
    scope: Scope,
) -> QueryResult<Option<Project>> {
    sql_query(format!(
        "SELECT {SUMMARY_COLUMNS},
            (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
                'description', a.description) ORDER BY l.linked_at, a.id), '[]'::jsonb)
             FROM project_apps l JOIN apps a ON a.id = l.app_id
             WHERE l.project_id = p.id AND a.organization_id = $2
               AND a.deleted_at IS NULL AND a.id = ANY($4)) AS apps
         FROM projects p LEFT JOIN \"user\" u ON u.id = p.user_id
         WHERE p.id = $1 AND p.organization_id = $2 AND p.user_id = $3 AND p.deleted_at IS NULL"
    ))
    .bind::<SqlUuid, _>(scope.id)
    .bind::<Text, _>(scope.organization_id)
    .bind::<Text, _>(scope.owner_id)
    .bind::<Array<SqlUuid>, _>(scope.app_ids)
    .get_result(connection)
    .await
    .optional()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppLink {
    project_id: Uuid,
    app_id: Uuid,
    organization_id: String,
    linked_by: String,
}

pub async fn link_app(connection: &mut AsyncPgConnection, link: AppLink) -> QueryResult<bool> {
    #[derive(QueryableByName)]
    struct Status {
        #[diesel(sql_type = diesel::sql_types::Bool)]
        eligible: bool,
    }
    sql_query(
        "WITH eligible AS (
             SELECT p.id AS project_id, a.id AS app_id
             FROM projects p CROSS JOIN apps a
             WHERE p.id = $1 AND a.id = $2 AND p.organization_id = $3
                 AND a.organization_id = $3 AND p.deleted_at IS NULL AND a.deleted_at IS NULL
         ), linked AS (
             INSERT INTO project_apps (project_id, app_id, linked_by)
             SELECT project_id, app_id, $4 FROM eligible
             ON CONFLICT (project_id, app_id) DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM eligible) AS eligible",
    )
    .bind::<SqlUuid, _>(link.project_id)
    .bind::<SqlUuid, _>(link.app_id)
    .bind::<Text, _>(link.organization_id)
    .bind::<Text, _>(link.linked_by)
    .get_result::<Status>(connection)
    .await
    .map(|row| row.eligible)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppUnlink {
    project_id: Uuid,
    app_id: Uuid,
    organization_id: String,
}

pub async fn unlink_app(connection: &mut AsyncPgConnection, link: AppUnlink) -> QueryResult<bool> {
    sql_query(
        "DELETE FROM project_apps AS link USING projects AS p
         WHERE link.project_id = p.id AND p.id = $1 AND link.app_id = $2
             AND p.organization_id = $3 AND p.deleted_at IS NULL",
    )
    .bind::<SqlUuid, _>(link.project_id)
    .bind::<SqlUuid, _>(link.app_id)
    .bind::<Text, _>(link.organization_id)
    .execute(connection)
    .await
    .map(|deleted| deleted != 0)
}
