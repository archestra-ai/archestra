//! Pure, Node-free per-session tier routing under an average daily budget. `plan` fits the
//! session-size and long-prompt-share models on history and solves the budget LP exactly for a
//! dual-price policy; `decide` routes one session with a caller-supplied policy (the plan's own,
//! or a paced one) and a caller-supplied uniform.
//!
//! Pipeline: pre-run session features → `estimate` (per-tier value and cost) → `allocate`
//! (hull breakpoints, λ*/q under the budget, route with propensity).

mod allocate;
mod domain;
mod estimate;
mod linalg;
mod plan;

pub use allocate::{Decision, Policy};
pub use domain::{
    HistoryRow, ModelId, PerDay, PlanInput, Probability, SessionFeatures, SessionWeight, Source,
    TIER_COUNT, TierNeeded, TierSet, TierSpec, TokenCounts, TokenMix, TokenPrices, TokenTypes,
    UsdPerDay, UsdPerMTok, Volume,
};
pub use estimate::{LongShareModel, SizeModel, SourceEffect, TokenMixes};
pub use plan::{Diagnostics, Holdout, PLAN_FORMAT_VERSION, Plan, Summary, Versions};

use serde::Serialize;

use crate::allocate::{Draw, Hull, WeightedSession, solve};
use crate::estimate::{
    BlockPrices, Estimator, MAX_NEWTON_ITERATIONS, SessionEstimate, fit_long_share, fit_mixes,
    fit_size,
};
use crate::plan::{holdout, summarize};

/// This crate's version, recorded on every plan and decision.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RouterError {
    #[error("price must be finite and non-negative, got {0}")]
    InvalidPrice(f64),
    #[error("budget must be finite and non-negative, got {0}")]
    InvalidBudget(f64),
    #[error("volume must be finite and positive, got {0}")]
    InvalidVolume(f64),
    #[error("session weight must be finite and positive, got {0}")]
    InvalidWeight(f64),
    #[error("probability must be in [0, 1], got {0}")]
    InvalidProbability(f64),
    #[error("tier_needed must be non-negative and sum to 1 within 1e-6, got {0:?}")]
    InvalidTierNeeded([f64; TIER_COUNT]),
    #[error("model id must not be empty")]
    EmptyModelId,
    #[error("a positive long-context threshold is required iff some tier has long prices")]
    LongContextThresholdMismatch,
    #[error("history is empty")]
    EmptyHistory,
    #[error("history has no tokens")]
    EmptyTokenHistory,
    #[error("baseline source {0:?} does not occur in history")]
    BaselineSourceMissing(String),
    #[error("size model did not converge in {iterations} iterations")]
    NotConverged { iterations: usize },
    #[error("size model hessian is singular")]
    SingularSizeModel,
    #[error("long-share regression is singular")]
    SingularLongShare,
    #[error("cheapest routing costs {cheapest_spend} USD/day, above the {budget} USD/day budget")]
    Infeasible { cheapest_spend: f64, budget: f64 },
    #[error("plan format version {found} is not supported (expected {expected})")]
    UnsupportedPlanFormat { found: u32, expected: u32 },
    #[error("plan field {0} is not finite")]
    NonFinitePlan(&'static str),
    #[error("u must be in [0, 1), got {0}")]
    InvalidUniform(f64),
    #[error("policy needs a finite λ ≥ 0 and q in [0, 1], got λ = {lam_star}, q = {q}")]
    InvalidPolicy { lam_star: f64, q: f64 },
    #[error("expected session cost is not finite: {0}")]
    NonFiniteEstimate(f64),
}

pub fn plan(input: PlanInput) -> Result<Plan, RouterError> {
    let PlanInput {
        history,
        tiers,
        budget,
        volume,
        baseline_source,
    } = input;
    if history.is_empty() {
        return Err(RouterError::EmptyHistory);
    }
    let (sessions_per_day, tokens_per_day) = match volume {
        Volume::Flat {
            sessions_per_day,
            tokens_per_day,
        } => (sessions_per_day.get(), tokens_per_day.get()),
    };
    let token_mix = fit_mixes(&history)?;
    let size_model = fit_size(&history, &baseline_source, MAX_NEWTON_ITERATIONS)?;
    let sizes: Vec<f64> = history
        .iter()
        .map(|r| size_model.predict(&r.features))
        .collect();
    let long_share = fit_long_share(&history, &sizes)?;

    let estimator = Estimator {
        size_model: &size_model,
        long_share: &long_share,
        prices: BlockPrices::new(&tiers, &token_mix),
    };
    let estimates: Vec<_> = history
        .iter()
        .map(|r| estimator.estimate(&r.features))
        .collect();
    let hulls: Vec<Hull> = estimates
        .iter()
        .map(|e| Hull::new(e.price, e.adequacy))
        .collect();
    let session_weights: Vec<f64> = history.iter().map(HistoryRow::weight).collect();
    let total_size: f64 = estimates
        .iter()
        .zip(&session_weights)
        .map(|(e, w)| w * e.size)
        .sum();
    let weights: Vec<f64> = estimates
        .iter()
        .zip(&session_weights)
        .map(|(e, w)| tokens_per_day * w * e.size / total_size)
        .collect();
    let weighted: Vec<WeightedSession> = estimates
        .iter()
        .zip(&hulls)
        .zip(&weights)
        .map(|((e, hull), &w)| WeightedSession {
            hull,
            price: e.price,
            tokens_per_day: w,
        })
        .collect();
    let policy = solve(&weighted, budget.get())?;
    let summary = summarize(
        &estimates,
        &hulls,
        &session_weights,
        &weights,
        &policy,
        sessions_per_day,
        tokens_per_day,
    );
    let diagnostics = plan::Diagnostics {
        holdout: holdout(&history, &baseline_source),
    };
    Ok(Plan {
        versions: Versions {
            plan_format_version: PLAN_FORMAT_VERSION,
            core_version: CORE_VERSION.to_owned(),
        },
        tiers_fingerprint: tiers,
        size_model,
        long_share,
        token_mix,
        policy,
        summary,
        diagnostics,
    })
}

/// Routes with `policy`, which need not be `plan.policy`. `u` must be uniform on [0, 1) and
/// drawn by the caller once per session.
pub fn decide(
    plan: &Plan,
    policy: &Policy,
    features: &SessionFeatures,
    u: f64,
) -> Result<Decision, RouterError> {
    let estimator = validated_estimator(plan, policy)?;
    if !(0.0..1.0).contains(&u) {
        return Err(RouterError::InvalidUniform(u));
    }
    let estimate = estimator.estimate(features);
    let Draw {
        tier_index,
        propensity,
    } = Hull::new(estimate.price, estimate.adequacy)
        .route(policy)
        .draw(policy.q, u);
    Ok(Decision {
        tier_index,
        propensity,
        lambda: policy.lam_star,
        expected_cost_usd: finite_cost(&estimate, tier_index)?,
    })
}

/// One session as `plan` sees it under its own policy: the estimator's prediction and the
/// route, with the tied upgrade (taken with probability q) kept apart from the base tier.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionAssessment {
    pub predicted_tokens: f64,
    pub usd_per_token: [f64; TIER_COUNT],
    pub base_tier: usize,
    pub tie_tier: Option<usize>,
}

/// Read-only diagnostics over many sessions; routes exactly as `decide` with `plan.policy`.
pub fn assess(
    plan: &Plan,
    features: &[SessionFeatures],
) -> Result<Vec<SessionAssessment>, RouterError> {
    let estimator = validated_estimator(plan, &plan.policy)?;
    features
        .iter()
        .map(|f| {
            let estimate = estimator.estimate(f);
            let route = Hull::new(estimate.price, estimate.adequacy).route(&plan.policy);
            for tier in std::iter::once(route.base).chain(route.tie) {
                finite_cost(&estimate, tier)?;
            }
            Ok(SessionAssessment {
                predicted_tokens: estimate.size,
                usd_per_token: estimate.price,
                base_tier: route.base,
                tie_tier: route.tie,
            })
        })
        .collect()
}

fn validated_estimator<'a>(plan: &'a Plan, policy: &Policy) -> Result<Estimator<'a>, RouterError> {
    plan.validate()?;
    policy.validate()?;
    Ok(Estimator {
        size_model: &plan.size_model,
        long_share: &plan.long_share,
        prices: BlockPrices::new(&plan.tiers_fingerprint, &plan.token_mix),
    })
}

fn finite_cost(estimate: &SessionEstimate, tier: usize) -> Result<f64, RouterError> {
    let cost = estimate.size * estimate.price[tier];
    match cost.is_finite() {
        true => Ok(cost),
        false => Err(RouterError::NonFiniteEstimate(cost)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    fn prices(input: f64) -> TokenPrices {
        let p = |v: f64| UsdPerMTok::new(v).unwrap();
        TokenPrices {
            input: p(input),
            cache_read: p(input / 10.0),
            cache_write: p(input * 1.25),
            output: p(input * 5.0),
        }
    }

    fn tiers() -> TierSet {
        let tier = |id: &str, input: f64, long: Option<f64>| TierSpec {
            model_id: ModelId::new(id.into()).unwrap(),
            short: prices(input),
            long: long.map(prices),
        };
        TierSet::new(
            [
                tier("fast", 1.0, Some(5.0)),
                tier("normal", 3.0, None),
                tier("smart", 15.0, None),
            ],
            Some(100_000),
        )
        .unwrap()
    }

    fn features(source: &str) -> SessionFeatures {
        SessionFeatures {
            tier_needed: TierNeeded::new([0.5, 0.25, 0.25]).unwrap(),
            p_long: Probability::new(0.0).unwrap(),
            source: Source(source.into()),
        }
    }

    /// Identical features everywhere, so all sessions share their breakpoints exactly.
    fn input(budget: f64) -> PlanInput {
        let history = (0..40_u64)
            .map(|i| HistoryRow {
                features: features("main"),
                short: TokenCounts {
                    input: 1_000 + 37 * i,
                    cache_read: 20_000 + 101 * i,
                    cache_write: 2_000,
                    output: 500 + 11 * i,
                },
                long: TokenCounts {
                    input: 0,
                    cache_read: 0,
                    cache_write: 0,
                    output: 0,
                },
                timestamp_ms: i as i64 * DAY_MS,
                weight: SessionWeight::new(1.0).unwrap(),
            })
            .collect();
        PlanInput {
            history,
            tiers: tiers(),
            budget: UsdPerDay::new(budget).unwrap(),
            volume: Volume::Flat {
                sessions_per_day: PerDay::new(40.0).unwrap(),
                tokens_per_day: PerDay::new(1e6).unwrap(),
            },
            baseline_source: Source("main".into()),
        }
    }

    #[test]
    fn tie_is_taken_iff_u_below_q() {
        let plan = plan(input(4.0)).unwrap();
        let Policy { lam_star, q } = plan.policy;
        assert!(lam_star > 0.0 && q > 0.0 && q < 1.0, "{:?}", plan.policy);
        assert!((plan.summary.expected_spend - 4.0).abs() < 1e-12);
        let below = decide(&plan, &plan.policy, &features("main"), q * 0.999).unwrap();
        let above = decide(
            &plan,
            &plan.policy,
            &features("main"),
            q + (1.0 - q) * 0.001,
        )
        .unwrap();
        assert_eq!(below.propensity, q);
        assert_eq!(above.propensity, 1.0 - q);
        assert!(below.tier_index > above.tier_index);
    }

    #[test]
    fn caller_policy_overrides_the_plan_anchor() {
        let plan = plan(input(4.0)).unwrap();
        let f = features("main");
        let route =
            |lam_star: f64, q: f64, u: f64| decide(&plan, &Policy { lam_star, q }, &f, u).unwrap();
        let lam = plan.policy.lam_star;
        let anchored_up = route(lam, plan.policy.q, 0.0);
        let anchored_down = route(lam, plan.policy.q, 0.999_999);
        // λ above the tie: the tied upgrade is never taken, whatever u is
        let tighter = route(lam * 1.5, plan.policy.q, 0.0);
        assert_eq!(tighter.tier_index, anchored_down.tier_index);
        assert_eq!((tighter.propensity, tighter.lambda), (1.0, lam * 1.5));
        // λ below the tie: the tied upgrade is always taken
        let looser = route(lam * 0.999, plan.policy.q, 0.999_999);
        assert_eq!(looser.tier_index, anchored_up.tier_index);
        assert_eq!(looser.propensity, 1.0);
        assert!(anchored_up.tier_index > anchored_down.tier_index);
        // λ = 0 buys every upgrade on the hull
        assert_eq!(route(0.0, 0.0, 0.5).tier_index, 2);

        for (lam_star, q) in [(-1.0, 0.5), (f64::NAN, 0.5), (lam, 1.5)] {
            assert!(matches!(
                decide(&plan, &Policy { lam_star, q }, &f, 0.5),
                Err(RouterError::InvalidPolicy { .. })
            ));
        }
    }

    #[test]
    fn expected_cost_reconciles_with_the_solved_spend() {
        // identical sessions: expected_spend = tokens_per_day × E_u[USD per token]
        let plan = plan(input(4.0)).unwrap();
        let f = features("main");
        let Policy { q, .. } = plan.policy;
        let tie = decide(&plan, &plan.policy, &f, 0.0).unwrap();
        let base = decide(&plan, &plan.policy, &f, 0.999_999).unwrap();
        assert!(tie.expected_cost_usd > base.expected_cost_usd);
        let size = plan.size_model.predict(&f);
        let per_token = (q * tie.expected_cost_usd + (1.0 - q) * base.expected_cost_usd) / size;
        let spend = plan.summary.tokens_per_day * per_token;
        assert!(
            (spend - plan.summary.expected_spend).abs() < 1e-9,
            "{spend}"
        );
    }

    #[test]
    fn all_best_affordable_routes_everyone_to_their_best_vertex() {
        let plan = plan(input(1e6)).unwrap();
        assert_eq!(
            plan.policy,
            Policy {
                lam_star: 0.0,
                q: 0.0
            }
        );
        let decision = decide(&plan, &plan.policy, &features("main"), 0.0).unwrap();
        assert_eq!((decision.tier_index, decision.propensity), (2, 1.0));
        assert_eq!(decision.lambda, 0.0);
        let [fast, normal, smart] = plan.summary.tier_session_share;
        assert_eq!((fast, normal), (0.0, 0.0));
        assert!((smart - 1.0).abs() < 1e-12);
        assert_eq!(plan.summary.value_per_usd, 0.0);
    }

    #[test]
    fn budget_below_cheapest_is_infeasible() {
        assert!(matches!(
            plan(input(0.01)),
            Err(RouterError::Infeasible { budget: 0.01, .. })
        ));
    }

    #[test]
    fn unknown_source_routes_as_baseline() {
        let plan = plan(input(4.0)).unwrap();
        let u = plan.policy.q * 0.5;
        assert_eq!(
            decide(&plan, &plan.policy, &features("never-seen"), u),
            decide(&plan, &plan.policy, &features("main"), u)
        );
    }

    #[test]
    fn sources_beyond_the_fit_cap_route_as_baseline() {
        let mut input = input(4.0);
        let extra = estimate::MAX_FIT_SOURCES + 5;
        let main_rows = input.history.len() - extra;
        for (i, row) in input.history.iter_mut().skip(main_rows).enumerate() {
            row.features.source = Source(format!("s{i:02}"));
        }
        let plan = plan(input).unwrap();
        let SizeModel::PoissonGlm { source_effects, .. } = &plan.size_model;
        assert_eq!(source_effects.len(), estimate::MAX_FIT_SOURCES);
        let dropped = format!("s{:02}", extra - 1);
        assert!(source_effects.iter().all(|e| e.source.0 != dropped));
        let q = plan.policy.q;
        for u in [q * 0.5, (1.0 + q) / 2.0] {
            assert_eq!(
                decide(&plan, &plan.policy, &features(&dropped), u),
                decide(&plan, &plan.policy, &features("main"), u)
            );
        }
    }

    #[test]
    fn weighted_cohorts_plan_as_their_expanded_population() {
        let mut varied = input(4.0);
        for (i, row) in varied.history.iter_mut().enumerate() {
            row.features.p_long = Probability::new((i % 3) as f64 / 2.0).unwrap();
            row.long.input = 3_000 * (i % 4) as u64;
        }
        let unit = plan(varied.clone()).unwrap();
        let mut weighted = varied.clone();
        let mut copied = varied;
        // Two cohorts sampled at different rates, as live and past sessions are.
        let tripled = copied.history[..10].to_vec();
        let doubled = copied.history[10..15].to_vec();
        for row in &mut weighted.history[..10] {
            row.weight = SessionWeight::new(3.0).unwrap();
        }
        for row in &mut weighted.history[10..15] {
            row.weight = SessionWeight::new(2.0).unwrap();
        }
        copied.history.extend(tripled.iter().cloned());
        copied.history.extend(tripled);
        copied.history.extend(doubled);
        let (weighted, copied) = (plan(weighted).unwrap(), plan(copied).unwrap());
        let close = |a: &[f64], b: &[f64]| {
            a.iter()
                .zip(b)
                .all(|(x, y)| (x - y).abs() <= 1e-8 * y.abs().max(1.0))
        };
        assert!(close(
            &weighted.size_model.coefficients(),
            &copied.size_model.coefficients()
        ));
        assert!(close(
            &weighted.long_share.coefficients(),
            &copied.long_share.coefficients()
        ));
        assert!(close(
            &weighted.token_mix.values(),
            &copied.token_mix.values()
        ));
        assert!(close(
            &[weighted.policy.lam_star, weighted.policy.q],
            &[copied.policy.lam_star, copied.policy.q]
        ));
        assert!(close(
            &weighted.summary.tier_session_share,
            &copied.summary.tier_session_share
        ));
        assert!(!close(
            &weighted.size_model.coefficients(),
            &unit.size_model.coefficients()
        ));
    }

    #[test]
    fn single_window_history_skips_holdout() {
        let mut input = input(4.0);
        for row in &mut input.history {
            row.timestamp_ms = 0;
        }
        assert_eq!(
            plan(input).unwrap().diagnostics.holdout,
            Holdout::InsufficientHistory
        );
    }

    #[test]
    fn plan_json_round_trips_and_rejects_other_versions() {
        let plan = plan(input(4.0)).unwrap();
        let json = serde_json::to_string(&plan).unwrap();
        let restored: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, plan);
        let q = plan.policy.q;
        for u in [q * 0.5, q, (1.0 + q) / 2.0] {
            assert_eq!(
                decide(&restored, &restored.policy, &features("main"), u),
                decide(&plan, &plan.policy, &features("main"), u)
            );
        }

        let mut newer = restored;
        newer.versions.plan_format_version = PLAN_FORMAT_VERSION + 1;
        assert_eq!(
            decide(&newer, &newer.policy, &features("main"), 0.5),
            Err(RouterError::UnsupportedPlanFormat {
                found: PLAN_FORMAT_VERSION + 1,
                expected: PLAN_FORMAT_VERSION
            })
        );
    }

    #[test]
    fn non_finite_inputs_are_rejected() {
        assert!(
            matches!(UsdPerMTok::new(f64::NAN), Err(RouterError::InvalidPrice(v)) if v.is_nan())
        );
        assert!(UsdPerMTok::new(f64::INFINITY).is_err());
        assert!(UsdPerDay::new(f64::NAN).is_err());
        assert!(PerDay::new(0.0).is_err());
        assert!(Probability::new(f64::NAN).is_err());
        assert!(TierNeeded::new([f64::NAN, 0.5, 0.5]).is_err());
        assert!(TierNeeded::new([0.5, 0.5, 0.5]).is_err());
        assert!(
            serde_json::from_str::<SessionFeatures>(
                r#"{"tier_needed":[0.5,0.5,0.5],"p_long":0,"source":"x"}"#
            )
            .is_err()
        );

        let mut plan = plan(input(4.0)).unwrap();
        assert!(matches!(
            decide(&plan, &plan.policy, &features("main"), f64::NAN),
            Err(RouterError::InvalidUniform(v)) if v.is_nan()
        ));
        assert!(decide(&plan, &plan.policy, &features("main"), 1.0).is_err());
        plan.long_share.log_size = f64::NAN;
        assert_eq!(
            decide(&plan, &plan.policy, &features("main"), 0.5),
            Err(RouterError::NonFinitePlan("long_share"))
        );
    }

    #[test]
    fn steep_p_long_fit_still_routes_long_sessions() {
        // one source; the sessions with a slightly higher p_long are vastly larger
        let mut input = input(4.0);
        for (i, row) in input.history.iter_mut().enumerate() {
            if i % 2 == 1 {
                row.features.p_long = Probability::new(0.01).unwrap();
                row.short.cache_read *= 100_000;
            }
        }
        let plan = plan(input).unwrap();
        let SizeModel::PoissonGlm { p_long, .. } = plan.size_model;
        assert!(p_long > 710.0, "{p_long}");
        let mut long = features("main");
        long.p_long = Probability::new(1.0).unwrap();
        let decision = decide(&plan, &plan.policy, &long, 0.5).unwrap();
        assert!(decision.expected_cost_usd.is_finite() && decision.expected_cost_usd > 0.0);
    }

    fn overflowing_plan() -> Plan {
        let mut plan = plan(input(4.0)).unwrap();
        let tier = |id: &str| TierSpec {
            model_id: ModelId::new(id.into()).unwrap(),
            short: prices(f64::MAX / 5.0),
            long: None,
        };
        plan.tiers_fingerprint =
            TierSet::new([tier("fast"), tier("normal"), tier("smart")], None).unwrap();
        let SizeModel::PoissonGlm { intercept, .. } = &mut plan.size_model;
        *intercept = 100.0;
        plan
    }

    #[test]
    fn non_finite_expected_cost_is_an_error() {
        let plan = overflowing_plan();
        assert!(matches!(
            decide(&plan, &plan.policy, &features("main"), 0.5),
            Err(RouterError::NonFiniteEstimate(_))
        ));
    }

    #[test]
    fn tier_set_requires_threshold_iff_long_prices() {
        let [fast, normal, smart] = tiers().tiers().clone();
        assert_eq!(
            TierSet::new([fast.clone(), normal.clone(), smart.clone()], None),
            Err(RouterError::LongContextThresholdMismatch)
        );
        let short_only = TierSpec { long: None, ..fast };
        assert_eq!(
            TierSet::new([short_only, normal, smart], Some(100_000)),
            Err(RouterError::LongContextThresholdMismatch)
        );
    }

    #[test]
    fn assess_routes_as_decide() {
        let plan = plan(input(4.0)).unwrap();
        let sessions = [features("main"), features("other")];
        let assessed = assess(&plan, &sessions).unwrap();
        for (f, a) in sessions.iter().zip(&assessed) {
            let tie = decide(&plan, &plan.policy, f, 0.0).unwrap();
            let base = decide(&plan, &plan.policy, f, 0.999_999).unwrap();
            assert_eq!(a.base_tier, base.tier_index);
            assert_eq!(a.tie_tier.unwrap_or(a.base_tier), tie.tier_index);
            let cost = a.predicted_tokens * a.usd_per_token[a.base_tier];
            assert!((cost - base.expected_cost_usd).abs() <= 1e-12 * cost);
        }
        assert!(assessed[0].tie_tier.is_some());
    }

    #[test]
    fn assess_validates_as_decide() {
        let mut plan = plan(input(4.0)).unwrap();
        plan.policy.q = 1.5;
        assert!(matches!(
            assess(&plan, &[features("main")]),
            Err(RouterError::InvalidPolicy { .. })
        ));
    }

    #[test]
    fn assess_refuses_a_non_finite_cost() {
        let plan = overflowing_plan();
        assert!(matches!(
            assess(&plan, &[features("main")]),
            Err(RouterError::NonFiniteEstimate(_))
        ));
    }
}
