use crate::{
    Sql, State,
    admin_api::OpenappaStatus,
    errors::{
        Failure, failure, invalid_input, invariant, panicked, sql_failure, status_read_failure,
    },
    input::{Input, RecordedCall},
    remedy::sha256_hex,
};
use appa_eventlog::{OperationKey, ProcessedResultKey, ReceiptBinding, SessionScope};
use appa_runtime::api::EmbeddedPresentationOptions;
use appa_runtime_api::{HookDecision, TrajectoryId, WireDecision};
use serde_json::Value;

/// The engine's reason for holding a child return while one of the child's
/// calls is open (`EventError::ChildDispatchOpen`). The engine reports that
/// hold only as text, so the binding names it here, next to the test that pins
/// the text to the engine's output.
pub(crate) const CHILD_CALL_OPEN_REASON: &str =
    "the child has a call still open; report its outcome before the child ends";

/// Marks a child return held only because the child has a call open, so the
/// host keeps a busy runtime's file as pending instead of refusing it. Only
/// the exact reason marks it; a ruling that quotes it stays a ruling.
pub(crate) fn mark_busy_hold(mut decision: Value) -> Value {
    let busy = decision.get("decision").and_then(Value::as_str) == Some("block")
        && decision.get("reason").and_then(Value::as_str) == Some(CHILD_CALL_OPEN_REASON);
    if busy && let Some(fields) = decision.as_object_mut() {
        fields.insert("busy".into(), Value::Bool(true));
    }
    decision
}

pub(crate) fn wire(decision: &HookDecision) -> napi::Result<Value> {
    require_decision(decision)?;
    serde_json::to_value(WireDecision::of(decision)).map_err(invariant)
}

pub(crate) fn require_decision(decision: &HookDecision) -> napi::Result<()> {
    if let HookDecision::Refuse { class, detail } = decision {
        return Err(failure(
            Failure::Refused(*class),
            format!("OpenAPPA processing interrupted: {detail}"),
        ));
    }
    Ok(())
}

fn session_scope(input: &Input) -> SessionScope {
    SessionScope {
        organization_id: input.organization_id.clone(),
        session_id: input.session_id.clone(),
    }
}

pub(crate) fn session_binding(input: &Input) -> ReceiptBinding {
    ReceiptBinding::Session {
        caller_id: input.caller_id.clone(),
    }
}

pub(crate) fn operation_key(
    input: &Input,
    binding: ReceiptBinding,
    operation_id: String,
) -> OperationKey {
    OperationKey {
        session: session_scope(input),
        binding,
        operation_id,
    }
}

pub(crate) fn processed_result_key(input: &Input, tool_call_id: String) -> ProcessedResultKey {
    ProcessedResultKey {
        session: session_scope(input),
        caller_id: input.caller_id.clone(),
        tool_call_id,
    }
}

pub(crate) fn presentation_options(input: &Input) -> EmbeddedPresentationOptions {
    input
        .presentation
        .as_ref()
        .map_or_else(native_presentation_options, |presentation| {
            EmbeddedPresentationOptions {
                control_tool: presentation.control_tool.clone(),
                supports_delegation: presentation.supports_delegation,
                include_display_plan: true,
                yell_tool: presentation.yell_tool.clone(),
            }
        })
}

pub(crate) fn result_presentation_options(
    input: &Input,
    call: &RecordedCall,
) -> EmbeddedPresentationOptions {
    input
        .presentation
        .as_ref()
        .or(call.presentation.as_ref())
        .map_or_else(native_presentation_options, |presentation| {
            EmbeddedPresentationOptions {
                control_tool: presentation.control_tool.clone(),
                supports_delegation: presentation.supports_delegation,
                include_display_plan: true,
                yell_tool: presentation.yell_tool.clone(),
            }
        })
}

pub(crate) fn native_presentation_options() -> EmbeddedPresentationOptions {
    // Default presentation options without delegation transport.
    EmbeddedPresentationOptions {
        supports_delegation: false,
        include_display_plan: true,
        ..EmbeddedPresentationOptions::default()
    }
}

/// A session's stored identity — root, parent and forked-from session — must be the
/// one this event names.
pub(crate) fn check_session_identity(
    saved: &(String, Option<String>, Option<String>),
    root: &str,
    input: &Input,
) -> napi::Result<()> {
    let (saved_root, saved_parent, saved_fork) = saved;
    if saved_root != root || *saved_parent != input.parent_id {
        return Err(invalid_input("session identity changed"));
    }
    // A fork retains its parent session. A session with its own root cannot move
    // to a different history.
    if input.fork_of.is_some() && *saved_fork != input.fork_of {
        return Err(invalid_input(
            "OpenAPPA cannot continue another session's history in a session that governs its own trajectory",
        ));
    }
    Ok(())
}

/// The key of a session's `openappa_sessions` row. Session ids come from clients, so
/// two organizations may share one; the row and its lookups are therefore keyed by
/// the organization as well as the actor.
#[derive(Clone)]
pub(crate) struct SessionKey {
    pub(crate) organization_id: String,
    pub(crate) actor: String,
}

impl SessionKey {
    pub(crate) fn new(organization_id: &str, session_id: &str) -> Self {
        Self {
            organization_id: organization_id.to_owned(),
            actor: session_actor(session_id),
        }
    }

    pub(crate) fn of(input: &Input) -> Self {
        Self::new(&input.organization_id, &input.session_id)
    }
}

/// A session's actor, and a child session's trajectory id. It hashes the session id
/// alone; the organization is part of the row key beside it.
pub(crate) fn session_actor(session_id: &str) -> String {
    format!("archestra:{}", sha256_hex(session_id.as_bytes()))
}

/// The root a top-level session opens. The runtime shares in-process state by root id
/// alone, so the root formula names the organization. Neither identity may hold a
/// control character, which makes the separator unambiguous.
pub(crate) fn root_id(organization_id: &str, session_id: &str) -> String {
    format!(
        "archestra:{}",
        sha256_hex(format!("{organization_id}\n{session_id}"))
    )
}

/// The root the session `key` names has recorded, or `None` before it started.
pub(crate) fn recorded_root(state: &State, key: &SessionKey) -> napi::Result<Option<String>> {
    let key = key.clone();
    Sql(&state.store)
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| row.get::<_, String>(0)))
        })
        .map_err(sql_failure)
}

/// The label of the session `key` names, read through `state`'s pinned view.
pub(crate) async fn session_status(
    state: State,
    key: SessionKey,
) -> napi::Result<Option<OpenappaStatus>> {
    let policy_revision = state
        .served
        .and_then(|revision| i64::try_from(revision).ok())
        .ok_or_else(|| invariant("OpenAPPA status was read outside a pinned deployment"))?;
    let leased = state.lease().await?;
    tokio::task::spawn_blocking(move || {
        let root = Sql(&leased.state.store).with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| row.get::<_, String>(0)))
        })?;
        let Some(root) = root else { return Ok(None) };
        let root = TrajectoryId(root);
        let status = match leased.state.runtime.try_status(&root) {
            Ok(status) => status,
            // A family opened under the earlier policy model has no label to
            // report: its next event is refused with `legacy_family`.
            Err(appa_runtime::api::StatusReadError::Read(
                appa_eventlog::ReadError::LegacyFamily { .. },
            )) => return Ok(None),
            Err(read) => return Err(status_read_failure(read)),
        };
        Ok(Some(OpenappaStatus {
            trust: status.trust,
            audience: status.audience,
            policy_revision,
        }))
    })
    .await
    .map_err(panicked)?
}
