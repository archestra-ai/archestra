use std::panic::AssertUnwindSafe;

use archestra_db::audit_log::AuditListRequest;
use archestra_db::{PgPool, pilot_pool};
use futures_util::FutureExt;
use napi_derive::napi;
use tokio::sync::OnceCell;

#[napi]
pub async fn list_audit_rows(database_url: String, input_json: String) -> napi::Result<String> {
    AssertUnwindSafe(list(&database_url, &input_json))
        .catch_unwind()
        .await
        .map_err(|_| napi::Error::from_reason("audit repository panicked"))?
}

static POOL: OnceCell<(String, PgPool)> = OnceCell::const_new();

async fn list(database_url: &str, input_json: &str) -> napi::Result<String> {
    let input: AuditListRequest = serde_json::from_str(input_json)
        .map_err(|_| napi::Error::from_reason("invalid audit query"))?;
    let query = input
        .query()
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let (configured_url, pool) = POOL
        .get_or_try_init(async || {
            let pool = pilot_pool(database_url)
                .await
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            Ok::<_, napi::Error>((database_url.to_owned(), pool))
        })
        .await?;
    if configured_url != database_url {
        return Err(napi::Error::from_reason(
            "audit database changed after initialization",
        ));
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| napi::Error::from_reason("could not acquire audit database connection"))?;
    let rows = archestra_db::audit_log::list(&mut connection, query)
        .await
        .map_err(|_| napi::Error::from_reason("audit database query failed"))?;
    serde_json::to_string(&rows)
        .map_err(|_| napi::Error::from_reason("could not encode audit query results"))
}
