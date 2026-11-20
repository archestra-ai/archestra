use archestra_db::{
    PgPool,
    audit_log::{AuditListRequest, AuditRow},
};
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use time::{UtcOffset, macros::format_description};

pub(crate) async fn list(
    State(pool): State<PgPool>,
    Json(request): Json<AuditListRequest>,
) -> Result<Json<Page>, StatusCode> {
    let query = request.query().map_err(|_| StatusCode::BAD_REQUEST)?;
    let limit = query.limit;
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let mut data = archestra_db::audit_log::list(&mut connection, query)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let has_next = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = match data.last().filter(|_| has_next) {
        Some(last) => Some(encode_cursor(last).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?),
        None => None,
    };
    Ok(Json(Page {
        data,
        pagination: Pagination {
            limit,
            has_next,
            next_cursor,
        },
    }))
}

#[derive(Serialize)]
pub(crate) struct Page {
    data: Vec<AuditRow>,
    pagination: Pagination,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    limit: u32,
    has_next: bool,
    next_cursor: Option<String>,
}

fn encode_cursor(row: &AuditRow) -> Result<String, Box<dyn std::error::Error>> {
    #[derive(Serialize)]
    struct Cursor {
        value: String,
        id: String,
    }
    // The cursor must match the public Fastify codec byte-for-byte.
    let value = row
        .event
        .created_at
        .to_offset(UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))?;
    let position = Cursor {
        value,
        id: row.event.event_sequence.to_string(),
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&position)?))
}
