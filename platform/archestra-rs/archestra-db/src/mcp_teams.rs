use std::collections::BTreeMap;

use diesel::{
    OptionalExtension, QueryableByName,
    result::QueryResult,
    sql_query,
    sql_types::{Array, BigInt, Bool, Jsonb, Nullable, Text, Uuid as SqlUuid},
};
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamCreate {
    name: String,
    description: Option<String>,
    roles: Vec<String>,
    organization_id: String,
    parent_id: Option<String>,
    created_by: Option<String>,
    created_by_service_account_id: Option<Uuid>,
    labels: BTreeMap<String, String>,
}

pub async fn create(
    connection: &mut AsyncPgConnection,
    team: TeamCreate,
) -> QueryResult<Option<String>> {
    #[derive(QueryableByName)]
    struct Created {
        #[diesel(sql_type = Text)]
        id: String,
    }
    connection
        .transaction(async |tx| {
            let Some(created) = sql_query(include_str!("mcp_team_create.sql"))
                .bind::<Text, _>(Uuid::new_v4().to_string())
                .bind::<Text, _>(&team.name)
                .bind::<Nullable<Text>, _>(&team.description)
                .bind::<Array<Text>, _>(&team.roles)
                .bind::<Text, _>(&team.organization_id)
                .bind::<Nullable<Text>, _>(&team.parent_id)
                .bind::<Nullable<Text>, _>(&team.created_by)
                .bind::<Nullable<SqlUuid>, _>(team.created_by_service_account_id)
                .bind::<Text, _>(Uuid::new_v4().to_string())
                .get_result::<Created>(tx)
                .await
                .optional()?
            else {
                return Ok(None);
            };
            if !team.labels.is_empty() {
                insert_labels(tx, &created.id, &team.labels).await?;
            }
            Ok(Some(created.id))
        })
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamEdit {
    id: String,
    organization_id: String,
    fields: serde_json::Map<String, serde_json::Value>,
    labels: Option<BTreeMap<String, String>>,
}

pub async fn edit(connection: &mut AsyncPgConnection, edit: TeamEdit) -> QueryResult<Option<Team>> {
    connection
        .transaction(async |tx| {
            let team = sql_query(include_str!("mcp_team_edit.sql"))
                .bind::<Text, _>(&edit.id)
                .bind::<Text, _>(&edit.organization_id)
                .bind::<Jsonb, _>(serde_json::Value::Object(edit.fields))
                .get_result::<Team>(tx)
                .await
                .optional()?;
            if let (Some(team), Some(labels)) = (&team, &edit.labels) {
                sql_query("DELETE FROM team_labels WHERE team_id = $1")
                    .bind::<Text, _>(&team.id)
                    .execute(tx)
                    .await?;
                if !labels.is_empty() {
                    insert_labels(tx, &team.id, labels).await?;
                }
            }
            Ok(team)
        })
        .await
}

async fn insert_labels(
    tx: &mut AsyncPgConnection,
    team_id: &str,
    labels: &BTreeMap<String, String>,
) -> QueryResult<()> {
    let values = serde_json::json!(labels);
    crate::labels::ensure_vocabulary(tx, &values).await?;
    let count = sql_query(
        "INSERT INTO team_labels (team_id, key_id, value_id)
         SELECT $1, k.id, v.id FROM jsonb_each_text($2) AS label
         JOIN label_keys k ON k.key = label.key JOIN label_values v ON v.value = label.value",
    )
    .bind::<Text, _>(team_id)
    .bind::<Jsonb, _>(values)
    .execute(tx)
    .await?;
    if count != labels.len() {
        return Err(diesel::result::Error::NotFound);
    }
    Ok(())
}

pub async fn delete(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    team_id: &str,
) -> QueryResult<bool> {
    sql_query("DELETE FROM team WHERE id = $1 AND organization_id = $2")
        .bind::<Text, _>(team_id)
        .bind::<Text, _>(organization_id)
        .execute(connection)
        .await
        .map(|deleted| deleted != 0)
}

pub enum Visibility {
    Organization,
    Member(String),
    AuthorizedTeam(String),
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Nullable<Text>)]
    description: Option<String>,
    #[diesel(sql_type = Array<Text>)]
    roles: Vec<String>,
    #[diesel(sql_type = Nullable<Text>)]
    parent_id: Option<String>,
    #[diesel(sql_type = Text)]
    organization_id: String,
    #[diesel(sql_type = Nullable<Text>)]
    created_by: Option<String>,
    #[diesel(sql_type = Text)]
    created_at: String,
    #[diesel(sql_type = Text)]
    updated_at: String,
    #[diesel(sql_type = BigInt)]
    member_count: i64,
}

pub async fn list(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    visibility: Visibility,
) -> QueryResult<Vec<Team>> {
    let (member, team) = match visibility {
        Visibility::Organization => (None, None),
        Visibility::Member(user_id) => (Some(user_id), None),
        Visibility::AuthorizedTeam(team_id) => (None, Some(team_id)),
    };
    sql_query(
        "SELECT t.id, t.name, t.description, t.roles, t.parent_team_id AS parent_id,
            t.organization_id, t.created_by,
            to_char(t.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
            to_char(t.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at,
            (SELECT COUNT(*) FROM team_member WHERE team_id = t.id) AS member_count
        FROM team t
        WHERE t.organization_id = $1
          AND ($3::text IS NULL OR t.id = $3)
          AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM team_member WHERE team_id = t.id AND user_id = $2
          ))",
    )
    .bind::<Text, _>(organization_id)
    .bind::<Nullable<Text>, _>(member)
    .bind::<Nullable<Text>, _>(team)
    .load(connection)
    .await
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    team_id: String,
    #[diesel(sql_type = Text)]
    user_id: String,
    #[diesel(sql_type = Text)]
    role: String,
    #[diesel(sql_type = Bool)]
    synced_from_sso: bool,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    email: String,
    #[diesel(sql_type = Text)]
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum MembershipRole {
    Admin,
    Member,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberRoleWrite {
    team_id: String,
    organization_id: String,
    user_id: String,
    role: MembershipRole,
}

#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualMembership {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    team_id: String,
    #[diesel(sql_type = Text)]
    user_id: String,
    #[diesel(sql_type = Text)]
    role: String,
    #[diesel(sql_type = Bool)]
    synced_from_sso: bool,
    #[diesel(sql_type = Bool)]
    role_synced_from_sso: bool,
    #[diesel(sql_type = Text)]
    created_at: String,
}

pub async fn add_member(
    connection: &mut AsyncPgConnection,
    input: MemberRoleWrite,
) -> QueryResult<Option<ManualMembership>> {
    sql_query(
        "INSERT INTO team_member (id, team_id, user_id, role, created_at)
         SELECT $1, t.id, $4, $5, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
         FROM team t WHERE t.id = $2 AND t.organization_id = $3
           AND EXISTS (SELECT 1 FROM member m WHERE m.organization_id = $3 AND m.user_id = $4)
         RETURNING id, team_id, user_id, role, synced_from_sso, role_synced_from_sso,
             to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
    )
    .bind::<Text, _>(Uuid::new_v4().to_string())
    .bind::<Text, _>(input.team_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Text, _>(input.user_id)
    .bind::<Text, _>(match input.role {
        MembershipRole::Admin => "admin",
        MembershipRole::Member => "member",
    })
    .get_result(connection)
    .await
    .optional()
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum MemberRoleUpdate {
    Membership(Option<ManualMembership>),
    LastAdmin(LastAdmin),
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LastAdmin {
    LastAdmin,
}

pub async fn update_member_role(
    connection: &mut AsyncPgConnection,
    input: MemberRoleWrite,
) -> QueryResult<MemberRoleUpdate> {
    connection.transaction(async |tx| {
        if !lock_team(tx, &input.team_id, &input.organization_id).await? {
            return Ok(MemberRoleUpdate::Membership(None));
        }
        let updated = sql_query(
            "UPDATE team_member m SET role = $3, role_synced_from_sso = false
             WHERE m.team_id = $1 AND m.user_id = $2
               AND ($3 = 'admin' OR m.role <> 'admin' OR EXISTS (
                 SELECT 1 FROM team_member a WHERE a.team_id = m.team_id AND a.role = 'admin' AND a.user_id <> m.user_id
               ))
             RETURNING id, team_id, user_id, role, synced_from_sso, role_synced_from_sso,
               to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
        )
        .bind::<Text, _>(&input.team_id)
        .bind::<Text, _>(&input.user_id)
        .bind::<Text, _>(match input.role {
            MembershipRole::Admin => "admin",
            MembershipRole::Member => "member",
        })
        .get_result(tx)
        .await
        .optional()?;
        if updated.is_some() {
            return Ok(MemberRoleUpdate::Membership(updated));
        }
        Ok(if member_exists(tx, &input.team_id, &input.user_id).await? {
            MemberRoleUpdate::LastAdmin(LastAdmin::LastAdmin)
        } else {
            MemberRoleUpdate::Membership(None)
        })
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberRemove {
    team_id: String,
    organization_id: String,
    user_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberRemoval {
    Removed,
    NotFound,
    LastAdmin,
}

pub async fn remove_member(
    connection: &mut AsyncPgConnection,
    input: MemberRemove,
) -> QueryResult<MemberRemoval> {
    connection.transaction(async |tx| {
        if !lock_team(tx, &input.team_id, &input.organization_id).await? {
            return Ok(MemberRemoval::NotFound);
        }
        let deleted = sql_query(
            "DELETE FROM team_member m WHERE m.team_id = $1 AND m.user_id = $2
               AND (m.role <> 'admin' OR EXISTS (
                 SELECT 1 FROM team_member a WHERE a.team_id = m.team_id AND a.role = 'admin' AND a.user_id <> m.user_id
               ))",
        )
        .bind::<Text, _>(&input.team_id)
        .bind::<Text, _>(&input.user_id)
        .execute(tx)
        .await?;
        Ok(if deleted != 0 {
            MemberRemoval::Removed
        } else if member_exists(tx, &input.team_id, &input.user_id).await? {
            MemberRemoval::LastAdmin
        } else {
            MemberRemoval::NotFound
        })
    }).await
}

#[derive(QueryableByName)]
struct Present {
    #[diesel(sql_type = Bool)]
    present: bool,
}

async fn lock_team(
    tx: &mut AsyncPgConnection,
    team_id: &str,
    organization_id: &str,
) -> QueryResult<bool> {
    sql_query("SELECT true AS present FROM team WHERE id = $1 AND organization_id = $2 FOR UPDATE")
        .bind::<Text, _>(team_id)
        .bind::<Text, _>(organization_id)
        .get_result::<Present>(tx)
        .await
        .optional()
        .map(|row| row.is_some_and(|row| row.present))
}

async fn member_exists(
    tx: &mut AsyncPgConnection,
    team_id: &str,
    user_id: &str,
) -> QueryResult<bool> {
    sql_query(
        "SELECT EXISTS (SELECT 1 FROM team_member WHERE team_id = $1 AND user_id = $2) AS present",
    )
    .bind::<Text, _>(team_id)
    .bind::<Text, _>(user_id)
    .get_result::<Present>(tx)
    .await
    .map(|row| row.present)
}

pub async fn members(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    team_id: &str,
) -> QueryResult<Vec<Member>> {
    sql_query(
        "SELECT m.id, m.team_id, m.user_id, m.role, m.synced_from_sso, u.name, u.email,
                to_char(m.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at
         FROM team_member m
         JOIN team t ON t.id = m.team_id
         JOIN \"user\" u ON u.id = m.user_id
         WHERE t.organization_id = $1 AND t.id = $2
         ORDER BY u.name",
    )
    .bind::<Text, _>(organization_id)
    .bind::<Text, _>(team_id)
    .load(connection)
    .await
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
#[derive(QueryableByName, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalGroup {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Text)]
    team_id: String,
    #[diesel(sql_type = Text)]
    group_identifier: String,
    #[diesel(sql_type = Nullable<Text>)]
    identity_provider_id: Option<String>,
    #[diesel(sql_type = Text)]
    role: String,
    #[diesel(sql_type = Text)]
    created_at: String,
}

pub async fn external_groups(
    connection: &mut AsyncPgConnection,
    organization_id: &str,
    team_id: &str,
) -> QueryResult<Vec<ExternalGroup>> {
    sql_query(
        "SELECT g.id, g.team_id, g.group_identifier, g.identity_provider_id, g.role,
                to_char(g.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at
         FROM team_external_group g
         JOIN team t ON t.id = g.team_id
         WHERE t.organization_id = $1 AND t.id = $2",
    )
    .bind::<Text, _>(organization_id)
    .bind::<Text, _>(team_id)
    .load(connection)
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalGroupAdd {
    team_id: String,
    organization_id: String,
    group_identifier: String,
    identity_provider_id: Option<String>,
    role: MembershipRole,
}

pub async fn add_external_group(
    connection: &mut AsyncPgConnection,
    input: ExternalGroupAdd,
) -> QueryResult<Option<ExternalGroup>> {
    sql_query(
        "INSERT INTO team_external_group (id, team_id, group_identifier, identity_provider_id, role)
         SELECT $1, t.id, $4, $5, $6 FROM team t
         WHERE t.id = $2 AND t.organization_id = $3
           AND ($5 IS NULL OR EXISTS (
             SELECT 1 FROM identity_provider p WHERE p.id = $5 AND p.organization_id = $3
           ))
         RETURNING id, team_id, group_identifier, identity_provider_id, role,
             to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
    )
    .bind::<Text, _>(Uuid::new_v4().to_string())
    .bind::<Text, _>(input.team_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Text, _>(input.group_identifier)
    .bind::<Nullable<Text>, _>(input.identity_provider_id)
    .bind::<Text, _>(match input.role {
        MembershipRole::Admin => "admin",
        MembershipRole::Member => "member",
    })
    .get_result(connection)
    .await
    .optional()
}
#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum ExternalGroupSelector {
    Id(String),
    Identifier(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalGroupRemove {
    team_id: String,
    organization_id: String,
    selector: ExternalGroupSelector,
}

pub async fn remove_external_group(
    connection: &mut AsyncPgConnection,
    input: ExternalGroupRemove,
) -> QueryResult<bool> {
    let (column, value) = match input.selector {
        ExternalGroupSelector::Id(id) => ("id", id),
        ExternalGroupSelector::Identifier(identifier) => ("group_identifier", identifier),
    };
    sql_query(format!(
        "DELETE FROM team_external_group g USING team t
         WHERE g.team_id = t.id AND t.id = $1 AND t.organization_id = $2 AND g.{column} = $3"
    ))
    .bind::<Text, _>(input.team_id)
    .bind::<Text, _>(input.organization_id)
    .bind::<Text, _>(value)
    .execute(connection)
    .await
    .map(|count| count > 0)
}
// SPDX-SnippetEnd
