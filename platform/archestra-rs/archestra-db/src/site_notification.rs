use diesel::prelude::*;
use diesel_async::{AsyncConnection, AsyncPgConnection, RunQueryDsl};
use serde::Serialize;
use time::{OffsetDateTime, PrimitiveDateTime, UtcOffset, macros::format_description};
use uuid::Uuid;

use crate::audit_log::{AuditEvent, audit_logs};

pub struct Replacement {
    pub organization_id: String,
    pub content: String,
    pub expires_at: Option<OffsetDateTime>,
    pub is_active: bool,
    pub audit: AuditContext,
}

pub struct AuditContext {
    pub occurred_at: OffsetDateTime,
    pub actor_id: Option<String>,
    pub actor_type: ActorType,
    pub actor_name: Option<String>,
    pub actor_email: String,
    pub impersonated_by: Option<String>,
    pub request_id: String,
    pub source_ip: Option<ipnetwork::IpNetwork>,
    pub user_agent: Option<String>,
}

pub enum ActorType {
    User,
    ApiKey,
    ServiceAccount,
}

impl ActorType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::ApiKey => "api_key",
            Self::ServiceAccount => "service_account",
        }
    }
}

#[derive(Queryable, Selectable, Serialize)]
#[diesel(table_name = site_notification)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    id: String,
    organization_id: String,
    content: String,
    #[serde(serialize_with = "optional_timestamp")]
    expires_at: Option<PrimitiveDateTime>,
    #[serde(serialize_with = "timestamp")]
    created_at: PrimitiveDateTime,
    is_active: bool,
}

/// The replacement, deactivation, and success audit are a single write.
pub async fn replace(
    connection: &mut AsyncPgConnection,
    input: Replacement,
) -> QueryResult<(Notification, AuditEvent)> {
    use site_notification::dsl as n;
    connection
        .transaction(async |tx| {
            // Same organization lock as the legacy replacement path.
            organization::table
                .find(&input.organization_id)
                .select(organization::id)
                .for_update()
                .first::<String>(tx)
                .await?;
            let slot = n::site_notification.filter(n::organization_id.eq(&input.organization_id));
            let before = slot
                .order((n::updated_at.desc(), n::created_at.desc()))
                .select(Notification::as_select())
                .first::<Notification>(tx)
                .await
                .optional()?;
            let now = without_offset(OffsetDateTime::now_utc());
            diesel::update(slot.filter(n::is_active.eq(true)))
                .set((n::is_active.eq(false), n::updated_at.eq(now)))
                .execute(tx)
                .await?;
            let after = diesel::insert_into(n::site_notification)
                .values((
                    n::id.eq(Uuid::new_v4().to_string()),
                    n::organization_id.eq(&input.organization_id),
                    n::content.eq(&input.content),
                    n::is_active.eq(input.is_active),
                    n::expires_at.eq(input.expires_at.map(without_offset)),
                    n::created_at.eq(now),
                    n::updated_at.eq(now),
                ))
                .returning(Notification::as_returning())
                .get_result::<Notification>(tx)
                .await?;
            let audit = record_audit(tx, &input, before.as_ref(), &after).await?;
            Ok((after, audit))
        })
        .await
}

async fn record_audit(
    tx: &mut AsyncPgConnection,
    input: &Replacement,
    before: Option<&Notification>,
    after: &Notification,
) -> QueryResult<AuditEvent> {
    use audit_logs::dsl as a;
    let to_json = |value: &Notification| {
        serde_json::to_value(value)
            .map_err(|error| diesel::result::Error::SerializationError(Box::new(error)))
    };
    let audit = &input.audit;
    diesel::insert_into(a::audit_logs)
        .values((
            a::organization_id.eq(&input.organization_id),
            a::occurred_at.eq(audit.occurred_at),
            a::actor_id.eq(audit.actor_id.as_deref()),
            a::actor_type.eq(audit.actor_type.as_str()),
            a::actor_email.eq(&audit.actor_email),
            a::actor_name.eq(audit.actor_name.as_deref()),
            a::impersonated_by.eq(audit.impersonated_by.as_deref()),
            a::action.eq("organization.updated"),
            a::outcome.eq("success"),
            a::resource_type.eq("organization"),
            a::resource_id.eq(&input.organization_id),
            a::before.eq(before.map(to_json).transpose()?),
            a::after.eq(to_json(after)?),
            a::http_method.eq("POST"),
            a::http_path.eq("/api/site-notification"),
            a::http_route.eq("/api/site-notification"),
            a::http_status.eq(200),
            a::request_id.eq(&audit.request_id),
            a::source_ip.eq(audit.source_ip),
            a::user_agent.eq(audit.user_agent.as_deref()),
        ))
        .returning(AuditEvent::as_returning())
        .get_result(tx)
        .await
}

fn without_offset(date: OffsetDateTime) -> PrimitiveDateTime {
    let utc = date.to_offset(UtcOffset::UTC);
    PrimitiveDateTime::new(utc.date(), utc.time())
}

fn timestamp<S: serde::Serializer>(
    date: &PrimitiveDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let iso = date
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .map_err(serde::ser::Error::custom)?;
    serializer.serialize_str(&iso)
}

fn optional_timestamp<S: serde::Serializer>(
    date: &Option<PrimitiveDateTime>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match date {
        Some(date) => timestamp(date, serializer),
        None => serializer.serialize_none(),
    }
}

diesel::table! {
    site_notification (id) {
        id -> Text,
        organization_id -> Text,
        content -> Text,
        expires_at -> Nullable<Timestamp>,
        created_at -> Timestamp,
        updated_at -> Timestamp,
        is_active -> Bool,
    }
}

diesel::table! {
    organization (id) {
        id -> Text,
    }
}
