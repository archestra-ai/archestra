//! Thin NAPI adapter over `router_core`. JSON strings in and out keep the TS↔Rust
//! contract on the core's serde types; the backend owns the matching zod schemas.
//! Errors and panics cross the boundary as a `{ code, message }` JSON body.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use router_core::{Plan, PlanInput, Policy, RouterError, SessionFeatures};

struct BoundaryError {
    code: &'static str,
    message: String,
}

impl BoundaryError {
    fn parse(code: &'static str, what: &str, error: serde_json::Error) -> Self {
        Self {
            code,
            message: format!("invalid {what} JSON: {error}"),
        }
    }

    fn internal(message: String) -> Self {
        Self {
            code: "ARCHESTRA_INTERNAL",
            message,
        }
    }
}

impl From<RouterError> for BoundaryError {
    fn from(error: RouterError) -> Self {
        let code = match &error {
            RouterError::InvalidPrice(_)
            | RouterError::InvalidBudget(_)
            | RouterError::InvalidVolume(_)
            | RouterError::InvalidProbability(_)
            | RouterError::InvalidWeight(_)
            | RouterError::InvalidTierNeeded(_)
            | RouterError::EmptyModelId
            | RouterError::LongContextThresholdMismatch => "ARCHESTRA_ROUTER_INVALID_INPUT",
            RouterError::EmptyHistory | RouterError::EmptyTokenHistory => {
                "ARCHESTRA_ROUTER_EMPTY_HISTORY"
            }
            RouterError::BaselineSourceMissing(_) => "ARCHESTRA_ROUTER_BASELINE_SOURCE_MISSING",
            RouterError::NotConverged { .. }
            | RouterError::SingularSizeModel
            | RouterError::SingularLongShare => "ARCHESTRA_ROUTER_FIT_FAILED",
            RouterError::Infeasible { .. } => "ARCHESTRA_ROUTER_INFEASIBLE",
            RouterError::UnsupportedPlanFormat { .. } => "ARCHESTRA_ROUTER_UNSUPPORTED_PLAN_FORMAT",
            RouterError::NonFinitePlan(_) | RouterError::NonFiniteEstimate(_) => {
                "ARCHESTRA_ROUTER_INVALID_PLAN"
            }
            RouterError::InvalidUniform(_) => "ARCHESTRA_ROUTER_INVALID_UNIFORM",
            RouterError::InvalidPolicy { .. } => "ARCHESTRA_ROUTER_INVALID_POLICY",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<BoundaryError> for napi::Error {
    fn from(error: BoundaryError) -> Self {
        let body = serde_json::json!({ "code": error.code, "message": error.message });
        napi::Error::new(napi::Status::GenericFailure, body.to_string())
    }
}

fn plan_json(input_json: &str) -> Result<String, BoundaryError> {
    let input: PlanInput = serde_json::from_str(input_json)
        .map_err(|e| BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_INPUT", "plan input", e))?;
    let plan = router_core::plan(input)?;
    serde_json::to_string(&plan).map_err(|e| BoundaryError::internal(e.to_string()))
}

fn decide_json(
    plan_json: &str,
    policy_json: &str,
    features_json: &str,
    u: f64,
) -> Result<String, BoundaryError> {
    let plan: Plan = serde_json::from_str(plan_json)
        .map_err(|e| BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_PLAN", "plan", e))?;
    let policy: Policy = serde_json::from_str(policy_json)
        .map_err(|e| BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_POLICY", "policy", e))?;
    let features: SessionFeatures = serde_json::from_str(features_json).map_err(|e| {
        BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_INPUT", "session features", e)
    })?;
    let decision = router_core::decide(&plan, &policy, &features, u)?;
    serde_json::to_string(&decision).map_err(|e| BoundaryError::internal(e.to_string()))
}

fn assess_json(plan_json: &str, features_json: &str) -> Result<String, BoundaryError> {
    let plan: Plan = serde_json::from_str(plan_json)
        .map_err(|e| BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_PLAN", "plan", e))?;
    let features: Vec<SessionFeatures> = serde_json::from_str(features_json).map_err(|e| {
        BoundaryError::parse("ARCHESTRA_ROUTER_INVALID_INPUT", "session features", e)
    })?;
    let assessed = router_core::assess(&plan, &features)?;
    serde_json::to_string(&assessed).map_err(|e| BoundaryError::internal(e.to_string()))
}

/// Fits and solves one plan on the libuv threadpool; the input string is owned, so
/// `compute` touches no JS handle.
pub struct PlanTask {
    input_json: String,
}

impl Task for PlanTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        guarded(|| plan_json(&self.input_json))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Fit the session-size and long-share models on a `PlanInput` JSON and solve the
/// daily-budget LP off the JS thread. Resolves to the `Plan` JSON consumed by `decide`.
#[napi(ts_return_type = "Promise<string>")]
pub fn plan(input_json: String) -> AsyncTask<PlanTask> {
    AsyncTask::new(PlanTask { input_json })
}

/// Route one session (`SessionFeatures` JSON) with a `Plan` JSON and a `{ lam_star, q }`
/// policy JSON — the plan's own `policy` or a paced one. `u` must be uniform on [0, 1),
/// drawn once per session. Returns `{ tier_index, propensity, lambda, expected_cost_usd }` JSON.
#[napi]
pub fn decide(
    plan_json: String,
    policy_json: String,
    features_json: String,
    u: f64,
) -> napi::Result<String> {
    guarded(|| decide_json(&plan_json, &policy_json, &features_json, u))
}

/// Diagnostics for many sessions (`SessionFeatures[]` JSON) under a `Plan` JSON and its own
/// policy: per session `{ predicted_tokens, usd_per_token, base_tier, tie_tier }` JSON, routed
/// exactly as `decide` (the tie tier is taken when u < q).
#[napi]
pub fn assess(plan_json: String, features_json: String) -> napi::Result<String> {
    guarded(|| assess_json(&plan_json, &features_json))
}

/// The `router_core` version that `plan` stamps on plans.
#[napi]
pub fn core_version() -> String {
    router_core::CORE_VERSION.to_owned()
}

/// The plan format `plan` produces and `decide` accepts.
#[napi]
pub fn plan_format_version() -> u32 {
    router_core::PLAN_FORMAT_VERSION
}

fn guarded(f: impl FnOnce() -> Result<String, BoundaryError>) -> napi::Result<String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from),
        Err(payload) => Err(BoundaryError::internal(format!(
            "rust panic: {}",
            panic_payload_message(payload.as_ref())
        ))
        .into()),
    }
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return s;
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.as_str();
    }
    "unknown panic payload"
}
