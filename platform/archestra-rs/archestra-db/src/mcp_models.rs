use diesel::{
    QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, Text},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelScope {
    organization_id: String,
    api_key_ids: Vec<String>,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedModel {
    #[diesel(sql_type = Text)]
    api_key_id: String,
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
}

pub async fn list(
    connection: &mut AsyncPgConnection,
    scope: ModelScope,
) -> QueryResult<Vec<LinkedModel>> {
    sql_query(
        "SELECT k.id::text AS api_key_id, m.id::text, m.model_id AS name
         FROM chat_api_keys k
         JOIN api_key_models l ON l.api_key_id = k.id
         JOIN models m ON m.id = l.model_id
         WHERE k.organization_id = $1 AND k.id = ANY($2::text[]::uuid[])
         ORDER BY l.created_at, l.id",
    )
    .bind::<Text, _>(scope.organization_id)
    .bind::<Array<Text>, _>(scope.api_key_ids)
    .load(connection)
    .await
}
