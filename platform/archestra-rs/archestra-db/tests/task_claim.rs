use archestra_db::tasks::{
    JobOutcome, PeriodicTask, claim, complete, finish_periodic, heartbeat, recover_periodic,
};
use diesel::sql_query;
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl, SimpleAsyncConnection};

#[tokio::test]
#[ignore = "requires an empty, disposable PostgreSQL database"]
async fn claims_are_exclusive_and_stale_attempts_cannot_complete() {
    let url = std::env::var("ARCHESTRA_TEST_POSTGRES_URL").unwrap();
    let mut first = AsyncPgConnection::establish(&url).await.unwrap();
    let mut second = AsyncPgConnection::establish(&url).await.unwrap();
    let base =
        include_str!("../../../backend/src/database/migrations/0172_reflective_gabe_jones.sql");
    let periodic =
        include_str!("../../../backend/src/database/migrations/0173_heavy_marvel_boy.sql");
    let heartbeat_migration =
        include_str!("../../../backend/src/database/migrations/0341_chief_talkback.sql");
    // Use the original DDL, without applying unrelated migrations to this fixture.
    first
        .batch_execute(base.split("--> statement-breakpoint").next().unwrap())
        .await
        .unwrap();
    first.batch_execute(periodic).await.unwrap();
    first
        .batch_execute(
            heartbeat_migration
                .split("--> statement-breakpoint")
                .map(str::trim)
                .find(|sql| sql.starts_with("ALTER TABLE \"tasks\" ADD COLUMN \"heartbeat_at\" "))
                .unwrap(),
        )
        .await
        .unwrap();

    first
        .batch_execute(
            "INSERT INTO tasks (task_type, payload, scheduled_for) VALUES
                ('llm_usage_rollup', '{\"due\":false}', NOW() + INTERVAL '1 hour'),
                ('connector_sync', '{}', NOW()),
                ('llm_usage_rollup', '{\"due\":true}', NOW())",
        )
        .await
        .unwrap();
    let types = &["llm_usage_rollup"];
    let (a, b) = tokio::join!(claim(&mut first, types), claim(&mut second, types));
    let previous = match (a.unwrap(), b.unwrap()) {
        (Some(claim), None) | (None, Some(claim)) => claim,
        other => panic!("expected exactly one claim, got {other:?}"),
    };
    assert_eq!(previous.task_type, types[0]);
    assert_eq!(previous.payload, serde_json::json!({"due": true}));

    // Reproduce the recovery transition, then let another worker reclaim the row.
    sql_query("UPDATE tasks SET status = 'pending' WHERE status = 'processing'")
        .execute(&mut second)
        .await
        .unwrap();
    let current = claim(&mut second, types).await.unwrap().unwrap();
    assert!(!complete(&mut first, &previous).await.unwrap());
    assert!(complete(&mut second, &current).await.unwrap());
    assert!(!complete(&mut second, &current).await.unwrap());
    assert!(claim(&mut first, types).await.unwrap().is_none());

    let schedule = PeriodicTask {
        task_type: "audit_log_cleanup",
        interval_seconds: 60,
    };
    let types = &[schedule.task_type];
    let (a, b) = tokio::join!(
        recover_periodic(&mut first, &schedule, 300),
        recover_periodic(&mut second, &schedule, 300)
    );
    a.unwrap();
    b.unwrap();
    let overdue = claim(&mut first, types).await.unwrap().unwrap();
    first
        .batch_execute(
            "UPDATE tasks SET heartbeat_at = NOW() - INTERVAL '6 minutes'
             WHERE task_type = 'audit_log_cleanup' AND status = 'processing'",
        )
        .await
        .unwrap();
    assert!(heartbeat(&mut first, &overdue).await.unwrap());
    recover_periodic(&mut second, &schedule, 300).await.unwrap();
    assert!(claim(&mut second, types).await.unwrap().is_none());

    // Make the live claim stale again; recovery must create a successor
    // even though the previous attempt has exhausted its retry budget.
    first
        .batch_execute(
            "UPDATE tasks SET heartbeat_at = NOW() - INTERVAL '6 minutes'
             WHERE task_type = 'audit_log_cleanup' AND status = 'processing'",
        )
        .await
        .unwrap();
    recover_periodic(&mut second, &schedule, 300).await.unwrap();
    assert!(!heartbeat(&mut first, &overdue).await.unwrap());
    assert!(
        !finish_periodic(&mut first, &overdue, &schedule, JobOutcome::Completed)
            .await
            .unwrap()
    );
    assert!(claim(&mut second, types).await.unwrap().is_none());
    first
        .batch_execute(
            "UPDATE tasks SET scheduled_for = NOW()
             WHERE task_type = 'audit_log_cleanup' AND status = 'pending'",
        )
        .await
        .unwrap();
    let next = claim(&mut second, types).await.unwrap().unwrap();
    assert_ne!(next.id(), overdue.id());
    assert!(
        finish_periodic(&mut second, &next, &schedule, JobOutcome::Failed)
            .await
            .unwrap()
    );
    assert!(claim(&mut first, types).await.unwrap().is_none());
}
