import type { ActivityDay } from "@/lib/openappa-remedies.query";

/** One bar of the week: the day's denied calls by how they ended, labelled by weekday. */
export type ActivityBar = ActivityDay & { label: string };

/** Weekday names in the viewer's locale, oldest day first. */
export function activityBars(
  days: ActivityDay[],
  locale?: string,
): ActivityBar[] {
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return days.map((day) => ({
    ...day,
    // The date is a calendar day in the viewer's zone; reading it as UTC
    // midnight names the same weekday without the zone shifting it.
    label: weekday.format(new Date(`${day.date}T00:00:00Z`)),
  }));
}

export type ActivityTotals = {
  blocked: number;
  approved: number;
  cleaned: number;
};

export function activityTotals(days: ActivityDay[]): ActivityTotals {
  return days.reduce(
    (totals, day) => ({
      blocked: totals.blocked + day.blocked,
      approved: totals.approved + day.approved,
      cleaned: totals.cleaned + day.cleaned,
    }),
    { blocked: 0, approved: 0, cleaned: 0 },
  );
}

/** The headline beside the week, in the words its legend uses. */
export function activityHeadline(totals: ActivityTotals): string {
  const denied = totals.blocked + totals.approved + totals.cleaned;
  if (denied === 0) return "nothing blocked";
  return `${denied.toLocaleString()} denied · ${totals.approved.toLocaleString()} approved · ${totals.cleaned.toLocaleString()} cleaned · ${totals.blocked.toLocaleString()} blocked`;
}
