use archestra_db::{
    PgPool,
    interaction_settlement::{
        AgentUse, LegacyTokenUsage, PoolFailover, SessionLink, Settlement, SettlementError,
    },
};
use axum::{Json, extract::State, http::StatusCode};
use diesel::result::{DatabaseErrorKind, Error};
use serde::Serialize;
use time::{UtcOffset, format_description::well_known::Rfc3339};

pub(crate) async fn mark_pool_attempt_failed_over(
    State(pool): State<PgPool>,
    Json(request): Json<PoolFailover>,
) -> Result<Json<()>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::interaction_settlement::mark_pool_attempt_failed_over(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn stamp_agent_use(
    State(pool): State<PgPool>,
    Json(request): Json<AgentUse>,
) -> Result<Json<()>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::interaction_settlement::stamp_agent_use(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn record_legacy_usage(
    State(pool): State<PgPool>,
    Json(request): Json<LegacyTokenUsage>,
) -> Result<Json<&'static str>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    match archestra_db::interaction_settlement::record_legacy_usage(&mut connection, request).await
    {
        Ok(()) => Ok(Json("written")),
        Err(Error::DatabaseError(_, info)) if info.message() == "deadlock detected" => {
            Ok(Json("deadlock"))
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

pub(crate) async fn link_session_titles(
    State(pool): State<PgPool>,
    Json(request): Json<SessionLink>,
) -> Result<Json<()>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::interaction_settlement::link_session_titles(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn admit_throughput(
    State(pool): State<PgPool>,
    Json(request): Json<archestra_db::throughput_admission::Admission>,
) -> Result<Json<archestra_db::throughput_admission::Outcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::throughput_admission::admit(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn refund_unsent(
    State(pool): State<PgPool>,
    Json(request): Json<archestra_db::minute_spend::UnsentRefund>,
) -> Result<Json<()>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::minute_spend::refund_unsent(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn reconcile_tokens(
    State(pool): State<PgPool>,
    Json(request): Json<archestra_db::minute_spend::TokenSettlement>,
) -> Result<Json<()>, StatusCode> {
    if !request.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::minute_spend::reconcile_tokens(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn minute_spend(
    State(pool): State<PgPool>,
    Json(request): Json<archestra_db::minute_spend::Settlement>,
) -> Result<Json<()>, StatusCode> {
    if !request.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    archestra_db::minute_spend::settle(&mut connection, request)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Outcome {
    Written {
        id: String,
        profile_id: Option<String>,
        created_at: String,
        record_legacy_usage: bool,
    },
    ForeignKey {
        constraint: String,
    },
    Deadlock,
}

pub(crate) async fn settle(
    State(pool): State<PgPool>,
    Json(request): Json<Settlement>,
) -> Result<Json<Outcome>, StatusCode> {
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let outcome = match archestra_db::interaction_settlement::settle(&mut connection, request).await
    {
        Ok(settled) => Outcome::Written {
            id: settled.key.id.to_string(),
            profile_id: settled.key.profile_id.map(|id| id.to_string()),
            created_at: settled
                .key
                .created_at
                .assume_offset(UtcOffset::UTC)
                .format(&Rfc3339)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
            record_legacy_usage: settled.record_legacy_usage,
        },
        Err(SettlementError::Invalid) => return Err(StatusCode::BAD_REQUEST),
        Err(SettlementError::Conflict) => return Err(StatusCode::CONFLICT),
        Err(SettlementError::Database(Error::DatabaseError(
            DatabaseErrorKind::ForeignKeyViolation,
            info,
        ))) => Outcome::ForeignKey {
            constraint: info
                .constraint_name()
                .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
                .to_owned(),
        },
        // diesel-async does not expose the SQLSTATE for deadlocks.
        Err(SettlementError::Database(Error::DatabaseError(_, info)))
            if info.message() == "deadlock detected" =>
        {
            Outcome::Deadlock
        }
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };
    Ok(Json(outcome))
}
