//! Archestra's host boundary. Policy evaluation and event serialization live in
//! OpenAPPA; identity, call correlation and durable processing receipts live here.

use appa_eventlog::{
    Backend, LogStore,
    postgres::{PostgresError, PostgresStore},
};
use appa_runtime::{api::Runtime, config::Config, hooks, mcp};
use appa_runtime_api::{
    Actor, HookDecision, HookEvent, OutcomeBody, ProposedCall, Ruling, SpawnRef, ToolOutcome,
    TrajectoryId, WireDecision,
};
use futures_util::FutureExt;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    panic::AssertUnwindSafe,
    path::Path,
    sync::{Arc, OnceLock},
};
use tokio::sync::Mutex;

static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

struct State {
    runtime: Runtime,
    config: Config,
    store: Arc<LogStore>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    organization_id: String,
    caller_id: String,
    session_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    event: String,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    arguments: Option<Box<RawValue>>,
    #[serde(default)]
    spawn: bool,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
    // Host-only field, never part of the model-facing remedy arguments.
    #[serde(default)]
    ruling: Option<Ruling>,
}

fn error(message: impl ToString) -> napi::Error {
    napi::Error::from_reason(message.to_string())
}
fn required<'a>(value: &'a Option<String>, name: &str) -> napi::Result<&'a str> {
    value
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error(format!("missing {name}")))
}
fn wire(decision: &HookDecision) -> Value {
    serde_json::to_value(WireDecision::of(decision)).expect("wire decision serializes")
}
fn identity(input: &Input) -> String {
    let bytes = serde_json::to_vec(&(&input.organization_id, &input.caller_id, &input.session_id))
        .expect("identity serializes");
    format!("archestra:{:x}", Sha256::digest(bytes))
}

#[napi(js_name = "initializeOpenappa")]
pub async fn initialize_openappa(database_url: String, policy_path: String) -> napi::Result<()> {
    let mut slot = STATE.get_or_init(|| Mutex::new(None)).lock().await;
    if slot.is_some() {
        return Ok(());
    }
    let state = tokio::task::spawn_blocking(move || -> napi::Result<State> {
        appa_runtime::tls::install_crypto_provider();
        let config = Config::load(Path::new(&policy_path)).map_err(error)?;
        let store =
            Arc::new(LogStore::open(Backend::Postgres { url: database_url }).map_err(error)?);
        let runtime =
            Runtime::open_with_store(config.clone(), store.clone(), None).map_err(error)?;
        Ok(State {
            runtime,
            config,
            store,
        })
    })
    .await
    .map_err(error)??;
    *slot = Some(state);
    Ok(())
}

#[napi(js_name = "dispatchHook")]
pub async fn dispatch_hook(input: String) -> napi::Result<String> {
    let input: Input = serde_json::from_str(&input).map_err(error)?;
    if input.ruling.is_some() && input.event != "remedy" {
        return Err(error("only a remedy execution may carry a host ruling"));
    }
    for (name, value) in [
        ("organization", &input.organization_id),
        ("caller", &input.caller_id),
        ("session", &input.session_id),
    ] {
        if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
            return Err(error(format!("invalid {name} identity")));
        }
    }
    for (name, value) in [
        ("parent", &input.parent_id),
        ("operation", &input.operation_id),
        ("tool call", &input.tool_call_id),
    ] {
        if let Some(value) = value {
            if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
                return Err(error(format!("invalid {name} identity")));
            }
        }
    }
    // Reject malformed host requests before writing an interrupted-operation
    // receipt. A typo is not evidence that an external consult may have run.
    match input.event.as_str() {
        "session_start" => {}
        "tool_result" => {
            required(&input.tool_call_id, "tool_call_id")?;
            if input.output.is_none() {
                return Err(error("missing output"));
            }
            if !matches!(
                input.outcome.as_deref(),
                None | Some("success" | "failure" | "unknown")
            ) {
                return Err(error("invalid tool outcome"));
            }
        }
        "tool_call" | "resume_tool_call" => {
            required(&input.operation_id, "operation_id")?;
            proposed(&input)?;
        }
        "remedy" | "remedy_review" => {
            required(&input.operation_id, "operation_id")?;
            let _: mcp::ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(&input)?).map_err(error)?;
        }
        "prompt" | "turn_end" | "child_end" => {
            required(&input.operation_id, "operation_id")?;
        }
        _ => return Err(error("unsupported OpenAPPA event")),
    }
    let mut slot = STATE.get_or_init(|| Mutex::new(None)).lock().await;
    let state = slot
        .as_mut()
        .ok_or_else(|| error("OpenAPPA is not initialized"))?;
    let result = AssertUnwindSafe(state.dispatch(input)).catch_unwind().await;
    match result {
        Ok(Ok(value)) => Ok(value.to_string()),
        failure => {
            // A rollback must also discard tentative in-memory vouches and
            // turn markers. Durable pending receipts remain fail-closed.
            let rebuilt = Runtime::open_with_store(state.config.clone(), state.store.clone(), None)
                .map_err(error)?;
            state.runtime = rebuilt;
            match failure {
                Ok(Err(error)) => Err(error),
                _ => Err(error("OpenAPPA panicked; operation was not released")),
            }
        }
    }
}

struct SessionLock {
    pg: PostgresStore,
    root: String,
}
impl SessionLock {
    fn acquire(pg: &PostgresStore, root: String) -> napi::Result<Self> {
        let key = root.clone();
        pg.with_client(move |client| {
            client.query_one("SELECT pg_advisory_lock(hashtextextended($1, 0))", &[&key])?;
            Ok(())
        })
        .map_err(error)?;
        Ok(Self {
            pg: pg.clone(),
            root,
        })
    }
}
impl Drop for SessionLock {
    fn drop(&mut self) {
        let key = self.root.clone();
        let _ = self.pg.with_client(move |client| {
            client.query_one(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                &[&key],
            )?;
            Ok(())
        });
    }
}

impl State {
    async fn dispatch(&self, input: Input) -> napi::Result<Value> {
        let pg = self.store.postgres().expect("PostgreSQL runtime");
        let actor_id = identity(&input);
        let parent = input.parent_id.clone().map(|id| Input {
            session_id: id,
            ..input.clone()
        });
        let root = if let Some(parent) = parent {
            let parent_key = identity(&parent);
            pg.with_client(move |client| {
                client
                    .query_opt(
                        "SELECT root FROM openappa_sessions WHERE actor = $1",
                        &[&parent_key],
                    )?
                    .map(|row| row.get::<_, String>(0))
                    .ok_or_else(|| PostgresError("parent session has not started".into()))
            })
            .map_err(error)?
        } else {
            actor_id.clone()
        };
        let _lock = SessionLock::acquire(pg, root.clone())?;
        // Check every member of the family: continuing a parent while a child's
        // result is interrupted could otherwise bypass inherited restrictions.
        let check_root = root.clone();
        let interrupted = pg.with_client(move |client| Ok(client.query_opt(
            "SELECT 1 FROM openappa_operations WHERE root = $1 AND status = 'pending'
             UNION ALL SELECT 1 FROM openappa_processed_results WHERE root = $1 AND status = 'pending' LIMIT 1", &[&check_root])?.is_some())).map_err(error)?;
        if interrupted {
            return Err(error(
                "OpenAPPA session has interrupted processing; operator recovery is required",
            ));
        }

        let actor = Actor {
            root: TrajectoryId(root.clone()),
            child: (root != actor_id).then(|| TrajectoryId(actor_id.clone())),
        };
        let lookup = actor_id.clone();
        let existing = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id FROM openappa_sessions WHERE actor = $1",
                        &[&lookup],
                    )?
                    .map(|row| (row.get::<_, String>(0), row.get::<_, Option<String>>(1))))
            })
            .map_err(error)?;
        if let Some((saved_root, saved_parent)) = &existing {
            if *saved_root != root || *saved_parent != input.parent_id {
                return Err(error("session parent identity changed"));
            }
        } else {
            let tx = pg.begin().map_err(error)?;
            let start = if let Some(child) = &actor.child {
                HookEvent::ChildStart {
                    root: actor.root.clone(),
                    child: child.clone(),
                    spawn: SpawnRef::InFlight,
                }
            } else {
                HookEvent::SessionStart {
                    root: actor.root.clone(),
                }
            };
            let decision = hooks::handle(&self.runtime, start).await;
            if !matches!(decision, HookDecision::Ack | HookDecision::Context { .. }) {
                return Err(error(wire(&decision)));
            }
            // A return contract must be delivered before the child starts work.
            // Keep it in the start receipt so repeat SessionStart can deliver it.
            let start_decision = wire(&decision);
            let (id, root, input) = (actor_id.clone(), root.clone(), input.clone());
            pg.with_client(move |client| {
                client.execute("INSERT INTO openappa_sessions (actor, root, organization_id, caller_id, session_id, parent_id, start_decision) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    &[&id, &root, &input.organization_id, &input.caller_id, &input.session_id, &input.parent_id, &start_decision])?;
                Ok(())
            }).map_err(error)?;
            tx.commit().map_err(error)?;
        }

        if input.event == "session_start" {
            return pg
                .with_client(move |client| {
                    Ok(client
                        .query_one(
                            "SELECT start_decision FROM openappa_sessions WHERE actor = $1",
                            &[&actor_id],
                        )?
                        .get(0))
                })
                .map_err(error);
        }
        if input.event == "tool_result" {
            return self.result(pg, &input, &actor).await;
        }

        let operation = input
            .operation_id
            .clone()
            .ok_or_else(|| error("an operation id is required"))?;
        let resumed = input.event == "resume_tool_call";
        let event = if resumed { "tool_call" } else { &input.event };
        let request = json!({ "event": event, "tool": input.tool, "arguments": input.arguments, "spawn": input.spawn, "output": input.output, "ruling": input.ruling });
        if resumed {
            let (saved, denied) = lookup_operation(pg, &input, &operation)?
                .ok_or_else(|| error("reviewed call has no original receipt"))?;
            if saved != request || denied["decision"] != "deny_call" {
                return Err(error("reviewed call must match the original denied call"));
            }
        }
        let operation = if resumed {
            format!("{operation}:reviewed")
        } else {
            operation
        };
        let cached = lookup_operation(pg, &input, &operation)?;
        if let Some((saved, decision)) = cached {
            if input.event == "remedy_review"
                && saved["event"] == "remedy"
                && saved["arguments"] == request["arguments"]
            {
                return Ok(decision);
            }
            // Receipts predating host review have no ruling field.
            let mut saved = saved;
            if saved.get("ruling").is_none() {
                saved["ruling"] = Value::Null;
            }
            if saved != request {
                return Err(error("operation id was reused with different input"));
            }
            if input.event == "tool_call" && decision["decision"] == "deny_call" {
                if let Some((reviewed_input, reviewed)) =
                    lookup_operation(pg, &input, &format!("{operation}:reviewed"))?
                {
                    if reviewed_input != request {
                        return Err(error("reviewed call input differs from original"));
                    }
                    return Ok(reviewed);
                }
            }
            return Ok(decision);
        }
        if input.event == "remedy_review" {
            // A read-only phase releases the native mutex and database lock
            // before the host waits for a person. The review itself was saved
            // atomically with the original deny decision.
            return Ok(json!({"decision": "review", "review": remedy_review(pg, &input)?}));
        }
        if input.ruling.is_some() && remedy_review(pg, &input)?.is_empty() {
            return Err(error("a host ruling requires an issued human-review offer"));
        }
        claim_operation(pg, &input, &root, &operation, &request)?;
        let tx = pg.begin().map_err(error)?;
        let mut decision = if input.event == "remedy" {
            let call = ProposedCall {
                tool: appa_runtime_api::CONTROL_TOOL.into(),
                arguments: input
                    .arguments
                    .clone()
                    .ok_or_else(|| error("missing remedy arguments"))?,
            };
            let gate = hooks::handle(
                &self.runtime,
                HookEvent::ToolCall {
                    actor: actor.clone(),
                    call,
                    spawn: false,
                    ruling: input.ruling,
                },
            )
            .await;
            if !matches!(gate, HookDecision::PassControl) {
                wire(&gate)
            } else {
                let args = serde_json::from_str(required_arguments(&input)?).map_err(error)?;
                let result = mcp::execute_embedded_remedy(&self.runtime, &actor, args).await;
                json!({ "decision": "mcp_result", "result": result })
            }
        } else {
            let event = match input.event.as_str() {
                "tool_call" | "resume_tool_call" => HookEvent::ToolCall {
                    actor: actor.clone(),
                    call: proposed(&input)?,
                    spawn: input.spawn,
                    ruling: None,
                },
                "prompt" => HookEvent::Prompt {
                    actor: actor.clone(),
                    text: String::new(),
                },
                "turn_end" => HookEvent::TurnEnd {
                    actor: actor.clone(),
                },
                "child_end" => HookEvent::ChildEnd {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| error("not a child session"))?,
                    value: input.output.clone(),
                },
                _ => return Err(error("unsupported OpenAPPA event")),
            };
            wire(&hooks::handle(&self.runtime, event).await)
        };
        if resumed {
            decision["reviewed"] = Value::Bool(true);
        }
        finish_operation(pg, &input, &operation, &decision)?;
        tx.commit().map_err(error)?;
        Ok(decision)
    }

    async fn result(
        &self,
        pg: &PostgresStore,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let call_id = required(&input.tool_call_id, "tool_call_id")?.to_owned();
        let key = (
            input.organization_id.clone(),
            input.caller_id.clone(),
            input.session_id.clone(),
            call_id.clone(),
        );
        let lookup = key.clone();
        let cached = pg.with_client(move |client| Ok(client.query_opt("SELECT approved_output, decision FROM openappa_processed_results WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3 AND tool_call_id=$4 AND status='complete'", &[&lookup.0,&lookup.1,&lookup.2,&lookup.3])?
            .map(|row| (row.get::<_, String>(0), row.get::<_, Value>(1))))).map_err(error)?;
        if let Some((output, mut decision)) = cached {
            decision["approved_output"] = json!(output);
            decision["cached"] = json!(true);
            return Ok(decision);
        }
        // Correlation comes from the call actually released by the proxy, even
        // when compaction has removed it from the client's submitted history.
        let (saved, mut allowed) = lookup_operation(pg, input, &format!("call:{call_id}"))?
            .ok_or_else(|| error("tool result has no previously checked call"))?;
        if allowed["decision"] == "deny_call" {
            if let Some((reviewed_input, reviewed)) =
                lookup_operation(pg, input, &format!("call:{call_id}:reviewed"))?
            {
                if reviewed_input != saved {
                    return Err(error("reviewed call input differs from original"));
                }
                allowed = reviewed;
            }
        }
        if allowed["decision"] == "deny_call" {
            // Denied calls produce policy feedback, never tool data. Ignore
            // client-supplied output, including claimed success, and do not
            // apply result hooks or label changes for an unexecuted call.
            let feedback = allowed["feedback"]
                .as_str()
                .unwrap_or("OpenAPPA blocked this tool call");
            return Ok(json!({
                "decision": "deny_call",
                "approved_output": format!("{feedback}\n\nThe tool was not executed. Use an offered remedy if appropriate before retrying; otherwise explain the ruling.")
            }));
        }
        if !matches!(
            allowed["decision"].as_str(),
            Some("allow_call" | "pass_control")
        ) {
            return Err(error("tool result belongs to a blocked call"));
        }
        let call = ProposedCall {
            tool: saved["tool"]
                .as_str()
                .ok_or_else(|| error("stored call is missing its tool"))?
                .into(),
            arguments: serde_json::value::to_raw_value(&saved["arguments"]).map_err(error)?,
        };
        let output = input
            .output
            .clone()
            .ok_or_else(|| error("missing tool output"))?;
        let outcome = match input.outcome.as_deref() {
            Some("success") => ToolOutcome::Success {
                body: OutcomeBody::Available(output.clone()),
            },
            Some("failure") => ToolOutcome::Failure {
                message: output.clone(),
            },
            Some("unknown") | None => ToolOutcome::Indeterminate,
            _ => return Err(error("invalid tool outcome")),
        };
        let claim = key.clone();
        let root = actor.root.0.clone();
        pg.with_client(move |client| {
            client.execute("INSERT INTO openappa_processed_results (organization_id,caller_id,session_id,tool_call_id,root,status) VALUES ($1,$2,$3,$4,$5,'pending')", &[&claim.0,&claim.1,&claim.2,&claim.3,&root])?;
            Ok(())
        }).map_err(error)?;
        let tx = pg.begin().map_err(error)?;
        let event = if saved["spawn"] == true {
            // No child return is guessed from an opaque tool result. The child
            // must have reported ChildEnd through its adapter first.
            HookEvent::SpawnResult {
                actor: actor.clone(),
                call,
                outcome,
                child: None,
                value: None,
            }
        } else {
            HookEvent::ToolResult {
                actor: actor.clone(),
                call,
                outcome,
            }
        };
        let decision = hooks::handle(&self.runtime, event).await;
        let approved = match &decision {
            HookDecision::Ack
                if input.outcome.as_deref() == Some("unknown") || input.outcome.is_none() =>
            {
                "[appa] Tool output withheld: execution outcome is unknown.".into()
            }
            HookDecision::Ack => output,
            HookDecision::DeliverValue { value } | HookDecision::ChildReturn { value } => {
                value.clone()
            }
            HookDecision::ReplaceOutput { output } => model_text(output),
            HookDecision::Block { reason } => {
                format!("[appa] Tool output withheld: {}", model_text(reason))
            }
            HookDecision::Refuse { detail } => {
                return Err(error(format!("OpenAPPA result refused: {detail}")));
            }
            _ => return Err(error("unexpected tool result decision")),
        };
        let mut response = wire(&decision);
        response["approved_output"] = json!(approved);
        let saved_response = response.clone();
        pg.with_client(move |client| {
            client.execute("UPDATE openappa_processed_results SET status='complete', approved_output=$5, decision=$6 WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3 AND tool_call_id=$4", &[&key.0,&key.1,&key.2,&key.3,&approved,&saved_response])?;
            Ok(())
        }).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(response)
    }
}

fn model_text(text: &str) -> String {
    text.replace(
        appa_runtime_api::CONTROL_TOOL,
        "archestra__execute_remedy_plan",
    )
    .replace(
        "    execute_remedy_plan(",
        "    archestra__execute_remedy_plan(",
    )
}
fn required_arguments(input: &Input) -> napi::Result<&str> {
    input
        .arguments
        .as_ref()
        .map(|args| args.get())
        .ok_or_else(|| error("missing arguments"))
}
fn proposed(input: &Input) -> napi::Result<ProposedCall> {
    Ok(ProposedCall {
        tool: required(&input.tool, "tool")?.to_owned(),
        arguments: input
            .arguments
            .clone()
            .ok_or_else(|| error("missing arguments"))?,
    })
}
fn lookup_operation(
    pg: &PostgresStore,
    input: &Input,
    operation: &str,
) -> napi::Result<Option<(Value, Value)>> {
    let (input, operation) = (input.clone(), operation.to_owned());
    pg.with_client(move |client| Ok(client.query_opt("SELECT input, decision FROM openappa_operations WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3 AND operation_id=$4 AND status='complete'", &[&input.organization_id,&input.caller_id,&input.session_id,&operation])?.map(|row| (row.get(0), row.get(1))))).map_err(error)
}
fn remedy_review(pg: &PostgresStore, input: &Input) -> napi::Result<Vec<Value>> {
    let args: mcp::ExecuteRemedyPlanArgs =
        serde_json::from_str(required_arguments(input)?).map_err(error)?;
    let input = input.clone();
    pg.with_client(move |client| {
        let rows = client.query(
            "SELECT review FROM openappa_operations, jsonb_array_elements(COALESCE(NULLIF(decision->'review', 'null'::jsonb), '[]'::jsonb)) AS review WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3 AND status='complete' AND input->>'event'='tool_call' AND review->>'offer_id'=$4",
            &[&input.organization_id, &input.caller_id, &input.session_id, &args.offer_id],
        )?;
        Ok(rows.into_iter().map(|row| row.get(0)).collect())
    }).map_err(error)
}
fn claim_operation(
    pg: &PostgresStore,
    input: &Input,
    root: &str,
    operation: &str,
    request: &Value,
) -> napi::Result<()> {
    let (input, root, operation, request) = (
        input.clone(),
        root.to_owned(),
        operation.to_owned(),
        request.clone(),
    );
    pg.with_client(move |client| {
        client.execute("INSERT INTO openappa_operations (organization_id,caller_id,session_id,operation_id,root,input,status) VALUES ($1,$2,$3,$4,$5,$6,'pending')", &[&input.organization_id,&input.caller_id,&input.session_id,&operation,&root,&request])?;
        Ok(())
    }).map_err(error)
}
fn finish_operation(
    pg: &PostgresStore,
    input: &Input,
    operation: &str,
    decision: &Value,
) -> napi::Result<()> {
    let (input, operation, decision) = (input.clone(), operation.to_owned(), decision.clone());
    pg.with_client(move |client| {
        client.execute("UPDATE openappa_operations SET status='complete', decision=$5 WHERE organization_id=$1 AND caller_id=$2 AND session_id=$3 AND operation_id=$4", &[&input.organization_id,&input.caller_id,&input.session_id,&operation,&decision])?;
        Ok(())
    }).map_err(error)
}
