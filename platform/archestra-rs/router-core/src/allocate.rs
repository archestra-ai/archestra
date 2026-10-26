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
    pub(crate) tokens_per_day: f64,
}

/// Exact solve of the LP relaxation: walk all upgrade steps by descending breakpoint from the
/// all-cheapest spend until the budget is crossed.
pub(crate) fn solve(sessions: &[WeightedSession], budget: f64) -> Result<Policy, RouterError> {
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
    let mut spend = cheapest;
    for group in steps.chunk_by(|a, b| a.0 == b.0) {
        let cost: f64 = group.iter().map(|(_, c)| c).sum();
        if spend + cost > budget {
            return Ok(Policy {
                lam_star: group[0].0,
                q: (budget - spend) / cost,
            });
        }
        spend += cost;
    }
    Ok(Policy {
        lam_star: 0.0,
        q: 0.0,
    })
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
            tokens_per_day: w,
        };
        let sessions = [session(1.0), session(1.0)];
        // cheapest 2, first block (λ = 0.375) costs 2, second (λ = 0.125) costs 2
        let policy = solve(&sessions, 3.5).unwrap();
        assert_eq!(
            policy,
            Policy {
                lam_star: 0.375,
                q: 0.75
            }
        );
        assert_eq!(
            solve(&sessions, 6.0).unwrap(),
            Policy {
                lam_star: 0.0,
                q: 0.0
            }
        );
        assert_eq!(
            solve(&sessions, 1.0),
            Err(RouterError::Infeasible {
                cheapest_spend: 2.0,
                budget: 1.0
            })
        );
    }
}
