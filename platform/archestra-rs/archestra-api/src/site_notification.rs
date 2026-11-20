use std::net::IpAddr;

use archestra_db::{
    PgPool,
    audit_log::AuditEvent,
    parse_api_datetime,
    site_notification::{ActorType, AuditContext, Notification, Replacement},
};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) async fn replace(
    State(pool): State<PgPool>,
    Json(input): Json<Input>,
) -> Result<Json<Committed>, StatusCode> {
    let input = input.validate()?;
    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let (notification, audit) = archestra_db::site_notification::replace(&mut connection, input)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(Committed {
        notification,
        audit,
    }))
}

#[derive(Serialize)]
pub(crate) struct Committed {
    notification: Notification,
    audit: AuditEvent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    organization_id: String,
    content: String,
    expires_at: Option<String>,
    is_active: Option<bool>,
    audit: AuditInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditInput {
    occurred_at: String,
    actor_id: String,
    actor_type: Actor,
    actor_name: Option<String>,
    actor_email: String,
    impersonated_by: Option<String>,
    request_id: String,
    source_ip: Option<IpAddr>,
    user_agent: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Actor {
    User,
    ApiKey,
    ServiceAccount,
}

impl Input {
    fn validate(self) -> Result<Replacement, StatusCode> {
        if self.organization_id.is_empty()
            || self.audit.actor_id.is_empty()
            || self.content.is_empty()
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let date = |value: &str| {
            OffsetDateTime::parse(value, &Rfc3339).map_err(|_| StatusCode::BAD_REQUEST)
        };
        let (actor_type, actor_id) = match self.audit.actor_type {
            Actor::User => (ActorType::User, Some(self.audit.actor_id)),
            Actor::ApiKey => (ActorType::ApiKey, Some(self.audit.actor_id)),
            Actor::ServiceAccount => (ActorType::ServiceAccount, None),
        };
        Ok(Replacement {
            organization_id: self.organization_id,
            content: self.content,
            expires_at: self
                .expires_at
                .as_deref()
                .map(parse_api_datetime)
                .transpose()
                .map_err(|_| StatusCode::BAD_REQUEST)?,
            is_active: self.is_active.unwrap_or(true),
            audit: AuditContext {
                occurred_at: date(&self.audit.occurred_at)?,
                actor_id,
                actor_type,
                actor_name: self.audit.actor_name,
                actor_email: self.audit.actor_email,
                impersonated_by: self.audit.impersonated_by,
                request_id: self.audit.request_id,
                source_ip: self.audit.source_ip.map(Into::into),
                user_agent: self.audit.user_agent,
            },
        })
    }
}
