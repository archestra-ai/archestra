/**
 * Pure helpers for comparing two immutable skill versions. Version bytes are
 * whole snapshots rather than patches, so the change set the history dialog
 * shows is computed here by pairing a version's resource files with its
 * predecessor's.
 */

export type SkillFileChange = "added" | "removed" | "changed" | "unchanged";

/** The minimum a compared file needs; the real snapshot files satisfy it. */
interface ComparableFile {
  path: string;
  content: string;
}

export interface ComparedSkillFile<T extends ComparableFile> {
  path: string;
  change: SkillFileChange;
  /** The file as it exists in the newer version; null when it was removed. */
  current: T | null;
  /** The file as it existed in the older version; null when it was added. */
  previous: T | null;
}

/**
 * Pair a version's files against its predecessor's, keyed by path and sorted by
 * path so the list is stable across selections. Callers that have no
 * predecessor (the oldest retained version) should not call this — there is no
 * baseline to describe a change against.
 */
export function compareSkillVersionFiles<T extends ComparableFile>(
  current: T[],
  previous: T[],
): ComparedSkillFile<T>[] {
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  const compared: ComparedSkillFile<T>[] = current.map((file) => {
    const before = previousByPath.get(file.path) ?? null;
    return {
      path: file.path,
      change: !before
        ? "added"
        : before.content === file.content
          ? "unchanged"
          : "changed",
      current: file,
      previous: before,
    };
  });

  const currentPaths = new Set(current.map((file) => file.path));
  for (const file of previous) {
    if (currentPaths.has(file.path)) continue;
    compared.push({
      path: file.path,
      change: "removed",
      current: null,
      previous: file,
    });
  }

  return compared.sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether anything other than resource-file ordering actually differs. */
export function hasFileChanges(
  compared: ComparedSkillFile<ComparableFile>[],
): boolean {
  return compared.some((file) => file.change !== "unchanged");
}
