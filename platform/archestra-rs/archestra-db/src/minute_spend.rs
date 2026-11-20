use diesel::{
    OptionalExtension, QueryableByName,
    result::Error,
    sql_query,
    sql_types::{Double, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::throughput_counter::{self, CounterChange, RequestReservation};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MINUTE_MS: f64 = 60_000.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settlement {
    receipt_id: Uuid,
    limit_ids: Vec<Uuid>,
    spend: f64,
    billing_mode: BillingMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenSettlement {
    receipt_id: Uuid,
    limit_ids: Vec<Uuid>,
    tokens: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsentRefund {
    receipt_id: Uuid,
    limit_ids: Vec<Uuid>,
}

impl TokenSettlement {
    pub fn valid(&self) -> bool {
        self.tokens as f64 <= MAX_SAFE
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum BillingMode {
    Metered,
    Subscription,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    expires_at: Option<f64>,
    limits: Vec<ReceiptLimit>,
}

#[derive(Deserialize)]
struct ReceiptLimit {
    id: Uuid,
    #[serde(default)]
    money: bool,
    #[serde(default)]
    token: bool,
    #[serde(flatten)]
    reservation: Option<RequestReservation>,
    epoch: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Entry<T> {
    value: T,
    expires: f64,
}

#[derive(QueryableByName)]
struct CacheValue {
    #[diesel(sql_type = Text)]
    value: String,
}

#[derive(QueryableByName)]
struct Rule {
    #[diesel(sql_type = Double)]
    capacity: f64,
    #[diesel(sql_type = Nullable<Text>)]
    epoch: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    version: u8,
    generation: String,
    count: f64,
    released: f64,
    updated_at: f64,
    rate: f64,
    interval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<String>,
}

impl Settlement {
    pub fn valid(&self) -> bool {
        (0.0..=MAX_SAFE).contains(&self.spend)
    }
}

pub async fn settle(conn: &mut AsyncPgConnection, request: Settlement) -> Result<(), Error> {
    conn.transaction(async move |tx| {
        let Some((receipt, now)) =
            take_receipt(tx, request.receipt_id, request.limit_ids, ReceiptUse::Spend).await?
        else {
            return Ok(());
        };
        if matches!(request.billing_mode, BillingMode::Subscription) {
            return Ok(());
        }
        for rule in receipt.limits.into_iter().filter(|rule| rule.money) {
            charge(tx, rule, request.spend, now).await?;
        }
        Ok(())
    })
    .await
}

pub async fn reconcile_tokens(
    conn: &mut AsyncPgConnection,
    request: TokenSettlement,
) -> Result<(), Error> {
    conn.transaction(async move |tx| {
        let Some((receipt, now)) = take_receipt(
            tx,
            request.receipt_id,
            request.limit_ids,
            ReceiptUse::Tokens,
        )
        .await?
        else {
            return Ok(());
        };
        for rule in receipt
            .limits
            .into_iter()
            .filter(|rule| rule.token && !rule.money)
        {
            throughput_counter::reconcile(
                tx,
                rule.id,
                CounterChange::Tokens(request.tokens as f64),
                now,
            )
            .await?;
        }
        Ok(())
    })
    .await
}

pub async fn refund_unsent(
    conn: &mut AsyncPgConnection,
    request: UnsentRefund,
) -> Result<(), Error> {
    conn.transaction(async move |tx| {
        let Some((receipt, now)) = take_receipt(
            tx,
            request.receipt_id,
            request.limit_ids,
            ReceiptUse::Unsent,
        )
        .await?
        else {
            return Ok(());
        };
        for rule in receipt
            .limits
            .into_iter()
            .filter(|rule| !rule.token && !rule.money)
        {
            let reservation = rule.reservation.ok_or(Error::RollbackTransaction)?;
            throughput_counter::reconcile(
                tx,
                rule.id,
                CounterChange::Refund {
                    reservation: &reservation,
                    epoch: rule.epoch.as_deref(),
                },
                now,
            )
            .await?;
        }
        Ok(())
    })
    .await
}

enum ReceiptUse {
    Spend,
    Tokens,
    Unsent,
}

async fn take_receipt(
    tx: &mut AsyncPgConnection,
    id: Uuid,
    mut limit_ids: Vec<Uuid>,
    operation: ReceiptUse,
) -> Result<Option<(Receipt, f64)>, Error> {
    throughput_counter::lock_limits(tx, &mut limit_ids).await?;
    let key = throughput_counter::receipt_key(id);
    let spend_key = format!("{key}:spend");
    if matches!(operation, ReceiptUse::Unsent) {
        sql_query("DELETE FROM keyv_cache WHERE key = $1")
            .bind::<Text, _>(&spend_key)
            .execute(tx)
            .await?;
    }
    let stored = sql_query("DELETE FROM keyv_cache WHERE key = $1 RETURNING value")
        .bind::<Text, _>(match operation {
            ReceiptUse::Spend => spend_key,
            ReceiptUse::Tokens | ReceiptUse::Unsent => key,
        })
        .get_result::<CacheValue>(tx)
        .await
        .optional()?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let receipt = decode::<Receipt>(&stored.value)?;
    if receipt
        .limits
        .iter()
        .any(|rule| limit_ids.binary_search(&rule.id).is_err())
    {
        return Err(Error::RollbackTransaction);
    }
    let now = throughput_counter::clock(tx).await?;
    Ok(receipt
        .expires_at
        .filter(|expires| *expires > now)
        .map(|_| (receipt, now)))
}

async fn charge(
    tx: &mut AsyncPgConnection,
    receipt: ReceiptLimit,
    spend: f64,
    now: f64,
) -> Result<(), Error> {
    let rule = sql_query(
        "SELECT limit_value::float8 AS capacity,
           to_char(last_cleanup, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS epoch
         FROM limits WHERE id = $1 AND limit_type = 'token_cost' AND cleanup_interval = 'minute'",
    )
    .bind::<SqlUuid, _>(receipt.id)
    .get_result::<Rule>(tx)
    .await
    .optional()?;
    let Some(rule) = rule.filter(|rule| rule.epoch == receipt.epoch) else {
        return Ok(());
    };
    let key = format!("keyv:llm-throughput-counter-{}", receipt.id);
    let raw = sql_query("SELECT value FROM keyv_cache WHERE key = $1")
        .bind::<Text, _>(&key)
        .get_result::<CacheValue>(tx)
        .await
        .optional()?;
    let mut bucket = read_bucket(raw.map(|row| row.value).as_deref(), now, &rule)?;
    if spend > MAX_SAFE - bucket.count {
        return Err(Error::RollbackTransaction);
    }
    bucket.count += spend;
    let expires = bucket.updated_at + bucket.count * MINUTE_MS / bucket.rate + 1.0;
    if !expires.is_finite() || expires > 8_640_000_000_000_000.0 {
        return Err(Error::RollbackTransaction);
    }
    let encoded = serde_json::to_string(&Entry {
        value: bucket,
        expires,
    })
    .map_err(|_| Error::RollbackTransaction)?;
    sql_query("INSERT INTO keyv_cache (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
        .bind::<Text, _>(key).bind::<Text, _>(encoded).execute(tx).await?;
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, Error> {
    serde_json::from_str::<Entry<T>>(raw)
        .map(|entry| entry.value)
        .map_err(|_| Error::RollbackTransaction)
}

fn read_bucket(raw: Option<&str>, now: f64, rule: &Rule) -> Result<Bucket, Error> {
    let fresh = |at| Bucket {
        version: 2,
        generation: Uuid::new_v4().to_string(),
        count: 0.0,
        released: 0.0,
        updated_at: at,
        rate: rule.capacity,
        interval: Some("minute".into()),
        epoch: rule.epoch.clone(),
    };
    let Some(raw) = raw else {
        return Ok(fresh(now));
    };
    let value = decode::<Value>(raw)?;
    if value.get("version").is_none() {
        let window = value["window"]
            .as_f64()
            .filter(|n| n.abs() <= MAX_SAFE && n % MINUTE_MS == 0.0);
        let count = value["count"]
            .as_f64()
            .filter(|n| (0.0..=MAX_SAFE).contains(n) && n.fract() == 0.0);
        let (Some(window), Some(count)) = (window, count) else {
            return Err(Error::RollbackTransaction);
        };
        return Ok(Bucket {
            count: if now < window + MINUTE_MS { count } else { 0.0 },
            ..fresh(now)
        });
    }
    let mut bucket: Bucket =
        serde_json::from_value(value).map_err(|_| Error::RollbackTransaction)?;
    if bucket.version != 2
        || bucket.rate <= 0.0
        || [
            bucket.count,
            bucket.released,
            bucket.updated_at,
            bucket.rate,
        ]
        .into_iter()
        .any(|n| !(0.0..=MAX_SAFE).contains(&n))
    {
        return Err(Error::RollbackTransaction);
    }
    if bucket.interval.as_deref().unwrap_or("minute") != "minute"
        || (bucket.interval.is_some() && bucket.epoch != rule.epoch)
    {
        return Ok(fresh(now));
    }
    let at = now.max(bucket.updated_at);
    let drained = bucket
        .count
        .min((at - bucket.updated_at) * bucket.rate / MINUTE_MS);
    if drained >= bucket.count {
        return Ok(fresh(at));
    }
    bucket.count -= drained;
    bucket.released += drained;
    bucket.updated_at = at;
    bucket.rate = rule.capacity;
    bucket.interval = Some("minute".into());
    bucket.epoch.clone_from(&rule.epoch);
    Ok(bucket)
}
