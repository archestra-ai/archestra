use diesel::prelude::*;
use diesel::sql_types::{BigInt, Bool, Timestamp};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use time::PrimitiveDateTime;

#[derive(QueryableByName)]
struct Hour {
    #[diesel(sql_type = Timestamp)]
    hour: PrimitiveDateTime,
}

#[derive(QueryableByName)]
struct MarkedHour {
    #[diesel(sql_type = Timestamp)]
    hour: PrimitiveDateTime,
    #[diesel(sql_type = BigInt)]
    version: i64,
    #[diesel(sql_type = Bool)]
    settling: bool,
}

pub enum Work {
    MarkedFirst,
    UnrolledFirst,
}

pub enum Progress {
    Recomputed,
    Rolled,
    Idle,
}

pub async fn step(connection: &mut AsyncPgConnection, work: Work) -> QueryResult<Progress> {
    connection
        .transaction(async |connection| {
            // Bound each statement well below the claim recovery interval.
            diesel::sql_query("SET LOCAL statement_timeout = '15s'")
                .execute(connection)
                .await?;
            diesel::sql_query(
                "SELECT pg_advisory_xact_lock(hashtextextended('llm_usage_rollup', 0))",
            )
            .execute(connection)
            .await?;
            match work {
                Work::MarkedFirst => {
                    if recompute_marked(connection).await? {
                        Ok(Progress::Recomputed)
                    } else if roll_next(connection).await? {
                        Ok(Progress::Rolled)
                    } else {
                        Ok(Progress::Idle)
                    }
                }
                Work::UnrolledFirst => {
                    if roll_next(connection).await? {
                        Ok(Progress::Rolled)
                    } else if recompute_marked(connection).await? {
                        Ok(Progress::Recomputed)
                    } else {
                        Ok(Progress::Idle)
                    }
                }
            }
        })
        .await
}

async fn roll_next(connection: &mut AsyncPgConnection) -> QueryResult<bool> {
    let next = diesel::sql_query(
        "SELECT next.hour FROM (
            SELECT COALESCE(
                (SELECT rolled_through FROM llm_usage_rollup_state WHERE id = 1),
                (SELECT date_trunc('hour', min(created_at)) FROM interactions)
            ) AS hour
        ) AS next
        WHERE next.hour + interval '1 hour' <= (now() - interval '15 minutes')::timestamp",
    )
    .get_result::<Hour>(connection)
    .await
    .optional()?;
    let Some(Hour { hour }) = next else {
        return Ok(false);
    };
    diesel::sql_query(
        "INSERT INTO llm_usage_rollup_state (id, rolled_through)
         VALUES (1, $1 + interval '1 hour')
         ON CONFLICT (id) DO UPDATE SET rolled_through = excluded.rolled_through",
    )
    .bind::<Timestamp, _>(hour)
    .execute(connection)
    .await?;
    recompute(connection, hour).await?;
    diesel::sql_query(
        "INSERT INTO llm_usage_rollup_dirty AS dirty (hour, settle_after)
         VALUES ($1, pg_snapshot_xmax(pg_current_snapshot())::text::bigint)
         ON CONFLICT (hour) DO UPDATE SET version = dirty.version + 1, settle_after = NULL",
    )
    .bind::<Timestamp, _>(hour)
    .execute(connection)
    .await?;
    Ok(true)
}

async fn recompute_marked(connection: &mut AsyncPgConnection) -> QueryResult<bool> {
    let marked = diesel::sql_query(
        "SELECT hour, version, settle_after IS NOT NULL AS settling
         FROM llm_usage_rollup_dirty
         WHERE (settle_after IS NULL OR settle_after <= pg_snapshot_xmin(pg_current_snapshot())::text::bigint)
           AND hour < (SELECT rolled_through FROM llm_usage_rollup_state WHERE id = 1)
         ORDER BY hour LIMIT 1",
    )
    .get_result::<MarkedHour>(connection)
    .await
    .optional()?;
    let Some(marked) = marked else {
        return Ok(false);
    };
    recompute(connection, marked.hour).await?;
    let settle = match marked.settling {
        true => "DELETE FROM llm_usage_rollup_dirty WHERE hour = $1 AND version = $2",
        false => {
            "UPDATE llm_usage_rollup_dirty
                  SET settle_after = pg_snapshot_xmax(pg_current_snapshot())::text::bigint
                  WHERE hour = $1 AND version = $2"
        }
    };
    diesel::sql_query(settle)
        .bind::<Timestamp, _>(marked.hour)
        .bind::<BigInt, _>(marked.version)
        .execute(connection)
        .await?;
    Ok(true)
}

async fn recompute(connection: &mut AsyncPgConnection, hour: PrimitiveDateTime) -> QueryResult<()> {
    diesel::sql_query("DELETE FROM llm_usage_hourly WHERE hour = $1")
        .bind::<Timestamp, _>(hour)
        .execute(connection)
        .await?;
    diesel::sql_query(include_str!("llm_usage_rollup/hourly.sql"))
        .bind::<Timestamp, _>(hour)
        .execute(connection)
        .await?;
    diesel::sql_query("DELETE FROM llm_usage_daily WHERE hour = date_trunc('day', $1::timestamp)")
        .bind::<Timestamp, _>(hour)
        .execute(connection)
        .await?;
    diesel::sql_query(include_str!("llm_usage_rollup/daily.sql"))
        .bind::<Timestamp, _>(hour)
        .execute(connection)
        .await?;
    Ok(())
}
