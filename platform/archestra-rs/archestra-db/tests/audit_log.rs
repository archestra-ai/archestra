use archestra_db::audit_log::{AuditFilter, AuditPosition, AuditQuery, AuditVisibility, list};
use diesel_async::{AsyncConnection, AsyncPgConnection, SimpleAsyncConnection};

#[tokio::test]
#[ignore = "requires a disposable database with the Archestra migrations applied"]
async fn page_filters_by_organization_and_actor_and_handles_timestamp_ties() {
    let url = std::env::var("ARCHESTRA_TEST_POSTGRES_URL").unwrap();
    let mut connection = AsyncPgConnection::establish(&url).await.unwrap();
    connection.begin_test_transaction().await.unwrap();
    connection
        .batch_execute(
            "INSERT INTO organization (id, name, slug, created_at)
                 VALUES ('riir-a', 'A', 'riir-a', NOW()), ('riir-b', 'B', 'riir-b', NOW());
             INSERT INTO \"user\" (id, name, email)
                 VALUES ('riir-owner', 'Owner', 'owner@example.invalid'),
                        ('riir-other', 'Other', 'other@example.invalid');
             INSERT INTO audit_logs
                 (organization_id, occurred_at, actor_id, actor_type, impersonated_by,
                  action, outcome, resource_type, resource_id)
                 VALUES
                 ('riir-a', NOW(), 'riir-owner', 'user', NULL, 'agent.created', 'success', 'agent', 'earlier'),
                 ('riir-b', NOW(), 'riir-owner', 'user', NULL, 'agent.created', 'success', 'agent', 'outside'),
                 ('riir-a', NOW(), 'riir-owner', 'user', 'riir-other', 'agent.created', 'success', 'agent', 'latest'),
                 ('riir-a', NOW(), 'riir-other', 'user', NULL, 'agent.created', 'success', 'agent', 'other actor');",
        )
        .await
        .unwrap();

    let query = |position| AuditQuery {
        organization_id: "riir-a",
        visibility: AuditVisibility::OwnEvents("riir-owner".to_owned()),
        filters: AuditFilter {
            actor_id: Some("riir-other".to_owned()),
            resource_types: Some(vec!["agent".to_owned()]),
            ..AuditFilter::default()
        },
        position,
        limit: 1,
    };
    let first = list(&mut connection, query(None)).await.unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].event.resource_id.as_deref(), Some("latest"));
    assert_eq!(
        first[0].impersonated_by_email.as_deref(),
        Some("other@example.invalid")
    );
    let second = list(
        &mut connection,
        query(Some(AuditPosition {
            created_at: first[0].event.created_at,
            event_sequence: first[0].event.event_sequence,
        })),
    )
    .await
    .unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].event.resource_id.as_deref(), Some("earlier"));
}
