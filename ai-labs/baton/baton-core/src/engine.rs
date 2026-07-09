//! The policy engine: evaluate one requested flow against the folded context.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use tracing::{debug, warn};

use crate::ToolName;
use crate::authority::{Authority, AuthorityName, Ruling};
use crate::contract::{Breach, Fixability, Requirements, ToolContract, ToolRequest, Unprovable, Verdict, Violation};
use crate::label::{AuditEntry, Grant, Label};
use crate::turn::{Trajectory, TrajectoryId};

/// What an unprovable (`Unknown`-caused) violation means at a sink.
///
/// This is the gradual-adoption knob: annotate a handful of high-risk tools,
/// leave the rest unknown, and choose how loudly the gaps fail — without
/// pretending the whole system is formally safe.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UnknownPolicy {
    /// Treat unprovable violations like breaches: the authority decides.
    #[default]
    Escalate,
    /// Fail closed.
    Deny,
    /// Let the flow through, recording an unsigned
    /// [`AuditEntry::Acknowledged`] (`by: None`) on the result label.
    AllowWithAudit,
}

/// The source-side taint knob, orthogonal to [`UnknownPolicy`]. `Allow`
/// (default) is today's behavior: taint propagates silently through the fold.
/// `Escalate` additionally flags any flow whose output would *degrade* the
/// context (`context.combine(output) ≠ context` in some dimension) with an
/// acknowledge-only [`Violation::TaintEntry`], so a degrading step is
/// recorded (and, if nothing else clears it, signed off by an authority).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TaintPolicy {
    #[default]
    Allow,
    Escalate,
}

/// Proof that the engine authorized one tool call — the only way to append a
/// tool result to a [`Trajectory`]. Carries the exact [`ToolRequest`] that
/// was evaluated (execute that, nothing else) and the label the result must
/// wear, including any audit entries the authorization produced.
///
/// A permit is linear (not `Clone`) and bound to the identity and head of the
/// trajectory it was evaluated against, so one authorization records at most
/// one result, and never into a context the policy did not see.
///
/// Both properties hold at compile time. A permit has no public constructor:
///
/// ```compile_fail
/// let permit = baton_core::Permit {
///     request: baton_core::ToolRequest::new(baton_core::ToolName::new("email.send")),
/// };
/// ```
///
/// and cannot be spent twice:
///
/// ```compile_fail
/// fn spend_twice(mut trajectory: baton_core::Trajectory, permit: baton_core::Permit) {
///     let _ = trajectory.record_result(permit, "first");
///     let _ = trajectory.record_result(permit, "second");
/// }
/// ```
#[derive(Debug, PartialEq, Eq)]
pub struct Permit {
    request: ToolRequest,
    result_label: Label,
    trajectory: TrajectoryId,
    /// Trajectory length at evaluation time.
    basis: usize,
}

impl Permit {
    /// The request this permit authorizes, verbatim as evaluated.
    pub fn request(&self) -> &ToolRequest {
        &self.request
    }

    pub fn result_label(&self) -> &Label {
        &self.result_label
    }

    pub(crate) fn into_parts(self) -> (ToolRequest, Label, TrajectoryId, usize) {
        (self.request, self.result_label, self.trajectory, self.basis)
    }
}

/// [`Trajectory::record_result`] refused a permit: it no longer (or never
/// did) describe that trajectory's context, so the flow must be re-evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectedPermit {
    /// The permit was minted for a different trajectory.
    ForeignTrajectory {
        minted_for: TrajectoryId,
        this: TrajectoryId,
    },
    /// The trajectory grew between `evaluate` and the recording.
    Stale { granted_at: usize, current_len: usize },
}

impl fmt::Display for RejectedPermit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ForeignTrajectory { minted_for, this } => {
                write!(f, "permit was minted for {minted_for}, not {this}")
            }
            Self::Stale {
                granted_at,
                current_len,
            } => write!(
                f,
                "permit granted at trajectory length {granted_at}, but the trajectory now has {current_len} turns"
            ),
        }
    }
}

impl std::error::Error for RejectedPermit {}

/// [`PolicyEngine::register`] refused a contract: a contract for that tool is
/// already registered. Contracts are the policy boundary, so a silent replace
/// could weaken policy unnoticed — registration fails loudly instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateContract {
    pub tool: ToolName,
}

impl fmt::Display for DuplicateContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a contract for `{}` is already registered", self.tool)
    }
}

impl std::error::Error for DuplicateContract {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockReason {
    DeniedByAuthority {
        authority: AuthorityName,
        reason: String,
    },
    /// [`UnknownPolicy::Deny`] and at least one requirement was unprovable.
    UnknownDenied,
    /// A structural violation (an integration bug the caller must fix) was
    /// present; no authority may override it, so the flow is blocked before
    /// anyone is consulted.
    RequiresStructuralFix,
    /// No registered authority's declared mandate covers the grant this flow
    /// would need, so no one is competent to rule on it.
    NoCompetentAuthority,
    /// An approved grant did not clear on recheck the grant-fixable gaps it
    /// targeted — a bug in derivation or lift. The engine fails closed rather
    /// than permit an under-covered flow.
    InternalInvariantFailed,
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeniedByAuthority { authority, reason } => {
                write!(f, "denied by {authority}: {reason}")
            }
            Self::UnknownDenied => write!(f, "unknown-policy is deny and the flow is unprovable"),
            Self::RequiresStructuralFix => {
                write!(f, "a structural violation no authority may override")
            }
            Self::NoCompetentAuthority => {
                write!(f, "no authority's mandate covers the needed grant")
            }
            Self::InternalInvariantFailed => {
                write!(f, "an approved grant did not clear the flow on recheck")
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
#[must_use = "a dropped Decision means the flow was neither executed nor blocked"]
pub enum Decision {
    Permitted(Permit),
    Blocked {
        violations: Vec<Violation>,
        reason: BlockReason,
    },
}

/// Holds the tool contracts, the unknown policy, and the escalation channel.
///
/// `evaluate` never mutates the trajectory: an approval is a one-shot
/// exception carried on the [`Permit`]'s result label, so the same violation
/// in a later flow escalates again.
pub struct PolicyEngine<A: Authority> {
    contracts: BTreeMap<ToolName, ToolContract>,
    unknown_policy: UnknownPolicy,
    taint_policy: TaintPolicy,
    authority: A,
}

impl<A: Authority> PolicyEngine<A> {
    pub fn new(authority: A, unknown_policy: UnknownPolicy) -> Self {
        Self {
            contracts: BTreeMap::new(),
            unknown_policy,
            taint_policy: TaintPolicy::default(),
            authority,
        }
    }

    /// Opt into the source-side taint knob (default [`TaintPolicy::Allow`]).
    #[must_use]
    pub fn with_taint_policy(mut self, taint_policy: TaintPolicy) -> Self {
        self.taint_policy = taint_policy;
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

    /// Evaluate one requested flow against the folded context. Violations
    /// (from the [`Requirements::check`] adequacy relation) are triaged on two
    /// axes: fixability decides authority handling, provability drives the
    /// [`UnknownPolicy`].
    ///
    /// 1. Any *structural* violation blocks immediately — an integration bug
    ///    no authority may override.
    /// 2. The [`UnknownPolicy`] disposes of the unprovables (deny closed,
    ///    audit through, or escalate).
    /// 3. If nothing reaches an authority, permit (recording any
    ///    policy-audited unknowns).
    /// 4. Otherwise derive the grant that would cover the grant-fixable gaps,
    ///    route it to the first authority whose mandate covers it (or block
    ///    with [`BlockReason::NoCompetentAuthority`] without consulting), and
    ///    on approval apply the grant, recheck fail-closed, and record the
    ///    declassification.
    ///
    /// A tool with no registered contract is first-class: calling it is
    /// itself unprovable ([`Unprovable::NoContract`]) and its output label is
    /// all-`Unknown`, which then poisons the context fold.
    ///
    /// `evaluate` does not mutate the trajectory: an approval is a one-shot
    /// exception carried on the [`Permit`]'s result label, so the same
    /// violation in a later flow escalates again. It is not referentially
    /// pure — it calls arbitrary [`Authority`] code — but enforcement is the
    /// evaluate → execute → [`Trajectory::record_result`] loop of the
    /// embedding harness; the permit's binding to the trajectory head keeps
    /// that loop honest.
    #[tracing::instrument(level = "debug", skip_all, fields(tool = %request.tool))]
    pub fn evaluate(&self, trajectory: &Trajectory, request: &ToolRequest) -> Decision {
        let context = trajectory.context_label();
        let confirmation = trajectory.pending_confirmation();
        let trajectory_id = trajectory.id();
        let basis = trajectory.turns().len();
        debug!(%context, confirmation = ?confirmation, basis, "folded context");

        let permit = |result_label| {
            Decision::Permitted(Permit {
                request: request.clone(),
                result_label,
                trajectory: trajectory_id,
                basis,
            })
        };

        let contract = self.contracts.get(&request.tool);
        let (verdict, result_label) = match contract {
            Some(c) => (
                c.requires.check(&context, confirmation, request),
                c.output_label.clone(),
            ),
            None => (
                Verdict::Escalate(vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: request.tool.clone(),
                })]),
                Label::unknown(),
            ),
        };
        debug!(has_contract = contract.is_some(), "contract lookup");

        let mut violations = match verdict {
            Verdict::Allow => Vec::new(),
            Verdict::Escalate(violations) => violations,
        };

        // Source-side taint knob (orthogonal to the requirement check): flag a
        // flow whose output would degrade the context as acknowledge-only.
        let taint = if self.taint_policy == TaintPolicy::Escalate {
            taint_entry(&context, &result_label, &request.tool)
        } else {
            None
        };
        if let Some(taint) = taint {
            debug!("taint flagged (output would degrade context)");
            violations.push(taint);
        }

        if violations.is_empty() {
            debug!("permitted (no violations)");
            return permit(result_label);
        }
        debug!(violations = ?violations, "triaging violations");

        // Axis: fixability. A structural violation is an integration bug no
        // authority may override — block before consulting anyone.
        if violations.iter().any(|v| v.fixability() == Fixability::Structural) {
            debug!("blocked (structural fix required)");
            return Decision::Blocked {
                violations,
                reason: BlockReason::RequiresStructuralFix,
            };
        }

        // Axis: provability. Apply the UnknownPolicy to the unprovables.
        let (unprovable, breaches): (Vec<Violation>, Vec<Violation>) = violations
            .into_iter()
            .partition(|v| matches!(v, Violation::Unprovable(_)));

        let mut result_label = result_label;
        let mut escalating = breaches;
        let mut audited_unknowns = Vec::new();
        debug!(
            policy = ?self.unknown_policy,
            unprovable = unprovable.len(),
            breaches = escalating.len(),
            "unknown-policy disposition",
        );
        match self.unknown_policy {
            UnknownPolicy::Escalate => escalating.extend(unprovable),
            UnknownPolicy::Deny => {
                if !unprovable.is_empty() {
                    escalating.extend(unprovable);
                    debug!("blocked (unknown-policy deny)");
                    return Decision::Blocked {
                        violations: escalating,
                        reason: BlockReason::UnknownDenied,
                    };
                }
            }
            UnknownPolicy::AllowWithAudit => audited_unknowns = unprovable,
        }

        if escalating.is_empty() {
            if !audited_unknowns.is_empty() {
                debug!(count = audited_unknowns.len(), "acknowledging policy-audited unknowns");
                result_label.audit.push(AuditEntry::Acknowledged {
                    tool: request.tool.clone(),
                    facts: audited_unknowns,
                    by: None,
                });
            }
            debug!("permitted (no escalation)");
            return permit(result_label);
        }

        // Derive the grant that would cover the grant-fixable gaps, then route
        // by mandate before consulting anyone. `needed_grant` needs a
        // contract; the only escalation without one is a lone `NoContract`
        // (acknowledge-only, so the empty grant is correct).
        let needed = match contract {
            Some(c) => needed_grant(&escalating, request, &c.requires),
            None => Grant::empty(),
        };
        debug!(grant = ?needed, escalating = ?escalating, "derived grant, routing to authority");

        // Route and adjudicate in one traversal: the authority names the
        // deciding member and returns its ruling together, so attribution is
        // consistent by construction. `None` means no mandate covers the need
        // — block without consulting anyone.
        let full_picture: Vec<Violation> = escalating.iter().chain(audited_unknowns.iter()).cloned().collect();
        let Some((authority_name, ruling)) = self.authority.rule(&needed, request, &context, &full_picture) else {
            debug!("blocked (no competent authority)");
            escalating.extend(audited_unknowns);
            return Decision::Blocked {
                violations: escalating,
                reason: BlockReason::NoCompetentAuthority,
            };
        };
        debug!(authority = %authority_name, "routed to authority");

        match ruling {
            Ruling::Approve { reason } => {
                debug!(authority = %authority_name, "authority approved");
                // Fail closed (a control-flow check, not a debug_assert that
                // vanishes in release): the grant must actually clear every
                // grant-fixable gap it targeted. Acknowledge-only violations
                // and policy-audited unknowns are expected to remain and are
                // not targeted, so we check only the targeted set.
                let targeted: Vec<Violation> = escalating
                    .iter()
                    .filter(|v| v.fixability() == Fixability::GrantFixable)
                    .cloned()
                    .collect();
                if !targeted.is_empty() {
                    let lifted = context.lift(&needed);
                    let recheck_confirmation = if needed.confirms {
                        Some(&request.tool)
                    } else {
                        confirmation
                    };
                    let reverdict = contract
                        .expect("grant-fixable violations imply a contract")
                        .requires
                        .check(&lifted, recheck_confirmation, request);
                    let uncovered = match &reverdict {
                        Verdict::Allow => false,
                        Verdict::Escalate(remaining) => remaining.iter().any(|v| targeted.contains(v)),
                    };
                    if uncovered {
                        warn!(
                            authority = %authority_name,
                            "recheck failed — grant did not clear targeted gaps, failing closed",
                        );
                        escalating.extend(audited_unknowns);
                        return Decision::Blocked {
                            violations: escalating,
                            reason: BlockReason::InternalInvariantFailed,
                        };
                    }
                    debug!("recheck cleared targeted gaps");
                }

                // Record one declassification for the grant-fixable gaps the
                // grant resolved, and acknowledgment entries for the rest:
                // acknowledge-only members the authority signed off on
                // (`by: Some`), then policy-audited unknowns (`by: None`).
                let (resolved, acknowledged): (Vec<Violation>, Vec<Violation>) = escalating
                    .into_iter()
                    .partition(|v| v.fixability() == Fixability::GrantFixable);
                if !resolved.is_empty() {
                    result_label.audit.push(AuditEntry::Declassified {
                        grant: needed,
                        resolved,
                        authority: authority_name.clone(),
                        reason,
                    });
                }
                if !acknowledged.is_empty() {
                    result_label.audit.push(AuditEntry::Acknowledged {
                        tool: request.tool.clone(),
                        facts: acknowledged,
                        by: Some(authority_name),
                    });
                }
                if !audited_unknowns.is_empty() {
                    result_label.audit.push(AuditEntry::Acknowledged {
                        tool: request.tool.clone(),
                        facts: audited_unknowns,
                        by: None,
                    });
                }
                debug!("permitted (authority approved)");
                permit(result_label)
            }
            Ruling::Deny { reason } => {
                debug!(authority = %authority_name, reason = %reason, "blocked (denied by authority)");
                // Report the full picture: the audited unknowns did not cause
                // the block, but they were part of this flow's evaluation.
                escalating.extend(audited_unknowns);
                Decision::Blocked {
                    violations: escalating,
                    reason: BlockReason::DeniedByAuthority {
                        authority: authority_name,
                        reason,
                    },
                }
            }
        }
    }
}

/// Derive the grant that would cover the grant-fixable gaps in `violations`.
/// Takes the `request` (for `AudienceUnknown`, which carries no payload) and
/// the `requirements` (for `TrustUnknown`, likewise). Acknowledge-only and
/// structural violations contribute nothing; a non-empty grant-fixable set
/// always yields a non-empty grant.
fn needed_grant(violations: &[Violation], request: &ToolRequest, requirements: &Requirements) -> Grant {
    let mut grant = Grant::empty();
    for violation in violations {
        match violation {
            Violation::Breach(Breach::TrustBelow { required, .. }) => {
                grant.trust = Some(*required);
            }
            Violation::Unprovable(Unprovable::TrustUnknown) => {
                grant.trust = requirements.trust;
            }
            Violation::Breach(Breach::AudienceExceeds { outside }) => {
                grant
                    .audience
                    .get_or_insert_with(BTreeSet::new)
                    .extend(outside.iter().cloned());
            }
            Violation::Unprovable(Unprovable::AudienceUnknown) => {
                grant
                    .audience
                    .get_or_insert_with(BTreeSet::new)
                    .extend(request.recipients.iter().cloned());
            }
            Violation::Breach(Breach::ForbiddenPriorEffects { effects }) => {
                grant
                    .effects
                    .get_or_insert_with(BTreeSet::new)
                    .extend(effects.iter().copied());
            }
            Violation::Breach(Breach::ConfirmationMissing { .. } | Breach::ConfirmationForOtherTool { .. }) => {
                grant.confirms = true;
            }
            Violation::Breach(Breach::UndeclaredRecipients)
            | Violation::Unprovable(Unprovable::EffectsUnknown | Unprovable::NoContract { .. })
            | Violation::TaintEntry { .. } => {}
        }
    }
    grant
}

/// If the taint knob is on, flag a flow whose output would degrade the
/// context: `context.combine(output)` differs from `context` in some
/// dimension. (Combine is the taint meet, so folding can only keep or worsen
/// a dimension — any difference is a degradation.)
fn taint_entry(context: &Label, output: &Label, tool: &ToolName) -> Option<Violation> {
    let would_be = context.clone().combine(output.clone());
    let degrades =
        would_be.audience != context.audience || would_be.trust != context.trust || would_be.effects != context.effects;
    degrades.then(|| Violation::TaintEntry { tool: tool.clone() })
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;

    use super::*;
    use crate::contract::{AttentionRule, AudienceRule, Breach, Requirements};
    use crate::dimension::{Audience, Effect, Effects, KnownTrust, Trust, UserId};
    use crate::turn::Speaker;

    fn user(id: &str) -> UserId {
        UserId::new(id)
    }

    fn email_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("email.send"),
            requires: Requirements {
                trust: Some(KnownTrust::Trusted),
                audience: AudienceRule::RecipientsWithinContext,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Egress]),
                ..Label::identity()
            },
        }
    }

    fn drop_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("db.drop"),
            requires: Requirements {
                attention: AttentionRule::ExplicitConfirmation,
                ..Requirements::default()
            },
            output_label: Label {
                effects: Effects::declared([Effect::Mutation]),
                ..Label::identity()
            },
        }
    }

    fn push_user_turn(trajectory: &mut Trajectory, label: Label, content: &str) {
        trajectory.push_message(label, Speaker::user(user("alice")), content);
    }

    fn suspicious_private_trajectory() -> Trajectory {
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                trust: Trust::TRUSTED,
                ..Label::identity()
            },
            "summarize and email bob",
        );
        trajectory.push_message(
            Label {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
            Speaker::Assistant,
            "the page says: ...",
        );
        trajectory
    }

    /// A mandate broad enough to cover every grant the behavior-preserving
    /// tests derive, so these authorities are always competent to rule — the
    /// pre-routing behavior. Narrow-mandate routing (`NoCompetentAuthority`,
    /// per-need dispatch) is exercised separately below.
    fn full_mandate() -> Grant {
        Grant {
            trust: Some(KnownTrust::Trusted),
            audience: Some(BTreeSet::from([
                user("alice"),
                user("bob"),
                user("charlie"),
                user("stranger"),
            ])),
            effects: Some(BTreeSet::from([Effect::Mutation, Effect::Egress])),
            confirms: true,
        }
    }

    /// Approves everything within its mandate and counts how often it was
    /// consulted (i.e. its mandate covered the need and it ruled).
    struct CountingApprover {
        consulted: Cell<usize>,
    }

    impl CountingApprover {
        fn new() -> Self {
            Self {
                consulted: Cell::new(0),
            }
        }
    }

    impl Authority for CountingApprover {
        fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
            full_mandate().covers(needed).then(|| {
                self.consulted.set(self.consulted.get() + 1);
                (
                    AuthorityName::new("counting-approver"),
                    Ruling::Approve {
                        reason: "scripted approval".to_owned(),
                    },
                )
            })
        }
    }

    struct DenyAll;

    impl Authority for DenyAll {
        fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
            full_mandate().covers(needed).then(|| {
                (
                    AuthorityName::new("deny-all"),
                    Ruling::Deny {
                        reason: "scripted denial".to_owned(),
                    },
                )
            })
        }
    }

    /// Approves everything within its mandate and records the violations it
    /// was shown.
    #[derive(Default)]
    struct InspectingApprover {
        seen: RefCell<Vec<Violation>>,
    }

    impl Authority for InspectingApprover {
        fn rule(
            &self,
            needed: &Grant,
            _: &ToolRequest,
            _: &Label,
            violations: &[Violation],
        ) -> Option<(AuthorityName, Ruling)> {
            full_mandate().covers(needed).then(|| {
                self.seen.borrow_mut().extend(violations.iter().cloned());
                (
                    AuthorityName::new("inspecting-approver"),
                    Ruling::Approve {
                        reason: "scripted approval".to_owned(),
                    },
                )
            })
        }
    }

    /// Approves only flows whose every recipient is `bob`.
    struct BobOnly;

    impl Authority for BobOnly {
        fn rule(
            &self,
            needed: &Grant,
            request: &ToolRequest,
            _: &Label,
            _: &[Violation],
        ) -> Option<(AuthorityName, Ruling)> {
            full_mandate().covers(needed).then(|| {
                let to_bob_only =
                    !request.recipients.is_empty() && request.recipients.iter().all(|u| u == &user("bob"));
                let ruling = if to_bob_only {
                    Ruling::Approve {
                        reason: "reviewed for bob".to_owned(),
                    }
                } else {
                    Ruling::Deny {
                        reason: "only bob was reviewed".to_owned(),
                    }
                };
                (AuthorityName::new("bob-only"), ruling)
            })
        }
    }

    /// A leaf with an explicit mandate and a fixed ruling; counts consults.
    struct Mandated {
        name: &'static str,
        mandate: Grant,
        approve: bool,
        consulted: Cell<usize>,
    }

    impl Mandated {
        fn new(name: &'static str, mandate: Grant, approve: bool) -> Self {
            Self {
                name,
                mandate,
                approve,
                consulted: Cell::new(0),
            }
        }
    }

    impl Authority for Mandated {
        fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
            self.mandate.covers(needed).then(|| {
                self.consulted.set(self.consulted.get() + 1);
                let ruling = if self.approve {
                    Ruling::Approve {
                        reason: "ok".to_owned(),
                    }
                } else {
                    Ruling::Deny {
                        reason: "no".to_owned(),
                    }
                };
                (AuthorityName::new(self.name), ruling)
            })
        }
    }

    fn trust_mandate() -> Grant {
        Grant {
            trust: Some(KnownTrust::Trusted),
            ..Grant::empty()
        }
    }

    fn confirms_mandate() -> Grant {
        Grant {
            confirms: true,
            ..Grant::empty()
        }
    }

    fn audience_mandate(ids: &[&str]) -> Grant {
        Grant {
            audience: Some(ids.iter().map(|id| user(id)).collect()),
            ..Grant::empty()
        }
    }

    #[test]
    fn clean_flow_is_permitted_without_the_authority() {
        let counting = CountingApprover::new();
        let mut engine = PolicyEngine::new(counting, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                ..Label::identity()
            },
            "email bob",
        );

        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(permit.result_label().effects, Effects::declared([Effect::Egress]));
        assert!(permit.result_label().audit.is_empty());
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn approval_is_one_shot_and_never_loosens_the_context() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let mut trajectory = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);

        let first = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = first else {
            panic!("expected permit, got {first:?}");
        };
        let declassifications = permit
            .result_label()
            .audit
            .iter()
            .filter(|e| matches!(e, AuditEntry::Declassified { .. }))
            .count();
        assert_eq!(declassifications, 1);
        trajectory
            .record_result(permit, "sent")
            .expect("permit minted for this trajectory head");

        // The identical flow escalates again: the approval waived one flow,
        // not the trust breach itself.
        let second = engine.evaluate(&trajectory, &request);
        assert!(matches!(second, Decision::Permitted(_)));
        assert_eq!(engine.authority.consulted.get(), 2);
    }

    #[test]
    fn a_permit_goes_stale_when_the_trajectory_moves_on() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let mut trajectory = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };

        push_user_turn(&mut trajectory, Label::identity(), "wait, one more thing");

        let err = trajectory
            .record_result(permit, "sent")
            .expect_err("the context changed under the permit");
        assert_eq!(
            err,
            RejectedPermit::Stale {
                granted_at: 2,
                current_len: 3,
            }
        );
        // Nothing was appended by the failed recording.
        assert_eq!(trajectory.turns().len(), 3);
    }

    #[test]
    fn a_permit_cannot_cross_trajectories() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let evaluated = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&evaluated, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };

        // Same length, different trajectory: the policy never saw it.
        let mut other = suspicious_private_trajectory();
        let err = other
            .record_result(permit, "sent")
            .expect_err("permit minted for a different trajectory");
        assert!(matches!(err, RejectedPermit::ForeignTrajectory { .. }));
        assert_eq!(other.turns().len(), 2);
    }

    #[test]
    fn approval_for_bob_does_not_permit_charlie() {
        let mut engine = PolicyEngine::new(BobOnly, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();
        let trajectory = suspicious_private_trajectory();

        let to_bob = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(engine.evaluate(&trajectory, &to_bob), Decision::Permitted(_)));

        let to_charlie = ToolRequest::exposing(ToolName::new("email.send"), [user("charlie")]);
        let decision = engine.evaluate(&trajectory, &to_charlie);
        let Decision::Blocked { violations, reason } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(violations.iter().any(|v| matches!(
            v,
            Violation::Breach(Breach::AudienceExceeds { outside })
                if outside == &BTreeSet::from([user("charlie")])
        )));
        assert!(matches!(reason, BlockReason::DeniedByAuthority { .. }));
    }

    #[test]
    fn stale_or_foreign_confirmation_cannot_authorize_a_drop() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        engine.register(drop_contract()).unwrap();
        let request = ToolRequest::new(ToolName::new("db.drop"));

        // Confirmation bound to another tool.
        let mut trajectory = Trajectory::new();
        trajectory.push_message(
            Label::identity(),
            Speaker::confirming(user("alice"), ToolName::new("email.send")),
            "yes, send it",
        );
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Correct confirmation, but a later turn already ended it.
        let mut trajectory = Trajectory::new();
        trajectory.push_message(
            Label::identity(),
            Speaker::confirming(user("alice"), ToolName::new("db.drop")),
            "yes, drop it",
        );
        push_user_turn(&mut trajectory, Label::identity(), "unrelated chatter");
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));

        // Fresh confirmation for exactly this tool.
        let mut trajectory = Trajectory::new();
        trajectory.push_message(
            Label::identity(),
            Speaker::confirming(user("alice"), ToolName::new("db.drop")),
            "yes, drop it",
        );
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(permit.result_label().effects, Effects::declared([Effect::Mutation]));
    }

    #[test]
    fn recording_the_result_ends_the_confirmation() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        engine.register(drop_contract()).unwrap();
        let request = ToolRequest::new(ToolName::new("db.drop"));

        let mut trajectory = Trajectory::new();
        trajectory.push_message(
            Label::identity(),
            Speaker::confirming(user("alice"), ToolName::new("db.drop")),
            "yes, drop it",
        );

        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        trajectory
            .record_result(permit, "table dropped")
            .expect("permit minted for this trajectory head");

        // The tool result is now the newest turn: the confirmation is spent,
        // and running the same tool again needs a fresh one.
        assert_eq!(trajectory.pending_confirmation(), None);
        assert!(matches!(
            engine.evaluate(&trajectory, &request),
            Decision::Blocked { .. }
        ));
    }

    #[test]
    fn unregistered_tool_follows_the_unknown_policy() {
        let request = ToolRequest::new(ToolName::new("calendar.lookup"));
        let trajectory = Trajectory::new();

        // Deny: fail closed without consulting the authority.
        let counting = CountingApprover::new();
        let engine = PolicyEngine::new(counting, UnknownPolicy::Deny);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, reason } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(reason, BlockReason::UnknownDenied);
        assert_eq!(
            violations,
            vec![Violation::Unprovable(Unprovable::NoContract {
                tool: ToolName::new("calendar.lookup"),
            })]
        );
        assert_eq!(engine.authority.consulted.get(), 0);

        // Escalate: the authority decides.
        let engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        assert!(matches!(engine.evaluate(&trajectory, &request), Decision::Permitted(_)));
        assert_eq!(engine.authority.consulted.get(), 1);

        // AllowWithAudit: permitted without the authority, but on the record,
        // and the result label is all-unknown.
        let engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::AllowWithAudit);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert_eq!(engine.authority.consulted.get(), 0);
        assert_eq!(permit.result_label().audience, Audience::UNKNOWN);
        assert_eq!(permit.result_label().trust, Trust::UNKNOWN);
        assert_eq!(permit.result_label().effects, Effects::UNKNOWN);
        assert_eq!(
            permit.result_label().audit,
            vec![AuditEntry::Acknowledged {
                tool: ToolName::new("calendar.lookup"),
                facts: vec![Violation::Unprovable(Unprovable::NoContract {
                    tool: ToolName::new("calendar.lookup"),
                })],
                by: None,
            }]
        );
    }

    #[test]
    fn deny_policy_with_breaches_only_still_escalates() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Deny);
        engine.register(email_contract()).unwrap();

        // Suspicious trust is a breach, not an unknown: the deny policy does
        // not apply, the authority does.
        let trajectory = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(engine.evaluate(&trajectory, &request), Decision::Permitted(_)));
        assert_eq!(engine.authority.consulted.get(), 1);
    }

    #[test]
    fn one_approval_declassifies_a_mixed_escalation() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        // Suspicious trust (breach) + unknown audience (unprovable), both
        // grant-fixable and both resolved by the single minted grant, recorded
        // in one Declassified entry.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::UNKNOWN,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        let declassifications: Vec<&Vec<Violation>> = permit
            .result_label()
            .audit
            .iter()
            .filter_map(|e| match e {
                AuditEntry::Declassified { resolved, .. } => Some(resolved),
                AuditEntry::Acknowledged { .. } => None,
            })
            .collect();
        // A single grant, one Declassified entry, both violations resolved.
        assert_eq!(declassifications.len(), 1);
        let resolved = declassifications[0];
        assert_eq!(resolved.len(), 2);
        assert!(resolved.iter().any(|v| matches!(v, Violation::Breach(_))));
        assert!(
            resolved
                .iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn allow_with_audit_still_escalates_breaches_and_reports_unknowns_on_block() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::AllowWithAudit);
        engine.register(email_contract()).unwrap();

        // Unknown audience (unprovable, allowed by policy) plus a trust
        // breach (escalated, denied by the authority): the breach wins, and
        // the blocked decision still reports the audited unknown.
        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::UNKNOWN,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(violations.iter().any(|v| matches!(v, Violation::Breach(_))));
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn the_authority_sees_audited_unknowns_alongside_breaches() {
        let mut engine = PolicyEngine::new(InspectingApprover::default(), UnknownPolicy::AllowWithAudit);
        engine.register(email_contract()).unwrap();

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::UNKNOWN,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
            "context of unknown provenance",
        );
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        assert!(matches!(engine.evaluate(&trajectory, &request), Decision::Permitted(_)));

        let seen = engine.authority.seen.borrow();
        assert!(seen.iter().any(|v| matches!(v, Violation::Breach(_))));
        assert!(
            seen.iter()
                .any(|v| matches!(v, Violation::Unprovable(Unprovable::AudienceUnknown)))
        );
    }

    #[test]
    fn recorded_effects_feed_later_requirement_checks() {
        let mut engine = PolicyEngine::new(DenyAll, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();
        engine
            .register(ToolContract {
                name: ToolName::new("report.generate"),
                requires: Requirements {
                    forbid_prior_effects: BTreeSet::from([Effect::Egress]),
                    ..Requirements::default()
                },
                output_label: Label::identity(),
            })
            .unwrap();

        let mut trajectory = Trajectory::new();
        push_user_turn(
            &mut trajectory,
            Label {
                audience: Audience::readers([user("alice"), user("bob")]),
                ..Label::identity()
            },
            "email bob, then build the report",
        );

        let email = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &email);
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        trajectory
            .record_result(permit, "sent")
            .expect("permit minted for this trajectory head");

        // The recorded egress now trips the report tool's requirement.
        let report = ToolRequest::new(ToolName::new("report.generate"));
        let decision = engine.evaluate(&trajectory, &report);
        let Decision::Blocked { violations, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(
            violations,
            vec![Violation::Breach(Breach::ForbiddenPriorEffects {
                effects: BTreeSet::from([Effect::Egress]),
            })]
        );
    }

    #[test]
    fn structural_violation_blocks_without_consulting() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        // An audience-guarded sink called with no recipients is a structural
        // integration bug (UndeclaredRecipients); no authority may override.
        let trajectory = suspicious_private_trajectory();
        let request = ToolRequest::new(ToolName::new("email.send"));
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { violations, reason } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(reason, BlockReason::RequiresStructuralFix);
        assert!(
            violations
                .iter()
                .any(|v| matches!(v, Violation::Breach(Breach::UndeclaredRecipients)))
        );
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn an_uncovered_need_blocks_without_consulting() {
        // A confirms-only mandate cannot cover a trust gap, so the flow is
        // blocked as NoCompetentAuthority before anyone is consulted.
        let authority = Mandated::new("confirms-only", confirms_mandate(), true);
        let mut engine = PolicyEngine::new(authority, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let trajectory = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { reason, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(reason, BlockReason::NoCompetentAuthority);
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn each_grant_fixable_kind_derives_a_covering_grant_and_rechecks_clean() {
        let email_to = |ids: &[&str]| ToolRequest::exposing(ToolName::new("email.send"), ids.iter().map(|id| user(id)));
        let with_email = || {
            let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
            engine.register(email_contract()).unwrap();
            engine
        };
        let context = |label: Label| {
            let mut trajectory = Trajectory::new();
            push_user_turn(&mut trajectory, label, "context");
            trajectory
        };

        // TrustBelow: suspicious context, email within audience.
        assert!(matches!(
            with_email().evaluate(&suspicious_private_trajectory(), &email_to(&["bob"])),
            Decision::Permitted(_)
        ));

        // TrustUnknown: unknown-trust context, audience fine.
        let unknown_trust = context(Label {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::UNKNOWN,
            ..Label::identity()
        });
        assert!(matches!(
            with_email().evaluate(&unknown_trust, &email_to(&["bob"])),
            Decision::Permitted(_)
        ));

        // AudienceExceeds: trusted private context, recipient outside it.
        let private_trusted = context(Label {
            audience: Audience::readers([user("alice"), user("bob")]),
            trust: Trust::TRUSTED,
            ..Label::identity()
        });
        assert!(matches!(
            with_email().evaluate(&private_trusted, &email_to(&["charlie"])),
            Decision::Permitted(_)
        ));

        // AudienceUnknown: unknown-audience but trusted context.
        let unknown_audience = context(Label {
            audience: Audience::UNKNOWN,
            trust: Trust::TRUSTED,
            ..Label::identity()
        });
        assert!(matches!(
            with_email().evaluate(&unknown_audience, &email_to(&["bob"])),
            Decision::Permitted(_)
        ));

        // ForbiddenPriorEffects: context already carries the forbidden effect.
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine
            .register(ToolContract {
                name: ToolName::new("report.generate"),
                requires: Requirements {
                    forbid_prior_effects: BTreeSet::from([Effect::Egress]),
                    ..Requirements::default()
                },
                output_label: Label::identity(),
            })
            .unwrap();
        let egressed = context(Label {
            effects: Effects::declared([Effect::Egress]),
            ..Label::identity()
        });
        assert!(matches!(
            engine.evaluate(&egressed, &ToolRequest::new(ToolName::new("report.generate"))),
            Decision::Permitted(_)
        ));

        // ConfirmationMissing: db.drop with no pending confirmation.
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(drop_contract()).unwrap();
        assert!(matches!(
            engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("db.drop"))),
            Decision::Permitted(_)
        ));
    }

    #[test]
    fn a_tuple_routes_each_need_to_the_mandated_member() {
        let panel = (
            Mandated::new("trust-auth", trust_mandate(), true),
            Mandated::new("confirms-auth", confirms_mandate(), true),
        );
        let mut engine = PolicyEngine::new(panel, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();
        engine.register(drop_contract()).unwrap();

        let signed_by = |permit: &Permit| -> Vec<String> {
            permit
                .result_label()
                .audit
                .iter()
                .filter_map(|e| match e {
                    AuditEntry::Declassified { authority, .. } => Some(authority.as_str().to_owned()),
                    AuditEntry::Acknowledged { .. } => None,
                })
                .collect()
        };

        // A trust need routes to the trust-mandated member.
        let trust_flow = engine.evaluate(
            &suspicious_private_trajectory(),
            &ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]),
        );
        let Decision::Permitted(permit) = trust_flow else {
            panic!("expected permit, got {trust_flow:?}");
        };
        assert!(signed_by(&permit).iter().all(|a| a == "trust-auth"));

        // A confirmation need routes to the confirms-mandated member.
        let mut confirming = Trajectory::new();
        confirming.push_message(Label::identity(), Speaker::user(user("alice")), "no confirmation yet");
        let confirm_flow = engine.evaluate(&confirming, &ToolRequest::new(ToolName::new("db.drop")));
        let Decision::Permitted(permit) = confirm_flow else {
            panic!("expected permit, got {confirm_flow:?}");
        };
        assert!(signed_by(&permit).iter().all(|a| a == "confirms-auth"));
    }

    #[test]
    fn tuple_nesting_is_associative_for_routing() {
        let needs = [
            Grant::empty(),
            trust_mandate(),
            audience_mandate(&["bob"]),
            confirms_mandate(),
        ];
        let left = (
            Mandated::new("a", trust_mandate(), true),
            (
                Mandated::new("b", audience_mandate(&["bob"]), true),
                Mandated::new("c", confirms_mandate(), true),
            ),
        );
        let right = (
            (
                Mandated::new("a", trust_mandate(), true),
                Mandated::new("b", audience_mandate(&["bob"]), true),
            ),
            Mandated::new("c", confirms_mandate(), true),
        );
        let request = ToolRequest::new(ToolName::new("noop"));
        let context = Label::identity();
        for need in &needs {
            let left_name = left.rule(need, &request, &context, &[]).map(|(name, _)| name);
            let right_name = right.rule(need, &request, &context, &[]).map(|(name, _)| name);
            assert_eq!(left_name, right_name, "need={need:?}");
        }
    }

    /// A tool whose output degrades trust (Trusted → Suspicious) from a clean
    /// context, with no requirements of its own.
    fn fetch_contract() -> ToolContract {
        ToolContract {
            name: ToolName::new("web.fetch"),
            requires: Requirements::default(),
            output_label: Label {
                audience: Audience::PUBLIC,
                trust: Trust::SUSPICIOUS,
                ..Label::identity()
            },
        }
    }

    #[test]
    fn taint_allow_does_not_flag_a_degrading_flow() {
        // Default TaintPolicy::Allow: a degrading fetch permits silently.
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(fetch_contract()).unwrap();
        let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("web.fetch")));
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert!(permit.result_label().audit.is_empty());
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn taint_escalate_flags_and_signs_off_a_degrading_flow() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate)
            .with_taint_policy(TaintPolicy::Escalate);
        engine.register(fetch_contract()).unwrap();
        let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("web.fetch")));
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        // The degrading fetch was acknowledged by an authority (by: Some).
        assert_eq!(engine.authority.consulted.get(), 1);
        assert!(permit.result_label().audit.iter().any(|e| matches!(
            e,
            AuditEntry::Acknowledged { facts, by: Some(_), .. }
                if facts.iter().any(|v| matches!(v, Violation::TaintEntry { .. }))
        )));
    }

    #[test]
    fn taint_escalate_ignores_a_non_degrading_flow() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate)
            .with_taint_policy(TaintPolicy::Escalate);
        engine
            .register(ToolContract {
                name: ToolName::new("noop.tool"),
                requires: Requirements::default(),
                output_label: Label::identity(),
            })
            .unwrap();
        let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("noop.tool")));
        let Decision::Permitted(permit) = decision else {
            panic!("expected permit, got {decision:?}");
        };
        assert!(permit.result_label().audit.is_empty());
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn no_contract_blocks_on_deny_regardless_of_the_taint_knob() {
        // NoContract is unprovable; UnknownPolicy::Deny fails closed before any
        // authority, and the taint knob does not change that.
        let engine =
            PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Deny).with_taint_policy(TaintPolicy::Escalate);
        let decision = engine.evaluate(&Trajectory::new(), &ToolRequest::new(ToolName::new("calendar.lookup")));
        let Decision::Blocked { reason, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert_eq!(reason, BlockReason::UnknownDenied);
        assert_eq!(engine.authority.consulted.get(), 0);
    }

    #[test]
    fn first_covering_member_decides_and_is_attributed() {
        // Both members are mandated for trust; the first denies, the second
        // would approve. The panel takes the first member's denial, attributes
        // it to that member, and never consults the second — routing,
        // attribution, and consultation all agree by construction.
        let panel = (
            Mandated::new("first", trust_mandate(), false),
            Mandated::new("second", trust_mandate(), true),
        );
        let mut engine = PolicyEngine::new(panel, UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();

        let trajectory = suspicious_private_trajectory();
        let request = ToolRequest::exposing(ToolName::new("email.send"), [user("bob")]);
        let decision = engine.evaluate(&trajectory, &request);
        let Decision::Blocked { reason, .. } = decision else {
            panic!("expected block, got {decision:?}");
        };
        assert!(matches!(
            reason,
            BlockReason::DeniedByAuthority { authority, .. } if authority.as_str() == "first"
        ));
        assert_eq!(engine.authority.0.consulted.get(), 1);
        assert_eq!(engine.authority.1.consulted.get(), 0);
    }

    #[test]
    fn registering_a_duplicate_contract_is_refused() {
        let mut engine = PolicyEngine::new(CountingApprover::new(), UnknownPolicy::Escalate);
        engine.register(email_contract()).unwrap();
        let err = engine
            .register(email_contract())
            .expect_err("a second contract for the same tool must be refused");
        assert_eq!(
            err,
            DuplicateContract {
                tool: ToolName::new("email.send"),
            }
        );
    }
}
