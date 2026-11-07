//! Archestra's host boundary. Policy evaluation and event serialization live in
//! OpenAPPA; identity, call correlation and durable processing receipts live here.
// Clippy's deeper trait analysis overflows the default solver recursion on the
// napi-bound dispatch futures; plain rustc stays within it.
#![recursion_limit = "256"]

mod adapter;
pub mod admin_api;
mod batteries;
pub mod child_returns;
mod consults;
mod declarations;
mod deployments;
mod errors;
mod input;
mod labels;
mod lease;
mod metrics;
mod operations;
#[cfg_attr(test, allow(dead_code))]
mod peer;
mod policy;
pub mod remedy;
mod replay;
mod retained_refusal;
mod sealed;
mod session;

use crate::{
    admin_api::{ContentEncryption, DispatchPolicy, ReportingOptions},
    child_returns::{
        AddressedChild, addressed_before_start, classify_addressed_child, rebind_child,
        released_spawn_binding, spawn_ref_from_receipt,
    },
    errors::{
        BindingFailure, Failure, Fault, failure, fork_refused, invalid_input, invariant,
        is_policy_moved, lease_lost, panicked, policy_moved, receipt_failure, sql_failure, storage,
    },
    input::{ExecutionOutcome, HookEventKind, Input, OfferOwner, RulingInput, required, validate},
    operations::{
        CompletedOperation, OperationState, ResultClaim, YellArguments, cancellation_operation,
        cancelled_call, claim_operation, claim_result, expected_actor, finish_operation,
        finish_remedy, operation_semantic, proposed, read_operation_state,
        recorded_call_presentation, remedy_binding, required_arguments, tool_call_context,
    },
    remedy::{
        OutputSource, RemedyAct, authoritative_unexecuted_response, decision_text,
        inherited_result, proposed_recorded_call, recorded_call, remedy_operation, remedy_request,
        render_remedy_outcome, runtime_refusal, stored_approved_output, unknown_result_response,
        with_approved_output, with_presentation_offers,
    },
    session::{
        SessionKey, check_session_identity, mark_busy_hold, operation_key, presentation_options,
        processed_result_key, require_decision, result_presentation_options, root_id,
        session_actor, session_binding, wire,
    },
};
use appa_eventlog::{
    LogStore, OperationKey,
    encryption::{StorageCipher, field_context},
    postgres::{LeaseError, PostgresError},
};
use appa_runtime::{
    api::{ExecuteRemedyPlanArgs, PublishedDeployment, Runtime},
    hooks,
};
use appa_runtime_api::{
    Actor, HookDecision, HookEvent, OutcomeBody, ProposedCall, Ruling, SpawnKind, SpawnRef,
    ToolOutcome, TrajectoryId,
};
use futures_util::FutureExt;
use napi_derive::napi;
use serde_json::{Value, json};
use std::{
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime},
};
use tokio::sync::Mutex;

/// Process-wide runtime slot. The mutex covers initialize only. Every dispatch
/// runs through a view pinned to the head of its organization's deployment line
/// (see [`deployments`]), so dispatches run concurrently and none changes what
/// another serves. Every family decides its next event under its line's head,
/// whichever revision opened it; the runtime refuses a family pinned to the
/// policy it opened under as `RefusalClass::LegacyFamily`, which is not retryable.
/// No dispatch holds a database connection or a lock while it works: the event
/// log serializes each read-decide-append step of a family on the family's row,
/// receipts carry a lease per operation (see [`lease`]), and every write is one
/// short transaction.
static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

#[derive(Clone)]
struct State {
    runtime: Arc<Runtime>,
    store: Arc<LogStore>,
    deployments: Arc<deployments::Deployments>,
    reporting: Option<ReportingOptions>,
    /// The policy revision this state's runtime is pinned to; `None` before a pin.
    served: Option<u64>,
}

/// A state whose store is one pooled connection of its own, for a short read.
struct Leased {
    state: State,
}

/// Host SQL beside the ledger. A store that is not leased checks a pooled
/// connection out for each query alone, so a dispatch holds no connection while
/// it waits on a consult.
pub(crate) struct Sql<'a>(&'a LogStore);

impl Sql<'_> {
    pub(crate) fn with_client<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut postgres::Client) -> Result<T, PostgresError> + Send + 'static,
    ) -> Result<T, SqlError> {
        if let Some(pg) = self.0.postgres() {
            return Ok(pg.with_client(operation)?);
        }
        let leased = self.0.lease()?;
        let pg = leased
            .postgres()
            .ok_or_else(|| PostgresError("OpenAPPA requires PostgreSQL storage".into()))?;
        Ok(pg.with_client(operation)?)
    }
}

/// Why host SQL beside the ledger did not run.
#[derive(Debug)]
pub(crate) enum SqlError {
    /// Every pooled connection stayed busy for the whole checkout wait.
    Exhausted(Duration),
    Postgres(PostgresError),
}

impl std::fmt::Display for SqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlError::Exhausted(wait) => {
                write!(f, "no PostgreSQL connection became free within {wait:?}")
            }
            SqlError::Postgres(error) => error.fmt(f),
        }
    }
}

impl From<PostgresError> for SqlError {
    fn from(error: PostgresError) -> Self {
        SqlError::Postgres(error)
    }
}

impl From<LeaseError> for SqlError {
    fn from(error: LeaseError) -> Self {
        match error {
            LeaseError::Exhausted(wait) => SqlError::Exhausted(wait),
            other => SqlError::Postgres(PostgresError::from(other)),
        }
    }
}

impl From<SqlError> for Fault {
    fn from(error: SqlError) -> Self {
        match error {
            SqlError::Exhausted(_) => Fault::binding(
                BindingFailure::PoolExhausted,
                "OpenAPPA had no free PostgreSQL connection in time; retry later",
            ),
            SqlError::Postgres(error) => Fault::binding(BindingFailure::Storage, error),
        }
    }
}

impl From<SqlError> for napi::Error {
    fn from(error: SqlError) -> Self {
        Fault::from(error).into()
    }
}

fn state_mutex() -> &'static Mutex<Option<State>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Runs `work` through a view pinned to the head of the organization's deployment
/// line. When the line moved past that head while `work` was decided, which only
/// happens when another process published, nothing was appended: the
/// organization's deployment is pinned at the new head when it names the same
/// policy, and `work` runs once more. When the head names another policy, or moves
/// again, the dispatch fails as retryable and the host's retry reads the policy
/// again.
async fn on_deployment<T, Work>(
    state: &State,
    organization_id: &str,
    policy: &deployments::HostedPolicy,
    work: impl Fn(State) -> Work,
) -> napi::Result<T>
where
    Work: std::future::Future<Output = napi::Result<T>>,
{
    let deployment = state
        .deployments
        .deployment(
            &state.runtime,
            &state.store,
            organization_id,
            policy,
            state.reporting.is_some(),
        )
        .await
        .map_err(|refusal| match refusal {
            deployments::DeploymentError::Superseded => policy_moved(),
            deployments::DeploymentError::Diverged => Fault::binding(
                BindingFailure::InvalidInput,
                "OpenAPPA was handed two policy documents under one composition; the organization's deployment is unchanged",
            )
            .into(),
            deployments::DeploymentError::Failed(fault) => fault.into(),
        })?;
    match work(state.pinned(&deployment)).await {
        Err(moved) if is_policy_moved(&moved) => {
            let Some(head) = state
                .deployments
                .repin(&state.runtime, &state.store, organization_id, &deployment)
                .await?
            else {
                return Err(policy_moved());
            };
            match work(state.pinned(&head)).await {
                Err(moved) if is_policy_moved(&moved) => Err(policy_moved()),
                result => result,
            }
        }
        result => result,
    }
}

#[napi(js_name = "dispatchHook")]
pub async fn dispatch_hook(
    input: String,
    policy: DispatchPolicy,
    encryption: Option<ContentEncryption>,
) -> napi::Result<String> {
    let input: Input = serde_json::from_str(&input).map_err(invalid_input)?;
    validate(&input)?;
    run(input, policy.into(), encryption).await
}

/// Runs one validated event through a view pinned to its organization's deployment.
async fn run(
    input: Input,
    policy: deployments::HostedPolicy,
    encryption: Option<ContentEncryption>,
) -> napi::Result<String> {
    let result = AssertUnwindSafe(async {
        let state = initialized().await?.encrypted(encryption)?;
        on_deployment(&state, &input.organization_id, &policy, |pinned| {
            let input = input.clone();
            async move { pinned.dispatch(input).await }
        })
        .await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(Ok(value)) => Ok(value.to_string()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(panicked("OpenAPPA panicked; operation was not released")),
    }
}

async fn initialized() -> napi::Result<State> {
    state_mutex()
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| invalid_input("OpenAPPA is not initialized"))
}

impl State {
    /// Opens this session's root as a fork of `fork_of`.
    /// Freezes the parent session's policy revision, labels, effects, and
    /// denials into the new root. Returns the parent watermark bounding inherited results.
    fn open_fork(
        &self,
        pg: &Sql<'_>,
        input: &Input,
        fork_of: &str,
        root: &str,
    ) -> napi::Result<Option<SystemTime>> {
        if input.parent_id.is_some() {
            return Err(invalid_input(
                "an OpenAPPA session cannot both fork a session and be its child",
            ));
        }
        let parent = SessionKey::new(&input.organization_id, fork_of);
        let (lookup, caller_id) = (parent.clone(), input.caller_id.clone());
        let (parent_root, parent_is_child) = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id IS NOT NULL FROM openappa_sessions WHERE organization_id = $1 AND actor = $2 AND caller_id IS NOT DISTINCT FROM $3",
                        &[&lookup.organization_id, &lookup.actor, &caller_id],
                    )?
                    .map(|row| (row.get::<_, String>(0), row.get::<_, bool>(1))))
            })
            ?
            .ok_or_else(|| invalid_input("the session this one forks has not started"))?;
        // A top-level session's trajectory is its root, a child's is its actor.
        let parent_trajectory = if parent_is_child {
            parent.actor
        } else {
            parent_root.clone()
        };

        let fork_root = root.to_owned();
        let already_opened = pg.with_client(move |client| {
            Ok(client
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM openappa_events WHERE root = $1)",
                    &[&fork_root],
                )?
                .get::<_, bool>(0))
        })?;
        if already_opened {
            // A crash after `Runtime::open_root_fork` but before our session row left a
            // durable opening without a reliable boundary. Re-open it to verify
            // its immutable origin matches this request, but keep results closed.
            self.runtime
                .open_root_fork(
                    &TrajectoryId(parent_root),
                    &TrajectoryId(parent_trajectory),
                    &TrajectoryId(root.to_owned()),
                )
                .map_err(fork_refused)?;
            return Ok(None);
        }

        // Taken before the fork reads the parent's log. A parent result completes
        // only after its admission is in that log, so every result completed
        // before this moment is part of the history the fork copies. A result
        // still being processed while the fork opens is not inherited: the fork
        // answers it as unknown, which withholds it.
        let forked_at = pg.with_client(|client| {
            Ok(client
                .query_one("SELECT clock_timestamp()", &[])?
                .get::<_, SystemTime>(0))
        })?;
        self.runtime
            .open_root_fork(
                &TrajectoryId(parent_root),
                &TrajectoryId(parent_trajectory),
                &TrajectoryId(root.to_owned()),
            )
            .map_err(fork_refused)?;
        Ok(Some(forked_at))
    }

    fn encrypted(&self, encryption: Option<ContentEncryption>) -> napi::Result<State> {
        let Some(encryption) = encryption else {
            return Ok(self.clone());
        };
        let cipher = StorageCipher::encrypted(encryption.key.as_ref(), encryption.scope)
            .map_err(invalid_input)?;
        let store = Arc::new(self.store.encrypted_view(cipher).map_err(SqlError::from)?);
        let runtime = self.runtime.on(store.clone());
        let runtime = match encryption.annotator_context {
            Some(context) => runtime.with_archestra_context(context),
            None => runtime,
        };
        Ok(State {
            runtime: Arc::new(runtime),
            store,
            ..self.clone()
        })
    }

    /// This state with its runtime pinned to `deployment`: every lease of it, and
    /// every view made of such a lease, serves that deployment.
    fn pinned(&self, deployment: &PublishedDeployment) -> State {
        State {
            runtime: Arc::new(self.runtime.pinned(deployment)),
            served: Some(deployment.revision()),
            ..self.clone()
        }
    }

    /// This state over one pooled connection, for a short read: the store is a
    /// lease of it and the runtime reads through that lease.
    async fn lease(&self) -> napi::Result<Leased> {
        let store = Arc::new(self.store.lease().map_err(SqlError::from)?);
        Ok(Leased {
            state: State {
                runtime: Arc::new(self.runtime.on(store.clone())),
                store,
                ..self.clone()
            },
        })
    }

    async fn dispatch(&self, input: Input) -> napi::Result<Value> {
        let key = SessionKey::of(&input);
        let sql = Sql(&self.store);
        let root = self.dispatch_root(&input)?;
        let consults = Arc::new(consults::ConsultBuffer::default());
        let recording = State {
            runtime: Arc::new(self.runtime.transcribing(consults.clone())),
            ..self.clone()
        };
        let attribution = consults::Attribution {
            organization_id: input.organization_id.clone(),
            session_id: input.session_id.clone(),
            caller_id: input.caller_id.clone(),
            withhold_content: input.withhold_consult_content,
        };
        let child_return = input.event == HookEventKind::ChildReturn;
        let observation = self.label_observation(&input, &root);
        let result = recording.dispatch_in_family(input, root, key).await;
        consults::store(&sql, attribution, &consults);
        if result.is_ok() {
            self.record_label(&sql, observation);
        }
        if child_return {
            result.map(mark_busy_hold)
        } else {
            result
        }
    }

    /// Who and what a label change after dispatching `input` is filed under.
    fn label_observation(&self, input: &Input, root: &str) -> labels::Observation {
        let event = match input.event {
            HookEventKind::SessionStart => labels::ChangeEvent::SessionStart,
            HookEventKind::ToolCall => labels::ChangeEvent::ToolCall,
            HookEventKind::ToolResult | HookEventKind::CancelCall => {
                labels::ChangeEvent::ToolResult
            }
            HookEventKind::Remedy => labels::ChangeEvent::Remedy,
            HookEventKind::ChildReturn | HookEventKind::ChildEnd | HookEventKind::ChildTurnEnd => {
                labels::ChangeEvent::ChildReturn
            }
            HookEventKind::Yell
            | HookEventKind::Prompt
            | HookEventKind::TurnEnd
            | HookEventKind::ChildAddress => labels::ChangeEvent::Other,
        };
        let call_id = match (&input.operation_id, &input.tool_call_id) {
            (Some(operation), _) if operation.starts_with("call:") => Some(operation.clone()),
            (_, Some(tool_call_id)) => Some(format!("call:{tool_call_id}")),
            _ => None,
        };
        labels::Observation {
            organization_id: input.organization_id.clone(),
            root: root.to_owned(),
            session_id: input.session_id.clone(),
            caller_id: input.caller_id.clone(),
            event,
            call_id,
            tool: input.tool.clone(),
            policy_revision: self
                .served
                .and_then(|revision| i64::try_from(revision).ok()),
        }
    }

    /// Reads the root's label after a dispatch and records it if it moved. A
    /// root the runtime cannot read is skipped: the dataset never fails a dispatch.
    fn record_label(&self, sql: &Sql<'_>, observation: labels::Observation) {
        let Ok(status) = self
            .runtime
            .try_status(&TrajectoryId(observation.root.clone()))
        else {
            return;
        };
        labels::record(
            sql,
            observation,
            labels::Label {
                trust: status.trust,
                audience: status.audience,
            },
        );
    }

    /// The root of the family `input` belongs to: the owner's for a proxy-stamped
    /// trajectory, the parent's for a child, else the session's own.
    fn dispatch_root(&self, input: &Input) -> napi::Result<String> {
        if let Some(root) = input.owner_root.clone() {
            return Ok(root);
        }
        let Some(parent_id) = &input.parent_id else {
            return self.session_root(input, &SessionKey::of(input));
        };
        // A parent is only ever looked up in the child's own organization.
        let parent = SessionKey::new(&input.organization_id, parent_id);
        Sql(&self.store)
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                        &[&parent.organization_id, &parent.actor],
                    )?
                    .map(|row| row.get::<_, String>(0)))
            })
            ?
            .ok_or_else(|| {
                failure(
                    Failure::Binding(BindingFailure::UnstartedParent),
                    "parent session has not started",
                )
            })
    }

    /// The root a top-level session governs: the one its row records once it has
    /// started, [`root_id`] before. A session that started while roots were named by
    /// the session id alone keeps that root, so its history carries on.
    fn session_root(&self, input: &Input, key: &SessionKey) -> napi::Result<String> {
        let lookup = key.clone();
        let recorded = Sql(&self.store).with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&lookup.organization_id, &lookup.actor],
                )?
                .map(|row| row.get::<_, String>(0)))
        })?;
        Ok(recorded.unwrap_or_else(|| root_id(&input.organization_id, &input.session_id)))
    }

    /// One event of a session family. Dispatches of one family run side by side:
    /// the event log takes their steps in turn, and each operation's receipt
    /// lets one of them work on it at a time.
    async fn dispatch_in_family(
        &self,
        input: Input,
        root: String,
        key: SessionKey,
    ) -> napi::Result<Value> {
        let sql = Sql(&self.store);
        let pg = &sql;

        let actor = expected_actor(&root, &input.session_id, input.parent_id.as_deref());
        let lookup = key.clone();
        let existing = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT root, parent_id, forked_from FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                        &[&lookup.organization_id, &lookup.actor],
                    )?
                    .map(|row| {
                        (
                            row.get::<_, String>(0),
                            row.get::<_, Option<String>>(1),
                            row.get::<_, Option<String>>(2),
                        )
                    }))
            })
            ?;
        if let Some(saved) = &existing {
            check_session_identity(saved, &root, &input)?;
        } else {
            let forked_at = input
                .fork_of
                .as_deref()
                .map(|fork_of| self.open_fork(pg, &input, fork_of, &root))
                .transpose()?
                .flatten();
            let start = if let Some(child) = &actor.child {
                HookEvent::ChildStart {
                    root: actor.root.clone(),
                    child: child.clone(),
                    spawn: self.child_spawn_ref(pg, &input)?,
                }
            } else {
                HookEvent::SessionStart {
                    root: actor.root.clone(),
                    principal: input.principal.clone(),
                    address: None,
                    title: None,
                    start: None,
                    launch: None,
                }
            };
            let decision = hooks::handle(&self.runtime, start).await;
            if !matches!(decision, HookDecision::Ack | HookDecision::Context { .. }) {
                return Err(invariant(wire(&decision)?));
            }
            // A child opens under its fork's seed: the parent's label when it spawned
            // the child. A parent that addressed the child before this first event may
            // have read more since, so the child takes the parent's current label now,
            // as a later address would give it.
            if let Some(child) = &actor.child
                && addressed_before_start(pg, &input)?
            {
                let readdress = hooks::handle(
                    &self.runtime,
                    HookEvent::ChildStart {
                        root: actor.root.clone(),
                        child: child.clone(),
                        spawn: SpawnRef::InFlight,
                    },
                )
                .await;
                if !matches!(readdress, HookDecision::Ack | HookDecision::Context { .. }) {
                    return Err(invariant(wire(&readdress)?));
                }
            }
            // A return contract must be delivered before the child starts work.
            // Keep it in the start receipt so repeat SessionStart can deliver it.
            let start_decision = self
                .store
                .cipher()
                .seal_json(
                    &field_context(&[
                        "openappa_sessions",
                        &key.organization_id,
                        &key.actor,
                        "start_decision",
                    ]),
                    &wire(&decision)?,
                )
                .map_err(storage)?;
            let (id, saved_root, row) = (key.actor.clone(), root.clone(), input.clone());
            // Two first events of one session can both get here; the runtime opened the
            // session once, and the first row stands. The other must describe the same
            // session.
            let stored = pg
                .with_client(move |client| {
                    client.execute("INSERT INTO openappa_sessions (actor, root, organization_id, caller_id, session_id, parent_id, forked_from, forked_at, start_decision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (organization_id, actor) DO NOTHING",
                        &[&id, &saved_root, &row.organization_id, &row.caller_id, &row.session_id, &row.parent_id, &row.fork_of, &forked_at, &start_decision])?;
                    Ok(client
                        .query_one(
                            "SELECT root, parent_id, forked_from FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                            &[&row.organization_id, &id],
                        )
                        .map(|row| (row.get(0), row.get(1), row.get(2)))?)
                })
                ?;
            check_session_identity(&stored, &root, &input)?;
        }

        let receipts = lease::Receipts::new(self.store.clone());
        let began = lease::log_end(pg, &root)?;
        let work = self.handle_event(pg, &receipts, input, root.clone(), key, actor);
        let failure = match receipts.hold(work).await {
            lease::Guarded::Finished(Ok(value)) => return Ok(value),
            lease::Guarded::Finished(Err(failure)) => failure,
            lease::Guarded::Lost => lease_lost(),
        };
        // The host's retry takes these receipts over at once.
        receipts.release(lease::log_end(pg, &root).ok() == Some(began));
        Err(failure)
    }

    /// The part of a dispatch that claims and completes receipts. It runs under
    /// the family's lock and lease.
    async fn handle_event(
        &self,
        pg: &Sql<'_>,
        receipts: &lease::Receipts,
        input: Input,
        root: String,
        key: SessionKey,
        actor: Actor,
    ) -> napi::Result<Value> {
        if input.event == HookEventKind::SessionStart {
            let cipher = self.store.cipher().clone();
            return pg
                .with_client(move |client| {
                    let stored: Value = client
                        .query_one(
                            "SELECT start_decision FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                            &[&key.organization_id, &key.actor],
                        )?
                        .get(0);
                    cipher.open_json(&field_context(&["openappa_sessions", &key.organization_id, &key.actor, "start_decision"]), stored).map_err(Into::into)
                })
                .map_err(sql_failure);
        }
        if matches!(
            input.event,
            HookEventKind::ToolResult | HookEventKind::CancelCall
        ) {
            return self.result(pg, receipts, &input, &actor).await;
        }
        if input.event == HookEventKind::Remedy {
            let operation = remedy_operation(&input)?;
            let request = remedy_request(&input)?;
            let binding = remedy_binding(&input.caller_id);
            let result_key = input
                .tool_call_id
                .clone()
                .map(|tool_call_id| processed_result_key(&input, tool_call_id));
            if let Some(decision) = claim_operation(
                &self.store,
                receipts,
                &input,
                &root,
                &operation,
                &request,
                binding.clone(),
                None,
            )
            .await?
            {
                // The remedy's answer is saved. A dispatch stopped between its
                // two completions leaves the tracked result pending; it takes
                // exactly this answer, so finish that receipt from it now. A
                // result another live request is finishing is left to it.
                if let Some(result_key) = result_key {
                    let root = TrajectoryId::new(root.as_str());
                    if let ResultClaim::Work =
                        claim_result(&self.store, receipts, &result_key, &root).await?
                    {
                        let approved = decision_text(&decision)?;
                        self.store
                            .complete_processed_result(
                                result_key,
                                approved,
                                decision.clone(),
                                receipts.owner(),
                            )
                            .map_err(receipt_failure)?;
                    }
                }
                return Ok(decision);
            }
            if let Some(result_key) = &result_key {
                let root = TrajectoryId::new(root.as_str());
                if let ResultClaim::Complete(decision) =
                    claim_result(&self.store, receipts, result_key, &root).await?
                {
                    return Ok(decision);
                }
            }
            if let Some(refusal) = &input.precheck_refusal {
                // The host found the target call would fail even if approved,
                // so no human was asked. The runtime never sees this act: the
                // offer is neither vouched nor spent, and a corrected call
                // earns its own review.
                let response = runtime_refusal(refusal.clone())?;
                return finish_remedy(
                    &self.store,
                    receipts,
                    &input,
                    &operation,
                    binding,
                    result_key,
                    response,
                );
            }
            let args: ExecuteRemedyPlanArgs =
                serde_json::from_str(required_arguments(&input)?).map_err(invalid_input)?;
            let offer_id = args.offer_id.clone();
            let call = ProposedCall {
                tool: appa_runtime_api::CONTROL_TOOL.into(),
                arguments: input
                    .arguments
                    .clone()
                    .ok_or_else(|| invalid_input("missing remedy arguments"))?,
                cwd: None,
            };
            let ruling = input.ruling.as_ref().map(|r| match r {
                RulingInput::Approve => Ruling::Approve,
                RulingInput::Deny => Ruling::Deny,
            });
            let gate = hooks::handle(
                &self.runtime,
                HookEvent::ToolCall {
                    actor: actor.clone(),
                    call,
                    call_id: None,
                    spawn: None,
                    prompt: None,
                    ruling,
                },
            )
            .await;
            require_decision(&gate)?;
            if !matches!(gate, HookDecision::PassControl) {
                let text = match gate {
                    HookDecision::DenyCall { feedback, .. } => feedback,
                    HookDecision::Block { reason } => reason,
                    HookDecision::Refuse { detail, .. } => detail,
                    _ => return Err(invariant("unexpected remedy control decision")),
                };
                let response = runtime_refusal(text)?;
                return finish_remedy(
                    &self.store,
                    receipts,
                    &input,
                    &operation,
                    binding,
                    result_key,
                    response,
                );
            }
            // Before the runtime spends the offer. A missing row is empty
            // presentation, not an error, so an old call still redeems.
            let recorded = match offer_id.as_deref() {
                Some(offer_id) => recorded_call_presentation(
                    pg,
                    &input.organization_id,
                    &input.session_id,
                    offer_id,
                )?,
                // A return declared ahead of its spawn names no offer, so no call presented one.
                None => Default::default(),
            };
            let outcome = self
                .runtime
                .execute_embedded_remedy_with_options(&actor, args, presentation_options(&input))
                .await;
            let owner = OfferOwner {
                organization_id: input.organization_id.clone(),
                session_id: input.session_id.clone(),
                parent_id: input.parent_id.clone(),
                root: root.clone(),
                tool: recorded.tool,
                spelling: recorded.spelling,
                dispatch: recorded.dispatch,
            };
            let response = render_remedy_outcome(
                outcome,
                &RemedyAct {
                    owner: &owner,
                    offer_id: offer_id.as_deref().unwrap_or_default(),
                    ruling: input.ruling,
                },
            )?;
            return finish_remedy(
                &self.store,
                receipts,
                &input,
                &operation,
                binding,
                result_key,
                response,
            );
        }

        let operation = input
            .operation_id
            .clone()
            .ok_or_else(|| invalid_input("an operation id is required"))?;
        if input.event == HookEventKind::ToolCall {
            let call_id = operation.strip_prefix("call:").ok_or_else(|| {
                invalid_input("tool call operation_id must be call:<tool-call-id>")
            })?;
            if let Some(decision) = cancelled_call(pg, &input, call_id)? {
                return Ok(decision);
            }
        }
        let mut request = operation_semantic(&input);
        let context = (input.event == HookEventKind::ToolCall).then(|| tool_call_context(&input));
        if input.event == HookEventKind::ToolCall {
            // The receipt key is also the host call identity. Results reconstruct
            // the same namespace from the provider's tool-call ID.
            request["call_id"] = json!(operation);
        }
        if input.event == HookEventKind::ChildAddress {
            // Retained so the child's side can find what its parent addressed to it.
            request["spawned_id"] = json!(input.spawned_id);
        }
        // Reject host configuration and malformed reporting input before
        // claiming a durable operation. No effect has started yet, so these
        // refusals must not leave a pending receipt fencing the whole family.
        let report = if input.event == HookEventKind::Yell {
            let reporting = self
                .reporting
                .as_ref()
                .ok_or_else(|| invalid_input("OpenAPPA reporting is disabled"))?;
            let args: YellArguments =
                serde_json::from_str(required_arguments(&input)?).map_err(invalid_input)?;
            let endpoint = match &input.yell_receiver {
                Some(receiver) => receiver.endpoint()?,
                None => reporting.endpoint.clone(),
            };
            Some((reporting, args, endpoint))
        } else {
            None
        };
        if let Some(decision) = claim_operation(
            &self.store,
            receipts,
            &input,
            &root,
            &operation,
            &request,
            session_binding(&input),
            context,
        )
        .await?
        {
            return Ok(decision);
        }
        let decision = if let Some((reporting, args, endpoint)) = report {
            let result = appa_runtime::yell::embedded::send(
                &self.runtime,
                appa_runtime::yell::embedded::Request {
                    actor: actor.clone(),
                    harness: adapter::harness(),
                    endpoint,
                    hostname: reporting.hostname.clone(),
                    message: args.message,
                    with_trajectory: args.with_trajectory,
                },
            )
            .await;
            let (is_error, message) = match result {
                Ok(receipt) => (false, format!("[appa] Reported. Receipt {receipt}.")),
                Err(reason) => (true, format!("[appa] Not reported: {reason}")),
            };
            json!({ "decision": "mcp_result", "result": { "isError": is_error, "content": [{ "type": "text", "text": message }] } })
        } else if input.event == HookEventKind::ChildAddress {
            self.address_child(pg, &input, &actor).await?
        } else {
            let event = match input.event {
                HookEventKind::ToolCall => HookEvent::ToolCall {
                    actor: actor.clone(),
                    call: proposed(&input)?,
                    call_id: Some(operation.clone()),
                    spawn: input.spawn.then_some(SpawnKind::Single),
                    prompt: None,
                    ruling: None,
                },
                HookEventKind::Prompt => HookEvent::Prompt {
                    actor: actor.clone(),
                    text: String::new(),
                    settles: None,
                    peer: None,
                    title: None,
                },
                HookEventKind::TurnEnd => HookEvent::TurnEnd {
                    actor: actor.clone(),
                },
                HookEventKind::ChildTurnEnd => HookEvent::ChildTurnEnd {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| invalid_input("not a child session"))?,
                },
                HookEventKind::ChildEnd => HookEvent::ChildEnd {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| invalid_input("not a child session"))?,
                    value: input.output.clone(),
                },
                HookEventKind::ChildReturn => HookEvent::ChildReturn {
                    root: actor.root.clone(),
                    child: actor
                        .child
                        .clone()
                        .ok_or_else(|| invalid_input("not a child session"))?,
                    value: input
                        .output
                        .clone()
                        .ok_or_else(|| invalid_input("missing output"))?,
                },
                HookEventKind::SessionStart
                | HookEventKind::ToolResult
                | HookEventKind::CancelCall
                | HookEventKind::Remedy
                | HookEventKind::Yell
                | HookEventKind::ChildAddress => {
                    return Err(invalid_input("unsupported OpenAPPA event"));
                }
            };
            let outcome = hooks::handle_embedded_with_options(
                &self.runtime,
                event,
                presentation_options(&input),
            )
            .await;
            wire(&outcome.decision)?
        };
        finish_operation(
            &self.store,
            receipts,
            &input,
            &operation,
            &decision,
            session_binding(&input),
        )?;
        Ok(decision)
    }

    /// The sealed spawn binding on the parent's completed allow-call receipt, or the
    /// family's in-flight fork when the host named no spawn call. A supplied call id
    /// never falls back to in-flight: the engine has no call-id spawn reference, and
    /// the receipt's `spawn_binding` is the reference it minted.
    fn child_spawn_ref(&self, pg: &Sql<'_>, input: &Input) -> napi::Result<SpawnRef> {
        let binding = match input.spawn_call_id.as_deref() {
            Some(spawn_call_id) => {
                let parent = required(&input.parent_id, "parent_id")?;
                released_spawn_binding(pg, &input.organization_id, parent, spawn_call_id)?
            }
            None => None,
        };
        spawn_ref_from_receipt(input.spawn_call_id.as_deref(), binding).map_err(invariant)
    }

    /// The parent addresses a child it started, so the parent's current label flows into
    /// the child before the child reads the message. The runtime reads a start for a child
    /// it already bound as exactly this. A child that has not started yet is left to its
    /// first event, which takes the parent's label at that point (`addressed_before_start`).
    ///
    /// A started child is the `openappa_sessions` row for this organization whose
    /// `session_id` and `parent_id` are exactly the addressed session and this dispatcher.
    /// That row authorizes a runtime workspace id that does not use the native prefix.
    /// An unstarted native child still has to be named `{parent}:` plus a suffix. A prefix
    /// alone never selects a row: a grandchild or a same-prefix foreign session does not
    /// match `parent_id` and is not joined.
    ///
    /// ChildStart names this dispatcher's family root and the stored child actor, not the
    /// dispatcher's own child trajectory. The dispatch already holds the family lock.
    async fn address_child(
        &self,
        pg: &Sql<'_>,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let (parent, child_session) = (
            input.session_id.clone(),
            required(&input.spawned_id, "spawned_id")?.to_owned(),
        );
        let (lookup_org, lookup_parent, lookup_child) = (
            input.organization_id.clone(),
            parent.clone(),
            child_session.clone(),
        );
        let started = pg
            .with_client(move |client| {
                Ok(client
                    .query_opt(
                        "SELECT actor FROM openappa_sessions WHERE organization_id = $1 AND session_id = $2 AND parent_id = $3",
                        &[&lookup_org, &lookup_child, &lookup_parent],
                    )?
                    .map(|row| row.get::<_, String>(0)))
            })
            ?;
        let stored_actor = match classify_addressed_child(&parent, &child_session, started) {
            AddressedChild::Rebind(stored_actor) => stored_actor,
            AddressedChild::UnstartedNative => return Ok(json!({ "decision": "ack" })),
            AddressedChild::Foreign => {
                return Ok(json!({
                    "decision": "block",
                    "feedback": "OpenAPPA did not send this message: its recipient is not a child of this session.",
                }));
            }
        };
        let decision = hooks::handle(&self.runtime, rebind_child(&actor.root, stored_actor)).await;
        match decision {
            // The contract text is the child's to read at its own start, not the parent's.
            HookDecision::Ack | HookDecision::Context { .. } => Ok(json!({ "decision": "ack" })),
            other => wire(&other),
        }
    }

    async fn result(
        &self,
        pg: &Sql<'_>,
        receipts: &lease::Receipts,
        input: &Input,
        actor: &Actor,
    ) -> napi::Result<Value> {
        let call_id = required(&input.tool_call_id, "tool_call_id")?.to_owned();
        if let Some(withheld) = peer::forged_read_result(pg, input, &call_id)? {
            return Ok(withheld);
        }
        let key = processed_result_key(input, call_id.clone());
        // A recovered receipt is this same result, claimed by a dispatch that
        // stopped mid-processing. It is driven again and completed.
        if let ResultClaim::Complete(decision) =
            claim_result(&self.store, receipts, &key, &actor.root).await?
        {
            return Ok(decision);
        }
        let operation = operation_key(input, session_binding(input), format!("call:{call_id}"));
        let released = match read_operation_state(pg, &operation)? {
            OperationState::Complete(completed) => completed,
            OperationState::Pending {
                input: recorded,
                context,
            } => {
                // The call's own dispatch stopped after its claim: take its
                // receipt over once that dispatch's lease has expired. Re-drive
                // the recorded call — the runtime replays a committed decision
                // and decides one it never recorded — and complete its receipt,
                // so this result is processed against exactly the answer the
                // host was owed.
                if let Some(completed) = claim_operation(
                    &self.store,
                    receipts,
                    input,
                    &actor.root.0,
                    &operation.operation_id,
                    &recorded,
                    session_binding(input),
                    context.clone(),
                )
                .await?
                {
                    CompletedOperation {
                        input: recorded,
                        context,
                        decision: completed,
                    }
                } else {
                    self.recover_call(input, actor, receipts, &operation, recorded, context)
                        .await?
                }
            }
            OperationState::Absent => {
                // A fork replays the history of the session it forks: a result from before the
                // fork comes back as that session processed it, never as an unknown call.
                let response =
                    inherited_result(pg, input, &call_id)?.unwrap_or_else(unknown_result_response);
                let approved = decision_text(&response)?;
                self.store
                    .complete_processed_result(key, approved, response.clone(), receipts.owner())
                    .map_err(receipt_failure)?;
                return Ok(response);
            }
        };
        let allowed = matches!(
            released.decision.get("decision").and_then(Value::as_str),
            Some("allow_call" | "pass_control")
        );
        if !allowed {
            let response = authoritative_unexecuted_response(released.decision)?;
            let approved = decision_text(&response)?;
            self.store
                .complete_processed_result(key, approved, response.clone(), receipts.owner())
                .map_err(receipt_failure)?;
            return Ok(response);
        }
        let call = recorded_call(released.context, released.input)?;
        let cancelled = input.event == HookEventKind::CancelCall;
        let output = if cancelled {
            "OpenAPPA withheld the tool-call batch. This tool was not executed. Retry with a new tool-call ID.".to_owned()
        } else {
            input
                .output
                .clone()
                .ok_or_else(|| invalid_input("missing tool output"))?
        };
        let outcome = match (cancelled, input.outcome) {
            (true, _) => ToolOutcome::Failure {
                message: output.clone(),
            },
            (false, Some(ExecutionOutcome::Success)) => ToolOutcome::Success {
                body: OutcomeBody::Available(output.clone()),
            },
            (false, Some(ExecutionOutcome::Failure)) => ToolOutcome::Failure {
                message: output.clone(),
            },
            (false, Some(ExecutionOutcome::Unknown) | None) => ToolOutcome::Indeterminate,
        };
        let event = if call.spawn {
            // No child return is guessed from an opaque tool result. The child
            // must have reported ChildEnd through its adapter first.
            HookEvent::SpawnResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call)?,
                call_id: Some(format!("call:{call_id}")),
                outcome,
                child: input
                    .spawned_id
                    .as_deref()
                    .map(session_actor)
                    .map(TrajectoryId),
                value: input.spawned_id.as_ref().and_then(|_| input.output.clone()),
            }
        } else {
            HookEvent::ToolResult {
                actor: actor.clone(),
                call: proposed_recorded_call(&call)?,
                call_id: Some(format!("call:{call_id}")),
                outcome,
            }
        };
        let outcome = hooks::handle_embedded_with_options(
            &self.runtime,
            event,
            result_presentation_options(input, &call),
        )
        .await;
        let decision = outcome.decision;
        if cancelled && !matches!(decision, HookDecision::Ack) {
            return Err(invariant("OpenAPPA could not settle a withheld tool call"));
        }
        let approved = match &decision {
            HookDecision::Ack
                if !cancelled
                    && matches!(input.outcome, Some(ExecutionOutcome::Unknown) | None) =>
            {
                "[appa] Tool output withheld: execution outcome is unknown.".into()
            }
            HookDecision::Ack => output,
            HookDecision::DeliverValue { value } | HookDecision::ChildReturn { value } => {
                value.clone()
            }
            HookDecision::ReplaceOutput { output } => output.clone(),
            HookDecision::Block { reason } => {
                format!("[appa] Tool output withheld: {reason}")
            }
            HookDecision::Refuse { class, detail } => {
                return Err(failure(
                    Failure::Refused(*class),
                    format!("OpenAPPA result refused: {detail}"),
                ));
            }
            _ => return Err(invariant("unexpected tool result decision")),
        };
        let mut response = if cancelled {
            // Never replay an admission for a dispatch we have closed without
            // execution. The processed-result receipt closes this exact call.
            let refusal = json!({ "decision": "deny_call", "feedback": approved });
            refusal
        } else {
            with_presentation_offers(wire(&decision)?, outcome.presentation.as_ref())?
        };
        let output_source = if cancelled {
            OutputSource::Runtime
        } else {
            match decision {
                HookDecision::Ack
                | HookDecision::DeliverValue { .. }
                | HookDecision::ChildReturn { .. } => OutputSource::Tool,
                HookDecision::ReplaceOutput { .. }
                | HookDecision::Block { .. }
                | HookDecision::Refuse { .. } => OutputSource::Runtime,
                _ => return Err(invariant("unexpected tool result decision")),
            }
        };
        response = with_approved_output(&response, approved.clone(), output_source)?;
        if cancelled {
            let operation = cancellation_operation(&call_id);
            let request = json!({ "event": "cancel_call", "tool_call_id": call_id });
            if let Some(saved) = claim_operation(
                &self.store,
                receipts,
                input,
                &actor.root.0,
                &operation,
                &request,
                session_binding(input),
                None,
            )
            .await?
            {
                response = saved;
            } else {
                finish_operation(
                    &self.store,
                    receipts,
                    input,
                    &operation,
                    &response,
                    session_binding(input),
                )?;
            }
        }
        let approved = stored_approved_output(&decision_text(&response)?, &response);
        self.store
            .complete_processed_result(key, approved, response.clone(), receipts.owner())
            .map_err(receipt_failure)?;
        Ok(response)
    }

    /// Re-drives a call whose receipt an interrupted dispatch left pending,
    /// then completes that receipt with the answer. The runtime replays a
    /// decision it committed and decides afresh one it never recorded, so the
    /// completed receipt holds exactly the answer the first dispatch owed.
    async fn recover_call(
        &self,
        input: &Input,
        actor: &Actor,
        receipts: &lease::Receipts,
        operation: &OperationKey,
        recorded: Value,
        context: Option<Value>,
    ) -> napi::Result<CompletedOperation> {
        let call = recorded_call(context.clone(), recorded.clone())?;
        let event = HookEvent::ToolCall {
            actor: actor.clone(),
            call: proposed_recorded_call(&call)?,
            call_id: Some(operation.operation_id.clone()),
            spawn: call.spawn.then_some(SpawnKind::Single),
            prompt: None,
            ruling: None,
        };
        let outcome = hooks::handle_embedded_with_options(
            &self.runtime,
            event,
            result_presentation_options(input, &call),
        )
        .await;
        let decision = wire(&outcome.decision)?;
        self.store
            .complete_operation(operation.clone(), decision.clone(), receipts.owner())
            .map_err(receipt_failure)?;
        Ok(CompletedOperation {
            input: recorded,
            context,
            decision,
        })
    }
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/// Cumulative embedded engine samples for the host's existing Prometheus endpoint.
#[napi(js_name = "collectOpenappaMetrics")]
pub fn collect_openappa_metrics() -> napi::Result<String> {
    metrics::collect().map_err(|_| napi::Error::from_reason("OpenAPPA metric collection failed"))
}
// SPDX-SnippetEnd
