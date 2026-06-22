//! the backend-agnostic actor. owns the process-singleton session handle, the
//! request channel, concurrency back-pressure, and panic recovery. it dispatches
//! every message to a `Backend` without knowing which runtime backs it; the
//! Dagger-specific connect/warm/materialise logic lives in `crate::backends`.

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use tokio::sync::{Mutex, OnceCell, Semaphore, mpsc, oneshot};

use crate::backend::{ArtifactRequest, Backend, RunRequest};
use crate::{ArtifactBytes, CommandExecution, EngineFault, Result, SandboxError};

pub(crate) const CHANNEL_CAPACITY: usize = 64;
// Rust-side cap on concurrent backend handlers. Defense in depth — the TS
// adapter caps its own queue at a smaller value, but if any other caller ever
// reaches the NAPI surface directly we still want the engine protected.
const MAX_CONCURRENT_HANDLERS: usize = 32;
const MAX_SUBMIT_ATTEMPTS: usize = 2;

pub(crate) enum SessionMsg {
    Run {
        req: RunRequest,
        reply: oneshot::Sender<Result<CommandExecution>>,
    },
    ReadArtifact {
        req: ArtifactRequest,
        reply: oneshot::Sender<Result<ArtifactBytes>>,
    },
    CheckSession {
        traceparent: Option<String>,
        reply: oneshot::Sender<Result<()>>,
    },
}

impl SessionMsg {
    fn operation(&self) -> SessionOperation {
        match self {
            SessionMsg::Run { .. } => SessionOperation::Run,
            SessionMsg::ReadArtifact { .. } => SessionOperation::ReadArtifact,
            SessionMsg::CheckSession { .. } => SessionOperation::CheckSession,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionOperation {
    Run,
    ReadArtifact,
    CheckSession,
}

impl SessionOperation {
    fn as_str(self) -> &'static str {
        match self {
            SessionOperation::Run => "run",
            SessionOperation::ReadArtifact => "read_artifact",
            SessionOperation::CheckSession => "check_session",
        }
    }
}

/// label for retry logs, covering the pre-send acquisition failure where the
/// operation isn't known yet.
fn operation_label(operation: Option<SessionOperation>) -> &'static str {
    operation.map_or("unknown", SessionOperation::as_str)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RetryReason {
    SessionAcquisition,
    ClosedSession,
    StaleAttachables,
    ReadOnlyEngineError,
}

impl RetryReason {
    fn as_str(self) -> &'static str {
        match self {
            RetryReason::SessionAcquisition => "session_acquisition",
            RetryReason::ClosedSession => "closed_session",
            RetryReason::StaleAttachables => "stale_attachables",
            RetryReason::ReadOnlyEngineError => "read_only_engine_error",
        }
    }
}

pub(crate) struct SessionHandle {
    tx: mpsc::Sender<SessionMsg>,
}

impl SessionHandle {
    pub(crate) fn new(tx: mpsc::Sender<SessionMsg>) -> Self {
        Self { tx }
    }

    async fn send(&self, msg: SessionMsg) -> Result<()> {
        self.tx
            .send(msg)
            .await
            .map_err(|_| SandboxError::EngineUnreachable {
                message: "the sandbox session is not running".to_string(),
                fault: EngineFault::Unreachable,
            })
    }

    fn is_open(&self) -> bool {
        !self.tx.is_closed()
    }
}

type SharedSpawn = Shared<BoxFuture<'static, Result<Arc<SessionHandle>>>>;

struct Slot {
    handle: Option<Arc<SessionHandle>>,
    /// the in-flight spawn future, shared so concurrent callers all await the
    /// same connect attempt instead of serially retrying after a 60s timeout.
    spawning: Option<SharedSpawn>,
    /// session lineage counter, bumped on every invalidation. a spawn captures it
    /// before awaiting and installs its result only if it is still current, so a
    /// late waiter cannot resurrect a session another caller already retired.
    generation: u64,
}

static HANDLE_SLOT: OnceCell<Mutex<Slot>> = OnceCell::const_new();

/// returns a live handle, spawning the actor on first call or after a previous
/// session torn down (engine restart, panic in the connect closure).
async fn current() -> Result<Arc<SessionHandle>> {
    let slot = HANDLE_SLOT
        .get_or_init(|| async {
            Mutex::new(Slot {
                handle: None,
                spawning: None,
                generation: 0,
            })
        })
        .await;

    // pick up either the live handle or a shared in-flight spawn; release the
    // lock before awaiting so concurrent callers don't block on each other.
    // capture the generation so the post-await install can detect a concurrent
    // invalidation that retired this spawn's lineage.
    let (spawn_fut, generation) = {
        let mut guard = slot.lock().await;
        if let Some(handle) = guard.handle.as_ref() {
            if handle.is_open() {
                return Ok(handle.clone());
            }
            guard.handle = None;
        }
        let fut = if let Some(s) = guard.spawning.clone() {
            s
        } else {
            // the one hardcoded backend-selection point.
            let fut: BoxFuture<'static, Result<Arc<SessionHandle>>> =
                crate::backends::dagger::spawn().boxed();
            let shared = fut.shared();
            guard.spawning = Some(shared.clone());
            shared
        };
        (fut, guard.generation)
    };

    let result = spawn_fut.await;

    let mut guard = slot.lock().await;
    finish_spawn(&mut guard, generation, result.as_ref().ok());
    result
}

/// install a freshly spawned handle, unless a concurrent invalidation advanced
/// the generation while we awaited — in that case the spawn belongs to a retired
/// lineage, so its handle is dropped and the slot is left for the new lineage.
fn finish_spawn(slot: &mut Slot, started_generation: u64, handle: Option<&Arc<SessionHandle>>) {
    if slot.generation != started_generation {
        return;
    }
    slot.spawning = None;
    if let Some(handle) = handle {
        slot.handle = Some(handle.clone());
    }
}

/// submit a request and await the reply.
pub(crate) async fn submit<T, F>(build: F) -> Result<T>
where
    F: FnMut(oneshot::Sender<Result<T>>) -> SessionMsg,
{
    submit_with_attempts(build, MAX_SUBMIT_ATTEMPTS).await
}

async fn submit_with_attempts<T, F>(mut build: F, max_attempts: usize) -> Result<T>
where
    F: FnMut(oneshot::Sender<Result<T>>) -> SessionMsg,
{
    for attempt in 1..=max_attempts {
        match attempt_once(&mut build).await {
            Attempt::Done(result) => {
                if attempt > 1 && result.is_ok() {
                    tracing::info!(attempt, "sandbox request recovered on a fresh session");
                }
                return result;
            }
            // last attempt exhausted: surface the failure that triggered the retry.
            Attempt::Retry {
                reason,
                err,
                operation,
            } if attempt == max_attempts => {
                tracing::warn!(
                    attempt,
                    max_attempts,
                    reason = reason.as_str(),
                    operation = operation_label(operation),
                    error_code = err.code(),
                    error = %err,
                    "sandbox request failed; retries exhausted"
                );
                return Err(err);
            }
            Attempt::Retry {
                reason,
                err,
                operation,
            } => log_retry(attempt, max_attempts, reason, operation, &err),
        }
    }
    unreachable!("max_attempts is at least 1, so the loop always returns")
}

/// the outcome of a single submit attempt: either a terminal result to return as
/// is, or a retryable failure tagged with why a fresh session might recover it
/// and which operation was in flight (absent before the request is built).
enum Attempt<T> {
    Done(Result<T>),
    Retry {
        reason: RetryReason,
        err: SandboxError,
        operation: Option<SessionOperation>,
    },
}

/// run one acquire -> send -> await-reply cycle. each failure stage classifies
/// itself as retryable or terminal; the caller owns the attempt bound and logging.
async fn attempt_once<T, F>(build: &mut F) -> Attempt<T>
where
    F: FnMut(oneshot::Sender<Result<T>>) -> SessionMsg,
{
    let (reply_tx, reply_rx) = oneshot::channel();
    let handle = match current().await {
        Ok(handle) => handle,
        // the request never left, so a fresh acquire is always side-effect-free.
        Err(err) if is_engine_unreachable(&err) => {
            return Attempt::Retry {
                reason: RetryReason::SessionAcquisition,
                err,
                operation: None,
            };
        }
        Err(err) => return Attempt::Done(Err(err)),
    };

    let msg = build(reply_tx);
    let operation = msg.operation();
    if let Err(err) = handle.send(msg).await {
        // the actor closed before accepting the message: drop it and retry fresh.
        invalidate_current(&handle, &err).await;
        return Attempt::Retry {
            reason: RetryReason::ClosedSession,
            err,
            operation: Some(operation),
        };
    }

    let result = match reply_rx.await {
        Ok(result) => result,
        Err(_) => {
            return Attempt::Done(Err(SandboxError::internal(
                "the sandbox session dropped a request before replying",
            )));
        }
    };
    match result {
        Ok(value) => Attempt::Done(Ok(value)),
        Err(err) => {
            invalidate_current_on_engine_error(&handle, &err).await;
            match retry_reason(operation, &err) {
                Some(reason) => Attempt::Retry {
                    reason,
                    err,
                    operation: Some(operation),
                },
                None => Attempt::Done(Err(err)),
            }
        }
    }
}

fn retry_reason(operation: SessionOperation, err: &SandboxError) -> Option<RetryReason> {
    // stale attachables means the engine gave up before serving the query, so
    // nothing ran — safe to retry for any operation, command execution included.
    if is_stale_attachables_error(err) {
        return Some(RetryReason::StaleAttachables);
    }
    // a generic engine error is ambiguous about whether work executed. only
    // check_session is side-effect-free; read_artifact replays the recorded
    // command log before exporting, so a broad retry could re-run commands that
    // may have already partially executed. run never gets a broad retry either.
    match (operation, err) {
        (SessionOperation::CheckSession, SandboxError::EngineUnreachable { .. }) => {
            Some(RetryReason::ReadOnlyEngineError)
        }
        _ => None,
    }
}

fn log_retry(
    attempt: usize,
    max_attempts: usize,
    reason: RetryReason,
    operation: Option<SessionOperation>,
    err: &SandboxError,
) {
    tracing::warn!(
        attempt,
        max_attempts,
        reason = reason.as_str(),
        operation = operation_label(operation),
        error_code = err.code(),
        error = %err,
        "retrying sandbox request on a fresh session"
    );
}

async fn invalidate_current_on_engine_error(handle: &Arc<SessionHandle>, err: &SandboxError) {
    if let SandboxError::EngineUnreachable { .. } = err {
        invalidate_current(handle, err).await;
    }
}

async fn invalidate_current(handle: &Arc<SessionHandle>, err: &SandboxError) {
    let Some(slot) = HANDLE_SLOT.get() else {
        return;
    };
    let mut guard = slot.lock().await;
    if clear_if_current(&mut guard, handle) {
        tracing::warn!(error_code = err.code(), error = %err, "dropping stale sandbox session");
    }
}

fn clear_if_current(slot: &mut Slot, handle: &Arc<SessionHandle>) -> bool {
    match slot.handle.as_ref() {
        Some(current) if Arc::ptr_eq(current, handle) => {
            slot.handle = None;
            // advance the lineage so an in-flight spawn waiter can't re-store this
            // handle after we've retired it.
            slot.generation = slot.generation.wrapping_add(1);
            true
        }
        _ => false,
    }
}

fn is_stale_attachables_error(err: &SandboxError) -> bool {
    matches!(
        err,
        SandboxError::EngineUnreachable {
            fault: EngineFault::StaleAttachables,
            ..
        }
    )
}

fn is_engine_unreachable(err: &SandboxError) -> bool {
    matches!(err, SandboxError::EngineUnreachable { .. })
}

/// drive the actor loop over `backend` until the request channel closes. called
/// by a backend's `spawn` for the lifetime of its underlying connection.
pub(crate) async fn run_loop(backend: Arc<Backend>, mut rx: mpsc::Receiver<SessionMsg>) {
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_HANDLERS));
    // kick warmup off in the background so it overlaps with the first request.
    // this runs detached and shared across callers, so its `warm_base.build`
    // span has no caller traceparent and lands as its own root trace rather than
    // nested under whichever request triggered the cold start.
    {
        let backend = backend.clone();
        tokio::spawn(async move {
            backend.prewarm().await;
        });
    }
    while let Some(msg) = rx.recv().await {
        // back-pressure: hold the recv loop until a permit is available, so we
        // never spawn more than MAX_CONCURRENT_HANDLERS tasks against the
        // backend. a failed try_acquire means the handler pool is saturated —
        // the one back-pressure signal worth surfacing for capacity tuning.
        let permit = match permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                tracing::debug!(
                    max = MAX_CONCURRENT_HANDLERS,
                    "sandbox handler pool saturated; waiting for a permit"
                );
                match permits.clone().acquire_owned().await {
                    Ok(permit) => permit,
                    // the semaphore lives as long as this loop and is never
                    // closed; an error means it was dropped out from under us,
                    // so stop accepting work and let the session tear down.
                    Err(_) => break,
                }
            }
        };
        let backend = backend.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handle(backend, msg).await;
        });
    }
}

async fn handle(backend: Arc<Backend>, msg: SessionMsg) {
    match msg {
        SessionMsg::Run { req, reply } => {
            let result = catch_panic(backend.run(req)).await;
            let _ = reply.send(result);
        }
        SessionMsg::ReadArtifact { req, reply } => {
            let result = catch_panic(backend.read_artifact(req)).await;
            let _ = reply.send(result);
        }
        SessionMsg::CheckSession { traceparent, reply } => {
            let result = catch_panic(backend.check_session(traceparent)).await;
            let _ = reply.send(result);
        }
    }
}

async fn catch_panic<T, Fut>(fut: Fut) -> Result<T>
where
    Fut: std::future::Future<Output = Result<T>>,
{
    AssertUnwindSafe(fut)
        .catch_unwind()
        .await
        .unwrap_or_else(|payload| {
            let message = panic_message(payload.as_ref());
            tracing::error!(panic = message, "recovered a panic in a sandbox handler");
            Err(SandboxError::Internal(format!("rust panic: {message}")))
        })
}

fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return s;
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.as_str();
    }
    "unknown panic payload"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_handle() -> Arc<SessionHandle> {
        let (tx, _rx) = mpsc::channel(1);
        Arc::new(SessionHandle::new(tx))
    }

    #[test]
    fn clear_if_current_only_removes_matching_handle() {
        let first = make_handle();
        let second = make_handle();
        let mut slot = Slot {
            handle: Some(first.clone()),
            spawning: None,
            generation: 0,
        };

        assert!(!clear_if_current(&mut slot, &second));
        assert_eq!(slot.generation, 0, "a no-op clear must not advance lineage");
        assert!(
            slot.handle
                .as_ref()
                .is_some_and(|handle| Arc::ptr_eq(handle, &first))
        );

        assert!(clear_if_current(&mut slot, &first));
        assert!(slot.handle.is_none());
        assert_eq!(slot.generation, 1, "retiring a handle must advance lineage");
    }

    #[test]
    fn finish_spawn_drops_handle_when_generation_advanced() {
        let handle = make_handle();
        let mut slot = Slot {
            handle: None,
            spawning: None,
            generation: 0,
        };
        let started = slot.generation;
        // a concurrent invalidation retired this lineage while we awaited the spawn.
        slot.generation = slot.generation.wrapping_add(1);

        finish_spawn(&mut slot, started, Some(&handle));
        assert!(
            slot.handle.is_none(),
            "a retired spawn must not resurrect its handle"
        );
    }

    #[test]
    fn finish_spawn_installs_handle_for_current_generation() {
        let handle = make_handle();
        let mut slot = Slot {
            handle: None,
            spawning: None,
            generation: 7,
        };

        finish_spawn(&mut slot, 7, Some(&handle));
        assert!(
            slot.handle
                .as_ref()
                .is_some_and(|installed| Arc::ptr_eq(installed, &handle))
        );
    }

    fn engine_error(fault: EngineFault) -> SandboxError {
        SandboxError::EngineUnreachable {
            message: "engine boom".to_string(),
            fault,
        }
    }

    #[test]
    fn is_stale_attachables_error_keys_off_the_fault() {
        assert!(is_stale_attachables_error(&engine_error(
            EngineFault::StaleAttachables
        )));
        assert!(!is_stale_attachables_error(&engine_error(
            EngineFault::Unreachable
        )));
        // a non-engine error never qualifies, regardless of its message.
        assert!(!is_stale_attachables_error(&SandboxError::Internal(
            "waiting for client session attachables".to_string(),
        )));
    }

    #[test]
    fn generic_engine_retry_is_limited_to_check_session() {
        let err = engine_error(EngineFault::Unreachable);

        assert_eq!(
            retry_reason(SessionOperation::CheckSession, &err),
            Some(RetryReason::ReadOnlyEngineError),
        );
        // read_artifact replays the command log before exporting, so a generic
        // engine error (which may have run some of that history) is not retried.
        assert_eq!(retry_reason(SessionOperation::ReadArtifact, &err), None);
        assert_eq!(retry_reason(SessionOperation::Run, &err), None);
    }

    #[test]
    fn stale_attachables_retry_applies_to_every_operation() {
        let err = engine_error(EngineFault::StaleAttachables);

        // nothing executed, so the command-running and replay paths can retry too.
        assert_eq!(
            retry_reason(SessionOperation::Run, &err),
            Some(RetryReason::StaleAttachables),
        );
        assert_eq!(
            retry_reason(SessionOperation::ReadArtifact, &err),
            Some(RetryReason::StaleAttachables),
        );
        assert_eq!(
            retry_reason(SessionOperation::CheckSession, &err),
            Some(RetryReason::StaleAttachables),
        );
    }
}
