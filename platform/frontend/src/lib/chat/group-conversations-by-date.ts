import {
  differenceInCalendarDays,
  format,
  isToday,
  isYesterday,
} from "date-fns";

/**
 * Human label for a chat's date bucket: "Today", "Yesterday", a "Jul 14"-style
 * day label for the rest of the last week, or "Older".
 */
export function getDateBucketLabel(value: string | Date): string {
  const date = new Date(value);
  if (isToday(date)) {
    return "Today";
  }
  if (isYesterday(date)) {
    return "Yesterday";
  }
  const days = differenceInCalendarDays(new Date(), date);
  // A future calendar day only happens on client/server clock skew across
  // local midnight — the chat is effectively brand new, so call it "Today".
  if (days < 0) {
    return "Today";
  }
  // NaN (invalid date) fails both checks and falls to "Older", which also
  // keeps `format` away from Invalid Date (it throws).
  if (days >= 2 && days <= 6) {
    return format(date, "MMM d");
  }
  return "Older";
}

/**
 * Groups conversations into ordered per-day buckets for sectioned display.
 * Expects the input sorted by the same timestamp `getDate` returns (the API
 * sorts by lastMessageAt desc), so bucket order follows input order. Pure and
 * generic so it can be unit-tested independent of the React tree.
 */
export function groupConversationsByDay<T>(
  conversations: T[],
  getDate: (conversation: T) => string | Date,
): Array<{ label: string; chats: T[] }> {
  const groups = new Map<string, T[]>();
  for (const conv of conversations) {
    const label = getDateBucketLabel(getDate(conv));
    const chats = groups.get(label);
    if (chats) {
      chats.push(conv);
    } else {
      groups.set(label, [conv]);
    }
  }
  return Array.from(groups, ([label, chats]) => ({ label, chats }));
}
