//! Estimators: per session, each tier's expected value (adequacy) and cost (USD per token,
//! blended over the predicted long-prompt share), plus the session's predicted size.

mod models;

#[cfg(test)]
pub(crate) use models::MAX_FIT_SOURCES;
pub use models::{LongShareModel, SizeModel, SourceEffect, TokenMixes};
pub(crate) use models::{MAX_NEWTON_ITERATIONS, fit_long_share, fit_mixes, fit_size};

use crate::domain::{SessionFeatures, TIER_COUNT, TierSet, TokenMix, TokenPrices};
use models::TOKEN_SCALE;

/// USD per token of each tier within the short- and long-prompt blocks of the token mix.
pub(crate) struct BlockPrices {
    short: [f64; TIER_COUNT],
    long: [f64; TIER_COUNT],
}

impl BlockPrices {
    pub(crate) fn new(tiers: &TierSet, mixes: &TokenMixes) -> Self {
        let per_token = |mix: &TokenMix, prices: &TokenPrices| {
            mix.values()
                .iter()
                .zip(prices.values())
                .map(|(m, p)| m * p.get())
                .sum::<f64>()
                / TOKEN_SCALE
        };
        let tiers = tiers.tiers();
        Self {
            short: tiers.each_ref().map(|t| per_token(&mixes.short, &t.short)),
            long: tiers
                .each_ref()
                .map(|t| per_token(&mixes.long, t.long.as_ref().unwrap_or(&t.short))),
        }
    }

    fn session(&self, long_share: f64) -> [f64; TIER_COUNT] {
        std::array::from_fn(|t| (1.0 - long_share) * self.short[t] + long_share * self.long[t])
    }
}

/// Fitted models a session is estimated with; shared by planning and `decide` so that
/// estimates — and the breakpoints allocated from them — are bit-identical between the two.
pub(crate) struct Estimator<'a> {
    pub(crate) size_model: &'a SizeModel,
    pub(crate) long_share: &'a LongShareModel,
    pub(crate) prices: BlockPrices,
}

pub(crate) struct SessionEstimate {
    /// Predicted session tokens.
    pub(crate) size: f64,
    /// Per-tier expected USD per token.
    pub(crate) price: [f64; TIER_COUNT],
    /// Per-tier expected value: probability the tier is adequate.
    pub(crate) adequacy: [f64; TIER_COUNT],
}

impl Estimator<'_> {
    pub(crate) fn estimate(&self, features: &SessionFeatures) -> SessionEstimate {
        let size = self.size_model.predict(features);
        SessionEstimate {
            size,
            price: self.prices.session(self.long_share.predict(size)),
            adequacy: features.tier_needed.adequacy(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allocate::Hull;

    #[test]
    fn crossing_session_prices_change_the_hull() {
        let prices = BlockPrices {
            short: [1.0, 2.0, 4.0],
            long: [5.0, 2.0, 4.0],
        };
        let adequacy = [0.3, 0.7, 1.0];
        assert_eq!(
            Hull::new(prices.session(0.0), adequacy).vertices,
            vec![0, 1, 2]
        );
        assert_eq!(
            Hull::new(prices.session(1.0), adequacy).vertices,
            vec![1, 2]
        );
    }
}
