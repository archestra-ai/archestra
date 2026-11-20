use diesel::{result::QueryResult, sql_query, sql_types::Jsonb};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde_json::Value;

pub(crate) async fn ensure_vocabulary(
    tx: &mut AsyncPgConnection,
    labels: &Value,
) -> QueryResult<()> {
    sql_query(
        "WITH keys AS (
             INSERT INTO label_keys (key) SELECT key FROM jsonb_each_text($1)
             ORDER BY key ON CONFLICT (key) DO NOTHING
         )
         INSERT INTO label_values (value) SELECT DISTINCT value FROM jsonb_each_text($1)
         ORDER BY value ON CONFLICT (value) DO NOTHING",
    )
    .bind::<Jsonb, _>(labels)
    .execute(tx)
    .await
    .map(|_| ())
}
