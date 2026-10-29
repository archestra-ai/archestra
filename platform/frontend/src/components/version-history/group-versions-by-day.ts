import { format, isThisYear } from "date-fns";

interface VersionDayGroup<T> {
  label: string;
  versions: T[];
}

/**
 * Bucket versions by the day they were created, preserving the order they
 * arrive in. The list is newest-first, so the groups come out that way too, and
 * runs are collapsed by comparing against the last group rather than by sorting
 * — a version out of order would start its own group instead of being silently
 * folded into a day it does not belong to.
 *
 * Labels read like `git log` dates ("Mon Aug 3"), with the year added only
 * when it is not the current one.
 */
export function groupVersionsByDay<T extends { createdAt: string }>(
  versions: T[],
): VersionDayGroup<T>[] {
  const groups: VersionDayGroup<T>[] = [];
  for (const version of versions) {
    const createdAt = new Date(version.createdAt);
    const label = format(
      createdAt,
      isThisYear(createdAt) ? "EEE MMM d" : "EEE MMM d yyyy",
    );
    const current = groups.at(-1);
    if (current?.label === label) {
      current.versions.push(version);
    } else {
      groups.push({ label, versions: [version] });
    }
  }
  return groups;
}
