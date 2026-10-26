use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::RouterError;
use crate::domain::{HistoryRow, SessionFeatures, SessionKind, Source, TokenCounts, TokenMix};
use crate::linalg::solve_spd;

/// Sizes are fit in millions of tokens.
pub(crate) const TOKEN_SCALE: f64 = 1e6;
pub(crate) const MAX_NEWTON_ITERATIONS: usize = 100;
const RIDGE_ALPHA: f64 = 1e-6;
const STEP_TOLERANCE: f64 = 1e-10;

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
    /// Expected tokens; a source unseen in training gets the baseline's (zero) effect.
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
                (intercept + effect + p_long * features.p_long.get()).exp() * TOKEN_SCALE
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
pub(crate) fn fit_size(
    rows: &[HistoryRow],
    baseline: &Source,
    max_iterations: usize,
) -> Result<SizeModel, RouterError> {
    let sources: BTreeSet<&Source> = rows.iter().map(|r| &r.features.source).collect();
    if !sources.contains(baseline) {
        return Err(RouterError::BaselineSourceMissing(baseline.0.clone()));
    }
    let others: Vec<&Source> = sources.into_iter().filter(|s| *s != baseline).collect();
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
    for _ in 0..max_iterations {
        let mut gradient = vec![0.0; width];
        let mut hessian = vec![0.0; width * width];
        for (row, yi) in x.iter().zip(y) {
            let mu = dot(row, &b).exp();
            for j in 0..width {
                gradient[j] += (mu - yi) * row[j] / n;
                for k in 0..width {
                    hessian[j * width + k] += mu * row[j] * row[k] / n;
                }
            }
        }
        for j in 1..width {
            gradient[j] += RIDGE_ALPHA * b[j];
            hessian[j * width + j] += RIDGE_ALPHA;
        }
        let descent: Vec<f64> = gradient.iter().map(|g| -g).collect();
        let step = solve_spd(hessian, &descent).ok_or(RouterError::SingularSizeModel)?;
        let step_size = step.iter().fold(0.0_f64, |m, s| m.max(s.abs()));
        let current = objective(&b);
        let mut t = 1.0;
        loop {
            let candidate: Vec<f64> = b.iter().zip(&step).map(|(v, s)| v + t * s).collect();
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

/// Token-weighted least squares of long share on [1, log E[size], is_subagent]; zero-variance
/// regressors are dropped (coefficient 0).
pub(crate) fn fit_long_share(
    rows: &[HistoryRow],
    sizes: &[f64],
) -> Result<LongShareModel, RouterError> {
    let observations: Vec<(f64, f64, [f64; 3])> = rows
        .iter()
        .zip(sizes)
        .filter_map(|(r, &size)| {
            let total = r.total_tokens();
            (total > 0.0).then(|| {
                let x = [1.0, size.ln(), r.features.kind.indicator()];
                (total, r.long.total() / total, x)
            })
        })
        .collect();
    let Some((_, _, first)) = observations.first() else {
        return Err(RouterError::SingularLongShare);
    };
    let columns: Vec<usize> = std::iter::once(0)
        .chain((1..3).filter(|&c| observations.iter().any(|(_, _, x)| x[c] != first[c])))
        .collect();
    let m = columns.len();
    let mut normal = vec![0.0; m * m];
    let mut rhs = vec![0.0; m];
    for (w, share, x) in &observations {
        for (i, &ci) in columns.iter().enumerate() {
            rhs[i] += w * x[ci] * share;
            for (j, &cj) in columns.iter().enumerate() {
                normal[i * m + j] += w * x[ci] * x[cj];
            }
        }
    }
    let solution = solve_spd(normal, &rhs).ok_or(RouterError::SingularLongShare)?;
    let mut coef = [0.0; 3];
    for (&c, v) in columns.iter().zip(solution) {
        coef[c] = v;
    }
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
    fn collinear_long_share_regressors_are_singular() {
        let rows = [
            row("a", SessionKind::Main, 0.0, 300, 100),
            row("b", SessionKind::Subagent, 0.0, 100, 100),
        ];
        assert_eq!(
            fit_long_share(&rows, &[1e5, 2e5]),
            Err(RouterError::SingularLongShare)
        );
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
