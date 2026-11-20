use std::io;

use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{AuditFilter, AuditPosition, AuditQuery, AuditVisibility};
use crate::parse_api_datetime;

/// Internal wire contract. Scope is supplied by the trusted auth adapter, not
/// by the public query string, headers, or body.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditListRequest {
    organization_id: String,
    visibility: Visibility,
    limit: u32,
    cursor: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    actor_id: Option<String>,
    action: Option<String>,
    outcome: Option<String>,
    actor_type: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
}

impl AuditListRequest {
    pub fn query(&self) -> io::Result<AuditQuery<'_>> {
        if self.organization_id.is_empty() || !(1..=100).contains(&self.limit) {
            return Err(io::Error::other("invalid organization or page size"));
        }
        let parse_date = |value: &str| {
            parse_api_datetime(value).map_err(|_| io::Error::other("invalid audit query date"))
        };
        Ok(AuditQuery {
            organization_id: &self.organization_id,
            visibility: match &self.visibility {
                Visibility::Organization => AuditVisibility::Organization,
                Visibility::OwnEvents { actor_id } if !actor_id.is_empty() => {
                    AuditVisibility::OwnEvents(actor_id.clone())
                }
                Visibility::OwnEvents { .. } => {
                    return Err(io::Error::other("invalid actor scope"));
                }
            },
            filters: AuditFilter {
                start_date: self.start_date.as_deref().map(parse_date).transpose()?,
                end_date: self.end_date.as_deref().map(parse_date).transpose()?,
                actor_id: self.actor_id.clone(),
                action: self.action.clone(),
                outcome: self.outcome.clone(),
                actor_type: self.actor_type.clone(),
                resource_types: self
                    .resource_type
                    .as_deref()
                    .filter(|types| !types.is_empty())
                    .map(|types| {
                        types
                            .split(',')
                            .map(str::trim)
                            .filter(|part| !part.is_empty())
                            .map(str::to_owned)
                            .collect()
                    }),
                resource_id: self.resource_id.clone(),
            },
            position: self.cursor.as_deref().and_then(decode_cursor),
            limit: self.limit,
        })
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Visibility {
    Organization,
    OwnEvents { actor_id: String },
}

#[derive(Deserialize)]
struct Cursor {
    value: String,
    id: String,
}

fn decode_cursor(cursor: &str) -> Option<AuditPosition> {
    const DECODER: GeneralPurpose = GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    // Node's base64url decoder also accepts the standard alphabet and ignores
    // non-alphabet characters. A cursor that cannot be read starts at page one.
    let normalized: String = cursor
        .chars()
        .take_while(|ch| *ch != '=')
        .filter_map(|ch| match ch {
            '+' => Some('-'),
            '/' => Some('_'),
            '-' | '_' => Some(ch),
            alphanumeric if alphanumeric.is_ascii_alphanumeric() => Some(alphanumeric),
            _ => None,
        })
        .collect();
    let bytes = DECODER.decode(normalized).ok()?;
    let cursor: Cursor = serde_json::from_slice(&bytes).ok()?;
    Some(AuditPosition {
        created_at: OffsetDateTime::parse(&cursor.value, &Rfc3339).ok()?,
        event_sequence: cursor.id.parse().ok()?,
    })
}
