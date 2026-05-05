/**
 * Resolves date placeholders in scheduled task message templates
 */
export function resolvePlaceholders(
  template: string,
  timezone: string,
): string {
  const now = new Date();
  // sv-SE locale produces YYYY-MM-DD without any extra formatting.
  const fmt = (d: Date) =>
    d.toLocaleDateString("sv-SE", { timeZone: timezone });

  const today = fmt(now);

  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = fmt(yesterdayDate);

  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = fmt(tomorrowDate);

  const lastWeekStartDate = new Date(
    yesterdayDate.getTime() - 6 * 24 * 60 * 60 * 1000,
  );
  const lastWeek = `${fmt(lastWeekStartDate)} to ${fmt(yesterdayDate)}`;

  const patterns: Array<[RegExp, string]> = [
    [/\{\{\s*today\s*\}\}/gi, today],
    [/\{\{\s*yesterday\s*\}\}/gi, yesterday],
    [/\{\{\s*tomorrow\s*\}\}/gi, tomorrow],
    [/\{\{\s*last[_\s]+week\s*\}\}/gi, lastWeek],
    [/\{\{\s*now\s*\}\}/gi, now.toISOString()],
  ];

  return patterns.reduce(
    (acc, [pattern, value]) => acc.replace(pattern, value),
    template,
  );
}
