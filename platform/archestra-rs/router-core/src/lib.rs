//! Pure, Node-free per-session tier routing under an average daily budget. `plan` fits the
//! session-size and long-prompt-share models on history and solves the budget LP exactly for a
//! dual-price policy; `decide` routes one session with that policy and a caller-supplied uniform.

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
    HistoryRow, ModelId, PerDay, PlanInput, Probability, SessionFeatures, SessionKind, Source,
    TIER_COUNT, TierNeeded, TierSet, TierSpec, TokenCounts, TokenMix, TokenPrices, TokenTypes,
    UsdPerDay, UsdPerMTok, Volume,
};
pub use estimate::{LongShareModel, SizeModel, SourceEffect, TokenMixes};
pub use plan::{Diagnostics, Holdout, PLAN_FORMAT_VERSION, Plan, Summary, Versions};

use crate::allocate::{Hull, WeightedSession, solve};
use crate::estimate::{
    BlockPrices, Estimator, MAX_NEWTON_ITERATIONS, fit_long_share, fit_mixes, fit_size,
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
    let total_size: f64 = estimates.iter().map(|e| e.size).sum();
    let weights: Vec<f64> = estimates
        .iter()
        .map(|e| tokens_per_day * e.size / total_size)
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

/// `u` must be uniform on [0, 1) and drawn by the caller once per session.
pub fn decide(plan: &Plan, features: &SessionFeatures, u: f64) -> Result<Decision, RouterError> {
    plan.validate()?;
    if !(0.0..1.0).contains(&u) {
        return Err(RouterError::InvalidUniform(u));
    }
    let estimator = Estimator {
        size_model: &plan.size_model,
        long_share: &plan.long_share,
        prices: BlockPrices::new(&plan.tiers_fingerprint, &plan.token_mix),
    };
    let estimate = estimator.estimate(features);
    Ok(Hull::new(estimate.price, estimate.adequacy)
        .route(&plan.policy)
        .draw(plan.policy.q, u))
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
            kind: SessionKind::Main,
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
        let below = decide(&plan, &features("main"), q * 0.999).unwrap();
        let above = decide(&plan, &features("main"), q + (1.0 - q) * 0.001).unwrap();
        assert_eq!(below.propensity, q);
        assert_eq!(above.propensity, 1.0 - q);
        assert!(below.tier_index > above.tier_index);
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
        let decision = decide(&plan, &features("main"), 0.0).unwrap();
        assert_eq!(
            decision,
            Decision {
                tier_index: 2,
                propensity: 1.0
            }
        );
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
            decide(&plan, &features("never-seen"), u),
            decide(&plan, &features("main"), u)
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
                decide(&plan, &features(&dropped), u),
                decide(&plan, &features("main"), u)
            );
        }
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
                decide(&restored, &features("main"), u),
                decide(&plan, &features("main"), u)
            );
        }

        let mut newer = restored;
        newer.versions.plan_format_version = PLAN_FORMAT_VERSION + 1;
        assert_eq!(
            decide(&newer, &features("main"), 0.5),
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
                r#"{"tier_needed":[0.5,0.5,0.5],"p_long":0,"kind":"main","source":"x"}"#
            )
            .is_err()
        );

        let mut plan = plan(input(4.0)).unwrap();
        assert!(matches!(
            decide(&plan, &features("main"), f64::NAN),
            Err(RouterError::InvalidUniform(v)) if v.is_nan()
        ));
        assert!(decide(&plan, &features("main"), 1.0).is_err());
        plan.long_share.log_size = f64::NAN;
        assert_eq!(
            decide(&plan, &features("main"), 0.5),
            Err(RouterError::NonFinitePlan("long_share"))
        );
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
}
