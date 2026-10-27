/**
 * Whether the runtime can format dates in `value`: an IANA name in any of its
 * spellings (Asia/Kolkata and Asia/Calcutta alike) or a UTC offset such as
 * "+05:30". `Intl.supportedValuesOf("timeZone")` is not a substitute: it lists
 * only canonical names and misses current ones browsers report.
 */
export function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * {@link isKnownTimeZone}, restricted to IANA names. Use it for a zone that
 * reaches Postgres `AT TIME ZONE`, which reads a bare offset's sign inverted
 * ("+05:30" there means five and a half hours west).
 */
export function isNamedTimeZone(value: string): boolean {
  return TIME_ZONE_NAME_PATTERN.test(value) && isKnownTimeZone(value);
}

const TIME_ZONE_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
