/**
 * The headline on the greeting/glance new-chat layouts, e.g. "Good evening,
 * Ada." It is computed in the browser, so it follows the viewer's own clock
 * and timezone.
 */
export function pickChatGreeting({
  date,
  name,
}: {
  date: Date;
  name?: string | null;
}): string {
  const options = GREETINGS[timeOfDay(date.getHours())];
  // Stable for the whole day (no reshuffle per visit), but varies day to day.
  const greeting = options[dayOfYear(date) % options.length];
  const first = greetingName(name);
  return first ? `${greeting}, ${first}.` : `${greeting}.`;
}

/**
 * The first name to greet, or nothing when the account name is a role rather
 * than a person (the seeded admin is literally named "Admin").
 */
export function greetingName(name?: string | null): string | undefined {
  const first = name?.trim().split(/\s+/)[0];
  if (!first || GENERIC_ACCOUNT_NAMES.has(first.toLowerCase())) return;
  return first;
}

// ===

type TimeOfDay = "night" | "morning" | "afternoon" | "evening";

const GREETINGS: Record<TimeOfDay, string[]> = {
  night: ["Up late", "Burning the midnight oil", "Welcome back"],
  morning: ["Good morning", "Morning", "Welcome back"],
  afternoon: ["Good afternoon", "Afternoon", "Welcome back"],
  evening: ["Good evening", "Evening", "Welcome back"],
};

const GENERIC_ACCOUNT_NAMES = new Set([
  "admin",
  "administrator",
  "user",
  "owner",
  "root",
  "default",
]);

function timeOfDay(hour: number): TimeOfDay {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function dayOfYear(date: Date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}
