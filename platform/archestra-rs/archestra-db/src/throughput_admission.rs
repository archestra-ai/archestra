use diesel::{
    QueryableByName,
    result::{Error, QueryResult},
    sql_query,
    sql_types::{Array, Jsonb, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::throughput_counter::{self as counters, CounterRule};

const RECEIPT_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Admission {
    limit_ids: Vec<Uuid>,
    entities: Vec<Entity>,
    models: Vec<String>,
    subscription: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entity {
    entity_type: String,
    entity_id: String,
}

#[derive(QueryableByName)]
struct Rule {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Text)]
    entity_type: String,
    #[diesel(sql_type = Text)]
    entity_id: String,
    #[diesel(sql_type = Text)]
    behavior: String,
    #[diesel(embed)]
    counter: CounterRule,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reservation {
    id: Uuid,
    expires_at: f64,
    subscription: bool,
    limits: Vec<ReservedLimit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReservedLimit {
    id: Uuid,
    token: bool,
    money: bool,
    generation: String,
    released: f64,
    amount: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    period_end: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Denial {
    entity_type: String,
    limit_type: String,
    oversized: bool,
    retry_after: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: Uuid,
    entity_type: String,
    entity_id: String,
    limit_type: String,
    limit_value: i32,
    cleanup_interval: String,
    behavior: String,
    exceeded: bool,
    usage: f64,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Decision {
    Allowed { reservation: Option<Reservation> },
    Denied { denied: Denial },
}

#[derive(Serialize)]
pub struct Outcome {
    #[serde(flatten)]
    decision: Decision,
    observations: Vec<Observation>,
}

pub async fn admit(conn: &mut AsyncPgConnection, mut input: Admission) -> QueryResult<Outcome> {
    conn.transaction(async move |tx| {
        counters::lock_limits(tx, &mut input.limit_ids).await?;
        let rules = sql_query(
            "SELECT l.id, l.entity_type, l.entity_id, l.behavior, l.limit_type, l.cleanup_interval, l.limit_value,
                    to_char(l.last_cleanup, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS epoch,
                    (extract(epoch FROM date_trunc('milliseconds', coalesce(l.last_cleanup, l.created_at))) * 1000)::float8 AS anchor
             FROM limits l WHERE l.id = ANY($1)
               AND (l.limit_type IN ('requests', 'requests_per_minute', 'tokens', 'tokens_per_minute')
                    OR (l.limit_type = 'token_cost' AND l.cleanup_interval = 'minute'))
               AND (l.model IS NULL OR l.model = '[]'::jsonb OR l.model ?| $2)
               AND EXISTS (
                   SELECT FROM jsonb_array_elements($3) e
                   WHERE e->>'entityType' = l.entity_type AND e->>'entityId' = l.entity_id
               )
             ORDER BY l.id",
        )
        .bind::<Array<SqlUuid>, _>(input.limit_ids)
        .bind::<Array<Text>, _>(input.models)
        .bind::<Jsonb, _>(serde_json::to_value(input.entities).map_err(|_| Error::RollbackTransaction)?)
        .load::<Rule>(tx)
        .await?;
        if rules.is_empty() {
            return Ok(Outcome { decision: Decision::Allowed { reservation: None }, observations: vec![] });
        }
        let now = counters::clock(tx).await?;
        let mut observed = Vec::with_capacity(rules.len());
        let mut pending = Vec::with_capacity(rules.len());
        let mut denied: Option<Denial> = None;
        for rule in rules {
            let counter = rule.counter;
            let capacity = f64::from(counter.limit_value);
            if capacity <= 0.0 {
                return Err(Error::RollbackTransaction);
            }
            let key = counters::counter_key(rule.id, &counter.limit_type);
            let bucket = counters::load_bucket(tx, &key, now, &counter).await?;
            let token = matches!(counter.limit_type.as_str(), "tokens" | "tokens_per_minute");
            let money = counter.limit_type == "token_cost";
            let amount = u8::from(!(token || money));
            if !(money && input.subscription) {
                let shortage = (bucket.count + f64::from(amount)) - capacity;
                let exceeded = shortage > 0.0 || (amount == 0 && shortage == 0.0);
                if exceeded && rule.behavior != "soft" {
                    let retry_after = bucket.period_end
                        .map_or(shortage * 60.0 / capacity, |end| (end - now) / 1000.0)
                        .ceil().max(1.0);
                    let preferred = match &denied {
                        Some(previous) if previous.limit_type == "token_cost" => false,
                        Some(previous) => money || retry_after > previous.retry_after,
                        None => true,
                    };
                    if preferred {
                        denied = Some(Denial { entity_type: rule.entity_type.clone(),
                            limit_type: counter.limit_type.clone(), oversized: false, retry_after });
                    }
                }
                observed.push(Observation {
                    id: rule.id, entity_type: rule.entity_type, entity_id: rule.entity_id,
                    limit_type: counter.limit_type, limit_value: counter.limit_value,
                    cleanup_interval: counter.cleanup_interval, behavior: rule.behavior,
                    exceeded, usage: bucket.count,
                });
            }
            let reserved = ReservedLimit {
                id: rule.id, token, money, amount, epoch: counter.epoch,
                period_end: bucket.period_end, generation: bucket.generation.clone(), released: bucket.released,
            };
            pending.push((key, bucket, reserved));
        }
        let mut limits = Vec::with_capacity(pending.len());
        for (key, mut bucket, limit) in pending {
            if denied.is_none() {
                bucket.count += f64::from(limit.amount);
            }
            counters::put_cache(tx, key, counters::encode_bucket(bucket)?).await?;
            limits.push(limit);
        }
        let decision = if let Some(denied) = denied {
            Decision::Denied { denied }
        } else {
            let reservation = Reservation { id: Uuid::new_v4(), expires_at: now + RECEIPT_TTL_MS,
                subscription: input.subscription, limits };
            let key = counters::receipt_key(reservation.id);
            let value = json!({"value": reservation, "expires": reservation.expires_at}).to_string();
            if reservation.limits.iter().any(|limit| limit.money) {
                counters::put_cache(tx, format!("{key}:spend"), value.clone()).await?;
            }
            counters::put_cache(tx, key, value).await?;
            Decision::Allowed { reservation: Some(reservation) }
        };
        Ok(Outcome { decision, observations: observed })
    }).await
}
