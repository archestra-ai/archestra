//! The time of a sync as text: RFC 3339 in UTC with whole seconds, for
//! example `2026-11-10T12:00:00Z`. The config file keeps it in `synced_at`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SECONDS_PER_DAY: u64 = 86_400;
/// The days from 0000-03-01 to 1970-01-01 in the calendar of [`civil_date`].
const DAYS_TO_EPOCH: u64 = 719_468;
/// The days of 400 years. The calendar repeats after them.
const DAYS_PER_ERA: u64 = 146_097;

/// Writes a time. A time before 1970 becomes 1970.
pub(crate) fn format(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since_epoch| since_epoch.as_secs());
    let (year, month, day) = civil_date(seconds / SECONDS_PER_DAY);
    let second_of_day = seconds % SECONDS_PER_DAY;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second_of_day / 3600,
        second_of_day % 3600 / 60,
        second_of_day % 60
    )
}

/// Reads a time that [`format`] wrote. `None` for all other text.
pub(crate) fn parse(text: &str) -> Option<SystemTime> {
    let bytes = text.as_bytes();
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if bytes.len() != 20
        || bytes[19] != b'Z'
        || separators.iter().any(|(at, byte)| bytes[*at] != *byte)
    {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<u64> {
        let digits = &bytes[from..to];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(digits).ok()?.parse().ok()
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1970 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_since_epoch(year, month, day)?;
    let seconds = days * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second;
    UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
}

/// The year, month and day of a number of days after 1970-01-01. The year of
/// this calculation starts on the first of March, so the day that a leap
/// year adds is the last day of a year.
fn civil_date(days: u64) -> (u64, u64, u64) {
    let days = days + DAYS_TO_EPOCH;
    let era = days / DAYS_PER_ERA;
    let day_of_era = days % DAYS_PER_ERA;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    // The month, counted from March as 0.
    let march_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = if march_month < 10 {
        march_month + 3
    } else {
        march_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

/// The opposite of [`civil_date`]. `None` for a date that does not exist.
fn days_since_epoch(year: u64, month: u64, day: u64) -> Option<u64> {
    if !(1..=12).contains(&month) || day == 0 {
        return None;
    }
    let march_year = if month <= 2 { year - 1 } else { year };
    let march_month = if month > 2 { month - 3 } else { month + 9 };
    let year_of_era = march_year % 400;
    let day_of_year = (153 * march_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = (march_year / 400 * DAYS_PER_ERA + day_of_era).checked_sub(DAYS_TO_EPOCH)?;
    // A day such as the 31st of April gives a day of the next month.
    (civil_date(days) == (year, month, day)).then_some(days)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn writes_and_reads_known_times() {
        for (seconds, text) in [
            (0, "1970-01-01T00:00:00Z"),
            (946_684_799, "1999-12-31T23:59:59Z"),
            (951_868_800, "2000-03-01T00:00:00Z"),
            (1_709_251_199, "2024-02-29T23:59:59Z"),
            (1_794_312_000, "2026-11-10T12:00:00Z"),
            (2_147_483_648, "2038-01-19T03:14:08Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
        ] {
            assert_eq!(format(at(seconds)), text);
            assert_eq!(parse(text), Some(at(seconds)), "{text}");
        }
    }

    #[test]
    fn each_day_of_many_years_reads_back() {
        // 1970 to 2105: leap years, and 2100, which is not one.
        for day in 0..(136 * 366) {
            let time = at(day * SECONDS_PER_DAY + 3_723);
            assert_eq!(parse(&format(time)), Some(time), "day {day}");
        }
    }

    #[test]
    fn parts_of_a_second_are_dropped_and_old_times_are_1970() {
        let time = UNIX_EPOCH + Duration::from_millis(1_794_312_000_999);
        assert_eq!(format(time), "2026-11-10T12:00:00Z");
        let before_epoch = UNIX_EPOCH - Duration::from_secs(5);
        assert_eq!(format(before_epoch), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn text_that_is_not_such_a_time_is_not_read() {
        for text in [
            "",
            "2026-11-10",
            "2026-11-10T12:00:00",
            "2026-11-10T12:00:00+01:00",
            "2026-11-10 12:00:00Z",
            "2026-11-10T12:00:00.5Z",
            "2026-13-10T12:00:00Z",
            "2026-00-10T12:00:00Z",
            "2026-04-31T12:00:00Z",
            "2026-02-29T12:00:00Z",
            "2026-11-00T12:00:00Z",
            "2026-11-10T24:00:00Z",
            "2026-11-10T12:60:00Z",
            "2026-11-10T12:00:60Z",
            "1969-12-31T23:59:59Z",
            "+026-11-10T12:00:00Z",
            "2026-11-10T12:00:0éZ",
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }
    }
}
