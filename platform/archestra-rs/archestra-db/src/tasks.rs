use diesel::dsl::sql;
use diesel::prelude::*;
use diesel::sql_types::{Array, BigInt, Integer, Jsonb, Text, Timestamp, Uuid as SqlUuid};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use uuid::Uuid;

#[derive(Debug, diesel::QueryableByName)]
pub struct TaskClaim {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Integer)]
    attempt: i32,
    #[diesel(sql_type = Text)]
    pub task_type: String,
    #[diesel(sql_type = Jsonb)]
    pub payload: serde_json::Value,
}

impl TaskClaim {
    pub fn id(&self) -> Uuid {
        self.id
    }
}

pub struct PeriodicTask<'a> {
    pub task_type: &'a str,
    pub interval_seconds: i32,
}

/// Match the existing queue's ordering and claim only types owned by this worker.
pub async fn claim(
    connection: &mut AsyncPgConnection,
    owned_types: &[&str],
) -> QueryResult<Option<TaskClaim>> {
    diesel::sql_query(
        "WITH next_task AS (
            SELECT id FROM tasks
            WHERE status = 'pending' AND scheduled_for <= NOW()
              AND task_type = ANY($1)
            ORDER BY created_at
            LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE tasks
        SET status = 'processing', started_at = NOW(), heartbeat_at = NOW(),
            attempt = attempt + 1
        FROM next_task WHERE tasks.id = next_task.id
        RETURNING tasks.id, tasks.attempt, tasks.task_type, tasks.payload",
    )
    .bind::<Array<Text>, _>(owned_types)
    .get_result(connection)
    .await
    .optional()
}

/// Return false when recovery has already revoked or replaced this claim.
pub async fn complete(connection: &mut AsyncPgConnection, claim: &TaskClaim) -> QueryResult<bool> {
    let rows = diesel::update(
        tasks::table
            .find(claim.id)
            .filter(tasks::status.eq("processing"))
            .filter(tasks::attempt.eq(claim.attempt)),
    )
    .set((
        tasks::status.eq("completed"),
        tasks::completed_at.eq(sql::<Timestamp>("NOW()::timestamp").nullable()),
    ))
    .execute(connection)
    .await?;
    Ok(rows == 1)
}

pub async fn heartbeat(connection: &mut AsyncPgConnection, claim: &TaskClaim) -> QueryResult<bool> {
    let rows = diesel::update(
        tasks::table
            .find(claim.id)
            .filter(tasks::status.eq("processing"))
            .filter(tasks::attempt.eq(claim.attempt)),
    )
    .set(tasks::heartbeat_at.eq(sql::<Timestamp>("NOW()::timestamp").nullable()))
    .execute(connection)
    .await?;
    Ok(rows == 1)
}

pub enum JobOutcome {
    Completed,
    Failed,
}

/// Finish the claimed attempt and, if terminal, schedule its successor atomically.
pub async fn finish_periodic(
    connection: &mut AsyncPgConnection,
    claim: &TaskClaim,
    schedule: &PeriodicTask<'_>,
    outcome: JobOutcome,
) -> QueryResult<bool> {
    if claim.task_type != schedule.task_type {
        return Ok(false);
    }
    connection
        .transaction(async |connection| {
            let rows = match outcome {
                JobOutcome::Completed => usize::from(complete(connection, claim).await?),
                JobOutcome::Failed => {
                    diesel::sql_query(
                        "UPDATE tasks
                     SET status = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'pending' END,
                         last_error = 'job handler failed',
                         completed_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
                         scheduled_for = CASE WHEN attempt >= max_attempts THEN scheduled_for
                             ELSE NOW() + power(2, attempt - 1) * INTERVAL '30 seconds' END
                     WHERE id = $1 AND attempt = $2 AND status = 'processing'",
                    )
                    .bind::<SqlUuid, _>(claim.id)
                    .bind::<Integer, _>(claim.attempt)
                    .execute(connection)
                    .await?
                }
            };
            if rows == 1 {
                schedule_missing(connection, schedule, schedule.interval_seconds).await?;
            }
            Ok(rows == 1)
        })
        .await
}

/// Recover only this worker's periodic job type. The partial unique index
/// arbitrates seeding and replacement across replicas.
pub async fn recover_periodic(
    connection: &mut AsyncPgConnection,
    schedule: &PeriodicTask<'_>,
    stale_seconds: i64,
) -> QueryResult<()> {
    connection
        .transaction(async |connection| {
            let recovered = diesel::sql_query(
                "UPDATE tasks SET
                    status = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'pending' END,
                    last_error = 'Task timed out (worker stopped heartbeating)',
                    completed_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
                    scheduled_for = CASE WHEN attempt >= max_attempts THEN scheduled_for
                        ELSE NOW() + power(2, attempt - 1) * INTERVAL '30 seconds' END
                 WHERE status = 'processing' AND task_type = $1
                   AND COALESCE(heartbeat_at, started_at) < NOW() - $2 * INTERVAL '1 second'",
            )
            .bind::<Text, _>(schedule.task_type)
            .bind::<BigInt, _>(stale_seconds)
            .execute(connection)
            .await?;
            let delay = if recovered == 0 {
                0
            } else {
                schedule.interval_seconds
            };
            schedule_missing(connection, schedule, delay).await
        })
        .await
}

async fn schedule_missing(
    connection: &mut AsyncPgConnection,
    schedule: &PeriodicTask<'_>,
    delay_seconds: i32,
) -> QueryResult<()> {
    diesel::sql_query(
        "INSERT INTO tasks (task_type, periodic, max_attempts, scheduled_for)
         VALUES ($1, true, 1, NOW() + $2 * INTERVAL '1 second')
         ON CONFLICT (task_type) WHERE periodic = true AND status IN ('pending', 'processing')
         DO NOTHING",
    )
    .bind::<Text, _>(schedule.task_type)
    .bind::<Integer, _>(delay_seconds)
    .execute(connection)
    .await?;
    Ok(())
}

// Projection of the Drizzle-owned table: only columns used by typed updates.
diesel::table! {
    tasks (id) {
        id -> Uuid,
        status -> Text,
        attempt -> Int4,
        heartbeat_at -> Nullable<Timestamp>,
        completed_at -> Nullable<Timestamp>,
    }
}
