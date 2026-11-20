use diesel::{
    QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{BigInt, Text},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::Serialize;

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[diesel(sql_type = BigInt)]
    total_input_tokens: i64,
    #[diesel(sql_type = BigInt)]
    total_output_tokens: i64,
}

pub async fn agent_token_usage(
    connection: &mut AsyncPgConnection,
    agent_id: &str,
) -> QueryResult<TokenUsage> {
    sql_query(
        "SELECT COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens
           FROM interactions WHERE profile_id = $1::uuid",
    )
    .bind::<Text, _>(agent_id)
    .get_result(connection)
    .await
}
