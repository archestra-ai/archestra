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
use crate::{ArtifactBytes, CommandExecution, Result, SandboxError};

pub(crate) const CHANNEL_CAPACITY: usize = 64;
// Rust-side cap on concurrent backend handlers. Defense in depth — the TS
// adapter caps its own queue at a smaller value, but if any other caller ever
// reaches the NAPI surface directly we still want the engine protected.
const MAX_CONCURRENT_HANDLERS: usize = 32;

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

pub(crate) struct SessionHandle {
    tx: mpsc::Sender<SessionMsg>,
}

impl SessionHandle {
    pub(crate) fn new(tx: mpsc::Sender<SessionMsg>) -> Self {
        Self { tx }
    }

    async fn send(&self, msg: SessionMsg) -> Result<()> {
        self.tx.send(msg).await.map_err(|_| {
            SandboxError::EngineUnreachable("the sandbox session is not running".to_string())
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
            })
        })
        .await;

    // pick up either the live handle or a shared in-flight spawn; release the
    // lock before awaiting so concurrent callers don't block on each other.
    let spawn_fut = {
        let mut guard = slot.lock().await;
        if let Some(handle) = guard.handle.as_ref() {
            if handle.is_open() {
                return Ok(handle.clone());
            }
            guard.handle = None;
        }
        if let Some(s) = guard.spawning.clone() {
            s
        } else {
            // the one hardcoded backend-selection point.
            let fut: BoxFuture<'static, Result<Arc<SessionHandle>>> =
                crate::backends::dagger::spawn().boxed();
            let shared = fut.shared();
            guard.spawning = Some(shared.clone());
            shared
        }
    };

    let result = spawn_fut.await;

    let mut guard = slot.lock().await;
    guard.spawning = None;
    if let Ok(handle) = &result {
        guard.handle = Some(handle.clone());
    }
    result
}

/// submit a request and await the reply.
pub(crate) async fn submit<T, F>(build: F) -> Result<T>
where
    F: FnOnce(oneshot::Sender<Result<T>>) -> SessionMsg,
{
    let (reply_tx, reply_rx) = oneshot::channel();
    let handle = current().await?;
    handle.send(build(reply_tx)).await?;
    reply_rx.await.map_err(|_| {
        SandboxError::internal("the sandbox session dropped a request before replying")
    })?
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
