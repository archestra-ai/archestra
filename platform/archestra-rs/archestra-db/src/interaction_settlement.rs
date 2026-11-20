use diesel::{
    prelude::*,
    result::Error,
    sql_types::{Array, BigInt, Bool, Jsonb, Nullable, Text, Timestamp, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::{OffsetDateTime, PrimitiveDateTime, UtcOffset};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settlement {
    row: Map<String, Value>,
    receipt: Option<Receipt>,
    routing_usage: Option<RoutingUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    interaction_id: Uuid,
    fingerprint: String,
    usage: Value,
    organization_id: Option<String>,
    environment_id: Option<Uuid>,
    user_id: Option<String>,
    billing_team_id: Option<String>,
    billing_mode: String,
    attribution_labels: Option<Value>,
    entities: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoutingUsage {
    interaction_id: Uuid,
    decision_id: Uuid,
    input: i64,
    cache_read: i64,
    cache_write: i64,
    cache_write1h: i64,
    output: i64,
    estimated: bool,
}

#[derive(QueryableByName)]
pub struct InteractionKey {
    #[diesel(sql_type = SqlUuid)]
    pub id: Uuid,
    #[diesel(sql_type = Nullable<SqlUuid>)]
    pub profile_id: Option<Uuid>,
    #[diesel(sql_type = Timestamp)]
    pub created_at: PrimitiveDateTime,
}

pub struct SettledInteraction {
    pub key: InteractionKey,
    pub record_legacy_usage: bool,
}

#[derive(Debug)]
pub enum SettlementError {
    Database(Error),
    Conflict,
    Invalid,
}

impl From<Error> for SettlementError {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

pub async fn settle(
    connection: &mut AsyncPgConnection,
    request: Settlement,
) -> Result<SettledInteraction, SettlementError> {
    let id = request
        .row
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or(SettlementError::Invalid)?;
    if request
        .receipt
        .as_ref()
        .is_some_and(|receipt| receipt.interaction_id != id)
        || request
            .routing_usage
            .as_ref()
            .is_some_and(|usage| usage.interaction_id != id)
    {
        return Err(SettlementError::Invalid);
    }
    let has_unreceipted_tokens = request.receipt.is_none()
        && ["input_tokens", "output_tokens"].into_iter().any(|column| {
            request
                .row
                .get(column)
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
                .is_some_and(|tokens| tokens != 0)
        });
    connection.transaction(async move |tx| {
        let claimed = match &request.receipt {
            Some(receipt) => {
                let claimed = claim(tx, receipt).await?;
                if let Some(existing) = existing(tx, id).await? {
                    return if claimed { Err(SettlementError::Conflict) } else {
                        Ok(SettledInteraction { key: existing, record_legacy_usage: false })
                    };
                }
                claimed
            }
            None => false,
        };
        if let Some(routing) = request.routing_usage {
            diesel::sql_query(
                "INSERT INTO routing_usage (interaction_id, decision_id, input, cache_read, cache_write, cache_write_1h, output, estimated)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (interaction_id) DO NOTHING",
            )
            .bind::<SqlUuid, _>(id)
            .bind::<SqlUuid, _>(routing.decision_id)
            .bind::<BigInt, _>(routing.input)
            .bind::<BigInt, _>(routing.cache_read)
            .bind::<BigInt, _>(routing.cache_write)
            .bind::<BigInt, _>(routing.cache_write1h)
            .bind::<BigInt, _>(routing.output)
            .bind::<Bool, _>(routing.estimated)
            .execute(tx).await?;
        }
        let key: InteractionKey = diesel::sql_query(
            "SELECT id, profile_id, created_at FROM interaction_user_activity_append($1)",
        )
        .bind::<Jsonb, _>(Value::Object(request.row))
        .get_result(tx).await?;
        if let Some(receipt) = request.receipt.filter(|receipt| claimed && receipt.billing_mode != "subscription") {
            diesel::sql_query(include_str!("interaction_settlement_limits.sql"))
                .bind::<Jsonb, _>(receipt.entities)
                .bind::<Jsonb, _>(receipt.usage)
                .execute(tx).await?;
        }
        // The append function returns the row even on ON CONFLICT replay.
        // Only its inserting transaction may schedule the legacy increment.
        let record_legacy_usage = if has_unreceipted_tokens {
            #[derive(QueryableByName)]
            struct Inserted {
                #[diesel(sql_type = Bool)]
                inserted: bool,
            }
            diesel::sql_query("SELECT xmin = pg_current_xact_id()::xid AS inserted FROM interactions WHERE id = $1")
                .bind::<SqlUuid, _>(key.id)
                .get_result::<Inserted>(tx)
                .await?
                .inserted
        } else { false };
        Ok(SettledInteraction { key, record_legacy_usage })
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyTokenUsage {
    agent_id: Uuid,
    team_ids: Vec<String>,
    entities: Vec<UsageEntity>,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageEntity {
    entity_type: String,
    entity_id: String,
}

pub async fn record_legacy_usage(
    conn: &mut AsyncPgConnection,
    request: LegacyTokenUsage,
) -> QueryResult<()> {
    diesel::sql_query(include_str!("interaction_legacy_usage.sql"))
        .bind::<SqlUuid, _>(request.agent_id)
        .bind::<Array<Text>, _>(request.team_ids)
        .bind::<Jsonb, _>(
            serde_json::to_value(request.entities).map_err(|_| Error::RollbackTransaction)?,
        )
        .bind::<Text, _>(request.model)
        .bind::<BigInt, _>(request.input_tokens)
        .bind::<BigInt, _>(request.output_tokens)
        .execute(conn)
        .await
        .map(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolFailover {
    interaction_id: Uuid,
}

pub async fn mark_pool_attempt_failed_over(
    connection: &mut AsyncPgConnection,
    request: PoolFailover,
) -> QueryResult<()> {
    diesel::sql_query(
        "UPDATE interactions SET attempt_outcome = 'failed_over'
         WHERE id = $1 AND model_pool_id IS NOT NULL AND attempt_outcome = 'failed'",
    )
    .bind::<SqlUuid, _>(request.interaction_id)
    .execute(connection)
    .await
    .map(|_| ())
}

async fn existing(tx: &mut AsyncPgConnection, id: Uuid) -> QueryResult<Option<InteractionKey>> {
    diesel::sql_query("SELECT id, profile_id, created_at FROM interactions WHERE id = $1")
        .bind::<SqlUuid, _>(id)
        .get_result(tx)
        .await
        .optional()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUse {
    agent_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    used_at: OffsetDateTime,
}

pub async fn stamp_agent_use(conn: &mut AsyncPgConnection, input: AgentUse) -> QueryResult<()> {
    let utc = input.used_at.to_offset(UtcOffset::UTC);
    diesel::sql_query(
        "UPDATE agents SET last_used_at = $2
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2)",
    )
    .bind::<SqlUuid, _>(input.agent_id)
    .bind::<Timestamp, _>(PrimitiveDateTime::new(utc.date(), utc.time()))
    .execute(conn)
    .await
    .map(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLink {
    main_interaction_id: Uuid,
    titles: Vec<TitleCandidate>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TitleCandidate {
    id: Uuid,
    session_id: Option<String>,
}

pub async fn link_session_titles(
    conn: &mut AsyncPgConnection,
    request: SessionLink,
) -> QueryResult<()> {
    let candidates =
        serde_json::to_value(request.titles).map_err(|_| Error::RollbackTransaction)?;
    diesel::sql_query(
        "WITH main AS (
             SELECT id, profile_id, user_id, session_id, session_source
             FROM interactions WHERE id = $1 AND session_id IS NOT NULL
         ), moved AS (
             UPDATE interactions AS title
             SET session_id = main.session_id, session_source = main.session_source
             FROM main, jsonb_to_recordset($2) AS candidate(id uuid, \"sessionId\" text)
             WHERE title.id = candidate.id AND title.id <> main.id
               AND title.profile_id = main.profile_id
               AND title.user_id IS NOT DISTINCT FROM main.user_id
               AND title.parent_id IS NULL AND title.encrypted_chat_conversation_id IS NULL
               AND title.session_id IS NOT DISTINCT FROM candidate.\"sessionId\"
               AND title.session_id IS DISTINCT FROM main.session_id
               AND (title.session_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM interactions other
                   WHERE other.session_id = candidate.\"sessionId\" AND other.id <> candidate.id
               ))
             RETURNING title.id, main.session_id
         )
         DELETE FROM interaction_session_heads AS head USING moved
         WHERE head.last_interaction_id = moved.id AND head.session_key <> moved.session_id",
    )
    .bind::<SqlUuid, _>(request.main_interaction_id)
    .bind::<Jsonb, _>(candidates)
    .execute(conn)
    .await
    .map(|_| ())
}

async fn claim(tx: &mut AsyncPgConnection, receipt: &Receipt) -> Result<bool, SettlementError> {
    let inserted = diesel::sql_query(
        "INSERT INTO interaction_billing (interaction_id, fingerprint, usage, organization_id, environment_id,
             user_id, billing_team_id, billing_mode, attribution_labels, entities)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
    )
    .bind::<SqlUuid, _>(receipt.interaction_id)
    .bind::<Text, _>(&receipt.fingerprint)
    .bind::<Jsonb, _>(&receipt.usage)
    .bind::<Nullable<Text>, _>(&receipt.organization_id)
    .bind::<Nullable<SqlUuid>, _>(receipt.environment_id)
    .bind::<Nullable<Text>, _>(&receipt.user_id)
    .bind::<Nullable<Text>, _>(&receipt.billing_team_id)
    .bind::<Text, _>(&receipt.billing_mode)
    .bind::<Nullable<Jsonb>, _>(&receipt.attribution_labels)
    .bind::<Jsonb, _>(&receipt.entities)
    .execute(tx).await?;
    if inserted == 1 {
        return Ok(true);
    }
    #[derive(QueryableByName)]
    struct Matches {
        #[diesel(sql_type = Bool)]
        matches: bool,
    }
    let existing = diesel::sql_query(
        "SELECT fingerprint = $2 AS matches FROM interaction_billing WHERE interaction_id = $1",
    )
    .bind::<SqlUuid, _>(receipt.interaction_id)
    .bind::<Text, _>(&receipt.fingerprint)
    .get_result::<Matches>(tx)
    .await
    .optional()?;
    match existing {
        Some(Matches { matches: true }) => Ok(false),
        _ => Err(SettlementError::Conflict),
    }
}
