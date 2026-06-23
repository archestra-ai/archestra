//! the backend boundary. `SandboxBackend` is the contract a sandbox runtime
//! must satisfy; `Backend` is the concrete, closed set of wired runtimes the
//! actor dispatches over. selection is static (an enum match), never `dyn` — a
//! second backend slots in by adding a variant, and the compiler then forces
//! every match site to handle it.

use crate::backends::dagger::DaggerBackend;
use crate::{ArtifactBytes, CommandExecution, EngineFault, Limits, ReplayStep, Result};

/// a materialise-and-run request handed to a backend. validated at the public
/// core entry points before it reaches here. skill files and PYTHONPATH are no
/// longer passed separately — they ride in `replay_steps` as `SkillMount`
/// events, applied (and PYTHONPATH extended) at their sequence point.
#[derive(Clone)]
pub(crate) struct RunRequest {
    pub replay_steps: Vec<ReplayStep>,
    pub limits: Limits,
    pub command: String,
    pub cwd: String,
    pub timeout_seconds: u32,
    pub traceparent: Option<String>,
}

/// an artifact-read request. the backend replays history, then exports `path`.
#[derive(Clone)]
pub(crate) struct ArtifactRequest {
    pub replay_steps: Vec<ReplayStep>,
    pub limits: Limits,
    pub path: String,
    pub default_cwd: String,
    pub traceparent: Option<String>,
}

/// the behaviour every sandbox backend provides. used only via the concrete
/// `Backend` enum (static dispatch), so the `async_fn_in_trait` auto-trait
/// caveat — that callers can't add bounds to the returned future — does not
/// apply here.
#[allow(async_fn_in_trait)]
pub(crate) trait SandboxBackend: Send + Sync + 'static {
    async fn run(&self, req: RunRequest) -> Result<CommandExecution>;
    async fn read_artifact(&self, req: ArtifactRequest) -> Result<ArtifactBytes>;
    /// `traceparent` parents the check span under the caller's trace, matching
    /// the run/read paths where it travels inside the request struct.
    async fn check_session(&self, traceparent: Option<String>) -> Result<()>;
    /// best-effort background warm-up so the first real request is fast; errors
    /// are swallowed by the caller and surfaced on the next real request.
    async fn prewarm(&self);
}

/// the closed set of wired backends. one variant today; selection happens once
/// at session spawn (see `crate::backends::dagger::spawn`).
pub(crate) enum Backend {
    Dagger(DaggerBackend),
}

impl Backend {
    pub(crate) async fn run(&self, req: RunRequest) -> Result<CommandExecution> {
        match self {
            Backend::Dagger(b) => b.run(req).await,
        }
    }

    pub(crate) async fn read_artifact(&self, req: ArtifactRequest) -> Result<ArtifactBytes> {
        match self {
            Backend::Dagger(b) => b.read_artifact(req).await,
        }
    }

    pub(crate) async fn check_session(&self, traceparent: Option<String>) -> Result<()> {
        match self {
            Backend::Dagger(b) => b.check_session(traceparent).await,
        }
    }

    pub(crate) async fn prewarm(&self) {
        match self {
            Backend::Dagger(b) => b.prewarm().await,
        }
    }

    /// recover an engine fault from a handler panic payload. some backends (the
    /// Dagger SDK) `unwrap()` transient engine errors deep in generated code, so
    /// the failure escapes as a panic rather than a typed error; this lets the
    /// backend-agnostic session layer re-tag the known-recoverable ones onto the
    /// retry path without naming a concrete runtime.
    pub(crate) fn engine_fault_from_panic(&self, message: &str) -> Option<EngineFault> {
        match self {
            Backend::Dagger(_) => crate::backends::dagger::engine_fault_from_panic(message),
        }
    }
}
