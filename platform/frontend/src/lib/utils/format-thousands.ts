/**
 * Group a whole number into thousands: 128000 -> "128,000".
 *
 * Locale is pinned rather than taken from the browser: this formats values that
 * are typed back in, and a locale that groups with spaces or dots would produce
 * text the digit-only parsers read differently from what the user sees.
 *
 * Anything that is not a run of digits comes back untouched, so a partially
 * typed or empty field renders as-is instead of "NaN".
 */
export function formatThousands(value: string | number): string {
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}
