// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
use archestra_db::{PgPool, mcp_transcript};
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    organization_id: String,
    agent_id: String,
    run_id: String,
    encrypted: bool,
    roles: Vec<Role>,
    running: bool,
    runtime: bool,
    completed_at_ms: Option<u64>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Role {
    User,
    Assistant,
    Other,
}

#[derive(Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "source"
)]
pub(crate) enum Transcript {
    Encrypted,
    Conversation { count: usize },
    Interactions { id: String },
    Runtime { count: usize },
    Pending { count: usize },
    None,
}

pub(crate) async fn select(
    State(pool): State<PgPool>,
    Json(request): Json<Request>,
) -> Result<Json<Transcript>, StatusCode> {
    if request.encrypted {
        return Ok(Json(Transcript::Encrypted));
    }
    let count = request
        .roles
        .iter()
        .enumerate()
        .filter(|(_, role)| **role == Role::User)
        .nth(1)
        .map_or(request.roles.len(), |(index, _)| index);
    let conversation = || {
        if count > 0 {
            Transcript::Conversation { count }
        } else {
            Transcript::None
        }
    };
    if request.roles[..count].contains(&Role::Assistant) || request.running {
        return Ok(Json(conversation()));
    }

    let mut connection = pool
        .get()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let latest = mcp_transcript::latest_turn(
        &mut connection,
        &request.organization_id,
        &request.agent_id,
        &format!("scheduled-{}", request.run_id),
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(match latest {
        Some(id) => Transcript::Interactions { id },
        None if request.runtime => Transcript::Runtime { count },
        None if request.completed_at_ms.is_some_and(|ms| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                < Duration::from_millis(ms).saturating_add(Duration::from_secs(60))
        }) =>
        {
            Transcript::Pending { count }
        }
        None => conversation(),
    }))
}
