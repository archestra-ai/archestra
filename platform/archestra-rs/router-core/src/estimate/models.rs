use std::collections::BTreeMap;

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::RouterError;
use crate::domain::{HistoryRow, SessionFeatures, SessionKind, Source, TokenCounts, TokenMix};
use crate::linalg::least_squares;

/// Sizes are fit in millions of tokens.
pub(crate) const TOKEN_SCALE: f64 = 1e6;
pub(crate) const MAX_NEWTON_ITERATIONS: usize = 100;
const RIDGE_ALPHA: f64 = 1e-6;
const STEP_TOLERANCE: f64 = 1e-10;
// Each one-hot source adds a dense column; Newton's Hessian is O(rows · width²) per step.
pub(crate) const MAX_FIT_SOURCES: usize = 20;
/// Predicted sizes are clamped to [1, 1e12] tokens. Finite fitted coefficients can still push
/// `exp` of the linear predictor to 0 or ∞ on features unlike the training data, and every
/// downstream estimate (log size, cost) needs a positive finite size.
const MIN_SESSION_TOKENS: f64 = 1.0;
const MAX_SESSION_TOKENS: f64 = 1e12;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SourceEffect {
    pub source: Source,
    pub coef: f64,
}

/// Expected session size. Tagged so richer models can be added without breaking stored plans.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SizeModel {
    /// log E[tokens/1e6] = intercept + effect(source) + p_long·p_long; baseline source has no effect.
    PoissonGlm {
        baseline: Source,
        intercept: f64,
        source_effects: Vec<SourceEffect>,
        p_long: f64,
    },
}

impl SizeModel {
    /// Expected tokens in [`MIN_SESSION_TOKENS`, `MAX_SESSION_TOKENS`]; a source unseen in
    /// training gets the baseline's (zero) effect.
    pub(crate) fn predict(&self, features: &SessionFeatures) -> f64 {
        match self {
            Self::PoissonGlm {
                intercept,
                source_effects,
                p_long,
                ..
            } => {
                let effect = source_effects
                    .iter()
                    .find(|e| e.source == features.source)
                    .map_or(0.0, |e| e.coef);
                ((intercept + effect + p_long * features.p_long.get()).exp() * TOKEN_SCALE)
                    .clamp(MIN_SESSION_TOKENS, MAX_SESSION_TOKENS)
            }
        }
    }

    pub(crate) fn coefficients(&self) -> Vec<f64> {
        match self {
            Self::PoissonGlm {
                intercept,
                source_effects,
                p_long,
                ..
            } => std::iter::once(*intercept)
                .chain(source_effects.iter().map(|e| e.coef))
                .chain(std::iter::once(*p_long))
                .collect(),
        }
    }
}

/// Poisson GLM on [1, one-hot(source ≠ baseline), p_long], sources lexicographic after the baseline.
/// Only the `MAX_FIT_SOURCES` most frequent non-baseline sources (ties by label) get a column;
/// the rest are fit, and later predicted, as the baseline.
pub(crate) fn fit_size(
    rows: &[HistoryRow],
    baseline: &Source,
    max_iterations: usize,
) -> Result<SizeModel, RouterError> {
    let mut counts: BTreeMap<&Source, usize> = BTreeMap::new();
    for r in rows {
        *counts.entry(&r.features.source).or_default() += 1;
    }
    if !counts.contains_key(baseline) {
        return Err(RouterError::BaselineSourceMissing(baseline.0.clone()));
    }
    let mut ranked: Vec<(&Source, usize)> =
        counts.into_iter().filter(|(s, _)| *s != baseline).collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    ranked.truncate(MAX_FIT_SOURCES);
    let mut others: Vec<&Source> = ranked.into_iter().map(|(s, _)| s).collect();
    others.sort();
    let width = others.len() + 2;
    let design: Vec<Vec<f64>> = rows
        .iter()
        .map(|r| {
            let mut x = vec![0.0; width];
            x[0] = 1.0;
            if let Ok(j) = others.binary_search(&&r.features.source) {
                x[1 + j] = 1.0;
            }
            x[width - 1] = r.features.p_long.get();
            x
        })
        .collect();
    let y: Vec<f64> = rows
        .iter()
        .map(|r| r.total_tokens() / TOKEN_SCALE)
        .collect();
    let b = fit_poisson(&design, &y, max_iterations)?;
    Ok(SizeModel::PoissonGlm {
        baseline: baseline.clone(),
        intercept: b[0],
        source_effects: others
            .iter()
            .zip(&b[1..width - 1])
            .map(|(s, &coef)| SourceEffect {
                source: (*s).clone(),
                coef,
            })
            .collect(),
        p_long: b[width - 1],
    })
}

/// Newton with step halving on (1/(2n))·Σ deviance + (α/2)·‖b₁..‖² (intercept b₀ unpenalized).
fn fit_poisson(x: &[Vec<f64>], y: &[f64], max_iterations: usize) -> Result<Vec<f64>, RouterError> {
    let n = y.len() as f64;
    let width = x.first().map_or(0, Vec::len);
    let mean_y = y.iter().sum::<f64>() / n;
    if mean_y.is_nan() || mean_y <= 0.0 {
        return Err(RouterError::EmptyTokenHistory);
    }
    let dot = |row: &[f64], b: &[f64]| row.iter().zip(b).map(|(a, c)| a * c).sum::<f64>();
    let penalty = |b: &[f64]| 0.5 * RIDGE_ALPHA * b[1..].iter().map(|v| v * v).sum::<f64>();
    // deviance up to terms constant in b
    let objective = |b: &[f64]| {
        x.iter()
            .zip(y)
            .map(|(row, yi)| {
                let eta = dot(row, b);
                eta.exp() - yi * eta
            })
            .sum::<f64>()
            / n
            + penalty(b)
    };

    let mut b = vec![0.0; width];
    b[0] = mean_y.ln();
    let ridge = RIDGE_ALPHA.sqrt();
    for _ in 0..max_iterations {
        // The Newton step solves H·s = −g as least squares on [√(μ/n)·X; √α·I₁..] with the
        // residual [(y − μ)/√(nμ); −√α·b₁..], whose normal equations are exactly H and −g.
        // μ is floored at f64::EPSILON (as R's glm does) so the residual stays finite; the
        // gradient stays exact and only the curvature of vanishing-mean rows moves.
        let mu: Vec<f64> = x.iter().map(|row| dot(row, &b).exp()).collect();
        let rows = x.len();
        let design = DMatrix::from_fn(rows + width - 1, width, |i, j| match i < rows {
            true => (mu[i].max(f64::EPSILON) / n).sqrt() * x[i][j],
            false if j == i - rows + 1 => ridge,
            false => 0.0,
        });
        let residual = DVector::from_fn(rows + width - 1, |i, _| match i < rows {
            true => (y[i] - mu[i]) / (n * mu[i].max(f64::EPSILON)).sqrt(),
            false => -ridge * b[i - rows + 1],
        });
        let step = least_squares(design, residual).ok_or(RouterError::SingularSizeModel)?;
        let step_size = step.iter().fold(0.0_f64, |m, s| m.max(s.abs()));
        let current = objective(&b);
        let mut t = 1.0;
        loop {
            let candidate: Vec<f64> = b.iter().zip(step.iter()).map(|(v, s)| v + t * s).collect();
            if t * step_size < STEP_TOLERANCE {
                return Ok(candidate);
            }
            if objective(&candidate) <= current {
                b = candidate;
                break;
            }
            t *= 0.5;
        }
    }
    Err(RouterError::NotConverged {
        iterations: max_iterations,
    })
}

/// Linear model of the token-weighted long-prompt share, clipped to [0, 1].
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LongShareModel {
    pub intercept: f64,
    pub log_size: f64,
    pub is_subagent: f64,
}

impl LongShareModel {
    pub(crate) fn predict(&self, size_tokens: f64, kind: SessionKind) -> f64 {
        (self.intercept + self.log_size * size_tokens.ln() + self.is_subagent * kind.indicator())
            .clamp(0.0, 1.0)
    }

    pub(crate) fn coefficients(&self) -> [f64; 3] {
        [self.intercept, self.log_size, self.is_subagent]
    }
}

/// Token-weighted least squares of long share on [1, log E[size], is_subagent], solved as
/// ordinary least squares on √w-scaled rows. Column priority is that order: a column that is
/// (numerically) a linear combination of the ones before it — zero variance, or e.g. log size
/// affine in is_subagent — gets coefficient 0.
pub(crate) fn fit_long_share(
    rows: &[HistoryRow],
    sizes: &[f64],
) -> Result<LongShareModel, RouterError> {
    let weighted: Vec<(f64, [f64; 3], f64)> = rows
        .iter()
        .zip(sizes)
        .filter_map(|(r, &size)| {
            let w = r.total_tokens();
            (w > 0.0).then(|| {
                let root = w.sqrt();
                let x = [1.0, size.ln(), r.features.kind.indicator()];
                (root, x, r.long.total() / w)
            })
        })
        .collect();
    let design = DMatrix::from_fn(weighted.len(), 3, |i, j| weighted[i].0 * weighted[i].1[j]);
    let target = DVector::from_fn(weighted.len(), |i, _| weighted[i].0 * weighted[i].2);
    let coef = least_squares(design, target).ok_or(RouterError::SingularLongShare)?;
    Ok(LongShareModel {
        intercept: coef[0],
        log_size: coef[1],
        is_subagent: coef[2],
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenMixes {
    pub short: TokenMix,
    pub long: TokenMix,
}

impl TokenMixes {
    pub(crate) fn values(&self) -> [f64; 8] {
        let [a, b, c, d] = self.short.values();
        let [e, f, g, h] = self.long.values();
        [a, b, c, d, e, f, g, h]
    }
}

/// An empty block borrows the other block's mix.
pub(crate) fn fit_mixes(rows: &[HistoryRow]) -> Result<TokenMixes, RouterError> {
    let short = block_mix(rows.iter().map(|r| &r.short));
    let long = block_mix(rows.iter().map(|r| &r.long));
    match (short, long) {
        (Some(short), Some(long)) => Ok(TokenMixes { short, long }),
        (Some(mix), None) | (None, Some(mix)) => Ok(TokenMixes {
            short: mix,
            long: mix,
        }),
        (None, None) => Err(RouterError::EmptyTokenHistory),
    }
}

fn block_mix<'a>(blocks: impl Iterator<Item = &'a TokenCounts>) -> Option<TokenMix> {
    let mut sums = [0.0; 4];
    for block in blocks {
        for (sum, v) in sums.iter_mut().zip(block.values()) {
            *sum += v as f64;
        }
    }
    let total: f64 = sums.iter().sum();
    (total > 0.0).then(|| TokenMix::from_values(sums.map(|s| s / total)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Probability, TierNeeded};

    fn row(source: &str, kind: SessionKind, p_long: f64, short: u64, long: u64) -> HistoryRow {
        let counts = |n: u64| TokenCounts {
            input: n,
            cache_read: 2 * n,
            cache_write: 0,
            output: n / 2,
        };
        HistoryRow {
            features: SessionFeatures {
                tier_needed: TierNeeded::new([0.2, 0.3, 0.5]).unwrap(),
                p_long: Probability::new(p_long).unwrap(),
                kind,
                source: Source(source.into()),
            },
            short: counts(short),
            long: counts(long),
            timestamp_ms: 0,
        }
    }

    #[test]
    fn empty_long_block_uses_short_mix_and_vice_versa() {
        let short_only = [row("a", SessionKind::Main, 0.0, 100, 0)];
        let mixes = fit_mixes(&short_only).unwrap();
        assert_eq!(mixes.long, mixes.short);
        assert_eq!(mixes.short.cache_read, 2.0 / 3.5);

        let long_only = [row("a", SessionKind::Main, 0.0, 0, 100)];
        let mixes = fit_mixes(&long_only).unwrap();
        assert_eq!(mixes.short, mixes.long);

        let empty = [row("a", SessionKind::Main, 0.0, 0, 0)];
        assert_eq!(fit_mixes(&empty), Err(RouterError::EmptyTokenHistory));
    }

    #[test]
    fn long_share_drops_zero_variance_columns() {
        let rows = [
            row("a", SessionKind::Main, 0.0, 300, 100),
            row("a", SessionKind::Main, 0.0, 100, 100),
            row("a", SessionKind::Main, 0.0, 900, 100),
        ];
        let model = fit_long_share(&rows, &[1e5, 2e5, 4e5]).unwrap();
        assert_eq!(model.is_subagent, 0.0);
        assert!(model.log_size != 0.0);

        let same_size = fit_long_share(&rows, &[1e5, 1e5, 1e5]).unwrap();
        let (tokens, long) = (3.5 * 1600.0, 3.5 * 300.0);
        assert!((same_size.intercept - long / tokens).abs() < 1e-15);
        assert_eq!((same_size.log_size, same_size.is_subagent), (0.0, 0.0));
    }

    #[test]
    fn collinear_long_share_regressors_drop_the_dependent_column() {
        // log size is affine in is_subagent: each population has one size and one share
        let rows = [
            row("a", SessionKind::Main, 0.0, 300, 100),
            row("a", SessionKind::Main, 0.0, 600, 200),
            row("b", SessionKind::Subagent, 0.0, 100, 100),
            row("b", SessionKind::Subagent, 0.0, 200, 200),
        ];
        let sizes = [1e5, 1e5, 2e5, 2e5];
        let model = fit_long_share(&rows, &sizes).unwrap();
        assert_eq!(model.is_subagent, 0.0);
        for (r, &size) in rows.iter().zip(&sizes) {
            let observed = r.long.total() / r.total_tokens();
            assert!((model.predict(size, r.features.kind) - observed).abs() < 1e-12);
        }

        assert_eq!(
            fit_long_share(&[], &[]),
            Err(RouterError::SingularLongShare)
        );
    }

    #[test]
    fn near_collinear_long_share_regressors_stay_bounded() {
        // as above, but one subagent size is off by a relative 3e-6: log size is almost, not
        // exactly, affine in is_subagent, and that sliver alone would "explain" the subagent
        // share spread with a huge offsetting log_size / is_subagent pair
        let rows = [
            row("a", SessionKind::Main, 0.0, 300, 100),
            row("a", SessionKind::Main, 0.0, 600, 100),
            row("b", SessionKind::Subagent, 0.0, 100, 100),
            row("b", SessionKind::Subagent, 0.0, 300, 100),
        ];
        let exact = fit_long_share(&rows, &[1e5, 1e5, 2e5, 2e5]).unwrap();
        let near = fit_long_share(&rows, &[1e5, 1e5, 2e5, 2e5 * (1.0 + 3e-6)]).unwrap();
        for (a, b) in near.coefficients().iter().zip(exact.coefficients()) {
            assert!((a - b).abs() < 1e-4, "{near:?} vs {exact:?}");
        }
    }

    #[test]
    fn poisson_matches_closed_form_and_reports_non_convergence() {
        let rows = [
            row("base", SessionKind::Main, 0.0, 1000, 0),
            row("base", SessionKind::Main, 0.0, 3000, 0),
            row("other", SessionKind::Main, 0.0, 8000, 0),
        ];
        let baseline = Source("base".into());
        let model = fit_size(&rows, &baseline, MAX_NEWTON_ITERATIONS).unwrap();
        let scale = 3.5 / TOKEN_SCALE;
        let SizeModel::PoissonGlm {
            intercept,
            source_effects,
            ..
        } = &model;
        // ridge 1e-6 biases the closed-form group-mean solution only slightly
        assert!((intercept - (2000.0 * scale).ln()).abs() < 1e-3);
        assert!((source_effects[0].coef - 4.0_f64.ln()).abs() < 1e-3);

        assert_eq!(
            fit_size(&rows, &baseline, 1),
            Err(RouterError::NotConverged { iterations: 1 })
        );
        assert_eq!(
            fit_size(&rows, &Source("missing".into()), MAX_NEWTON_ITERATIONS),
            Err(RouterError::BaselineSourceMissing("missing".into()))
        );
    }

    /// s00..s03 seen once, s04/s05 twice, s06..s24 three times: the cap keeps s06..s24 plus s04,
    /// which wins the count tie with s05 on label.
    fn many_sources() -> Vec<HistoryRow> {
        let mut rows = vec![row("base", SessionKind::Main, 0.0, 1000, 0)];
        for i in 0..MAX_FIT_SOURCES + 5 {
            let repeats = match i {
                0..4 => 1,
                4..6 => 2,
                _ => 3,
            };
            for k in 0..repeats {
                let tokens = 1000 + 100 * i as u64 + 10 * k;
                rows.push(row(&format!("s{i:02}"), SessionKind::Main, 0.0, tokens, 0));
            }
        }
        rows
    }

    fn retained(model: &SizeModel) -> Vec<String> {
        let SizeModel::PoissonGlm { source_effects, .. } = model;
        source_effects.iter().map(|e| e.source.0.clone()).collect()
    }

    #[test]
    fn source_dimensions_are_capped_to_most_frequent() {
        let rows = many_sources();
        let baseline = Source("base".into());
        let model = fit_size(&rows, &baseline, MAX_NEWTON_ITERATIONS).unwrap();
        let expected: Vec<String> = std::iter::once(4)
            .chain(6..MAX_FIT_SOURCES + 5)
            .map(|i| format!("s{i:02}"))
            .collect();
        assert_eq!(retained(&model), expected);

        let reversed: Vec<HistoryRow> = rows.iter().rev().cloned().collect();
        let model_reversed = fit_size(&reversed, &baseline, MAX_NEWTON_ITERATIONS).unwrap();
        assert_eq!(retained(&model_reversed), expected);

        let mut features = rows[0].features.clone();
        let baseline_prediction = model.predict(&features);
        for dropped in ["s00", "s05"] {
            features.source = Source(dropped.into());
            assert_eq!(model.predict(&features), baseline_prediction);
        }
    }

    #[test]
    fn extreme_linear_predictors_stay_positive_and_finite() {
        let model = |p_long: f64| SizeModel::PoissonGlm {
            baseline: Source("base".into()),
            intercept: -7.0,
            source_effects: vec![],
            p_long,
        };
        let mut features = row("base", SessionKind::Main, 1.0, 0, 0).features;
        assert_eq!(model(1178.0).predict(&features), MAX_SESSION_TOKENS);
        assert_eq!(model(-1178.0).predict(&features), MIN_SESSION_TOKENS);
        features.p_long = Probability::new(0.0).unwrap();
        assert!((model(1178.0).predict(&features) - (-7.0_f64).exp() * TOKEN_SCALE).abs() < 1e-9);
    }

    #[test]
    fn unknown_source_predicts_as_baseline() {
        let rows = [
            row("base", SessionKind::Main, 0.0, 1000, 0),
            row("other", SessionKind::Main, 0.0, 8000, 0),
        ];
        let model = fit_size(&rows, &Source("base".into()), MAX_NEWTON_ITERATIONS).unwrap();
        let mut features = rows[0].features.clone();
        let baseline = model.predict(&features);
        features.source = Source("never-seen".into());
        assert_eq!(model.predict(&features), baseline);
    }
}
