import type { ConsultActivityDay } from "@/lib/openappa-remedies.query";

/** One bar of a panel's week: the day's answers, labelled by weekday. */
export type ActivityBar = ConsultActivityDay & { label: string };

/** Weekday names in the viewer's locale, oldest day first. */
export function activityBars(
  days: ConsultActivityDay[],
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

export function activityTotals(days: ConsultActivityDay[]): {
  approved: number;
  denied: number;
  cleaned: number;
} {
  return days.reduce(
    (totals, day) => ({
      approved: totals.approved + day.approved,
      denied: totals.denied + day.denied,
      cleaned: totals.cleaned + day.cleaned,
    }),
    { approved: 0, denied: 0, cleaned: 0 },
  );
}

/** The headline beside the Authorities week: what people and services ruled. */
export function reviewsHeadline(totals: {
  approved: number;
  denied: number;
}): string {
  if (totals.approved + totals.denied === 0) return "none yet";
  return `${totals.approved.toLocaleString()} approved · ${totals.denied.toLocaleString()} denied`;
}

/** The headline beside the Sanitizers week. */
export function cleaningsHeadline(totals: { cleaned: number }): string {
  return totals.cleaned === 0 ? "none yet" : totals.cleaned.toLocaleString();
}
