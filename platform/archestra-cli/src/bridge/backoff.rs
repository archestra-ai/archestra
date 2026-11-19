//! Bounded exponential backoff with jitter, for retries and restarts.

use std::time::Duration;

/// The delay doubles with each failed attempt, from `initial` up to `max`.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
}

impl Backoff {
    /// The delay before the next try, after `failures` failed tries in a row.
    /// The result is between half of the bounded delay and the bounded delay.
    pub(crate) fn delay(&self, failures: u32) -> Duration {
        let doublings = failures.saturating_sub(1).min(16);
        let ceiling = self.initial.saturating_mul(1u32 << doublings).min(self.max);
        let half = ceiling / 2;
        half + half.mul_f64(fastrand::f64())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BACKOFF: Backoff = Backoff {
        initial: Duration::from_millis(100),
        max: Duration::from_secs(2),
    };

    #[test]
    fn delay_grows_and_stays_in_bounds() {
        for (failures, ceiling_ms) in [(1, 100), (2, 200), (3, 400), (5, 1600), (6, 2000)] {
            let ceiling = Duration::from_millis(ceiling_ms);
            for _ in 0..50 {
                let delay = BACKOFF.delay(failures);
                assert!(delay >= ceiling / 2, "{failures}: {delay:?}");
                assert!(delay <= ceiling, "{failures}: {delay:?}");
            }
        }
    }

    #[test]
    fn delay_does_not_overflow() {
        assert!(BACKOFF.delay(u32::MAX) <= BACKOFF.max);
        assert!(BACKOFF.delay(0) <= BACKOFF.initial);
    }
}
