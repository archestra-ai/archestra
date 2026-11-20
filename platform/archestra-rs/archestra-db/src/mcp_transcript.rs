// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use diesel::{OptionalExtension, QueryableByName, result::QueryResult, sql_query, sql_types::Text};
use diesel_async::{AsyncPgConnection, RunQueryDsl};

pub async fn latest_turn(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    agent_id: &str,
    session_id: &str,
) -> QueryResult<Option<String>> {
    #[derive(QueryableByName)]
    struct InteractionId {
        #[diesel(sql_type = Text)]
        id: String,
    }
    sql_query(
        "SELECT i.id::text FROM interactions i
         JOIN agents a ON a.id = i.profile_id AND a.organization_id = $1
         WHERE i.profile_id = $2::uuid AND i.session_id = $3
           AND (i.source IS NULL OR i.source = 'schedule-trigger')
           AND (i.connector_id IS NULL OR EXISTS (
               SELECT 1 FROM knowledge_base_connectors c WHERE c.id = i.connector_id AND c.organization_id = $1
           ))
           AND (i.app_id IS NULL OR EXISTS (
               SELECT 1 FROM apps p WHERE p.id = i.app_id AND p.organization_id = $1
           ))
         ORDER BY i.created_at DESC LIMIT 1",
    )
    .bind::<Text, _>(organization_id)
    .bind::<Text, _>(agent_id)
    .bind::<Text, _>(session_id)
    .get_result::<InteractionId>(connection)
    .await
    .optional()
    .map(|row| row.map(|row| row.id))
}
