//! Peer send, arrival, list, and read. The runtime captures and combines labels.
//! This module passes opaque ids and bytes only.

use std::time::{SystemTime, UNIX_EPOCH};

use appa_eventlog::{
    OperationClaim, OperationKey, OperationRequest, ProcessedResultKey, ReceiptBinding,
    ReceiptError, SessionScope,
};
use appa_runtime::api::{
    EmbeddedPeerArrival, EmbeddedPeerError, EmbeddedPeerId, EmbeddedPeerNotice,
};
use appa_runtime_api::{Actor, HookDecision, PeerDigest, ProposedCall, TrajectoryId};
use futures_util::FutureExt;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};

use super::{
    DispatchPolicy, SessionKey, SessionLock, State, canonical_tool, error, initialized,
    postgres_store, read_completed_operation, recorded_call, required, session_actor,
};

const BODY_LIMIT: usize = 64 * 1024;
const MESSAGE_ID_LIMIT: usize = 128;

#[napi(js_name = "sendPeerMessage")]
pub async fn send_peer_message(input: String, policy: DispatchPolicy) -> napi::Result<String> {
    peer_call(input, policy, PeerKind::Send).await
}

#[napi(js_name = "admitPeerMessage")]
pub async fn admit_peer_message(input: String, policy: DispatchPolicy) -> napi::Result<String> {
    peer_call(input, policy, PeerKind::Admit).await
}

#[napi(js_name = "listPeerMessages")]
pub async fn list_peer_messages(input: String, policy: DispatchPolicy) -> napi::Result<String> {
    peer_call(input, policy, PeerKind::List).await
}

#[napi(js_name = "readPeerMessage")]
pub async fn read_peer_message(input: String, policy: DispatchPolicy) -> napi::Result<String> {
    peer_call(input, policy, PeerKind::Read).await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PeerKind {
    Send,
    Admit,
    List,
    Read,
}

async fn peer_call(input: String, policy: DispatchPolicy, kind: PeerKind) -> napi::Result<String> {
    let parsed: PeerInput = serde_json::from_str(&input).map_err(error)?;
    validate_actor(&parsed)?;
    let result = std::panic::AssertUnwindSafe(execute(parsed, policy.into(), kind))
        .catch_unwind()
        .await;
    match result {
        Ok(Ok(value)) => Ok(value.to_string()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(error(
            "OpenAPPA panicked; the peer message was not released",
        )),
    }
}

async fn execute(
    input: PeerInput,
    policy: super::deployments::HostedPolicy,
    kind: PeerKind,
) -> napi::Result<Value> {
    let state = initialized().await?;
    let deployment = state
        .deployments
        .deployment(
            &state.runtime,
            &input.organization_id,
            &policy,
            state.reporting.is_some(),
        )
        .await
        .map_err(error)?;
    let state = state.pinned(&deployment);
    // acting_root's connection lease is sequential with the execution lease
    // below, not nested. It must drop when acting_root returns, before
    // RootLock and state.lease().await. Holding it across either await can
    // exhaust the pool and deadlock the second lease.
    let root = acting_root(&state, &input).await?;
    let _root = super::RootLock::acquire(root.clone()).await;
    let leased = state.lease().await?;
    let pg = postgres_store(&leased.state.store)?;
    let _lock = SessionLock::acquire(pg, root.clone())?;
    // The family shares a log and operation journal. An interrupted receipt can
    // leave its projection incomplete, so non-recovery operations fail closed
    // across the root; ordinary open tool dispatches are not pending receipts.
    if kind != PeerKind::Read
        && leased
            .state
            .store
            .has_pending_receipts(&TrajectoryId::new(root.as_str()))
            .map_err(error)?
    {
        return Err(error(
            "OpenAPPA session has interrupted processing; operator recovery is required",
        ));
    }
    let actor = acting_actor(pg, &input, &root)?;
    match kind {
        PeerKind::Send => send(&leased.state, pg, &input, &actor).await,
        PeerKind::Admit => admit(&leased.state, pg, &input, &actor).await,
        PeerKind::List => list(&leased.state, pg, &input, &actor).await,
        PeerKind::Read => read(&leased.state, pg, &input, &actor).await,
    }
}

async fn send(
    state: &State,
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    actor: &Actor,
) -> napi::Result<Value> {
    let operation = required(&input.operation_id, "operation_id")?;
    let call_id = operation
        .strip_prefix("peer_send:")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error("peer send operation_id must be peer_send:<call-id>"))?;
    if call_id.chars().any(char::is_control) || operation.len() > 1024 {
        return Err(error("invalid peer send operation"));
    }
    let value = input
        .value
        .as_deref()
        .ok_or_else(|| error("missing peer message"))?;
    if value.is_empty() {
        return Ok(denied(
            "OpenAPPA did not send this message: the body is empty.",
        ));
    }
    if value.len() > BODY_LIMIT {
        return Ok(denied(
            "OpenAPPA did not send this message: the body exceeds 64KiB.",
        ));
    }
    let recipient = resolve_recipient(pg, input, &actor.root.0)?;
    let Recipient::Bound {
        trajectory,
        pending_spawn,
    } = recipient
    else {
        return Ok(denied(
            "OpenAPPA did not send this message: its recipient is not in this session's family.",
        ));
    };
    if trajectory == current_trajectory(actor).0 {
        return Ok(denied(
            "OpenAPPA did not send this message: a session cannot message itself.",
        ));
    }
    let request = json!({
        "event": "peer_send",
        "recipient_session_id": input.recipient_session_id,
        "recipient_parent_id": input.recipient_parent_id,
        "recipient_native_id": input.recipient_native_id,
        "recipient_spawn_call_id": input.recipient_spawn_call_id,
        "value": value,
    });
    let key = peer_operation_key(input, operation.to_owned());
    match state.store.claim_operation(OperationRequest {
        key: key.clone(),
        root: actor.root.clone(),
        input: request,
        context: None,
    }) {
        Ok(OperationClaim::Complete { decision }) => return Ok(decision),
        Ok(OperationClaim::Claimed) => {}
        Err(ReceiptError::InputMismatch) => {
            return Ok(denied(
                "OpenAPPA did not send this message: the operation id was already used for a different message.",
            ));
        }
        Err(reason) => return Err(error(reason)),
    }
    let notice = match state.runtime.send_embedded_peer(
        &actor.root,
        current_trajectory(actor),
        &TrajectoryId(trajectory),
        pending_spawn.as_deref(),
        &format!("call:{call_id}"),
        value,
    ) {
        Ok(notice) => notice,
        Err(EmbeddedPeerError::Refused(feedback)) => {
            let decision = denied(&feedback);
            state
                .store
                .complete_operation(key, decision.clone())
                .map_err(error)?;
            return Ok(decision);
        }
        Err(reason) => return Err(peer_failure(reason)),
    };
    let decision = released(&notice);
    state
        .store
        .complete_operation(key, decision.clone())
        .map_err(error)?;
    Ok(decision)
}

async fn admit(
    state: &State,
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    actor: &Actor,
) -> napi::Result<Value> {
    let notices = list_notices(state, pg, input, actor).await?;
    let structured = input.structured.unwrap_or(false);
    let message_id = blank_as_none(input.message_id.as_deref());
    let digest = match admit_digest(input.value.as_deref(), input.digest.as_deref()) {
        DigestCheck::Absent => None,
        DigestCheck::Value(digest) => Some(digest),
        DigestCheck::Unverified => return Ok(unverified()),
    };
    let Some(picked) = pick_admit(
        &notices,
        message_id,
        blank_as_none(input.sender_session_id.as_deref()),
        digest.as_deref(),
        structured,
    ) else {
        return Ok(unverified());
    };
    let id = match EmbeddedPeerId::parse(picked.message_id) {
        Ok(id) => id,
        Err(_) => return Ok(unverified()),
    };
    let sender = session_by_id(pg, &input.organization_id, picked.sender_session_id)?;
    let Some(sender) = sender else {
        return Ok(unverified());
    };
    if sender.root != actor.root.0 {
        return Ok(unverified());
    }
    let digest = match PeerDigest::parse(picked.digest) {
        Ok(digest) => digest,
        Err(_) => return Ok(unverified()),
    };
    match state.runtime.receive_embedded_peer(
        &actor.root,
        current_trajectory(actor),
        &id,
        &TrajectoryId(runtime_trajectory(&sender)),
        &digest,
    ) {
        Ok(EmbeddedPeerArrival::Direct { id, body }) => {
            if body.is_empty() {
                return Err(error(
                    "OpenAPPA returned an empty body for direct peer admission. No content was delivered. Check the peer inbox receipt and runtime storage.",
                ));
            }
            Ok(json!({
                "kind": "admitted",
                "message_id": id.as_str(),
                "value": body,
            }))
        }
        Ok(EmbeddedPeerArrival::Held(notice)) => Ok(held(&[notice_of(pg, input, &notice)?])),
        Err(EmbeddedPeerError::Refused(_)) => Ok(unverified()),
        Err(reason) => Err(peer_failure(reason)),
    }
}

async fn list(
    state: &State,
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    actor: &Actor,
) -> napi::Result<Value> {
    let Some(tool_call_id) = blank_as_none(input.tool_call_id.as_deref()) else {
        return Ok(json!({ "notices": list_notices(state, pg, input, actor).await? }));
    };
    if tool_call_id.len() > 1024 || tool_call_id.chars().any(char::is_control) {
        return Err(error("invalid tool call identity"));
    }
    let operation = format!("peer_list:{tool_call_id}");
    let key = peer_operation_key(input, operation);
    let tool = bounded_tool(input.tool.as_deref())?;
    let request = json!({ "event": "peer_list", "tool": tool });
    match state.store.claim_operation(OperationRequest {
        key: key.clone(),
        root: actor.root.clone(),
        input: request,
        context: None,
    }) {
        Ok(OperationClaim::Complete { decision }) => return Ok(decision),
        Ok(OperationClaim::Claimed) => {}
        Err(ReceiptError::InputMismatch) => return Ok(withheld_peer_list()),
        Err(reason) => return Err(error(reason)),
    }
    let notices = list_notices(state, pg, input, actor).await?;
    let decision = list_result(&notices);
    state
        .store
        .complete_operation(key, decision.clone())
        .map_err(error)?;
    let result_key = peer_result_key(input, tool_call_id);
    let approved = decision
        .get("approved_output")
        .and_then(Value::as_str)
        .unwrap_or("{}")
        .to_owned();
    match state
        .store
        .claim_processed_result(appa_eventlog::ProcessedResultRequest {
            key: result_key.clone(),
            root: actor.root.clone(),
        }) {
        Ok(appa_eventlog::ProcessedResultClaim::Complete {
            decision: stored, ..
        }) if stored.get("peer_list").and_then(Value::as_bool) == Some(true) => {
            return Ok(stored);
        }
        Ok(appa_eventlog::ProcessedResultClaim::Complete { .. })
        | Err(ReceiptError::NotPending) => {}
        Ok(appa_eventlog::ProcessedResultClaim::Claimed) | Err(ReceiptError::Pending) => {
            if let Err(reason) =
                state
                    .store
                    .complete_processed_result(result_key, approved, decision.clone())
                && !matches!(
                    reason,
                    ReceiptError::NotPending | ReceiptError::CompletionMismatch
                )
            {
                return Err(error(reason));
            }
        }
        Err(reason) => return Err(error(reason)),
    }
    Ok(decision)
}

fn list_result(notices: &[Value]) -> Value {
    let messages: Vec<Value> = notices
        .iter()
        .map(|notice| {
            json!({
                "message_id": notice.get("message_id").and_then(Value::as_str).unwrap_or(""),
                "expires_at": notice.get("expires_at").and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect();
    // One serialization serves the replay receipt and the MCP transport view.
    let approved_output = json!({ "messages": messages }).to_string();
    json!({
        "decision": "mcp_result",
        "peer_list": true,
        "notices": notices,
        "approved_output": approved_output,
        "output_source": "runtime",
        "result": {
            "isError": false,
            "content": [{ "type": "text", "text": approved_output }],
        },
    })
}

async fn list_notices(
    state: &State,
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    actor: &Actor,
) -> napi::Result<Vec<Value>> {
    let notices = state
        .runtime
        .list_embedded_peer(&actor.root, current_trajectory(actor))
        .map_err(peer_failure)?;
    notices
        .iter()
        .map(|notice| notice_of(pg, input, notice))
        .collect()
}

async fn read(
    state: &State,
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    actor: &Actor,
) -> napi::Result<Value> {
    let tool_call_id = required(&input.tool_call_id, "tool_call_id")?;
    if tool_call_id.len() > 1024 || tool_call_id.chars().any(char::is_control) {
        return Err(error("invalid tool call identity"));
    }
    let message_id = required(&input.message_id, "message_id")?;
    if message_id.len() > MESSAGE_ID_LIMIT || message_id.chars().any(char::is_control) {
        return Err(error("invalid peer message id"));
    }
    let tool = required(&input.tool, "tool")?;
    let result_key = peer_result_key(input, tool_call_id);
    if let Some(done) = completed_decision(pg, &result_key)?
        && admitted_read(&done)
    {
        return Ok(done);
    }
    let id = EmbeddedPeerId::parse(message_id).map_err(|_| error("invalid peer message id"))?;
    let arguments =
        RawValue::from_string(json!({ "message_id": message_id }).to_string()).map_err(error)?;
    let outcome = match state
        .runtime
        .read_embedded_peer(
            actor,
            tool_call_id,
            &id,
            ProposedCall {
                tool: canonical_tool(tool)?,
                arguments,
                cwd: None,
            },
        )
        .await
    {
        Ok(outcome) => outcome,
        Err(EmbeddedPeerError::Refused(feedback)) => return Err(error(feedback)),
        Err(reason) => return Err(peer_failure(reason)),
    };
    match &outcome.decision {
        HookDecision::DeliverValue { value } | HookDecision::ReplaceOutput { output: value } => {
            if value.is_empty() {
                return Err(error(
                    "OpenAPPA returned an empty body for an admitted peer read",
                ));
            }
            let decision = read_result(value, false);
            journal_processed(state, &actor.root, &result_key, value, &decision, true)?;
            Ok(decision)
        }
        HookDecision::DenyCall { .. } | HookDecision::Block { .. } => {
            let mut decision = super::with_presentation_offers(
                super::wire(&outcome.decision)?,
                outcome.presentation.as_ref(),
            )?;
            decision["peer_read_denied"] = Value::Bool(true);
            decision["message_id"] = json!(message_id);
            decision
                .as_object_mut()
                .map(|object| object.remove("value"));
            let feedback = decision
                .get("feedback")
                .or_else(|| decision.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("OpenAPPA withheld this peer read")
                .to_owned();
            decision["approved_output"] = json!(feedback);
            journal_processed(state, &actor.root, &result_key, &feedback, &decision, false)?;
            retain_denial(state, input, &actor.root, tool_call_id, &decision)?;
            Ok(decision)
        }
        HookDecision::Ack => Err(error(
            "OpenAPPA acknowledged a peer read without binding its stored label",
        )),
        HookDecision::Refuse { detail } => {
            Err(error(format!("OpenAPPA refused the peer read: {detail}")))
        }
        _ => Err(error("unexpected peer read decision")),
    }
}

fn admitted_read(decision: &Value) -> bool {
    decision.get("peer_read").and_then(Value::as_bool) == Some(true)
        && decision
            .get("result")
            .and_then(|result| result.get("isError"))
            .and_then(Value::as_bool)
            == Some(false)
}

fn journal_processed(
    state: &State,
    root: &TrajectoryId,
    result_key: &ProcessedResultKey,
    approved: &str,
    decision: &Value,
    replace_denial: bool,
) -> napi::Result<()> {
    if replace_denial && replace_denial_receipt(state, result_key, approved, decision)? {
        return Ok(());
    }
    match state
        .store
        .claim_processed_result(appa_eventlog::ProcessedResultRequest {
            key: result_key.clone(),
            root: root.clone(),
        }) {
        Ok(appa_eventlog::ProcessedResultClaim::Complete {
            decision: stored, ..
        }) => {
            if admitted_read(&stored) {
                return Ok(());
            }
            if denial_receipt(&stored) && !admitted_read(decision) {
                return Ok(());
            }
            if denial_receipt(&stored) && admitted_read(decision) {
                if !replace_denial_receipt(state, result_key, approved, decision)? {
                    return Err(error(
                        "OpenAPPA could not replace the peer-read denial receipt",
                    ));
                }
                return Ok(());
            }
            Err(error(
                "OpenAPPA will not replace a processed result that is not a peer-read denial",
            ))
        }
        Ok(appa_eventlog::ProcessedResultClaim::Claimed) | Err(ReceiptError::Pending) => state
            .store
            .complete_processed_result(result_key.clone(), approved.to_owned(), decision.clone())
            .map_err(error),
        Err(reason) => Err(error(reason)),
    }
}

fn replace_denial_receipt(
    state: &State,
    result_key: &ProcessedResultKey,
    approved: &str,
    decision: &Value,
) -> napi::Result<bool> {
    let organization_id = result_key.session.organization_id.clone();
    let session_id = result_key.session.session_id.clone();
    let tool_call_id = result_key.tool_call_id.clone();
    let approved = approved.to_owned();
    let decision = decision.clone();
    postgres_store(&state.store)?
        .with_client(move |client| {
            Ok(client.execute(
                "UPDATE openappa_processed_results \
                 SET status = 'complete', approved_output = $4, decision = $5 \
                 WHERE organization_id = $1 AND session_id = $2 AND tool_call_id = $3 \
                   AND status = 'complete' \
                   AND decision->>'peer_read_denied' = 'true'",
                &[
                    &organization_id,
                    &session_id,
                    &tool_call_id,
                    &approved,
                    &decision,
                ],
            )?)
        })
        .map(|updated| updated > 0)
        .map_err(error)
}

fn denial_receipt(decision: &Value) -> bool {
    decision.get("peer_read_denied").and_then(Value::as_bool) == Some(true)
        && decision.get("value").is_none()
        && decision
            .get("result")
            .and_then(|result| result.get("content"))
            .is_none()
}

fn retain_denial(
    state: &State,
    input: &PeerInput,
    root: &TrajectoryId,
    tool_call_id: &str,
    decision: &Value,
) -> napi::Result<()> {
    let key = peer_operation_key(input, format!("peer_read_notice:{tool_call_id}"));
    let request = json!({
        "event": "peer_read_notice",
        "message_id": input.message_id,
        "tool": input.tool,
    });
    match state.store.claim_operation(OperationRequest {
        key: key.clone(),
        root: root.clone(),
        input: request,
        context: None,
    }) {
        Ok(OperationClaim::Complete { .. }) => return Ok(()),
        Ok(OperationClaim::Claimed) | Err(ReceiptError::Pending) => {}
        Err(ReceiptError::InputMismatch) => return Ok(()),
        Err(reason) => return Err(error(reason)),
    }
    state
        .store
        .complete_operation(key, decision.clone())
        .map_err(error)
}

fn read_result(text: &str, is_error: bool) -> Value {
    json!({
        "decision": "mcp_result",
        "peer_read": true,
        "approved_output": text,
        "output_source": "runtime",
        "result": {
            "isError": is_error,
            "content": [{ "type": "text", "text": text }],
        },
    })
}

pub(super) fn forged_read_result(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &super::Input,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let operation = super::operation_key(
        input,
        super::session_binding(input),
        format!("call:{call_id}"),
    );
    let Some(released) = read_completed_operation(pg, &operation)? else {
        return Ok(None);
    };
    let Ok(call) = recorded_call(released.context, released.input) else {
        return Ok(None);
    };
    if is_peer_read_tool(&call.tool) {
        let key = super::processed_result_key(input, call_id.to_owned());
        if let Some(done) = completed_decision(pg, &key)?
            && (admitted_read(&done) || denial_receipt(&done))
        {
            return Ok(Some(done));
        }
        return Ok(Some(withheld_peer_read()));
    }
    if is_peer_list_tool(&call.tool) {
        let key = super::processed_result_key(input, call_id.to_owned());
        if let Some(done) = completed_decision(pg, &key)?
            && done.get("peer_list").and_then(Value::as_bool) == Some(true)
        {
            return Ok(Some(done));
        }
        return Ok(Some(withheld_peer_list()));
    }
    Ok(None)
}

pub(super) fn is_peer_read_tool(raw: &str) -> bool {
    peer_tool(raw, "read_peer_message")
}

fn is_peer_list_tool(raw: &str) -> bool {
    peer_tool(raw, "list_peer_messages")
}

fn peer_tool(raw: &str, short_name: &str) -> bool {
    raw == short_name
        || raw.ends_with(&format!("__{short_name}"))
        || canonical_tool(raw)
            .ok()
            .is_some_and(|name| name.ends_with(&format!("/{short_name}")))
}

pub(super) fn withheld_peer_read() -> Value {
    withheld("OpenAPPA withheld this peer read: the client result is not the retained native read.")
}

fn withheld_peer_list() -> Value {
    withheld(
        "OpenAPPA withheld this peer list: the client result is not the retained native metadata.",
    )
}

fn withheld(text: &str) -> Value {
    json!({
        "decision": "block",
        "feedback": text,
        "approved_output": text,
        "output_source": "runtime",
    })
}

fn completed_decision(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    key: &appa_eventlog::ProcessedResultKey,
) -> napi::Result<Option<Value>> {
    let organization_id = key.session.organization_id.clone();
    let session_id = key.session.session_id.clone();
    let tool_call_id = key.tool_call_id.clone();
    pg.with_client(move |client| {
        Ok(client
            .query_opt(
                "SELECT decision FROM openappa_processed_results \
                 WHERE organization_id = $1 AND session_id = $2 AND tool_call_id = $3 AND status = 'complete'",
                &[&organization_id, &session_id, &tool_call_id],
            )?
            .and_then(|row| row.get::<_, Option<Value>>(0)))
    })
    .map_err(error)
}

fn notice_of(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    notice: &EmbeddedPeerNotice,
) -> napi::Result<Value> {
    let sender = session_for_trajectory(pg, &input.organization_id, notice.sender.as_str())?;
    let recipient = session_for_trajectory(pg, &input.organization_id, notice.recipient.as_str())?;
    let (Some(sender), Some(recipient)) = (sender, recipient) else {
        return Err(error(format!(
            "OpenAPPA peer notice names a session this organization has not started ({}/{})",
            notice.sender.as_str(),
            notice.recipient.as_str(),
        )));
    };
    Ok(json!({
        "message_id": notice.id.as_str(),
        "sender_session_id": sender.session_id,
        "recipient_session_id": recipient.session_id,
        "digest": notice.digest.to_string(),
        "expires_at": iso8601(notice.expires),
    }))
}

fn released(notice: &EmbeddedPeerNotice) -> Value {
    json!({
        "kind": "released",
        "message_id": notice.id.as_str(),
    })
}

fn denied(feedback: &str) -> Value {
    json!({ "kind": "denied", "feedback": feedback })
}

fn held(notices: &[Value]) -> Value {
    json!({ "kind": "held", "notices": notices })
}

fn unverified() -> Value {
    json!({ "kind": "unverified" })
}

fn peer_failure(reason: EmbeddedPeerError) -> napi::Error {
    match reason {
        EmbeddedPeerError::Storage(detail) => {
            error(format!("OpenAPPA peer storage failed: {detail}"))
        }
        EmbeddedPeerError::Refused(feedback) => error(feedback),
    }
}

fn peer_operation_key(input: &PeerInput, operation_id: String) -> OperationKey {
    OperationKey {
        session: SessionScope {
            organization_id: input.organization_id.clone(),
            session_id: input.session_id.clone(),
        },
        binding: ReceiptBinding::Session {
            caller_id: input.caller_id.clone(),
        },
        operation_id,
    }
}

fn peer_result_key(input: &PeerInput, tool_call_id: &str) -> ProcessedResultKey {
    ProcessedResultKey {
        session: SessionScope {
            organization_id: input.organization_id.clone(),
            session_id: input.session_id.clone(),
        },
        caller_id: input.caller_id.clone(),
        tool_call_id: tool_call_id.to_owned(),
    }
}

fn current_trajectory(actor: &Actor) -> &TrajectoryId {
    actor.child.as_ref().unwrap_or(&actor.root)
}

async fn acting_root(state: &State, input: &PeerInput) -> napi::Result<String> {
    let key = SessionKey::new(&input.organization_id, &input.session_id);
    // Local lease only. Do not return it, and do not await again while it is held.
    let leased = state.lease().await?;
    let root = postgres_store(&leased.state.store)?
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| row.get::<_, String>(0)))
        })
        .map_err(error)?;
    root.ok_or_else(|| error("OpenAPPA session has not started"))
}

fn acting_actor(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    root: &str,
) -> napi::Result<Actor> {
    let Some(row) = session_by_id(pg, &input.organization_id, &input.session_id)? else {
        return Err(error("OpenAPPA session has not started"));
    };
    if row.root != root || row.parent_id.as_deref() != input.parent_id.as_deref() {
        return Err(error("session identity changed"));
    }
    Ok(Actor {
        root: TrajectoryId(root.to_owned()),
        child: input.parent_id.as_ref().map(|_| TrajectoryId(row.actor)),
    })
}

enum Recipient {
    Bound {
        trajectory: String,
        pending_spawn: Option<String>,
    },
    Foreign,
}

fn resolve_recipient(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    input: &PeerInput,
    root: &str,
) -> napi::Result<Recipient> {
    let session_id = required(&input.recipient_session_id, "recipient_session_id")?;
    opaque_id(session_id, "recipient session", 1024)?;
    if let Some(native_id) = input.recipient_native_id.as_deref() {
        opaque_id(native_id, "recipient native id", 1024)?;
    }
    let rows = sessions_by_id(pg, &input.organization_id, session_id)?;
    if rows.len() > 1 {
        return Err(error("recipient session identity is ambiguous"));
    }
    if let Some(row) = rows.into_iter().next() {
        if row.root != root {
            return Ok(Recipient::Foreign);
        }
        if let Some(parent) = input.recipient_parent_id.as_deref()
            && row.parent_id.as_deref() != Some(parent)
        {
            return Ok(Recipient::Foreign);
        }
        return Ok(Recipient::Bound {
            trajectory: runtime_trajectory(&row),
            pending_spawn: None,
        });
    }
    let Some(parent_id) = input.recipient_parent_id.as_deref() else {
        return Ok(Recipient::Foreign);
    };
    opaque_id(parent_id, "recipient parent", 1024)?;
    // The parent prefix is structural, not authority. The remaining native id
    // is opaque and may contain ':'; opaque_id rejects control characters.
    // The same-root parent and retained allowed spawn below authorize binding.
    if !session_id
        .strip_prefix(parent_id)
        .is_some_and(|suffix| suffix.starts_with(':') && suffix.len() > 1)
    {
        return Ok(Recipient::Foreign);
    }
    let Some(parent) = session_by_id(pg, &input.organization_id, parent_id)? else {
        return Ok(Recipient::Foreign);
    };
    if parent.root != root {
        return Ok(Recipient::Foreign);
    }
    let Some(spawn_call_id) = input.recipient_spawn_call_id.as_deref() else {
        return Ok(Recipient::Foreign);
    };
    opaque_id(spawn_call_id, "recipient spawn call", 1024)?;
    let Some(binding) = allowed_spawn_binding(
        pg,
        &input.organization_id,
        parent_id,
        spawn_call_id,
        input.recipient_native_id.as_deref(),
    )?
    else {
        return Ok(Recipient::Foreign);
    };
    Ok(Recipient::Bound {
        trajectory: session_actor(session_id),
        pending_spawn: Some(binding),
    })
}

fn allowed_spawn_binding(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    organization_id: &str,
    parent_id: &str,
    spawn_call_id: &str,
    native_id: Option<&str>,
) -> napi::Result<Option<String>> {
    let organization_id = organization_id.to_owned();
    let parent_id = parent_id.to_owned();
    let operation_id = format!("call:{spawn_call_id}");
    let native_id = native_id.map(str::to_owned);
    pg.with_client(move |client| {
        let Some(row) = client.query_opt(
            "SELECT input, status, decision FROM openappa_operations \
             WHERE organization_id = $1 AND session_id = $2 AND operation_id = $3",
            &[&organization_id, &parent_id, &operation_id],
        )?
        else {
            return Ok(None);
        };
        let status: String = row.get("status");
        if status != "complete" {
            return Ok(None);
        }
        let input: Value = row.get("input");
        let decision: Option<Value> = row.get("decision");
        let Some(decision) = decision else {
            return Ok(None);
        };
        let semantic = input.get("semantic").unwrap_or(&input);
        if semantic.get("spawn").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        if decision.get("decision").and_then(Value::as_str) != Some("allow_call") {
            return Ok(None);
        }
        if let Some(native_id) = native_id.as_deref()
            && let Some(stored) = semantic.get("child_native_id").and_then(Value::as_str)
            && stored != native_id
        {
            return Ok(None);
        }
        Ok(decision
            .get("spawn_binding")
            .and_then(Value::as_str)
            .filter(|binding| !binding.is_empty())
            .map(str::to_owned))
    })
    .map_err(error)
}

struct SessionRow {
    actor: String,
    root: String,
    parent_id: Option<String>,
    session_id: String,
}

fn session_by_id(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    organization_id: &str,
    session_id: &str,
) -> napi::Result<Option<SessionRow>> {
    let mut rows = sessions_by_id(pg, organization_id, session_id)?;
    if rows.len() > 1 {
        return Err(error("session identity is ambiguous"));
    }
    Ok(rows.pop())
}

fn runtime_trajectory(row: &SessionRow) -> String {
    if row.parent_id.is_none() {
        row.root.clone()
    } else {
        row.actor.clone()
    }
}

fn session_for_trajectory(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    organization_id: &str,
    trajectory: &str,
) -> napi::Result<Option<SessionRow>> {
    if let Some(row) = session_by_actor(pg, organization_id, trajectory)? {
        return Ok(Some(row));
    }
    let organization_id = organization_id.to_owned();
    let trajectory = trajectory.to_owned();
    let rows = pg
        .with_client(move |client| {
            Ok(client
                .query(
                    "SELECT actor, root, parent_id, session_id FROM openappa_sessions \
                     WHERE organization_id = $1 AND root = $2 AND parent_id IS NULL",
                    &[&organization_id, &trajectory],
                )?
                .into_iter()
                .map(|row| SessionRow {
                    actor: row.get(0),
                    root: row.get(1),
                    parent_id: row.get(2),
                    session_id: row.get(3),
                })
                .collect::<Vec<_>>())
        })
        .map_err(error)?;
    if rows.len() > 1 {
        return Err(error("session root identity is ambiguous"));
    }
    Ok(rows.into_iter().next())
}

fn session_by_actor(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    organization_id: &str,
    actor: &str,
) -> napi::Result<Option<SessionRow>> {
    let organization_id = organization_id.to_owned();
    let actor = actor.to_owned();
    let rows = pg
        .with_client(move |client| {
            Ok(client
                .query(
                    "SELECT actor, root, parent_id, session_id FROM openappa_sessions \
                     WHERE organization_id = $1 AND actor = $2",
                    &[&organization_id, &actor],
                )?
                .into_iter()
                .map(|row| SessionRow {
                    actor: row.get(0),
                    root: row.get(1),
                    parent_id: row.get(2),
                    session_id: row.get(3),
                })
                .collect::<Vec<_>>())
        })
        .map_err(error)?;
    if rows.len() > 1 {
        return Err(error("session actor identity is ambiguous"));
    }
    Ok(rows.into_iter().next())
}

fn sessions_by_id(
    pg: &appa_eventlog::postgres::LeasedPostgres,
    organization_id: &str,
    session_id: &str,
) -> napi::Result<Vec<SessionRow>> {
    let organization_id = organization_id.to_owned();
    let session_id = session_id.to_owned();
    pg.with_client(move |client| {
        Ok(client
            .query(
                "SELECT actor, root, parent_id, session_id FROM openappa_sessions \
                 WHERE organization_id = $1 AND session_id = $2",
                &[&organization_id, &session_id],
            )?
            .into_iter()
            .map(|row| SessionRow {
                actor: row.get(0),
                root: row.get(1),
                parent_id: row.get(2),
                session_id: row.get(3),
            })
            .collect())
    })
    .map_err(error)
}

fn validate_actor(input: &PeerInput) -> napi::Result<()> {
    opaque_id(&input.organization_id, "organization", 512)?;
    opaque_id(&input.session_id, "session", 1024)?;
    if let Some(caller) = input.caller_id.as_deref() {
        opaque_id(caller, "caller", 512)?;
    }
    if let Some(parent) = input.parent_id.as_deref() {
        opaque_id(parent, "parent", 1024)?;
    }
    Ok(())
}

/// The caller's public tool spelling, bounded before it is stored. The name is
/// kept as sent so a whitelabel spelling still matches a later call.
fn bounded_tool(raw: Option<&str>) -> napi::Result<Option<String>> {
    let Some(tool) = blank_as_none(raw) else {
        return Ok(None);
    };
    opaque_id(tool, "tool", 512)?;
    Ok(Some(tool.to_owned()))
}

fn opaque_id(value: &str, name: &str, limit: usize) -> napi::Result<()> {
    if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(error(format!("invalid {name} identity")));
    }
    Ok(())
}

fn blank_as_none(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

enum DigestCheck {
    Absent,
    Value(String),
    Unverified,
}

fn admit_digest(value: Option<&str>, digest: Option<&str>) -> DigestCheck {
    let digest = blank_as_none(digest);
    let value = value.filter(|text| !text.is_empty());
    match (value, digest) {
        (None, None) => DigestCheck::Absent,
        (Some(value), None) => DigestCheck::Value(PeerDigest::of_body(value).to_string()),
        (None, Some(digest)) => match PeerDigest::parse(digest) {
            Ok(parsed) => DigestCheck::Value(parsed.to_string()),
            Err(_) => DigestCheck::Unverified,
        },
        (Some(value), Some(digest)) => {
            let computed = PeerDigest::of_body(value).to_string();
            if computed == digest {
                DigestCheck::Value(computed)
            } else {
                DigestCheck::Unverified
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AdmitCandidate<'a> {
    message_id: &'a str,
    sender_session_id: &'a str,
    digest: &'a str,
}

fn pick_admit<'a>(
    notices: &'a [Value],
    message_id: Option<&'a str>,
    sender: Option<&'a str>,
    digest: Option<&'a str>,
    structured: bool,
) -> Option<AdmitCandidate<'a>> {
    if structured && message_id.is_none() {
        return None;
    }
    let notices: Vec<AdmitCandidate<'_>> = notices
        .iter()
        .filter_map(|notice| {
            Some(AdmitCandidate {
                message_id: notice.get("message_id")?.as_str()?,
                sender_session_id: notice.get("sender_session_id")?.as_str()?,
                digest: notice.get("digest")?.as_str()?,
            })
        })
        .collect();
    if let Some(message_id) = message_id {
        let mut matches = notices
            .into_iter()
            .filter(|notice| notice.message_id == message_id);
        let notice = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        if sender.is_some_and(|sender| sender != notice.sender_session_id) {
            return None;
        }
        if digest.is_some_and(|digest| digest != notice.digest) {
            return None;
        }
        return Some(notice);
    }
    let (Some(sender), Some(digest)) = (sender, digest) else {
        return None;
    };
    let mut matches = notices
        .into_iter()
        .filter(|notice| notice.sender_session_id == sender && notice.digest == digest);
    let notice = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(notice)
}

fn iso8601(time: SystemTime) -> String {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .unwrap_or(chrono::DateTime::UNIX_EPOCH)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PeerInput {
    organization_id: String,
    #[serde(default)]
    caller_id: Option<String>,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    recipient_session_id: Option<String>,
    #[serde(default)]
    recipient_parent_id: Option<String>,
    #[serde(default)]
    recipient_native_id: Option<String>,
    #[serde(default)]
    recipient_spawn_call_id: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    sender_session_id: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    structured: Option<bool>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{AdmitCandidate, PeerInput, bounded_tool, iso8601, pick_admit, validate_actor};
    use serde_json::json;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn epoch_formats_as_utc() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso8601(UNIX_EPOCH - Duration::from_secs(1)),
            "1970-01-01T00:00:00Z"
        );
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            "2023-11-14T22:13:20Z"
        );
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_millis(1_709_164_800_999)),
            "2024-02-29T00:00:00Z"
        );
    }

    #[test]
    fn identical_digests_are_not_picked_by_age() {
        let notices = vec![
            json!({
                "message_id": "older",
                "sender_session_id": "sender",
                "digest": "aa",
            }),
            json!({
                "message_id": "newer",
                "sender_session_id": "sender",
                "digest": "aa",
            }),
        ];
        assert!(pick_admit(&notices, None, Some("sender"), Some("aa"), false).is_none());
    }

    #[test]
    fn a_structured_arrival_without_an_id_does_not_pick() {
        let notices = vec![json!({
            "message_id": "only",
            "sender_session_id": "sender",
            "digest": "aa",
        })];
        assert!(pick_admit(&notices, None, Some("sender"), Some("aa"), true).is_none());
    }

    #[test]
    fn one_id_match_uses_that_row_not_a_hash() {
        let notices = vec![json!({
            "message_id": "chosen",
            "sender_session_id": "sender",
            "digest": "aa",
        })];
        let picked = pick_admit(&notices, Some("chosen"), None, None, false).expect("unique id");
        assert_eq!(
            picked,
            AdmitCandidate {
                message_id: "chosen",
                sender_session_id: "sender",
                digest: "aa",
            }
        );
    }

    fn actor(caller_id: Option<&str>) -> PeerInput {
        PeerInput {
            organization_id: "org".to_owned(),
            caller_id: caller_id.map(str::to_owned),
            session_id: "session".to_owned(),
            parent_id: None,
            operation_id: None,
            recipient_session_id: None,
            recipient_parent_id: None,
            recipient_native_id: None,
            recipient_spawn_call_id: None,
            value: None,
            message_id: None,
            sender_session_id: None,
            digest: None,
            structured: None,
            tool_call_id: None,
            tool: None,
        }
    }

    #[test]
    fn caller_id_uses_the_organization_identity_limit() {
        assert!(validate_actor(&actor(None)).is_ok());
        assert!(validate_actor(&actor(Some("user:alice"))).is_ok());
        assert!(validate_actor(&actor(Some(&"c".repeat(512)))).is_ok());
        assert!(validate_actor(&actor(Some(&"c".repeat(513)))).is_err());
        assert!(validate_actor(&actor(Some("user:alice\n"))).is_err());
        assert!(validate_actor(&actor(Some(""))).is_err());
    }

    #[test]
    fn a_list_tool_keeps_its_public_name_inside_the_bound() {
        assert_eq!(
            bounded_tool(Some("acme__list_peer_messages")).unwrap(),
            Some("acme__list_peer_messages".to_owned())
        );
        assert_eq!(bounded_tool(Some("")).unwrap(), None);
        assert!(bounded_tool(Some(&"t".repeat(513))).is_err());
        assert!(bounded_tool(Some("acme__list\n")).is_err());
    }
}
