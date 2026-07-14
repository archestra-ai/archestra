//! The policy engine: evaluate one requested flow against exactly the values
//! it depends on.
//!
//! Audience and trust requirements are checked against
//! `L_flow = combine(L_args, L_control)` — the fold of the values rendered
//! into the request plus the values that *selected* it — never against the
//! whole trajectory. Effects are checked against the trajectory's monotone
//! past. A raw value elsewhere in the conversation does not taint an
//! unrelated sink, but it still taints any action whose data or control
//! provenance depends on it.
//!
//! The remedy machinery lives here too: a blocked flow enumerates typed
//! remedy plans (transform, constrain, endorse, accept, waive/acknowledge),
//! grant-bearing steps (waive, accept, endorse) are competence-routed to an
//! authority while transforms and constraints execute their registered
//! implementations directly; every applied step is audited and
//! rechecked fail-closed. An escalation nothing can clear is an explicit
//! terminal block.
//!
//! ```
//! use baton_core::engine::{
//!     BlockReason, Blocked, CanonicalRequest, Decision, DispatchReceipt, DuplicateContract, EngineId,
//!     ExecutionToken, PolicyEngine, RejectedToken, ResponseDecision, ResponsePolicy, StepCapability, StepOutcome,
//!     StepRefused, TerminalBlock, ToolContract,
//! };
//! # fn main() {}
//! ```

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;
use tracing::debug;

use crate::ToolName;
use crate::approval::Authority;
use crate::transition::{ActionTransition, DuplicateRegistration, RegisteredTransformer};

mod application;
mod capability;
mod evaluation;
mod planning;

#[cfg(test)]
mod tests;

pub(crate) use capability::ReceiptParts;
pub use capability::{
    BlockReason, Blocked, CanonicalRequest, Decision, DispatchReceipt, DuplicateContract, ExecutionToken,
    RejectedToken, ResponseDecision, ResponsePolicy, StepCapability, StepOutcome, StepRefused, TerminalBlock,
    ToolContract,
};

/// Identity of one engine configuration, unique within the process. Plans,
/// step capabilities, and pending approvals bind to it: registries are the
/// semantic trust decision, so a capability minted under one engine's
/// registries must never resolve against another's — even if both registered
/// a transformer under the same public name and version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct EngineId(u64);

impl EngineId {
    fn next() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Self(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
}

impl fmt::Display for EngineId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "engine#{}", self.0)
    }
}

/// Holds the tool contracts, the transition registries, the authorities, and
/// the response policy. Registries are populated at construction time and
/// never mutated mid-run.
pub struct PolicyEngine {
    id: EngineId,
    contracts: BTreeMap<ToolName, ToolContract>,
    transformers: Vec<RegisteredTransformer>,
    action_transitions: Vec<ActionTransition>,
    authorities: Vec<Authority>,
    response_policy: Option<ResponsePolicy>,
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            id: EngineId::next(),
            contracts: BTreeMap::new(),
            transformers: Vec::new(),
            action_transitions: Vec::new(),
            authorities: Vec::new(),
            response_policy: None,
        }
    }

    /// Register a decision-making authority. All authorities share one name
    /// space; a duplicate name is refused. Routing consults inline authorities
    /// before external ones, each in registration order, so registration order
    /// is load-bearing.
    pub fn register_authority(&mut self, authority: Authority) -> Result<(), DuplicateRegistration> {
        if self.authorities.iter().any(|a| a.name == authority.name) {
            debug!(authority = %authority.name, "register_authority: duplicate refused");
            return Err(DuplicateRegistration {
                id: authority.name.to_string(),
            });
        }
        debug!(authority = %authority.name, "register_authority: registered");
        self.authorities.push(authority);
        Ok(())
    }

    /// Register a value transformer. Fails on a duplicate identity+version;
    /// registration order is the deterministic candidate order for planning.
    pub fn register_transformer(&mut self, transformer: RegisteredTransformer) -> Result<(), DuplicateRegistration> {
        let id = &transformer.descriptor.transformer;
        if self.transformers.iter().any(|t| t.descriptor.transformer == *id) {
            debug!(transformer = %id, "register_transformer: duplicate refused");
            return Err(DuplicateRegistration { id: id.to_string() });
        }
        debug!(transformer = %id, "register_transformer: registered");
        self.transformers.push(transformer);
        Ok(())
    }

    /// Register an action transition (an explicit tool-identity mapping with
    /// declared replacement effects). Fails on a duplicate identity+version.
    pub fn register_action_transition(&mut self, transition: ActionTransition) -> Result<(), DuplicateRegistration> {
        if self.action_transitions.iter().any(|t| t.id == transition.id) {
            debug!(transition = %transition.id, "register_action_transition: duplicate refused");
            return Err(DuplicateRegistration {
                id: transition.id.to_string(),
            });
        }
        debug!(transition = %transition.id, "register_action_transition: registered");
        self.action_transitions.push(transition);
        Ok(())
    }

    /// Set the final-response sink policy. Without one, emitting a response is
    /// unprovable (like calling a tool with no contract) and blocks terminally
    /// — the response sink is strict emit-or-terminal (no remediation).
    #[must_use]
    pub fn with_response_policy(mut self, policy: ResponsePolicy) -> Self {
        self.response_policy = Some(policy);
        self
    }

    /// Register a tool's contract. Fails if one is already registered for that
    /// tool: contracts are the policy boundary, so an accidental replace is an
    /// error, not a silent overwrite.
    pub fn register(&mut self, contract: ToolContract) -> Result<(), DuplicateContract> {
        if self.contracts.contains_key(&contract.name) {
            debug!(tool = %contract.name, "register: duplicate contract refused");
            return Err(DuplicateContract { tool: contract.name });
        }
        debug!(tool = %contract.name, "register: contract registered");
        self.contracts.insert(contract.name.clone(), contract);
        Ok(())
    }
}

/// Bound on enumerated plans returned per blocked flow.
const MAX_PLANS: usize = 8;
