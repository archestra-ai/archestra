import type { BlockedCallsDay } from "@/lib/openappa-remedies.query";

export type BlockedCallsTotals = {
  blocked: number;
  remedied: number;
  stayed: number;
};

/** One bar of the chart: the day's calls split by how they ended. */
export type BlockedCallsBar = {
  date: string;
  label: string;
  remedied: number;
  stayed: number;
};

export function blockedCallsTotals(
  days: BlockedCallsDay[],
): BlockedCallsTotals {
  const blocked = days.reduce((total, day) => total + day.blocked, 0);
  const remedied = days.reduce((total, day) => total + day.remedied, 0);
  return { blocked, remedied, stayed: blocked - remedied };
}

/** Weekday names in the viewer's locale, with the two halves of each bar. */
export function blockedCallsBars(
  days: BlockedCallsDay[],
  locale?: string,
): BlockedCallsBar[] {
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return days.map((day) => ({
    date: day.date,
    // The date is a calendar day in the viewer's zone; reading it as UTC
    // midnight names the same weekday without the zone shifting it.
    label: weekday.format(new Date(`${day.date}T00:00:00Z`)),
    remedied: day.remedied,
    stayed: day.blocked - day.remedied,
  }));
}

/** The headline beside the title, in the words the panel's legend uses. */
export function blockedCallsHeadline(totals: BlockedCallsTotals): string {
  if (totals.blocked === 0) return "nothing blocked";
  return `${totals.blocked.toLocaleString()} blocked · ${totals.remedied.toLocaleString()} approved or cleaned`;
}
