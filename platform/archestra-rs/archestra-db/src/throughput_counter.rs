use diesel::{
    OptionalExtension, QueryableByName,
    result::{Error, QueryResult},
    sql_query,
    sql_types::{Double, Integer, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Date, Month, OffsetDateTime, Weekday};
use uuid::Uuid;

const MINUTE_MS: f64 = 60_000.0;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(QueryableByName)]
pub(crate) struct CounterRule {
    #[diesel(sql_type = Text)]
    pub(crate) limit_type: String,
    #[diesel(sql_type = Text)]
    pub(crate) cleanup_interval: String,
    #[diesel(sql_type = Integer)]
    pub(crate) limit_value: i32,
    #[diesel(sql_type = Nullable<Text>)]
    pub(crate) epoch: Option<String>,
    #[diesel(sql_type = Double)]
    anchor: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bucket {
    version: u8,
    pub(crate) generation: String,
    pub(crate) count: f64,
    pub(crate) released: f64,
    updated_at: f64,
    rate: f64,
    interval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) period_end: Option<f64>,
}

pub(crate) fn counter_key(id: Uuid, limit_type: &str) -> String {
    let namespace = match limit_type {
        "tokens" | "tokens_per_minute" => "actual-tokens-v1-",
        _ => "",
    };
    format!("keyv:llm-throughput-counter-{namespace}{id}")
}

pub(crate) fn receipt_key(id: Uuid) -> String {
    format!("keyv:llm-throughput-receipt-actual-v1-{id}")
}

pub(crate) async fn lock_limits(
    tx: &mut AsyncPgConnection,
    ids: &mut Vec<Uuid>,
) -> QueryResult<()> {
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        sql_query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind::<Text, _>(format!("cache-entry:llm-throughput:{id}"))
            .execute(tx)
            .await?;
    }
    Ok(())
}

pub(crate) async fn clock(tx: &mut AsyncPgConnection) -> QueryResult<f64> {
    #[derive(QueryableByName)]
    struct Clock {
        #[diesel(sql_type = Double)]
        now: f64,
    }
    sql_query("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now")
        .get_result::<Clock>(tx)
        .await
        .map(|clock| clock.now)
}

pub(crate) async fn reconfigure(
    tx: &mut AsyncPgConnection,
    id: Uuid,
    rule: CounterRule,
) -> QueryResult<()> {
    match rule.limit_type.as_str() {
        "requests" | "requests_per_minute" | "tokens" | "tokens_per_minute" => (),
        "token_cost" if rule.cleanup_interval == "minute" => (),
        _ => return Ok(()),
    }
    #[derive(QueryableByName)]
    struct Stored {
        #[diesel(sql_type = Text)]
        value: String,
        #[diesel(sql_type = Double)]
        now: f64,
    }
    let key = counter_key(id, &rule.limit_type);
    let stored = sql_query(
        "SELECT value, (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now
         FROM keyv_cache WHERE key = $1 FOR UPDATE",
    )
    .bind::<Text, _>(&key)
    .get_result::<Stored>(tx)
    .await
    .optional()?;
    let Some(stored) = stored.filter(|row| !row.value.is_empty()) else {
        return Ok(());
    };
    let bucket = read_bucket(&stored.value, stored.now, &rule)?;
    sql_query("UPDATE keyv_cache SET value = $2 WHERE key = $1")
        .bind::<Text, _>(key)
        .bind::<Text, _>(encode_bucket(bucket)?)
        .execute(tx)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestReservation {
    generation: String,
    period_end: Option<f64>,
    released: f64,
    amount: f64,
}

pub(crate) enum CounterChange<'a> {
    Tokens(f64),
    Refund {
        reservation: &'a RequestReservation,
        epoch: Option<&'a str>,
    },
}

pub(crate) async fn reconcile(
    tx: &mut AsyncPgConnection,
    id: Uuid,
    change: CounterChange<'_>,
    now: f64,
) -> QueryResult<()> {
    let rule = sql_query(
        "SELECT limit_type, cleanup_interval, limit_value,
            to_char(last_cleanup, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS epoch,
            (extract(epoch FROM date_trunc('milliseconds', coalesce(last_cleanup, created_at))) * 1000)::float8 AS anchor
         FROM limits WHERE id = $1",
    )
    .bind::<SqlUuid, _>(id)
    .get_result::<CounterRule>(tx)
    .await
    .optional()?;
    let Some(rule) = rule else { return Ok(()) };
    let key = counter_key(id, &rule.limit_type);
    let mut bucket = load_bucket(tx, &key, now, &rule).await?;
    match change {
        CounterChange::Tokens(tokens) => {
            if tokens > MAX_SAFE - bucket.count {
                return Err(Error::RollbackTransaction);
            }
            bucket.count += tokens;
        }
        CounterChange::Refund {
            reservation: receipt,
            epoch,
        } => {
            if epoch != bucket.epoch.as_deref()
                || receipt
                    .period_end
                    .is_some_and(|end| now >= end || receipt.generation != bucket.generation)
            {
                return Ok(());
            }
            let remaining = if bucket.period_end.is_some() {
                receipt.amount
            } else if bucket.generation == receipt.generation {
                (receipt.amount - (bucket.released - receipt.released)).max(0.0)
            } else {
                0.0
            };
            let refund = bucket.count.min(remaining);
            bucket.count -= refund;
            bucket.released += refund;
        }
    }
    put_cache(tx, key, encode_bucket(bucket)?).await
}

pub(crate) async fn load_bucket(
    tx: &mut AsyncPgConnection,
    key: &str,
    now: f64,
    rule: &CounterRule,
) -> QueryResult<Bucket> {
    #[derive(QueryableByName)]
    struct Stored {
        #[diesel(sql_type = Text)]
        value: String,
    }
    let stored = sql_query("SELECT value FROM keyv_cache WHERE key = $1")
        .bind::<Text, _>(key)
        .get_result::<Stored>(tx)
        .await
        .optional()?;
    read_bucket(stored.as_ref().map_or("", |row| &row.value), now, rule)
}

pub(crate) async fn put_cache(
    tx: &mut AsyncPgConnection,
    key: String,
    value: String,
) -> QueryResult<()> {
    sql_query("INSERT INTO keyv_cache (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
        .bind::<Text, _>(key)
        .bind::<Text, _>(value)
        .execute(tx).await?;
    Ok(())
}

pub(crate) fn encode_bucket(bucket: Bucket) -> QueryResult<String> {
    let expires = bucket
        .period_end
        .unwrap_or_else(|| bucket.updated_at + bucket.count * MINUTE_MS / bucket.rate + 1.0);
    if !expires.is_finite() || expires > 8_640_000_000_000_000.0 {
        return Err(Error::RollbackTransaction);
    }
    Ok(json!({ "value": bucket, "expires": expires }).to_string())
}

fn read_bucket(raw: &str, now: f64, rule: &CounterRule) -> QueryResult<Bucket> {
    let minute = rule.cleanup_interval == "minute";
    let capacity = f64::from(rule.limit_value);
    let fresh = |updated_at| {
        Ok(Bucket {
            version: 2,
            generation: Uuid::new_v4().to_string(),
            count: 0.0,
            released: 0.0,
            updated_at,
            rate: capacity,
            interval: Some(rule.cleanup_interval.clone()),
            epoch: rule.epoch.clone(),
            period_end: if minute {
                None
            } else {
                Some(period_end(now, rule.anchor, &rule.cleanup_interval)?)
            },
        })
    };
    if raw.is_empty() {
        return fresh(now);
    }
    let mut entry: Value = serde_json::from_str(raw).map_err(|_| Error::RollbackTransaction)?;
    let value = entry
        .get_mut("value")
        .map(Value::take)
        .ok_or(Error::RollbackTransaction)?;
    if value.get("version").is_none()
        && let Some(window) = value["window"].as_f64()
    {
        let count = value["count"]
            .as_f64()
            .filter(|count| (0.0..=MAX_SAFE).contains(count) && count.fract() == 0.0);
        let Some(count) = count.filter(|_| window.abs() <= MAX_SAFE && window % MINUTE_MS == 0.0)
        else {
            return Err(Error::RollbackTransaction);
        };
        return Ok(Bucket {
            count: if now < window + MINUTE_MS { count } else { 0.0 },
            ..fresh(now)?
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
        .any(|number| !(0.0..=MAX_SAFE).contains(&number))
    {
        return Err(Error::RollbackTransaction);
    }
    if bucket.interval.as_deref().unwrap_or("minute") != rule.cleanup_interval
        || (bucket.interval.is_some() && bucket.epoch != rule.epoch)
    {
        return fresh(now);
    }
    let at = now.max(bucket.updated_at);
    if minute {
        // Accrued debt drains at the old rate; only future recovery uses the new cap.
        let drained = (at - bucket.updated_at) * bucket.rate / MINUTE_MS;
        if drained >= bucket.count {
            return fresh(at);
        }
        bucket.count -= drained;
        bucket.released += drained;
        bucket.interval = Some(rule.cleanup_interval.clone());
        bucket.epoch.clone_from(&rule.epoch);
    } else if now >= bucket.period_end.ok_or(Error::RollbackTransaction)? {
        return fresh(now);
    }
    bucket.updated_at = at;
    bucket.rate = capacity;
    Ok(bucket)
}

fn period_end(now: f64, anchor: f64, interval: &str) -> QueryResult<f64> {
    let duration_ms = match interval {
        "1h" => 3_600_000.0,
        "12h" => 43_200_000.0,
        "24h" => 86_400_000.0,
        "1w" => 604_800_000.0,
        _ => 0.0,
    };
    if duration_ms != 0.0 {
        return Ok(if anchor + duration_ms > now {
            anchor
        } else {
            now
        } + duration_ms);
    }
    let timestamp = |ms: f64| {
        OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
            .map_err(|_| Error::RollbackTransaction)
    };
    let current = timestamp(now)?;
    let end = match interval {
        "1m" => {
            let end = next_month(timestamp(anchor)?)?;
            if (end.unix_timestamp_nanos() / 1_000_000) as f64 > now {
                end
            } else {
                next_month(current)?
            }
        }
        "calendar_month" => next_month(
            current
                .date()
                .replace_day(1)
                .map_err(|_| Error::RollbackTransaction)?
                .midnight()
                .assume_utc(),
        )?,
        interval => {
            let date = current.date();
            let start = match interval {
                "calendar_day" => date.next_day().ok_or(Error::RollbackTransaction)?,
                "calendar_week_sunday" => date.next_occurrence(Weekday::Sunday),
                "calendar_week_monday" => date.next_occurrence(Weekday::Monday),
                _ => return Err(Error::RollbackTransaction),
            };
            start.midnight().assume_utc()
        }
    };
    Ok((end.unix_timestamp_nanos() / 1_000_000) as f64)
}

fn next_month(date: OffsetDateTime) -> QueryResult<OffsetDateTime> {
    let month = date.month().next();
    let year = date.year() + i32::from(month == Month::January);
    let next = Date::from_calendar_date(year, month, date.day().min(month.length(year)))
        .map_err(|_| Error::RollbackTransaction)?;
    Ok(next.with_time(date.time()).assume_utc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn period_boundaries_are_utc_and_month_clamped() {
        let ms = |date: OffsetDateTime| (date.unix_timestamp_nanos() / 1_000_000) as f64;
        let now = ms(datetime!(2028-01-31 12:30 UTC));
        for (interval, end) in [
            ("1m", datetime!(2028-02-29 12:30 UTC)),
            ("1h", datetime!(2028-01-31 13:30 UTC)),
            ("calendar_day", datetime!(2028-02-01 0:00 UTC)),
            ("calendar_month", datetime!(2028-02-01 0:00 UTC)),
            ("calendar_week_sunday", datetime!(2028-02-06 0:00 UTC)),
            ("calendar_week_monday", datetime!(2028-02-07 0:00 UTC)),
        ] {
            assert_eq!(period_end(now, now, interval).unwrap(), ms(end));
        }
    }
}
