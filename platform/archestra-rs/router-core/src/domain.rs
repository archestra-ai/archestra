use serde::{Deserialize, Serialize};

use crate::RouterError;

pub const TIER_COUNT: usize = 3;
const TIER_NEEDED_SUM_TOLERANCE: f64 = 1e-6;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenTypes<T> {
    pub input: T,
    pub cache_read: T,
    pub cache_write: T,
    pub output: T,
}

impl<T: Copy> TokenTypes<T> {
    pub(crate) fn values(&self) -> [T; 4] {
        [self.input, self.cache_read, self.cache_write, self.output]
    }

    pub(crate) fn from_values([input, cache_read, cache_write, output]: [T; 4]) -> Self {
        Self {
            input,
            cache_read,
            cache_write,
            output,
        }
    }
}

pub type TokenCounts = TokenTypes<u64>;
pub type TokenPrices = TokenTypes<UsdPerMTok>;
/// Shares of each token type within one prompt-size block; sums to 1.
pub type TokenMix = TokenTypes<f64>;

impl TokenCounts {
    pub(crate) fn total(&self) -> f64 {
        self.values().iter().map(|&v| v as f64).sum()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct UsdPerMTok(f64);

impl UsdPerMTok {
    pub fn new(value: f64) -> Result<Self, RouterError> {
        match value.is_finite() && value >= 0.0 {
            true => Ok(Self(value)),
            false => Err(RouterError::InvalidPrice(value)),
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for UsdPerMTok {
    type Error = RouterError;
    fn try_from(value: f64) -> Result<Self, RouterError> {
        Self::new(value)
    }
}

impl From<UsdPerMTok> for f64 {
    fn from(value: UsdPerMTok) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct UsdPerDay(f64);

impl UsdPerDay {
    pub fn new(value: f64) -> Result<Self, RouterError> {
        match value.is_finite() && value >= 0.0 {
            true => Ok(Self(value)),
            false => Err(RouterError::InvalidBudget(value)),
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for UsdPerDay {
    type Error = RouterError;
    fn try_from(value: f64) -> Result<Self, RouterError> {
        Self::new(value)
    }
}

impl From<UsdPerDay> for f64 {
    fn from(value: UsdPerDay) -> Self {
        value.0
    }
}

/// A strictly positive daily rate (sessions or tokens per day).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct PerDay(f64);

impl PerDay {
    pub fn new(value: f64) -> Result<Self, RouterError> {
        match value.is_finite() && value > 0.0 {
            true => Ok(Self(value)),
            false => Err(RouterError::InvalidVolume(value)),
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for PerDay {
    type Error = RouterError;
    fn try_from(value: f64) -> Result<Self, RouterError> {
        Self::new(value)
    }
}

impl From<PerDay> for f64 {
    fn from(value: PerDay) -> Self {
        value.0
    }
}

/// How many sessions a history row stands for: 1 for an observed session, the inverse inclusion
/// probability for a sampled one. Strictly positive and finite.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct SessionWeight(f64);

impl SessionWeight {
    pub fn new(value: f64) -> Result<Self, RouterError> {
        match value.is_finite() && value > 0.0 {
            true => Ok(Self(value)),
            false => Err(RouterError::InvalidWeight(value)),
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for SessionWeight {
    type Error = RouterError;
    fn try_from(value: f64) -> Result<Self, RouterError> {
        Self::new(value)
    }
}

impl From<SessionWeight> for f64 {
    fn from(value: SessionWeight) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Probability(f64);

impl Probability {
    pub fn new(value: f64) -> Result<Self, RouterError> {
        match (0.0..=1.0).contains(&value) {
            true => Ok(Self(value)),
            false => Err(RouterError::InvalidProbability(value)),
        }
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for Probability {
    type Error = RouterError;
    fn try_from(value: f64) -> Result<Self, RouterError> {
        Self::new(value)
    }
}

impl From<Probability> for f64 {
    fn from(value: Probability) -> Self {
        value.0
    }
}

/// Distribution of the weakest adequate tier, in capability order (fast, normal, smart).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "[f64; TIER_COUNT]", into = "[f64; TIER_COUNT]")]
pub struct TierNeeded([f64; TIER_COUNT]);

impl TierNeeded {
    /// Renormalizes a sum within 1e-6 of one; rejects anything else.
    pub fn new(p: [f64; TIER_COUNT]) -> Result<Self, RouterError> {
        let sum = p[0] + p[1] + p[2];
        let valid = p.iter().all(|v| v.is_finite() && *v >= 0.0)
            && (sum - 1.0).abs() <= TIER_NEEDED_SUM_TOLERANCE;
        match valid {
            true => Ok(Self(p.map(|v| v / sum))),
            false => Err(RouterError::InvalidTierNeeded(p)),
        }
    }

    pub(crate) fn probabilities(&self) -> [f64; TIER_COUNT] {
        self.0
    }

    /// P(tier t is adequate) = P(weakest adequate tier ≤ t).
    pub(crate) fn adequacy(&self) -> [f64; TIER_COUNT] {
        let [fast, normal, smart] = self.0;
        let normal = fast + normal;
        [fast, normal, normal + smart]
    }
}

impl TryFrom<[f64; TIER_COUNT]> for TierNeeded {
    type Error = RouterError;
    fn try_from(p: [f64; TIER_COUNT]) -> Result<Self, RouterError> {
        Self::new(p)
    }
}

impl From<TierNeeded> for [f64; TIER_COUNT] {
    fn from(t: TierNeeded) -> Self {
        t.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ModelId(String);

impl ModelId {
    pub fn new(id: String) -> Result<Self, RouterError> {
        match id.is_empty() {
            true => Err(RouterError::EmptyModelId),
            false => Ok(Self(id)),
        }
    }
}

impl TryFrom<String> for ModelId {
    type Error = RouterError;
    fn try_from(id: String) -> Result<Self, RouterError> {
        Self::new(id)
    }
}

impl From<ModelId> for String {
    fn from(id: ModelId) -> Self {
        id.0
    }
}

/// Session origin (client), one-hot encoded by the size model.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Source(pub String);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionFeatures {
    pub tier_needed: TierNeeded,
    pub p_long: Probability,
    pub source: Source,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryRow {
    pub features: SessionFeatures,
    pub short: TokenCounts,
    pub long: TokenCounts,
    pub timestamp_ms: i64,
    pub weight: SessionWeight,
}

impl HistoryRow {
    pub(crate) fn total_tokens(&self) -> f64 {
        self.short.total() + self.long.total()
    }

    pub(crate) fn weight(&self) -> f64 {
        self.weight.get()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TierSpec {
    pub model_id: ModelId,
    pub short: TokenPrices,
    /// Prices once the prompt passes the tier set's long-context threshold.
    pub long: Option<TokenPrices>,
}

/// The ordered trio (fast, normal, smart). Doubles as the plan's tiers fingerprint.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "TierSetFields")]
pub struct TierSet {
    tiers: [TierSpec; TIER_COUNT],
    long_context_threshold: Option<u64>,
}

#[derive(Deserialize)]
struct TierSetFields {
    tiers: [TierSpec; TIER_COUNT],
    long_context_threshold: Option<u64>,
}

impl TierSet {
    /// The threshold must be positive and present exactly when some tier has long prices.
    pub fn new(
        tiers: [TierSpec; TIER_COUNT],
        long_context_threshold: Option<u64>,
    ) -> Result<Self, RouterError> {
        let any_long = tiers.iter().any(|t| t.long.is_some());
        match (any_long, long_context_threshold) {
            (true, Some(threshold)) if threshold > 0 => Ok(Self {
                tiers,
                long_context_threshold,
            }),
            (false, None) => Ok(Self {
                tiers,
                long_context_threshold,
            }),
            _ => Err(RouterError::LongContextThresholdMismatch),
        }
    }

    pub(crate) fn tiers(&self) -> &[TierSpec; TIER_COUNT] {
        &self.tiers
    }
}

impl TryFrom<TierSetFields> for TierSet {
    type Error = RouterError;
    fn try_from(f: TierSetFields) -> Result<Self, RouterError> {
        Self::new(f.tiers, f.long_context_threshold)
    }
}

/// Daily traffic the policy is sized for. Tagged so seasonal profiles can be added later.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Volume {
    Flat {
        sessions_per_day: PerDay,
        tokens_per_day: PerDay,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanInput {
    pub history: Vec<HistoryRow>,
    pub tiers: TierSet,
    pub budget: UsdPerDay,
    pub volume: Volume,
    pub baseline_source: Source,
}
