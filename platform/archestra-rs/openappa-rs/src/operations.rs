use crate::{
    Sql, adapter,
    errors::{held_elsewhere, invalid_input, receipt_failure, sql_failure},
    input::{Input, OfferInput, OfferOwner, TrajectoryStamp, required},
    lease,
    remedy::decision_text,
    sealed,
    session::{SessionKey, operation_key, session_actor, session_binding},
};
use appa_eventlog::{
    LogStore, OperationClaim, OperationKey, OperationRequest, ProcessedResultClaim,
    ProcessedResultKey, ProcessedResultRequest, ReceiptBinding,
    encryption::{StorageCipher, field_context},
};
use appa_runtime_api::{Actor, CanonicalTool, ProposedCall, TrajectoryId};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const UNRELEASED_CALL_CODE: &str = "unreleased_call";

pub(crate) fn cancellation_operation(call_id: &str) -> String {
    format!("cancel:{call_id}")
}

pub(crate) struct CompletedOperation {
    pub(crate) input: Value,
    pub(crate) context: Option<Value>,
    pub(crate) decision: Value,
}

/// The operation receipt's state: absent, claimed but never completed (its
/// dispatch was interrupted mid-operation), or completed with its decision.
pub(crate) enum OperationState {
    Absent,
    Pending {
        input: Value,
        context: Option<Value>,
    },
    Complete(CompletedOperation),
}

pub(crate) fn read_operation_state(
    pg: &Sql<'_>,
    key: &OperationKey,
) -> napi::Result<OperationState> {
    let session_id = key.session.session_id.clone();
    let operation_id = key.operation_id.clone();
    let organization_id = key.session.organization_id.clone();
    let cipher = pg.0.cipher().clone();
    pg.with_client(move |client| {
        let row = client.query_opt(
            "SELECT input, status, decision FROM openappa_operations WHERE session_id=$1 AND operation_id=$2 AND organization_id=$3",
            &[&session_id, &operation_id, &organization_id],
        )?;
        let Some(row) = row else {
            return Ok(OperationState::Absent);
        };
        let input = cipher.open_json(&field_context(&["openappa_operations", &organization_id, &session_id, &operation_id, "input"]), row.get("input"))?;
        let (actual_input, context) = if let Some(obj) = input.as_object() {
            if let Some(semantic) = obj.get("semantic") {
                (semantic.clone(), obj.get("context").cloned())
            } else if let Some(legacy) = obj.get("input") {
                (legacy.clone(), obj.get("context").cloned())
            } else {
                (input, None)
            }
        } else {
            (input, None)
        };
        let status: String = row.get("status");
        if status != "complete" {
            return Ok(OperationState::Pending {
                input: actual_input,
                context,
            });
        }
        let decision = row.get::<_, Option<Value>>("decision").map(|value| cipher.open_json(&field_context(&["openappa_operations", &organization_id, &session_id, &operation_id, "decision"]), value)).transpose()?;
        let Some(decision) = decision else {
            return Ok(OperationState::Absent);
        };
        Ok(OperationState::Complete(CompletedOperation {
            input: actual_input,
            context,
            decision,
        }))
    })
    .map_err(sql_failure)
}

pub(crate) fn read_completed_operation(
    pg: &Sql<'_>,
    key: &OperationKey,
) -> napi::Result<Option<CompletedOperation>> {
    Ok(match read_operation_state(pg, key)? {
        OperationState::Complete(completed) => Some(completed),
        OperationState::Absent | OperationState::Pending { .. } => None,
    })
}

pub(crate) fn cancelled_call(
    pg: &Sql<'_>,
    input: &Input,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let key = operation_key(
        input,
        session_binding(input),
        cancellation_operation(call_id),
    );
    Ok(read_completed_operation(pg, &key)?.map(|record| record.decision))
}

pub(crate) fn required_arguments(input: &Input) -> napi::Result<&str> {
    input
        .arguments
        .as_ref()
        .map(|args| args.get())
        .ok_or_else(|| invalid_input("missing arguments"))
}
pub(crate) fn proposed(input: &Input) -> napi::Result<ProposedCall> {
    Ok(ProposedCall {
        tool: canonical_tool(required(&input.tool, "tool")?)?,
        arguments: input
            .arguments
            .clone()
            .ok_or_else(|| invalid_input("missing arguments"))?,
        cwd: None,
    })
}

/// The identity the runtime judges: the host's spelling derived through the
/// Archestra adapter, the way the wire derives a served host's calls.
pub(crate) fn canonical_tool(raw: &str) -> napi::Result<String> {
    (adapter::adapter().identify_tool)(raw)
        .map(|derived| derived.canonical.as_str().to_owned())
        .map_err(|refusal| {
            invalid_input(match refusal {
                appa_runtime_api::ParseRefusal::Unreadable { detail }
                | appa_runtime_api::ParseRefusal::Malformed { detail } => detail,
            })
        })
}

/// The host's spelling of a canonical identity the runtime hands back, for the
/// model's eyes; a canonical id the adapter cannot spell stays as it is.
pub(crate) fn spelled_tool(canonical: &str) -> String {
    CanonicalTool::parse(canonical)
        .ok()
        .and_then(|tool| (adapter::adapter().spell)(&tool))
        .unwrap_or_else(|| canonical.to_owned())
}

pub(crate) fn validate_trajectory(trajectory: &TrajectoryStamp) -> napi::Result<()> {
    if trajectory.v != 1 {
        return Err(invalid_input("invalid trajectory"));
    }
    if trajectory.session_id.is_empty()
        || trajectory.session_id.len() > 1024
        || trajectory.session_id.chars().any(char::is_control)
    {
        return Err(invalid_input("invalid session identity"));
    }
    if let Some(parent) = &trajectory.parent_id
        && (parent.is_empty() || parent.len() > 1024 || parent.chars().any(char::is_control))
    {
        return Err(invalid_input("invalid parent identity"));
    }
    Ok(())
}

/// The actor the runtime must match. A child stamp names this session; a root
/// stamp does not.
pub(crate) fn expected_actor(root: &str, session_id: &str, parent_id: Option<&str>) -> Actor {
    Actor {
        root: TrajectoryId(root.to_owned()),
        child: parent_id
            .is_some()
            .then(|| TrajectoryId(session_actor(session_id))),
    }
}

/// A present caller is the receipt spender. An anonymous token has no user id,
/// so its receipt is session-bound and still not an owner match.
pub(crate) fn remedy_binding(caller_id: &Option<String>) -> ReceiptBinding {
    match caller_id {
        Some(caller_id) => ReceiptBinding::Caller {
            caller_id: caller_id.clone(),
        },
        None => ReceiptBinding::Session { caller_id: None },
    }
}

pub(crate) fn operation_semantic(input: &Input) -> Value {
    json!({
        "event": input.event,
        "tool": input.tool,
        "arguments": input.arguments,
        "spawn": input.spawn,
        "output": input.output,
        "spawn_call_id": input.spawn_call_id,
        "child_native_id": input.child_native_id,
    })
}

/// Host retry text lives beside the call, not in the idempotency key. Absent
/// fields are omitted so an old row and a call without them stay the same shape.
pub(crate) fn tool_call_context(input: &Input) -> Value {
    let mut context = json!({
        "tool": input.tool,
        "arguments": input.arguments,
        "spawn": input.spawn,
        "presentation": input.presentation,
    });
    if let Some(spelling) = &input.spelling {
        context["spelling"] = Value::String(spelling.clone());
    }
    if let Some(dispatch) = &input.dispatch {
        context["dispatch"] = Value::String(dispatch.clone());
    }
    context
}

#[derive(Default)]
pub(crate) struct CallPresentation {
    pub(crate) tool: Option<String>,
    pub(crate) spelling: Option<String>,
    pub(crate) dispatch: Option<String>,
}

pub(crate) fn presentation_from_context(context: Option<&Value>) -> CallPresentation {
    let Some(context) = context else {
        return CallPresentation::default();
    };
    CallPresentation {
        tool: json_string(context, "tool"),
        spelling: json_string(context, "spelling"),
        dispatch: json_string(context, "dispatch"),
    }
}

fn presentation_from_row(context: Option<&Value>, tool: Option<String>) -> CallPresentation {
    let mut presentation = presentation_from_context(context);
    if presentation.tool.is_none() {
        presentation.tool = present(tool);
    }
    presentation
}

pub(crate) fn presentation_from_receipt(
    context: Option<&Value>,
    tool: Option<String>,
    event: Option<&str>,
) -> CallPresentation {
    let mut presentation = presentation_from_row(context, tool);
    if presentation.spelling.is_none() && event == Some("peer_read_notice") {
        presentation.spelling = presentation.tool.clone();
    }
    presentation
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    present(value.get(key).and_then(Value::as_str).map(str::to_owned))
}

pub(crate) fn present(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// The original call's retry text. A missing row or missing fields is an empty
/// presentation, not a refusal: the runtime still decides whether the offer is
/// live, and old rows fall back to the canonical tool spelling.
pub(crate) fn encrypted_receipts(
    pg: &Sql<'_>,
    organization_id: &str,
    session_id: &str,
) -> napi::Result<Vec<(Value, Value)>> {
    let (organization_id, session_id) = (organization_id.to_owned(), session_id.to_owned());
    let cipher = pg.0.cipher().clone();
    pg.with_client(move |client| {
        let receipts = sealed::read(
            client,
            &cipher,
            sealed::Receipts::All,
            "o.organization_id=$1 AND o.session_id=$2",
            &[&organization_id, &session_id],
        )?;
        Ok(receipts
            .into_iter()
            .map(|receipt| (receipt.input, receipt.decision))
            .collect())
    })
    .map_err(sql_failure)
}

pub(crate) fn recorded_call_presentation(
    pg: &Sql<'_>,
    organization_id: &str,
    session_id: &str,
    offer_id: &str,
) -> napi::Result<CallPresentation> {
    if pg.0.cipher().is_encrypted() {
        let receipts = encrypted_receipts(pg, organization_id, session_id)?;
        return Ok(presentation_in(receipts, offer_id).unwrap_or_default());
    }
    let (organization_id, session_id, offer_id) = (
        organization_id.to_owned(),
        session_id.to_owned(),
        offer_id.to_owned(),
    );
    let presentation = pg
        .with_client(move |client| {
            let row = client.query_opt(
                &format!(
                    "SELECT o.input->'context' AS context, \
                     COALESCE(o.input->'context'->>'tool', o.input->'semantic'->>'tool', o.input->>'tool') AS tool, \
                     COALESCE(o.input->'semantic'->>'event', o.input->>'event') AS event \
                     FROM openappa_operations o \
                     WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                     AND NOT {} \
                     AND ( \
                       EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.decision->'offers', '[]'::jsonb)) AS offer \
                         WHERE offer->>'offer_id' = $3) \
                       OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o.decision->'review', '[]'::jsonb)) AS entry \
                         WHERE entry->>'offer_id' = $3) \
                     ) \
                     ORDER BY o.created_at DESC \
                     LIMIT 1",
                    sealed::ESCAPED
                ),
                &[&organization_id, &session_id, &offer_id],
            )?;
            if let Some(row) = row {
                let context: Option<Value> = row.get("context");
                return Ok(Some(presentation_from_receipt(
                    context.as_ref(),
                    row.get("tool"),
                    row.get::<_, Option<String>>("event").as_deref(),
                )));
            }
            let opened = sealed::read(
                client,
                &StorageCipher::Plain,
                sealed::Receipts::Escaped,
                "o.organization_id=$1 AND o.session_id=$2",
                &[&organization_id, &session_id],
            )?;
            Ok(presentation_in(
                opened.into_iter().map(|receipt| (receipt.input, receipt.decision)),
                &offer_id,
            ))
        })
        ?;
    Ok(presentation.unwrap_or_default())
}

/// The presentation of the call whose receipt offered or reviewed `offer_id`,
/// among a session's receipts, newest first.
fn presentation_in(
    receipts: impl IntoIterator<Item = (Value, Value)>,
    offer_id: &str,
) -> Option<CallPresentation> {
    receipts.into_iter().find_map(|(input, decision)| {
        let matches = ["offers", "review"].iter().any(|field| {
            decision[*field].as_array().is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry["offer_id"].as_str() == Some(offer_id))
            })
        });
        if !matches {
            return None;
        }
        let semantic = input.get("semantic").unwrap_or(&input);
        Some(presentation_from_receipt(
            input.get("context"),
            input
                .get("context")
                .and_then(|v| v["tool"].as_str())
                .or_else(|| semantic["tool"].as_str())
                .map(str::to_owned),
            semantic["event"].as_str(),
        ))
    })
}

pub(crate) fn routing_owner(pg: &Sql<'_>, input: &OfferInput) -> napi::Result<Option<OfferOwner>> {
    let key = SessionKey::new(&input.organization_id, &input.trajectory.session_id);
    let stamped_parent = input.trajectory.parent_id.clone();
    let row = pg
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root, parent_id FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| (row.get::<_, String>(0), row.get::<_, Option<String>>(1))))
        })
        ?;
    let Some((root, recorded_parent)) = row else {
        return Ok(None);
    };
    if recorded_parent != stamped_parent {
        return Ok(None);
    }
    Ok(Some(OfferOwner {
        organization_id: input.organization_id.clone(),
        session_id: input.trajectory.session_id.clone(),
        parent_id: stamped_parent,
        root,
        tool: None,
        spelling: None,
        dispatch: None,
    }))
}

/// Claims the operation's receipt under this dispatch's lease. `None` means the
/// dispatch does the work: the receipt was just claimed, or it was left pending
/// by a dispatch that stopped and whose lease expired. The store recovers a
/// receipt only for the identical input of the same scope, so proceeding
/// re-drives exactly this operation: the runtime answers from its committed
/// facts where it kept them and runs the operation afresh where it kept
/// nothing, and the finish completes the receipt with that answer. A receipt
/// another live request is working on refuses as retryable; a mismatched retry
/// fails closed.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn claim_operation(
    store: &LogStore,
    receipts: &lease::Receipts,
    input: &Input,
    root: &str,
    operation: &str,
    request: &Value,
    binding: ReceiptBinding,
    context: Option<Value>,
) -> napi::Result<Option<Value>> {
    let key = operation_key(input, binding, operation.to_owned());
    let request = OperationRequest {
        key: key.clone(),
        root: TrajectoryId::new(root),
        input: request.clone(),
        context,
    };
    let mut held = lease::HeldWait::new();
    loop {
        match store.claim_operation(request.clone(), receipts.lease()) {
            Ok(OperationClaim::Claimed) => {
                receipts.hold_operation(key, lease::Holding::Created);
                return Ok(None);
            }
            Ok(OperationClaim::Recovered) => {
                receipts.hold_operation(key, lease::Holding::Recovered);
                return Ok(None);
            }
            Ok(OperationClaim::Complete { decision }) => return Ok(Some(decision)),
            // Another request works on this operation: its answer is this one's.
            Ok(OperationClaim::Held) if held.again().await => {}
            Ok(OperationClaim::Held) => return Err(held_elsewhere()),
            Err(reason) => return Err(receipt_failure(reason)),
        }
    }
}

/// What claiming a processed result's receipt left this dispatch to do.
pub(crate) enum ResultClaim {
    /// This dispatch holds the receipt and processes the result.
    Work,
    /// The result was processed before; this is its saved decision.
    Complete(Value),
}

/// Claims a processed result's receipt under this dispatch's lease, as
/// [`claim_operation`] claims an operation's.
pub(crate) async fn claim_result(
    store: &LogStore,
    receipts: &lease::Receipts,
    key: &ProcessedResultKey,
    root: &TrajectoryId,
) -> napi::Result<ResultClaim> {
    let request = ProcessedResultRequest {
        key: key.clone(),
        root: root.clone(),
    };
    let mut held = lease::HeldWait::new();
    loop {
        match store.claim_processed_result(request.clone(), receipts.lease()) {
            Ok(ProcessedResultClaim::Claimed) => {
                receipts.hold_result(key.clone(), lease::Holding::Created);
                return Ok(ResultClaim::Work);
            }
            Ok(ProcessedResultClaim::Recovered) => {
                receipts.hold_result(key.clone(), lease::Holding::Recovered);
                return Ok(ResultClaim::Work);
            }
            Ok(ProcessedResultClaim::Complete { decision, .. }) => {
                return Ok(ResultClaim::Complete(decision));
            }
            // Another request processes this result: its answer is this one's.
            Ok(ProcessedResultClaim::Held) if held.again().await => {}
            Ok(ProcessedResultClaim::Held) => return Err(held_elsewhere()),
            Err(reason) => return Err(receipt_failure(reason)),
        }
    }
}

/// Completes a remedy's operation receipt and, for a tracked call, its
/// processed result, so a retry of either replays this response.
pub(crate) fn finish_remedy(
    store: &LogStore,
    receipts: &lease::Receipts,
    input: &Input,
    operation: &str,
    binding: ReceiptBinding,
    result_key: Option<ProcessedResultKey>,
    response: Value,
) -> napi::Result<Value> {
    finish_operation(store, receipts, input, operation, &response, binding)?;
    if let Some(result_key) = result_key {
        let approved = decision_text(&response)?;
        store
            .complete_processed_result(result_key, approved, response.clone(), receipts.owner())
            .map_err(receipt_failure)?;
    }
    Ok(response)
}

pub(crate) fn finish_operation(
    store: &LogStore,
    receipts: &lease::Receipts,
    input: &Input,
    operation: &str,
    decision: &Value,
    binding: ReceiptBinding,
) -> napi::Result<()> {
    store
        .complete_operation(
            operation_key(input, binding, operation.to_owned()),
            decision.clone(),
            receipts.owner(),
        )
        .map_err(receipt_failure)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct YellArguments {
    pub(crate) message: String,
    pub(crate) with_trajectory: bool,
}
