use serde::{Deserialize, Serialize};

use crate::RouterError;
use crate::allocate::{Hull, Policy};
use crate::domain::{HistoryRow, Source, TIER_COUNT, TierSet};
use crate::estimate::{
    LongShareModel, MAX_NEWTON_ITERATIONS, SessionEstimate, SizeModel, TokenMixes, fit_size,
};

pub const PLAN_FORMAT_VERSION: u32 = 4;
const HOLDOUT_WINDOW_MS: i64 = 10 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Versions {
    pub plan_format_version: u32,
    pub core_version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub sessions_per_day: f64,
    pub tokens_per_day: f64,
    /// USD/day at the policy, tie block counted at probability q.
    pub expected_spend: f64,
    /// Size-weighted mean adequacy of the chosen tiers.
    pub value_size_weighted: f64,
    pub tier_session_share: [f64; TIER_COUNT],
    pub tier_token_share: [f64; TIER_COUNT],
    /// Shadow price λ*/tokens_per_day: value_size_weighted gained per extra USD/day of budget.
    pub value_per_usd: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Holdout {
    /// Size model refit without the last 10 days, scored on them.
    Evaluated {
        sessions: usize,
        predicted_tokens: f64,
        realized_tokens: f64,
        /// None when either side is constant or there is a single session.
        spearman: Option<f64>,
    },
    /// All history falls inside the holdout window.
    InsufficientHistory,
    FitFailed {
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostics {
    pub holdout: Holdout,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub versions: Versions,
    /// Callers compare this with the current trio before `decide`; prices are read from it.
    pub tiers_fingerprint: TierSet,
    pub size_model: SizeModel,
    pub long_share: LongShareModel,
    pub token_mix: TokenMixes,
    pub policy: Policy,
    pub summary: Summary,
    pub diagnostics: Diagnostics,
}

impl Plan {
    /// Plans are trusted beyond format version and finiteness of what `decide` reads.
    pub(crate) fn validate(&self) -> Result<(), RouterError> {
        let found = self.versions.plan_format_version;
        if found != PLAN_FORMAT_VERSION {
            return Err(RouterError::UnsupportedPlanFormat {
                found,
                expected: PLAN_FORMAT_VERSION,
            });
        }
        let finite = |values: &[f64]| values.iter().all(|v| v.is_finite());
        let checks = [
            ("size_model", finite(&self.size_model.coefficients())),
            ("long_share", finite(&self.long_share.coefficients())),
            ("token_mix", finite(&self.token_mix.values())),
            ("policy", finite(&[self.policy.lam_star, self.policy.q])),
        ];
        match checks.iter().find(|(_, ok)| !ok) {
            Some((field, _)) => Err(RouterError::NonFinitePlan(field)),
            None => Ok(()),
        }
    }
}

pub(crate) fn summarize(
    sessions: &[SessionEstimate],
    hulls: &[Hull],
    session_weights: &[f64],
    weights: &[f64],
    policy: &Policy,
    sessions_per_day: f64,
    tokens_per_day: f64,
) -> Summary {
    let total_size: f64 = sessions
        .iter()
        .zip(session_weights)
        .map(|(s, sw)| sw * s.size)
        .sum();
    let n: f64 = session_weights.iter().sum();
    let mut summary = Summary {
        sessions_per_day,
        tokens_per_day,
        expected_spend: 0.0,
        value_size_weighted: 0.0,
        tier_session_share: [0.0; TIER_COUNT],
        tier_token_share: [0.0; TIER_COUNT],
        value_per_usd: policy.lam_star / tokens_per_day,
    };
    for (((s, hull), w), sw) in sessions.iter().zip(hulls).zip(weights).zip(session_weights) {
        let route = hull.route(policy);
        let outcomes = match route.tie {
            Some(tie) => [(route.base, 1.0 - policy.q), (tie, policy.q)],
            None => [(route.base, 1.0), (route.base, 0.0)],
        };
        for (tier, p) in outcomes {
            summary.expected_spend += p * w * s.price[tier];
            summary.value_size_weighted += p * sw * s.size * s.adequacy[tier] / total_size;
            summary.tier_session_share[tier] += p * sw / n;
            summary.tier_token_share[tier] += p * sw * s.size / total_size;
        }
    }
    summary
}

pub(crate) fn holdout(history: &[HistoryRow], baseline: &Source) -> Holdout {
    let Some(latest) = history.iter().map(|r| r.timestamp_ms).max() else {
        return Holdout::InsufficientHistory;
    };
    let cutoff = latest.saturating_sub(HOLDOUT_WINDOW_MS);
    let (test, train): (Vec<HistoryRow>, Vec<HistoryRow>) = history
        .iter()
        .cloned()
        .partition(|r| r.timestamp_ms > cutoff);
    if train.is_empty() {
        return Holdout::InsufficientHistory;
    }
    match fit_size(&train, baseline, MAX_NEWTON_ITERATIONS) {
        Err(error) => Holdout::FitFailed {
            error: error.to_string(),
        },
        Ok(model) => {
            let predicted: Vec<f64> = test.iter().map(|r| model.predict(&r.features)).collect();
            let realized: Vec<f64> = test.iter().map(HistoryRow::total_tokens).collect();
            Holdout::Evaluated {
                sessions: test.len(),
                predicted_tokens: predicted.iter().sum(),
                realized_tokens: realized.iter().sum(),
                spearman: spearman(&predicted, &realized),
            }
        }
    }
}

fn spearman(a: &[f64], b: &[f64]) -> Option<f64> {
    pearson(&ranks(a), &ranks(b))
}

/// 1-based ranks, ties get their average rank.
fn ranks(values: &[f64]) -> Vec<f64> {
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by(|&i, &j| values[i].total_cmp(&values[j]));
    let mut ranks = vec![0.0; values.len()];
    let mut start = 0;
    for group in order.chunk_by(|&i, &j| values[i] == values[j]) {
        let rank = start as f64 + (group.len() as f64 + 1.0) / 2.0;
        for &i in group {
            ranks[i] = rank;
        }
        start += group.len();
    }
    ranks
}

fn pearson(x: &[f64], y: &[f64]) -> Option<f64> {
    let n = x.len() as f64;
    let (mx, my) = (x.iter().sum::<f64>() / n, y.iter().sum::<f64>() / n);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (a, b) in x.iter().zip(y) {
        sxy += (a - mx) * (b - my);
        sxx += (a - mx) * (a - mx);
        syy += (b - my) * (b - my);
    }
    (sxx > 0.0 && syy > 0.0).then(|| sxy / (sxx * syy).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spearman_averages_ties_and_rejects_constants() {
        assert_eq!(ranks(&[3.0, 1.0, 3.0, 2.0]), vec![3.5, 1.0, 3.5, 2.0]);
        assert_eq!(spearman(&[1.0, 2.0, 3.0], &[10.0, 20.0, 30.0]), Some(1.0));
        assert_eq!(spearman(&[1.0, 2.0, 3.0], &[30.0, 20.0, 10.0]), Some(-1.0));
        assert_eq!(spearman(&[1.0, 1.0], &[1.0, 2.0]), None);
        assert_eq!(spearman(&[1.0], &[1.0]), None);
    }
}
