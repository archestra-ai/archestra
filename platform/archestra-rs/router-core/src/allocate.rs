//! Allocator: per-session upper hulls of the estimated (cost, value) points, the exact LP solve
//! for the budget's dual price λ* and tie probability q, and routing one session with them.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::RouterError;
use crate::domain::TIER_COUNT;

/// Dual-price policy: take every upgrade whose breakpoint is above `lam_star`; the tied
/// upgrade exactly at `lam_star` is taken with probability `q`. A plan's own policy is the
/// LP optimum λ*; callers may route with another λ (e.g. a pacing controller's λ_t).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub lam_star: f64,
    pub q: f64,
}

impl Policy {
    pub(crate) fn validate(&self) -> Result<(), RouterError> {
        match self.lam_star.is_finite() && self.lam_star >= 0.0 && (0.0..=1.0).contains(&self.q) {
            true => Ok(()),
            false => Err(RouterError::InvalidPolicy {
                lam_star: self.lam_star,
                q: self.q,
            }),
        }
    }
}

/// Upper-left convex hull of a session's (price, adequacy) points, ascending in price.
/// `breakpoints[j]` = Δa/Δπ of the upgrade `vertices[j] → vertices[j + 1]`, strictly decreasing.
#[derive(Debug, PartialEq)]
pub(crate) struct Hull {
    pub(crate) vertices: Vec<usize>,
    pub(crate) breakpoints: Vec<f64>,
}

impl Hull {
    pub(crate) fn new(price: [f64; TIER_COUNT], adequacy: [f64; TIER_COUNT]) -> Self {
        // ties in both coordinates keep the lower capability index
        let dominated = |t: usize| {
            (0..TIER_COUNT).any(|s| {
                s != t
                    && price[s] <= price[t]
                    && adequacy[s] >= adequacy[t]
                    && (price[s] < price[t] || adequacy[s] > adequacy[t] || s < t)
            })
        };
        let mut candidates: Vec<usize> = (0..TIER_COUNT).filter(|&t| !dominated(t)).collect();
        candidates.sort_by(|&a, &b| price[a].total_cmp(&price[b]));
        let slope =
            |from: usize, to: usize| (adequacy[to] - adequacy[from]) / (price[to] - price[from]);
        let mut vertices: Vec<usize> = Vec::with_capacity(TIER_COUNT);
        for t in candidates {
            while let [.., before, last] = vertices[..] {
                match slope(before, last) <= slope(last, t) {
                    true => vertices.pop(),
                    false => break,
                };
            }
            vertices.push(t);
        }
        let breakpoints = vertices.windows(2).map(|w| slope(w[0], w[1])).collect();
        Self {
            vertices,
            breakpoints,
        }
    }

    pub(crate) fn route(&self, policy: &Policy) -> Route {
        let mut route = Route {
            base: self.vertices[0],
            tie: None,
        };
        for (lam, &next) in self.breakpoints.iter().zip(&self.vertices[1..]) {
            match lam.total_cmp(&policy.lam_star) {
                Ordering::Greater => route.base = next,
                Ordering::Equal => route.tie = Some(next),
                Ordering::Less => break,
            }
        }
        route
    }
}

/// `base` is always taken; `tie` (if any) replaces it with probability `q`.
pub(crate) struct Route {
    pub(crate) base: usize,
    pub(crate) tie: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Decision {
    pub tier_index: usize,
    /// Probability the policy picks this tier for this session: 1, q, or 1 − q.
    pub propensity: f64,
    /// The λ this session was routed with.
    pub lambda: f64,
    /// Predicted session tokens × the chosen tier's blended USD per token: the session's cost
    /// as the solver counts it.
    pub expected_cost_usd: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Draw {
    pub(crate) tier_index: usize,
    /// Probability the policy picks this tier for this session: 1, q, or 1 − q.
    pub(crate) propensity: f64,
}

impl Route {
    /// `u` must be uniform on [0, 1).
    pub(crate) fn draw(&self, q: f64, u: f64) -> Draw {
        match self.tie {
            Some(tie) if u < q => Draw {
                tier_index: tie,
                propensity: q,
            },
            Some(_) => Draw {
                tier_index: self.base,
                propensity: 1.0 - q,
            },
            None => Draw {
                tier_index: self.base,
                propensity: 1.0,
            },
        }
    }
}

/// A session as the solver sees it: hull plus its share of daily tokens.
pub(crate) struct WeightedSession<'a> {
    pub(crate) hull: &'a Hull,
    pub(crate) price: [f64; TIER_COUNT],
    pub(crate) adequacy: [f64; TIER_COUNT],
    pub(crate) tokens_per_day: f64,
}

/// The most token-weighted mean adequacy `spend` USD/day buys under the LP relaxation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrontierPoint {
    pub spend: f64,
    pub value: f64,
}

/// How far below the exact frontier a straight line between two kept points may fall: 0.05
/// quality points.
const FRONTIER_TOLERANCE: f64 = 0.0005;

/// Upgrade steps above the all-cheapest spend, built once for both `solve` and `frontier`.
pub(crate) struct Steps {
    cheapest: f64,
    /// `(breakpoint, USD/day)`, by descending breakpoint.
    steps: Vec<(f64, f64)>,
}

impl Steps {
    /// Fails before building anything when the all-cheapest routing already exceeds `budget`.
    pub(crate) fn within(sessions: &[WeightedSession], budget: f64) -> Result<Self, RouterError> {
        let cheapest: f64 = sessions
            .iter()
            .map(|s| s.tokens_per_day * s.price[s.hull.vertices[0]])
            .sum();
        if cheapest > budget {
            return Err(RouterError::Infeasible {
                cheapest_spend: cheapest,
                budget,
            });
        }
        let mut steps: Vec<(f64, f64)> = sessions
            .iter()
            .flat_map(|s| {
                s.hull
                    .breakpoints
                    .iter()
                    .zip(s.hull.vertices.windows(2))
                    .map(|(&lam, w)| (lam, s.tokens_per_day * (s.price[w[1]] - s.price[w[0]])))
            })
            .collect();
        steps.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(Self { cheapest, steps })
    }
}

/// Exact solve of the LP relaxation: walk all upgrade steps by descending breakpoint from the
/// all-cheapest spend until the budget is crossed.
pub(crate) fn solve(steps: &Steps, budget: f64) -> Policy {
    let mut spend = steps.cheapest;
    for group in steps.steps.chunk_by(|a, b| a.0 == b.0) {
        let cost: f64 = group.iter().map(|(_, c)| c).sum();
        if spend + cost > budget {
            return Policy {
                lam_star: group[0].0,
                q: (budget - spend) / cost,
            };
        }
        spend += cost;
    }
    Policy {
        lam_star: 0.0,
        q: 0.0,
    }
}

/// Value as a function of budget, from the all-cheapest spend to every upgrade taken: the walk
/// `solve` stops early, run to the end. Concave and piecewise linear; kept to the vertices a
/// straight line cannot skip without falling more than `FRONTIER_TOLERANCE` below it, plus the
/// exact point at `budget` (clamped to the curve), ascending in spend.
pub(crate) fn frontier(
    sessions: &[WeightedSession],
    steps: &Steps,
    budget: f64,
) -> Vec<FrontierPoint> {
    let tokens: f64 = sessions.iter().map(|s| s.tokens_per_day).sum();
    let start = FrontierPoint {
        spend: steps.cheapest,
        value: sessions
            .iter()
            .map(|s| s.tokens_per_day * s.adequacy[s.hull.vertices[0]])
            .sum::<f64>()
            / tokens,
    };
    let slopes: Vec<f64> = steps.steps.iter().map(|(lam, _)| lam / tokens).collect();
    let curve: Vec<FrontierPoint> = std::iter::once(start)
        .chain(
            steps
                .steps
                .iter()
                .zip(&slopes)
                .scan(start, |point, (&(_, cost), &slope)| {
                    *point = FrontierPoint {
                        spend: point.spend + cost,
                        value: point.value + slope * cost,
                    };
                    Some(*point)
                }),
        )
        .collect();
    let mut kept = thin(&curve, &slopes);
    let spend = budget.clamp(start.spend, curve[curve.len() - 1].spend);
    let at = kept.partition_point(|p| p.spend < spend);
    if kept.get(at).map(|p| p.spend) != Some(spend) {
        let value = value_at(&curve, spend);
        kept.insert(at, FrontierPoint { spend, value });
    }
    kept
}

/// Greedy over a concave curve with `slopes[i]` between `curve[i]` and `curve[i + 1]`. Between
/// two kept points the curve lies under both end tangents, so the chord falls at most
/// (slope leaving the first − slope entering the second) × (spend between them) / 4 below it.
fn thin(curve: &[FrontierPoint], slopes: &[f64]) -> Vec<FrontierPoint> {
    let mut kept = vec![curve[0]];
    let mut anchor = 0;
    for j in 1..curve.len() {
        let gap = (slopes[anchor] - slopes[j - 1]) * (curve[j].spend - curve[anchor].spend) / 4.0;
        if gap > FRONTIER_TOLERANCE {
            anchor = j - 1;
            kept.push(curve[anchor]);
        }
    }
    if curve.len() > 1 {
        kept.push(curve[curve.len() - 1]);
    }
    kept
}

/// Linear interpolation on the curve's vertices, held flat past either end.
fn value_at(vertices: &[FrontierPoint], spend: f64) -> f64 {
    match vertices.partition_point(|v| v.spend < spend) {
        0 => vertices[0].value,
        i if i == vertices.len() => vertices[i - 1].value,
        i => {
            let (a, b) = (vertices[i - 1], vertices[i]);
            match b.spend > a.spend {
                true => a.value + (b.value - a.value) * (spend - a.spend) / (b.spend - a.spend),
                false => b.value,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hull_drops_collinear_interior_vertex() {
        let hull = Hull::new([1.0, 2.0, 3.0], [0.25, 0.5, 0.75]);
        assert_eq!(hull.vertices, vec![0, 2]);
        assert_eq!(hull.breakpoints, vec![0.25]);
    }

    #[test]
    fn hull_drops_dominated_and_concave_vertices() {
        assert_eq!(
            Hull::new([1.0, 3.0, 2.0], [0.2, 0.5, 0.9]).vertices,
            vec![0, 2]
        );
        // normal sits below the fast→smart chord
        assert_eq!(
            Hull::new([1.0, 2.0, 3.0], [0.2, 0.3, 0.9]).vertices,
            vec![0, 2]
        );
        let concave = Hull::new([1.0, 2.0, 4.0], [0.2, 0.8, 1.0]);
        assert_eq!(concave.vertices, vec![0, 1, 2]);
        assert!(concave.breakpoints[0] > concave.breakpoints[1]);
    }

    #[test]
    fn identical_model_in_two_tiers_keeps_one() {
        // same prices, smart strictly more adequate: normal is dominated
        assert_eq!(
            Hull::new([1.0, 2.0, 2.0], [0.2, 0.6, 1.0]).vertices,
            vec![0, 2]
        );
        // same prices and adequacy: the lower capability index survives
        assert_eq!(
            Hull::new([1.0, 2.0, 2.0], [0.2, 1.0, 1.0]).vertices,
            vec![0, 1]
        );
    }

    #[test]
    fn tied_block_is_split_by_q() {
        let hull = Hull::new([1.0, 2.0, 3.0], [0.5, 0.875, 1.0]);
        let session = |w| WeightedSession {
            hull: &hull,
            price: [1.0, 2.0, 3.0],
            adequacy: [0.5, 0.875, 1.0],
            tokens_per_day: w,
        };
        let sessions = [session(1.0), session(1.0)];
        // cheapest 2, first block (λ = 0.375) costs 2, second (λ = 0.125) costs 2
        let solved = |budget| Steps::within(&sessions, budget).map(|steps| solve(&steps, budget));
        assert_eq!(
            solved(3.5),
            Ok(Policy {
                lam_star: 0.375,
                q: 0.75
            })
        );
        assert_eq!(
            solved(6.0),
            Ok(Policy {
                lam_star: 0.0,
                q: 0.0
            })
        );
        assert!(matches!(
            solved(1.0),
            Err(RouterError::Infeasible {
                cheapest_spend: 2.0,
                budget: 1.0
            })
        ));
    }

    #[test]
    fn frontier_is_concave_from_all_cheapest_to_all_best() {
        let (price_a, adequacy_a) = ([1.0, 2.0, 3.0], [0.5, 0.875, 1.0]);
        let (price_b, adequacy_b) = ([1.0, 2.0, 4.0], [0.2, 0.8, 1.0]);
        let (hull_a, hull_b) = (
            Hull::new(price_a, adequacy_a),
            Hull::new(price_b, adequacy_b),
        );
        let sessions = [
            WeightedSession {
                hull: &hull_a,
                price: price_a,
                adequacy: adequacy_a,
                tokens_per_day: 1.0,
            },
            WeightedSession {
                hull: &hull_b,
                price: price_b,
                adequacy: adequacy_b,
                tokens_per_day: 2.0,
            },
        ];
        let budget = 5.3;
        let at = |budget| {
            frontier(
                &sessions,
                &Steps::within(&sessions, budget).unwrap(),
                budget,
            )
        };
        let points = at(budget);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;

        let (first, last) = (points[0], points[points.len() - 1]);
        assert!(
            close(first.spend, 3.0) && close(first.value, 0.3),
            "{first:?}"
        );
        assert!(
            close(last.spend, 11.0) && close(last.value, 1.0),
            "{last:?}"
        );
        assert!(points.iter().any(|p| p.spend == budget));

        let slopes: Vec<f64> = points
            .windows(2)
            .map(|w| {
                assert!(w[1].spend > w[0].spend && w[1].value >= w[0].value, "{w:?}");
                (w[1].value - w[0].value) / (w[1].spend - w[0].spend)
            })
            .collect();
        assert!(
            slopes.windows(2).all(|s| s[1] <= s[0] + 1e-12),
            "{slopes:?}"
        );

        // a budget past every upgrade lands on the curve's end
        assert_eq!(at(1e9).last(), Some(&last));
    }

    #[test]
    fn thinning_keeps_a_sharp_vertex_between_distant_points() {
        // ($10, 0.5) → ($12, 0.8) → ($3210, 1.0): the chord over $12 would hide 30 points
        let curve = [
            FrontierPoint {
                spend: 10.0,
                value: 0.5,
            },
            FrontierPoint {
                spend: 12.0,
                value: 0.8,
            },
            FrontierPoint {
                spend: 3210.0,
                value: 1.0,
            },
        ];
        let kept = thin(&curve, &[0.15, 0.2 / 3198.0]);
        assert_eq!(kept, curve);
    }

    #[test]
    fn thinned_curve_stays_within_tolerance_below_the_exact_one() {
        // 2000 steps of shrinking slope: a smooth concave curve with many vertices
        let slopes: Vec<f64> = (1..=2000).map(|k| 1.0 / (k as f64).powi(2)).collect();
        let mut curve = vec![FrontierPoint {
            spend: 0.0,
            value: 0.0,
        }];
        for &slope in &slopes {
            let last = curve[curve.len() - 1];
            curve.push(FrontierPoint {
                spend: last.spend + 0.01,
                value: last.value + slope * 0.01,
            });
        }
        let kept = thin(&curve, &slopes);
        assert!(kept.len() < curve.len() / 10, "{}", kept.len());
        assert_eq!(
            (kept[0], kept[kept.len() - 1]),
            (curve[0], curve[curve.len() - 1])
        );
        for point in &curve {
            let gap = point.value - value_at(&kept, point.spend);
            assert!(
                (-1e-12..=FRONTIER_TOLERANCE).contains(&gap),
                "{point:?}: {gap}"
            );
        }
    }
}
