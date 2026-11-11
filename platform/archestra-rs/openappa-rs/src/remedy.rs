use crate::{
    Sql,
    admin_api::{ContentEncryption, DispatchPolicy},
    errors::{
        BindingFailure, Failure, failure, invalid_input, invariant, panicked, remedy_refused,
        sql_failure, storage,
    },
    initialized,
    input::{
        ExecutionMode, HookEventKind, Input, OfferId, OfferInput, OfferOwner, RecordedCall,
        RulingInput, validate,
    },
    operations::{
        UNRELEASED_CALL_CODE, canonical_tool, encrypted_receipts, routing_owner, spelled_tool,
        validate_trajectory,
    },
    retained_refusal, run, sealed,
    session::session_actor,
};
use appa_eventlog::encryption::StorageCipher;
use appa_runtime::api::{ExecuteRemedyPlanArgs, RemedyOutcome, RemedyPresentation, RemedyRefusal};
use appa_runtime_api::ProposedCall;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{panic::AssertUnwindSafe, time::SystemTime};

/// Executes a remedy for the proxy-stamped trajectory, resolving that session
/// from PostgreSQL. The caller, when present, is the receipt spender.
#[napi(js_name = "executeRemedyByOffer")]
pub async fn execute_remedy_by_offer(
    input: String,
    policy: DispatchPolicy,
    encryption: Option<ContentEncryption>,
) -> napi::Result<String> {
    let input: OfferInput = serde_json::from_str(&input).map_err(invalid_input)?;
    if input.organization_id.is_empty()
        || input.organization_id.len() > 512
        || input.organization_id.chars().any(char::is_control)
    {
        return Err(invalid_input("invalid organization identity"));
    }
    validate_trajectory(&input.trajectory)?;
    match (input.execution_mode, &input.tool_call_id) {
        (ExecutionMode::Tracked, Some(tool_call_id))
            if !tool_call_id.is_empty()
                && tool_call_id.len() <= 1024
                && !tool_call_id.chars().any(char::is_control) => {}
        (ExecutionMode::Tracked, _) => {
            return Err(invalid_input("tracked remedy requires tool_call_id"));
        }
        (ExecutionMode::Untracked, None) => {}
        (ExecutionMode::Untracked, Some(_)) => {
            return Err(invalid_input(
                "untracked remedy must not include tool_call_id",
            ));
        }
    }
    let visible_arguments = object_raw(&input.arguments, "remedy arguments")?;
    let original_arguments = original_arguments_raw(&input.original_arguments)?;
    let _: ExecuteRemedyPlanArgs =
        serde_json::from_str(visible_arguments.get()).map_err(invalid_input)?;
    let state = initialized().await?;
    let owner = {
        let leased = state.lease().await?;
        routing_owner(&Sql(&leased.state.store), &input)?
    };
    let Some(owner) = owner else {
        return Ok(
            with_offer_status(render_unknown_offer()?, OfferStatusKind::Unknown)?.to_string(),
        );
    };
    let input = Input {
        yell_receiver: None,
        organization_id: owner.organization_id,
        // Scopes a caller-bound receipt to the authenticated spender. Absent
        // for an anonymous organization token.
        caller_id: input.caller_id.clone(),
        session_id: owner.session_id,
        parent_id: owner.parent_id,
        principal: None,
        fork_of: None,
        event: HookEventKind::Remedy,
        operation_id: None,
        tool_call_id: input.tool_call_id,
        tool: None,
        arguments: Some(visible_arguments),
        original_arguments: Some(original_arguments),
        spawn: false,
        output: None,
        spawned_id: None,
        spawn_call_id: None,
        child_native_id: None,
        outcome: None,
        owner_root: Some(owner.root),
        spelling: None,
        dispatch: None,
        presentation: Some(input.presentation),
        ruling: input.ruling,
        precheck_refusal: input.precheck_refusal,
        withhold_consult_content: input.withhold_consult_content,
    };
    validate(&input)?;
    let response: Value =
        serde_json::from_str(&run(input, policy.into(), encryption).await?).map_err(invariant)?;
    Ok(with_offer_status(response, OfferStatusKind::Known)?.to_string())
}

#[napi(object)]
#[derive(Serialize)]
pub struct OfferReviewOutput {
    pub offer_id: String,
    pub text: String,
    pub session_id: String,
    /// The reviewed call's tool, as the host proposed it.
    pub tool: Option<String>,
    /// The reviewed call's arguments as JSON text. The ledger keeps them as
    /// JSONB, so key order and spacing can differ from the proposal; the
    /// values cannot.
    pub arguments: Option<String>,
    /// The review's coverage items as JSON text. Absent means unknown (a
    /// review stored before the runtime typed it, or one that joins several
    /// authorities), so show `text`; `[]` means the ruling accepts nothing else.
    pub scope: Option<String>,
    /// The ruling authority's own hint to the reviewer, when it declares one.
    pub hint: Option<String>,
}

/// Reads an offer's original refusal from authenticated, host-scoped journal
/// records, including encrypted and escaped decisions. Executes no remedy.
#[napi(js_name = "retainedOfferRefusal")]
pub fn retained_offer_refusal(
    input: String,
    encryption: Option<ContentEncryption>,
) -> napi::Result<Option<String>> {
    std::panic::catch_unwind(AssertUnwindSafe(|| {
        let input = serde_json::from_str(&input).map_err(invalid_input)?;
        let cipher = match encryption {
            Some(encryption) => StorageCipher::encrypted(encryption.key.as_ref(), encryption.scope)
                .map_err(invalid_input)?,
            None => StorageCipher::Plain,
        };
        retained_refusal::find(input, &cipher).map_err(invalid_input)
    }))
    .map_err(|_| panicked("OpenAPPA retained refusal lookup failed"))?
}

/// Loads the review entry for an offer from the retained DenyCall in PostgreSQL.
/// Session routing comes from the proxy-stamped current trajectory; no offer-owner lookup.
#[napi(js_name = "loadOfferReview")]
pub async fn load_offer_review(
    organization_id: String,
    session_id: String,
    offer_id: String,
    encryption: Option<ContentEncryption>,
) -> napi::Result<Option<OfferReviewOutput>> {
    // Mirror execute_remedy_by_offer: clone state, drop the mutex, then lease
    // a connection before host SQL so review loads never contend with
    // dispatches on the runtime state mutex.
    let state = initialized().await?.encrypted(encryption)?;
    let leased = state.lease().await?;
    let pg = &Sql(&leased.state.store);
    if pg.0.cipher().is_encrypted() {
        let receipts = encrypted_receipts(pg, &organization_id, &session_id)?;
        return Ok(review_in(receipts, &offer_id, &session_id));
    }
    // The SQL closure needs its own offer id copy because it must be 'static.
    let target_offer_id = offer_id.clone();
    let review = pg
        .with_client(move |client| {
            // session_id is the leading PK column of openappa_operations, and
            // organization_id is an additional tenancy guard. The JSONB match
            // is pushed into SQL so only the matching entry's text crosses the
            // boundary instead of every reviewed decision. The lateral join
            // scans each reviewed decision's entries linearly, which is
            // bounded by the handful of review entries a policy's DenyCall
            // carries; it is not sized for unbounded per-decision reviews.
            // The reviewed call is the one this receipt admitted or blocked:
            // its host context, or the semantic input of a receipt that
            // predates context.
            let row = client.query_opt(
                &format!(
                    "SELECT entry->>'text' AS text, \
                     (entry->'scope')::text AS scope, \
                     entry->>'hint' AS hint, \
                     COALESCE(o.input->'context'->>'tool', o.input->'semantic'->>'tool') AS tool, \
                     COALESCE(o.input->'context'->'arguments', o.input->'semantic'->'arguments')::text AS arguments \
                     FROM openappa_operations o \
                     CROSS JOIN LATERAL jsonb_array_elements(o.decision->'review') AS entry \
                     WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                     AND NOT {} \
                     AND o.decision->'review' IS NOT NULL \
                     AND entry->>'offer_id' = $3 \
                     ORDER BY o.created_at DESC \
                     LIMIT 1",
                    sealed::ESCAPED
                ),
                &[&organization_id, &session_id, &target_offer_id],
            )?;
            if let Some(row) = row {
                return Ok(Some(OfferReviewOutput {
                    offer_id: target_offer_id,
                    text: row.get("text"),
                    session_id,
                    tool: row.get("tool"),
                    arguments: row.get("arguments"),
                    scope: row.get("scope"),
                    hint: row.get("hint"),
                }));
            }
            let opened = sealed::read(
                client,
                &StorageCipher::Plain,
                sealed::Receipts::Escaped,
                "o.organization_id=$1 AND o.session_id=$2",
                &[&organization_id, &session_id],
            )?;
            Ok(review_in(
                opened.into_iter().map(|receipt| (receipt.input, receipt.decision)),
                &target_offer_id,
                &session_id,
            ))
        })
        ?;
    Ok(review)
}

/// The review entry for `offer_id` among a session's receipts, newest first,
/// with the reviewed call's tool and arguments.
fn review_in(
    receipts: impl IntoIterator<Item = (Value, Value)>,
    offer_id: &str,
    session_id: &str,
) -> Option<OfferReviewOutput> {
    receipts.into_iter().find_map(|(input, decision)| {
        let review = decision["review"]
            .as_array()?
            .iter()
            .find(|entry| entry["offer_id"].as_str() == Some(offer_id))?;
        let source = input
            .get("context")
            .or_else(|| input.get("semantic"))
            .unwrap_or(&input);
        Some(OfferReviewOutput {
            offer_id: offer_id.to_owned(),
            session_id: session_id.to_owned(),
            text: review["text"].as_str().unwrap_or_default().to_owned(),
            tool: source["tool"].as_str().map(str::to_owned),
            arguments: source.get("arguments").map(Value::to_string),
            scope: review.get("scope").map(Value::to_string),
            hint: review["hint"].as_str().map(str::to_owned),
        })
    })
}

/// The `approved_output` column of a completed tool result, which holds the text a second
/// time when the stored decision already carries it (`approved_output`, set by
/// [`with_approved_output`]). A long text is stored in the decision alone, and the column
/// holds `sha256:<hex>` of it.
///
/// Contract, checked at the pinned OpenAPPA revision and by the base commit's own code:
/// nothing reads the column as content. A replay answers from the decision
/// (`ProcessedResultClaim::Complete { decision, .. }` here and in `peer.rs`,
/// `inherited_result` selects `decision`), `resolve_result_claim` only requires the column
/// non-null, and `resolve_result_completion` compares it with the value a second completion
/// of a complete row passes, which no path in this crate or the base commit makes after a
/// claim answered `Complete`. Re-check all three when the OpenAPPA pin moves, and before
/// anything reads the column. No schema changes: the column stays non-null text.
pub(crate) fn stored_approved_output(approved: &str, decision: &Value) -> String {
    let carried = decision.get("approved_output").and_then(Value::as_str) == Some(approved);
    if carried && approved.len() > REFERENCE_FROM_BYTES {
        format!("sha256:{}", sha256_hex(approved.as_bytes()))
    } else {
        approved.to_owned()
    }
}

/// Texts up to this size stay readable in the column.
const REFERENCE_FROM_BYTES: usize = 1024;

#[derive(Serialize)]
struct ApprovedOutput<'a, T> {
    #[serde(flatten)]
    decision: &'a T,
    approved_output: String,
    output_source: OutputSource,
}

#[derive(Serialize)]
struct OfferStatusResponse<'a> {
    #[serde(flatten)]
    response: &'a Value,
    offer: OfferStatus,
}

#[derive(Serialize)]
struct OfferStatus {
    status: OfferStatusKind,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum OfferStatusKind {
    Known,
    Unknown,
}

#[derive(Serialize)]
struct HostMcpResult {
    decision: &'static str,
    approved_output: String,
    output_source: OutputSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    result: HostToolResult,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OutputSource {
    Runtime,
    Tool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostToolResult {
    is_error: bool,
    content: Vec<HostText>,
}

#[derive(Serialize)]
struct HostText {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

pub(crate) fn with_approved_output<T: Serialize>(
    decision: &T,
    approved_output: String,
    output_source: OutputSource,
) -> napi::Result<Value> {
    serde_json::to_value(ApprovedOutput {
        decision,
        approved_output,
        output_source,
    })
    .map_err(invariant)
}

fn render_unknown_offer() -> napi::Result<Value> {
    let approved_output = "[appa] No live offer with this id is available.".to_owned();
    serde_json::to_value(HostMcpResult {
        decision: "mcp_result",
        approved_output: approved_output.clone(),
        output_source: OutputSource::Runtime,
        reason: Some("unknown_control_call"),
        result: HostToolResult {
            is_error: true,
            content: vec![HostText {
                kind: "text",
                text: approved_output,
            }],
        },
    })
    .map_err(invariant)
}

/// Constructs a refusal response not generated by the runtime engine.
/// Used for control-gate refusals and host precheck refusals.
pub(crate) fn runtime_refusal(text: String) -> napi::Result<Value> {
    serde_json::to_value(HostMcpResult {
        decision: "mcp_result",
        approved_output: text.clone(),
        output_source: OutputSource::Runtime,
        reason: None,
        result: HostToolResult {
            is_error: true,
            content: vec![HostText { kind: "text", text }],
        },
    })
    .map_err(invariant)
}

fn with_offer_status(response: Value, status: OfferStatusKind) -> napi::Result<Value> {
    serde_json::to_value(OfferStatusResponse {
        response: &response,
        offer: OfferStatus { status },
    })
    .map_err(invariant)
}

pub(crate) fn with_presentation_offers(
    mut response: Value,
    presentation: Option<&RemedyPresentation>,
) -> napi::Result<Value> {
    let offers = presentation_offer_ids(presentation);
    if offers.is_empty() {
        return Ok(response);
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| invariant("decision is not an object"))?;
    object.insert(
        "offers".to_owned(),
        json!(
            offers
                .into_iter()
                .map(|id| json!({ "offer_id": id.0 }))
                .collect::<Vec<_>>()
        ),
    );
    Ok(response)
}

fn presentation_offer_ids(presentation: Option<&RemedyPresentation>) -> Vec<OfferId> {
    presentation
        .map(|presentation| {
            presentation
                .offers
                .iter()
                .map(|offer| OfferId(offer.id.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Context for a remedy outcome, including offer ownership, offer ID,
/// and human review decision.
pub(crate) struct RemedyAct<'a> {
    pub(crate) owner: &'a OfferOwner,
    pub(crate) offer_id: &'a str,
    pub(crate) ruling: Option<RulingInput>,
}

pub(crate) fn render_remedy_outcome(
    outcome: RemedyOutcome,
    act: &RemedyAct,
) -> napi::Result<Value> {
    let owner = Some(act.owner);
    let (output_source, reason, is_error, text) = match outcome {
        RemedyOutcome::Authorized { call } => (
            OutputSource::Runtime,
            None,
            false,
            render_released_call("Authorized", &call, owner),
        ),
        RemedyOutcome::Returned { value } => (OutputSource::Tool, None, false, value),
        RemedyOutcome::Declined { presentation } => (
            OutputSource::Runtime,
            None,
            false,
            render_human_denial(&presentation, act).unwrap_or(presentation.feedback),
        ),
        // The offer stands and the feedback tells the model what to do next:
        // an answer for it, not a runtime failure that ends the turn. It is an
        // error result because nothing was released.
        RemedyOutcome::NoAnswer { feedback } => (OutputSource::Runtime, None, true, feedback),
        RemedyOutcome::Refused {
            reason: appa_runtime::api::RemedyRefusal::Runtime { detail },
        } => {
            return Err(remedy_refused(format!(
                "OpenAPPA remedy interrupted: {detail}"
            )));
        }
        RemedyOutcome::Refused {
            reason: appa_runtime::api::RemedyRefusal::AlreadyExecuting,
        } => {
            return Err(failure(
                Failure::Binding(BindingFailure::HeldElsewhere),
                "OpenAPPA remedy is still executing; retry the request",
            ));
        }
        RemedyOutcome::Refused { reason } => (
            OutputSource::Runtime,
            unknown_control_reason(&reason),
            true,
            reason.detail().to_owned(),
        ),
    };
    serde_json::to_value(HostMcpResult {
        decision: "mcp_result",
        approved_output: text.clone(),
        output_source,
        reason,
        result: HostToolResult {
            is_error,
            content: vec![HostText { kind: "text", text }],
        },
    })
    .map_err(invariant)
}

/// Formats a human reviewer denial message.
/// The runtime records the denial and retires the offer.
/// Rewriting requires three conditions: the host recorded a denial, the runtime
/// returned a block, and the offer was retired.
/// Otherwise, the original runtime text returns unchanged.
fn render_human_denial(presentation: &RemedyPresentation, act: &RemedyAct) -> Option<String> {
    let block = denied_block(&presentation.feedback);
    let denied = act.ruling == Some(RulingInput::Deny)
        && block.starts_with("[appa] Blocked:")
        && !presentation
            .offers
            .iter()
            .any(|offer| offer.id == act.offer_id);
    if !denied {
        return None;
    }
    let target = act
        .owner
        .spelling
        .as_deref()
        .or(act.owner.tool.as_deref())
        .map_or_else(
            || "this call".to_owned(),
            |tool| format!("this call to {tool}"),
        );
    // The runtime records the denial on the call: proposed again in this
    // session, the call gets no plan naming the reviewer.
    let mut text = format!(
        "[appa] Denied: the human reviewer refused {target}. It did not run and will not run. \
         Do not retry it or re-submit it with changed arguments or encoding to get another \
         approval; tell the user it was denied. The denial holds for the rest of this session, \
         also when the user asks for the same call again; a new session can ask for it again."
    );
    if !presentation.offers.is_empty() {
        text.push_str("\n\nThe policy still offers options that do not need this reviewer:\n");
        text.push_str(block);
    }
    Some(text)
}

/// The call's block in a denial's feedback, past the line the runtime leads it with to name
/// the authority that denied the plan. The text above says who refused the call.
fn denied_block(feedback: &str) -> &str {
    match feedback.split_once('\n') {
        Some((lead, block))
            if lead.starts_with("[appa] authority ") && lead.ends_with(" denied this plan.") =>
        {
            block
        }
        _ => feedback,
    }
}

fn unknown_control_reason(reason: &RemedyRefusal) -> Option<&'static str> {
    match reason {
        // A superseded offer was a live one gone stale, reported before as an unknown offer.
        RemedyRefusal::Unvouched | RemedyRefusal::UnknownOffer | RemedyRefusal::Superseded => {
            Some("unknown_control_call")
        }
        // Its text says how to declare at the spawn's block instead.
        RemedyRefusal::UnvouchedDeclaration
        | RemedyRefusal::AttemptReused
        | RemedyRefusal::UnidentifiedDeclaration
        | RemedyRefusal::AmbiguousReplay
        | RemedyRefusal::InvalidOfferId(_)
        | RemedyRefusal::ActorMismatch
        | RemedyRefusal::AlreadyExecuting
        | RemedyRefusal::Runtime { .. } => None,
    }
}

/// A plan that only declares a subagent's return covers none of the call's other gaps, so
/// the runtime authorizes it and the retry can still be refused.
const RECHECKED: &str = "The call is checked again and can still be blocked for another reason; then follow that block. ";

fn render_released_call(status: &str, call: &ProposedCall, owner: Option<&OfferOwner>) -> String {
    // A call made through the dispatch tool is retried through it: the client
    // may hold no tool by the target's own name.
    if let Some(dispatch) = owner.and_then(|owner| owner.dispatch.as_deref()) {
        return format!(
            "[appa] {status}. {RECHECKED}Call the {dispatch} tool again with exactly these arguments: {{\"tool_name\":{},\"tool_args\":{}}}",
            Value::String(spelled_tool(&call.tool)),
            retry_arguments(call)
        );
    }
    let tool = owner
        .and_then(|owner| owner.spelling.clone())
        .unwrap_or_else(|| spelled_tool(&call.tool));
    // A model that just ran a remedy moves straight on to the retry and never
    // mentions it; the user must still learn which plan changed their session.
    // The user may have accepted the plan through ask_user, so the text does
    // not credit the model with the choice.
    format!(
        "[appa] {status}. Tell the user in your reply which plan was accepted. Make this your next call: until it runs, the session keeps its current label and calls that need the plan stay blocked. {RECHECKED}Call the {tool} tool again with exactly these arguments: {}",
        retry_arguments(call)
    )
}

/// The released call's arguments as the client spelled them. Before the
/// runtime judges a call, the backend (`normalizeToolArgumentsForPolicy`)
/// copies a command tool's `command` argument to `cmd`, or `cmd` to
/// `command`, and a Read, Write or Edit call's `path` to `file_path` when it
/// has none, so a rule matches every client's spelling. The client's tool
/// accepts only its own spelling, and a model that follows the tool schema
/// cannot send the copy, so the retry text leaves it out. The backend copies
/// the retry the same way, so the retry still matches the released call.
fn retry_arguments(call: &ProposedCall) -> String {
    let raw = call.arguments.get();
    let tool = call.tool.as_str();
    let tool = tool
        .strip_prefix("builtin:")
        .or_else(|| {
            tool.strip_prefix("host/")
                .and_then(|rest| rest.split_once('/'))
                .map(|(_, name)| name)
        })
        .unwrap_or(tool);
    let lowered = tool.to_ascii_lowercase();
    // The same tools the backend copies an argument for.
    let command_tool = matches!(
        lowered.as_str(),
        "bash" | "shell" | "exec_command" | "run_command" | "cmd"
    );
    let path_file_tool = matches!(tool, "Read" | "Write" | "Edit");
    if !command_tool && !path_file_tool {
        return raw.to_owned();
    }
    let Ok(Value::Object(arguments)) = serde_json::from_str::<Value>(raw) else {
        return raw.to_owned();
    };
    let copies = |original: &str, copy: &str| {
        arguments.get(original).is_some() && arguments.get(original) == arguments.get(copy)
    };
    // The path copy reads `/` where a Windows client sent `\`.
    let path_copied = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(|path| path.replace('\\', "/"))
        .is_some_and(|path| arguments.get("file_path").and_then(Value::as_str) == Some(&path));
    let copy = if command_tool && copies("command", "cmd") {
        // Codex's exec_command is the one command tool that spells it `cmd`.
        if lowered == "exec_command" {
            "command"
        } else {
            "cmd"
        }
    } else if path_file_tool && path_copied {
        // Only a call without `file_path` gets the copy.
        "file_path"
    } else {
        return raw.to_owned();
    };
    Value::Object(
        arguments
            .into_iter()
            .filter(|(name, _)| name != copy)
            .collect(),
    )
    .to_string()
}

pub(crate) fn remedy_operation(input: &Input) -> napi::Result<String> {
    match &input.tool_call_id {
        Some(tool_call_id) => Ok(format!("remedy:{tool_call_id}")),
        // Direct clients without a provider call id get a durable crash fence,
        // but no later result is inferred from a fabricated transport id.
        None => Ok(format!(
            "remedy:untracked:{}",
            sha256_hex(serde_json::to_vec(&remedy_fingerprint(input)?).map_err(invariant)?)
        )),
    }
}

pub(crate) fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    Sha256::digest(input)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn remedy_fingerprint(input: &Input) -> napi::Result<Value> {
    Ok(json!({
        "visible_arguments": raw_object_value(input.arguments.as_deref(), "remedy arguments")?,
        "original_arguments": raw_object_value(
            input.original_arguments.as_deref().or(input.arguments.as_deref()),
            "remedy arguments",
        )?,
    }))
}

pub(crate) fn remedy_request(input: &Input) -> napi::Result<Value> {
    Ok(json!({
        "event": "remedy",
        "tool_call_id": input.tool_call_id,
        "arguments": raw_object_value(input.arguments.as_deref(), "remedy arguments")?,
        "original_arguments": raw_object_value(
            input.original_arguments.as_deref().or(input.arguments.as_deref()),
            "remedy arguments",
        )?,
        "organization_id": input.organization_id,
        "caller_id": input.caller_id,
        "session_id": input.session_id,
        "parent_id": input.parent_id,
        "owner_root": input.owner_root,
    }))
}

fn original_arguments_raw(arguments: &str) -> napi::Result<Box<RawValue>> {
    let value: Value = serde_json::from_str(arguments).map_err(invalid_input)?;
    if !value.is_object() {
        return Err(invalid_input(
            "original remedy arguments must be a JSON object",
        ));
    }
    serde_json::value::to_raw_value(&value).map_err(invariant)
}

fn object_raw(arguments: &RawValue, name: &str) -> napi::Result<Box<RawValue>> {
    let value: Value = serde_json::from_str(arguments.get()).map_err(invalid_input)?;
    if !value.is_object() {
        return Err(invalid_input(format!("{name} must be a JSON object")));
    }
    serde_json::value::to_raw_value(&value).map_err(invariant)
}

fn raw_object_value(arguments: Option<&RawValue>, name: &str) -> napi::Result<Value> {
    let arguments = arguments.ok_or_else(|| invalid_input(format!("missing {name}")))?;
    let value: Value = serde_json::from_str(arguments.get()).map_err(invalid_input)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(invalid_input(format!("{name} must be a JSON object")))
    }
}

/// How many forks up the line a result is looked for. A fork of a fork of … deeper than this
/// sees an older result as unknown, which withholds it: the safe side.
const MAX_FORK_DEPTH: usize = 32;

/// The decision the session this one forks from processed for `call_id`, looked up the fork
/// line. A fork accepts only results completed before it opened (see `open_fork`), so it
/// replays the history it started with rather than later parent activity. A result completed
/// before completion times were recorded falls back to its claim time.
pub(crate) fn inherited_result(
    pg: &Sql<'_>,
    input: &Input,
    call_id: &str,
) -> napi::Result<Option<Value>> {
    let (organization_id, mut session, call_id) = (
        input.organization_id.clone(),
        input.session_id.clone(),
        call_id.to_owned(),
    );
    pg.with_client(move |client| {
        for _ in 0..MAX_FORK_DEPTH {
            let Some((parent, forked_at)) = client
                .query_opt(
                    "SELECT forked_from, forked_at FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&organization_id, &session_actor(&session)],
                )?
                .and_then(|row| {
                    row.get::<_, Option<String>>(0)
                        .zip(row.get::<_, Option<SystemTime>>(1))
                })
            else {
                return Ok(None);
            };
            if let Some(row) = client.query_opt(
                "SELECT decision FROM openappa_processed_results WHERE session_id = $1 AND tool_call_id = $2 AND organization_id = $3 AND status = 'complete' AND COALESCE(completed_at, created_at) < $4",
                &[&parent, &call_id, &organization_id, &forked_at],
            )? {
                return Ok(row.get::<_, Option<Value>>(0));
            }
            session = parent;
        }
        Ok(None)
    })
    .map_err(sql_failure)
}

pub(crate) fn decision_text(response: &Value) -> napi::Result<String> {
    response
        .get("approved_output")
        .or_else(|| response.get("feedback"))
        .or_else(|| response.get("detail"))
        .or_else(|| response.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invariant("control response lacks model-visible text"))
}

pub(crate) fn recorded_call(
    context: Option<Value>,
    legacy_input: Value,
) -> napi::Result<RecordedCall> {
    let value = context.unwrap_or(legacy_input);
    serde_json::from_value(value).map_err(|_| storage("released call receipt lacks call context"))
}

pub(crate) fn proposed_recorded_call(call: &RecordedCall) -> napi::Result<ProposedCall> {
    Ok(ProposedCall {
        tool: canonical_tool(&call.tool)?,
        arguments: call.arguments.clone(),
        cwd: None,
    })
}

pub(crate) fn authoritative_unexecuted_response(decision: Value) -> napi::Result<Value> {
    let feedback = decision
        .get("feedback")
        .or_else(|| decision.get("detail"))
        .or_else(|| decision.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("OpenAPPA blocked this tool call");
    with_approved_output(
        &decision,
        format!("{feedback}\n\n{UNEXECUTED_CALL_HINT}"),
        OutputSource::Runtime,
    )
}

/// Appended to every ruling a model reads in place of a blocked call's result,
/// in Chat and in every proxied client alike, so it is the one place to state
/// what to do after a block. The ruling counts readers rather than naming
/// them, and a model left to fill the gap invents who they are. Clients spell
/// tool names differently, so tools are named generically, ask_user by the
/// short name every spelling keeps. Which question tool to use follows
/// ask_user's own description: the client's own first. A plan is carried out
/// by the call the ruling shows for it, which is not always the remedy tool (a
/// redispatch plan names another tool to run first). The hint says what to do
/// and who decides; provider safety classifiers refused requests that told the
/// model to skip the user.
const UNEXECUTED_CALL_HINT: &str = "The tool did not run. A plan fits unless the narrower session could no longer do what the user asked for or will clearly ask next. Apply a fitting plan with the exact call that the ruling shows for it. When the policy requires approval, that call asks the user itself, so do not ask first. If no plan fits, ask the user with a question tool, not in plain text: the client's own question tool if it has one, otherwise ask_user, and say which part of their request the plan would prevent. In questions and replies, describe the block and any plan in the ruling's own words, and do not guess who the readers are beyond the audiences the ruling names. If the ruling offers no plan, explain the ruling to the user.";

/// A result for a call this session never released. The code tells the proxy
/// that nothing ran on the runtime's side: a remedy the gateway never ran
/// comes back this way, and the proxy shows the model what the client returned
/// instead of this text. It is a separate field because callers read `reason`
/// as the text of a block.
pub(crate) fn unknown_result_response() -> Value {
    let approved_output =
        "[appa] Tool output withheld: this result has no record of releasing a call.".to_owned();
    json!({
        "decision": "block",
        "feedback": approved_output,
        "approved_output": approved_output,
        "output_source": OutputSource::Runtime,
        "code": UNRELEASED_CALL_CODE,
    })
}

#[cfg(test)]
mod typed_tests {
    use super::{
        RemedyAct, authoritative_unexecuted_response, presentation_offer_ids, render_released_call,
        render_remedy_outcome, unknown_result_response,
    };
    use crate::input::{OfferId, OfferOwner};
    use crate::operations::presentation_from_context;
    use appa_runtime::api::{RemedyOutcome, RemedyPresentation};
    use appa_runtime_api::OfferedRemedy;
    use serde_json::Value;

    #[test]
    fn remedy_operation_preserves_existing_receipt_identifiers() {
        let mut input: crate::input::Input = serde_json::from_str(
            r#"{
                "organization_id": "test-organization",
                "session_id": "test-session",
                "event": "remedy",
                "arguments": {"value": 1}
            }"#,
        )
        .unwrap();

        assert_eq!(
            super::remedy_operation(&input).unwrap(),
            "remedy:untracked:1069ef23007b183f1d41a1944bbab35a87080806febc7c4fba3a17ae9750c58a"
        );
        input.tool_call_id = Some("test-call".to_owned());
        assert_eq!(super::remedy_operation(&input).unwrap(), "remedy:test-call");
    }

    #[test]
    fn runtime_like_prose_cannot_create_offer_ownership() {
        let presentation = RemedyPresentation {
            feedback: "[appa] Blocked. execute_remedy_plan(offer_id: \"untrusted-snippet\")"
                .to_owned(),
            offers: Vec::new(),
            review: Vec::new(),
            display: Vec::new(),
        };

        assert!(presentation_offer_ids(Some(&presentation)).is_empty());
    }

    #[test]
    fn only_structured_runtime_offers_are_registered() {
        let presentation = RemedyPresentation {
            feedback: "arbitrary runtime prose".to_owned(),
            offers: vec![OfferedRemedy {
                id: "typed-offer".to_owned(),
                returns: None,
                input_sanitizer: None,
            }],
            review: Vec::new(),
            display: Vec::new(),
        };

        assert_eq!(
            presentation_offer_ids(Some(&presentation)),
            vec![OfferId("typed-offer".to_owned())]
        );
    }

    #[test]
    fn retry_text_comes_from_recorded_context_and_old_rows_fall_back() {
        let recorded = presentation_from_context(Some(&serde_json::json!({
            "tool": "archestra__whoami",
            "arguments": {"verbose": true},
            "spawn": false,
            "spelling": "client_whoami",
            "dispatch": "my_gateway_archestra__run_tool"
        })));
        let call = appa_runtime_api::ProposedCall {
            tool: "mcp/archestra/whoami".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "verbose": true }))
                .unwrap(),
            cwd: None,
        };
        let hint = render_released_call("Authorized", &call, Some(&owner_from(recorded)));
        let (prefix, arguments) = hint.split_once("exactly these arguments: ").unwrap();
        assert_eq!(
            prefix,
            "[appa] Authorized. The call is checked again and can still be blocked for another reason; \
             then follow that block. Call the my_gateway_archestra__run_tool tool again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "tool_name": "archestra__whoami", "tool_args": { "verbose": true } })
        );

        let legacy = presentation_from_context(Some(&serde_json::json!({
            "tool": "read_untrusted",
            "arguments": {"path": "report.txt"},
            "spawn": false
        })));
        assert!(legacy.spelling.is_none());
        assert!(legacy.dispatch.is_none());
        let direct = render_released_call(
            "Authorized",
            &appa_runtime_api::ProposedCall {
                tool: "read_untrusted".to_owned(),
                arguments: serde_json::value::to_raw_value(
                    &serde_json::json!({ "path": "report.txt" }),
                )
                .unwrap(),
                cwd: None,
            },
            Some(&owner_from(legacy)),
        );
        assert!(direct.contains("Call the read_untrusted tool again"));
        assert!(!direct.contains("run_tool"));
        assert!(presentation_from_context(None).tool.is_none());
    }

    fn owner_from(presentation: crate::operations::CallPresentation) -> OfferOwner {
        OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: presentation.tool,
            spelling: presentation.spelling,
            dispatch: presentation.dispatch,
        }
    }

    #[test]
    fn released_call_uses_saved_spelling_and_reports_the_accepted_plan() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("canonical_tool".to_owned()),
            spelling: Some("client_tool".to_owned()),
            dispatch: None,
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "canonical_tool".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "value": 1 })).unwrap(),
            cwd: None,
        };

        // The user may have accepted the plan through ask_user, so the model
        // reports the plan without claiming the choice.
        let released = render_released_call("Authorized", &call, Some(&owner));
        assert!(released.contains("client_tool"));
        assert!(released.contains("Tell the user in your reply which plan was accepted."));
        assert!(!released.contains("you accepted"));
    }

    #[test]
    fn released_call_names_only_the_clients_own_arguments() {
        let released = |tool: &str, arguments: serde_json::Value| {
            let call = appa_runtime_api::ProposedCall {
                tool: tool.to_owned(),
                arguments: serde_json::value::to_raw_value(&arguments).unwrap(),
                cwd: None,
            };
            let text = render_released_call("Authorized", &call, None);
            let (_, json) = text.split_once("exactly these arguments: ").unwrap();
            serde_json::from_str::<serde_json::Value>(json).unwrap()
        };

        // Kimi Code's Bash refuses unknown arguments, so a retry that had to
        // carry the backend's `cmd` copy could never match.
        assert_eq!(
            released(
                "Bash",
                serde_json::json!({ "command": "curl -s http://127.0.0.1/", "timeout": 30, "cmd": "curl -s http://127.0.0.1/" })
            ),
            serde_json::json!({ "command": "curl -s http://127.0.0.1/", "timeout": 30 })
        );
        assert_eq!(
            released(
                "host/codex/exec_command",
                serde_json::json!({ "cmd": "git status", "command": "git status" })
            ),
            serde_json::json!({ "cmd": "git status" })
        );
        // Values that differ are the client's own, and other tools keep theirs.
        assert_eq!(
            released("bash", serde_json::json!({ "command": "ls", "cmd": "pwd" })),
            serde_json::json!({ "command": "ls", "cmd": "pwd" })
        );
        assert_eq!(
            released(
                "client_tool",
                serde_json::json!({ "command": "ls", "cmd": "ls" })
            ),
            serde_json::json!({ "command": "ls", "cmd": "ls" })
        );
        // Kimi Code's Read names the file `path`; the backend adds `file_path`.
        assert_eq!(
            released(
                "Read",
                serde_json::json!({ "path": "/repo/.env", "file_path": "/repo/.env" })
            ),
            serde_json::json!({ "path": "/repo/.env" })
        );
        // A Windows path is copied with forward slashes.
        assert_eq!(
            released(
                "Read",
                serde_json::json!({ "path": "C:\\Users\\me\\.npmrc", "file_path": "C:/Users/me/.npmrc" })
            ),
            serde_json::json!({ "path": "C:\\Users\\me\\.npmrc" })
        );
        // Claude Code's Read keeps its own `file_path`.
        assert_eq!(
            released("Read", serde_json::json!({ "file_path": "/repo/.env" })),
            serde_json::json!({ "file_path": "/repo/.env" })
        );
    }

    #[test]
    fn a_blocked_result_repeats_the_ruling_and_steers_the_model() {
        let ruling = "[appa] Blocked: read_secret cannot run yet.\n\nWhy:\n  - allowed readers would narrow: public -> 1 reader";
        let response = authoritative_unexecuted_response(serde_json::json!({
            "decision": "deny_call",
            "feedback": ruling,
        }))
        .unwrap();

        assert_eq!(response["decision"], "deny_call");
        assert_eq!(response["output_source"], "runtime");
        let text = response["approved_output"].as_str().unwrap();
        // The ruling stays verbatim and first: it is the only account of the
        // block the model has.
        assert!(text.starts_with(&format!("{ruling}\n\nThe tool did not run.")));
        // A plan is carried out by the call the ruling shows, which for a
        // redispatch plan is another tool rather than the remedy tool.
        assert!(
            text.contains("Apply a fitting plan with the exact call that the ruling shows for it")
        );
        assert!(!text.contains("remedy tool"));
        // The same order of question tools as ask_user's own description.
        assert!(text.contains("the client's own question tool if it has one, otherwise ask_user"));
        assert!(text.contains("not in plain text"));
        assert!(text.contains("in the ruling's own words"));
        assert!(text.contains("do not guess who the readers are"));
        // Who decides, not an instruction to skip the user.
        assert!(!text.contains("choose one yourself"));
    }

    #[test]
    fn an_unreleased_result_is_withheld_and_says_why() {
        let response = unknown_result_response();

        assert_eq!(response["decision"], "block");
        assert_eq!(response["output_source"], "runtime");
        assert_eq!(response["code"], "unreleased_call");
        // Callers read `reason` as the text of a block, so the code stays out of it.
        assert!(response.get("reason").is_none());
        assert_eq!(
            response["approved_output"],
            "[appa] Tool output withheld: this result has no record of releasing a call."
        );
    }

    #[test]
    fn authorized_remedy_uses_released_arguments_and_saved_spelling() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("canonical_tool".to_owned()),
            spelling: Some("client_tool".to_owned()),
            dispatch: None,
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "canonical_tool".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "value": 2 })).unwrap(),
            cwd: None,
        };

        let result = render_remedy_outcome(
            RemedyOutcome::Authorized { call },
            &RemedyAct {
                owner: &owner,
                offer_id: "offer-1",
                ruling: None,
            },
        )
        .unwrap();
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        let (prefix, arguments) = text.split_once("exactly these arguments: ").unwrap();
        assert_eq!(
            prefix,
            "[appa] Authorized. Tell the user in your reply which plan was accepted. Make this your next call: until it runs, \
             the session keeps its current label and calls that need the plan stay blocked. The call is checked again \
             and can still be blocked for another reason; then follow that block. Call the client_tool tool again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "value": 2 })
        );
        assert_eq!(result["output_source"], "runtime");
        assert_eq!(result["approved_output"], text);
        assert_eq!(result["result"]["isError"], false);
    }

    #[test]
    fn a_dispatched_call_is_retried_through_the_dispatch_tool() {
        let owner = OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("archestra__whoami".to_owned()),
            spelling: Some("archestra__whoami".to_owned()),
            dispatch: Some("my_gateway_archestra__run_tool".to_owned()),
        };
        let call = appa_runtime_api::ProposedCall {
            tool: "mcp/archestra/whoami".to_owned(),
            arguments: serde_json::value::to_raw_value(&serde_json::json!({ "verbose": true }))
                .unwrap(),
            cwd: None,
        };

        let hint = render_released_call("Authorized", &call, Some(&owner));
        let (prefix, arguments) = hint
            .split_once("exactly these arguments: ")
            .expect("hint names the arguments");
        assert_eq!(
            prefix,
            "[appa] Authorized. The call is checked again and can still be blocked for another reason; \
             then follow that block. Call the my_gateway_archestra__run_tool tool again with "
        );
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!({ "tool_name": "archestra__whoami", "tool_args": { "verbose": true } })
        );
    }
}

#[cfg(test)]
mod remedy_tests {
    use super::{RemedyAct, render_remedy_outcome};
    use crate::input::{OfferOwner, RulingInput};
    use appa_runtime::api::{RemedyOutcome, RemedyPresentation};
    use appa_runtime_api::OfferedRemedy;
    use serde_json::Value;

    const QUOTED: &str = "0123456789abcdef";
    const OTHER: &str = "fedcba9876543210";
    // The runtime's re-rendered block after a denial: the operator plan is
    // filtered out, so no Continue section remains.
    const DENIED_BLOCK: &str =
        "[appa] Blocked: send_mail cannot run yet.\n\nWhy:\n  - requires attention: signoff";

    fn owner(spelling: Option<&str>) -> OfferOwner {
        OfferOwner {
            organization_id: "organization".to_owned(),
            session_id: "session".to_owned(),
            parent_id: None,
            root: "root".to_owned(),
            tool: Some("archestra__todo_write".to_owned()),
            spelling: spelling.map(str::to_owned),
            dispatch: None,
        }
    }

    fn declined(feedback: &str, offers: &[&str]) -> RemedyOutcome {
        RemedyOutcome::Declined {
            presentation: RemedyPresentation {
                feedback: feedback.to_owned(),
                offers: offers
                    .iter()
                    .map(|id| OfferedRemedy {
                        id: (*id).to_owned(),
                        returns: None,
                        input_sanitizer: None,
                    })
                    .collect(),
                review: Vec::new(),
                display: Vec::new(),
            },
        }
    }

    fn render(outcome: RemedyOutcome, owner: &OfferOwner, ruling: Option<RulingInput>) -> Value {
        render_remedy_outcome(
            outcome,
            &RemedyAct {
                owner,
                offer_id: QUOTED,
                ruling,
            },
        )
        .unwrap()
    }

    fn text(response: &Value) -> &str {
        response["approved_output"].as_str().unwrap()
    }

    #[test]
    fn a_remedy_with_no_answer_reaches_the_model_as_an_error_result() {
        let feedback = "[appa] the return declaration is refused: the reserved attest-schema \
                        sanitizer is not registered, or its rank is above this trajectory's; \
                        the offer stands and may be executed again";
        let response = render(
            RemedyOutcome::NoAnswer {
                feedback: feedback.to_owned(),
            },
            &owner(None),
            None,
        );

        assert_eq!(text(&response), feedback);
        assert_eq!(response["result"]["content"][0]["text"], feedback);
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(response["output_source"], "runtime");
    }

    #[test]
    fn a_human_denial_reads_as_final_under_the_name_the_model_called() {
        let owner = owner(Some("mcp__archestra__todo_write"));
        let response = render(declined(DENIED_BLOCK, &[]), &owner, Some(RulingInput::Deny));

        let text = text(&response);
        assert!(text.starts_with("[appa] Denied:"), "{text}");
        assert!(text.contains("this call to mcp__archestra__todo_write"));
        assert!(text.contains("will not run"));
        assert!(text.contains("Do not retry it"));
        assert!(!text.contains("cannot run yet"));
        assert_eq!(response["result"]["content"][0]["text"], text);
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["output_source"], "runtime");
    }

    #[test]
    fn a_human_denial_reads_as_final_past_the_line_naming_the_authority() {
        let feedback = format!("[appa] authority human-approval denied this plan.\n{DENIED_BLOCK}");
        let response = render(
            declined(&feedback, &[]),
            &owner(None),
            Some(RulingInput::Deny),
        );
        let denial = text(&response);
        assert!(denial.starts_with("[appa] Denied:"), "{denial}");
        assert!(!denial.contains("denied this plan"), "{denial}");

        let remaining =
            format!("{feedback}\n\nContinue:\n  - execute_remedy_plan(offer_id: \"{OTHER}\")");
        let response = render(
            declined(&remaining, &[OTHER]),
            &owner(None),
            Some(RulingInput::Deny),
        );
        let denial = text(&response);
        assert!(denial.starts_with("[appa] Denied:"), "{denial}");
        assert!(denial.ends_with(&remaining[remaining.find('\n').unwrap() + 1..]));
        assert!(!denial.contains("denied this plan"), "{denial}");
    }

    #[test]
    fn a_human_denial_names_the_canonical_tool_without_a_client_spelling() {
        let response = render(
            declined(DENIED_BLOCK, &[]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert!(text(&response).contains("this call to archestra__todo_write."));
        // The runtime records the denial on the call, so asking again in this
        // session gets no new review.
        assert!(text(&response).contains("holds for the rest of this session"));
    }

    #[test]
    fn a_block_without_a_deny_ruling_keeps_the_runtime_text() {
        for ruling in [None, Some(RulingInput::Approve)] {
            let response = render(declined(DENIED_BLOCK, &[]), &owner(None), ruling);
            assert_eq!(text(&response), DENIED_BLOCK);
        }
    }

    #[test]
    fn a_deny_ruling_on_a_non_block_decline_keeps_the_runtime_text() {
        let invalidated =
            "[appa] the state changed and this offer no longer applies; re-propose the call";
        let response = render(
            declined(invalidated, &[]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert_eq!(text(&response), invalidated);
    }

    #[test]
    fn a_block_that_still_offers_the_quoted_offer_is_not_a_denial() {
        let response = render(
            declined(DENIED_BLOCK, &[QUOTED]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        assert_eq!(text(&response), DENIED_BLOCK);
    }

    #[test]
    fn a_denial_keeps_the_options_that_do_not_need_the_reviewer() {
        let remaining =
            format!("{DENIED_BLOCK}\n\nContinue:\n  - execute_remedy_plan(offer_id: \"{OTHER}\")");
        let response = render(
            declined(&remaining, &[OTHER]),
            &owner(None),
            Some(RulingInput::Deny),
        );

        let text = text(&response);
        assert!(text.starts_with("[appa] Denied:"), "{text}");
        assert!(text.contains("The policy still offers options that do not need this reviewer:"));
        assert!(text.ends_with(&remaining));
    }
}

#[cfg(test)]
mod stored_approved_output_tests {
    use super::{OutputSource, stored_approved_output, with_approved_output};
    use serde_json::json;

    fn decision(text: &str) -> serde_json::Value {
        with_approved_output(
            &json!({"decision": "ack"}),
            text.to_owned(),
            OutputSource::Tool,
        )
        .unwrap()
    }

    #[test]
    fn a_long_text_the_decision_carries_is_stored_once_as_a_reference() {
        let text = "x".repeat(5000);
        let stored = stored_approved_output(&text, &decision(&text));
        assert_eq!(
            stored,
            format!("sha256:{}", super::sha256_hex(text.as_bytes()))
        );
        assert_eq!(stored, stored_approved_output(&text, &decision(&text)));
    }

    #[test]
    fn a_short_text_or_one_the_decision_lacks_stays_in_the_column() {
        let short = "ok".repeat(100);
        assert_eq!(stored_approved_output(&short, &decision(&short)), short);
        let long = "y".repeat(5000);
        assert_eq!(
            stored_approved_output(&long, &json!({"decision": "ack"})),
            long
        );
        assert_eq!(
            stored_approved_output(&long, &decision("another text")),
            long
        );
    }
}

#[cfg(test)]
mod review_tests {
    use super::review_in;
    use serde_json::json;

    #[test]
    fn a_review_stored_before_typed_scope_leaves_it_unknown() {
        let input = json!({ "context": { "tool": "send_email", "arguments": {} } });
        let old = json!({ "review": [{ "offer_id": "o1", "text": "approve?" }] });
        let typed = json!({ "review": [{
            "offer_id": "o2", "text": "approve?", "authority": "operator", "scope": [],
            "hint": "Check the recipient.",
        }] });
        let receipts = [(input.clone(), old), (input, typed)];

        let old = review_in(receipts.clone(), "o1", "s").unwrap();
        assert_eq!((old.scope, old.hint), (None, None));
        let typed = review_in(receipts, "o2", "s").unwrap();
        assert_eq!(typed.scope.as_deref(), Some("[]"));
        assert_eq!(typed.hint.as_deref(), Some("Check the recipient."));
    }
}
