//! A wait for something that a different process does: the commands
//! `bridge start` and `bridge stop` look again until it happened.

use std::time::{Duration, Instant};

/// Calls `check` until it gives a value, with a pause of `interval` after
/// each call that gives none. `None`: no value came in `timeout`. The first
/// call is at once, so a `timeout` of zero is one call. An error of `check`
/// ends the wait.
pub(crate) fn wait_until<T, E>(
    timeout: Duration,
    interval: Duration,
    mut check: impl FnMut() -> Result<Option<T>, E>,
) -> Result<Option<T>, E> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = check()? {
            return Ok(Some(value));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEP: Duration = Duration::from_millis(1);

    #[test]
    fn gives_the_value_of_the_first_check_that_has_one() {
        let mut calls = 0;
        let value = wait_until(Duration::from_secs(30), STEP, || {
            calls += 1;
            Ok::<_, ()>((calls == 3).then_some("there"))
        });
        assert_eq!(value, Ok(Some("there")));
        assert_eq!(calls, 3);
    }

    #[test]
    fn gives_none_after_the_timeout_and_checks_one_time_at_least() {
        let mut calls = 0;
        let value = wait_until(Duration::ZERO, STEP, || {
            calls += 1;
            Ok::<Option<()>, ()>(None)
        });
        assert_eq!(value, Ok(None));
        assert_eq!(calls, 1);
    }

    #[test]
    fn an_error_of_the_check_ends_the_wait() {
        let value: Result<Option<()>, &str> =
            wait_until(Duration::from_secs(30), STEP, || Err("broken"));
        assert_eq!(value, Err("broken"));
    }
}
