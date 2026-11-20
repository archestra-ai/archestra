use diesel::dsl::sql;
use diesel::pg::Pg;
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Bool, Timestamptz};
use diesel_async::{AsyncPgConnection, RunQueryDsl};
use ipnetwork::IpNetwork;
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Queryable, Selectable, Serialize)]
#[diesel(table_name = audit_logs, check_for_backend(Pg))]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: Uuid,
    pub event_sequence: i64,
    pub organization_id: String,
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub actor_id: Option<String>,
    pub actor_type: String,
    pub actor_name: Option<String>,
    pub actor_email: Option<String>,
    pub impersonated_by: Option<String>,
    pub action: String,
    pub outcome: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub resource_name: Option<String>,
    pub before: Option<Value>,
    pub after: Option<Value>,
    pub http_method: Option<String>,
    pub http_path: Option<String>,
    pub http_route: Option<String>,
    pub http_status: Option<i32>,
    pub request_id: Option<String>,
    #[serde(serialize_with = "serialize_source_ip")]
    pub source_ip: Option<IpNetwork>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    #[serde(flatten)]
    pub event: AuditEvent,
    pub impersonated_by_email: Option<String>,
}

pub enum AuditVisibility {
    Organization,
    OwnEvents(String),
}

pub struct AuditPosition {
    pub created_at: OffsetDateTime,
    pub event_sequence: i64,
}

#[derive(Default)]
pub struct AuditFilter {
    pub start_date: Option<OffsetDateTime>,
    pub end_date: Option<OffsetDateTime>,
    pub actor_id: Option<String>,
    pub action: Option<String>,
    pub outcome: Option<String>,
    pub actor_type: Option<String>,
    pub resource_types: Option<Vec<String>>,
    pub resource_id: Option<String>,
}

pub struct AuditQuery<'a> {
    pub organization_id: &'a str,
    pub visibility: AuditVisibility,
    pub filters: AuditFilter,
    pub position: Option<AuditPosition>,
    pub limit: u32,
}

/// Fetch one extra row to tell the caller whether a next page exists.
pub async fn list(
    connection: &mut AsyncPgConnection,
    input: AuditQuery<'_>,
) -> QueryResult<Vec<AuditRow>> {
    use audit_logs::dsl as a;
    let mut query = a::audit_logs
        .left_join(user::table.on(a::impersonated_by.eq(user::id.nullable())))
        .filter(a::organization_id.eq(input.organization_id))
        .into_boxed();
    let filters = input.filters;
    let actor = match input.visibility {
        AuditVisibility::OwnEvents(actor) => Some(actor),
        AuditVisibility::Organization => filters.actor_id.filter(|value| !value.is_empty()),
    };
    if let Some(actor) = actor {
        if let Some(id) = actor.strip_prefix("service-account:") {
            query = query
                .filter(a::actor_type.eq("service_account"))
                .filter(a::actor_email.eq(format!("{id}@service-account.local")));
        } else {
            query = query.filter(a::actor_id.eq(actor));
        }
    }
    if let Some(date) = filters.start_date {
        query = query.filter(a::created_at.ge(date));
    }
    if let Some(date) = filters.end_date {
        query = query.filter(a::created_at.le(date));
    }
    if let Some(action) = filters.action {
        query = query.filter(a::action.eq(action));
    }
    if let Some(outcome) = filters.outcome {
        query = query.filter(a::outcome.eq(outcome));
    }
    if let Some(actor_type) = filters.actor_type {
        query = query.filter(a::actor_type.eq(actor_type));
    }
    if let Some(types) = filters.resource_types {
        query = query.filter(a::resource_type.eq_any(types));
    }
    if let Some(id) = filters.resource_id.filter(|value| !value.is_empty()) {
        query = query.filter(a::resource_id.eq(id));
    }
    if let Some(position) = input.position {
        query = query.filter(
            sql::<Bool>("(audit_logs.created_at, audit_logs.event_sequence) < (")
                .bind::<Timestamptz, _>(position.created_at)
                .sql(", ")
                .bind::<BigInt, _>(position.event_sequence)
                .sql(")"),
        );
    }
    let rows = query
        .select((AuditEvent::as_select(), user::email.nullable()))
        .order((a::created_at.desc(), a::event_sequence.desc()))
        .limit(i64::from(input.limit) + 1)
        .load::<(AuditEvent, Option<String>)>(connection)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(event, impersonated_by_email)| AuditRow {
            event,
            impersonated_by_email,
        })
        .collect())
}

fn serialize_source_ip<S: serde::Serializer>(
    value: &Option<IpNetwork>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(ip) if ip.prefix() == if ip.ip().is_ipv4() { 32 } else { 128 } => {
            serializer.serialize_str(&ip.ip().to_string())
        }
        Some(ip) => serializer.serialize_str(&ip.to_string()),
        None => serializer.serialize_none(),
    }
}

diesel::table! {
    audit_logs (id) {
        id -> Uuid,
        event_sequence -> Int8,
        organization_id -> Text,
        occurred_at -> Timestamptz,
        created_at -> Timestamptz,
        actor_id -> Nullable<Text>,
        actor_type -> Text,
        actor_name -> Nullable<Text>,
        actor_email -> Nullable<Text>,
        impersonated_by -> Nullable<Text>,
        action -> Text,
        outcome -> Text,
        resource_type -> Nullable<Text>,
        resource_id -> Nullable<Text>,
        resource_name -> Nullable<Text>,
        before -> Nullable<Jsonb>,
        after -> Nullable<Jsonb>,
        http_method -> Nullable<Text>,
        http_path -> Nullable<Text>,
        http_route -> Nullable<Text>,
        http_status -> Nullable<Int4>,
        request_id -> Nullable<Text>,
        source_ip -> Nullable<Inet>,
        user_agent -> Nullable<Text>,
    }
}

diesel::table! {
    user (id) {
        id -> Text,
        email -> Text,
    }
}

diesel::allow_tables_to_appear_in_same_query!(audit_logs, user);
mod request;
pub use request::AuditListRequest;
