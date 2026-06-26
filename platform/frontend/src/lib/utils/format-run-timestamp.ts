/**
 * Format a scheduled run's ISO timestamp for the runs UI: "Today at 3:04 PM",
 * "Yesterday at 3:04 PM", or "Jan 5 at 3:04 PM" for older dates.
 */
export function formatRunTimestamp(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `Today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) {
    return `Yesterday at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${dateStr} at ${timeStr}`;
}
