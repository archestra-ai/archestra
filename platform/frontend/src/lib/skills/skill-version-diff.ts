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
 * path so the list is stable across selections.
 *
 * Both sides are versions that were actually read. A version with no baseline —
 * the oldest one, or one whose predecessor could not be fetched — is not
 * compared at all: it is listed on its own, since calling every file `added`
 * would report the absence of a baseline as a fact about the skill's history.
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

/** One level of the file tree: a named folder, or the root when `folder` is null. */
export interface SkillFileFolder<T> {
  folder: string | null;
  files: T[];
}

/**
 * Group files into the single-level tree a skill directory actually has —
 * `scripts/`, `references/`, `assets/` and loose files at the root. Folders come
 * first, sorted, then the root group, matching the skill editor's tree.
 */
export function groupFilesByFolder<T extends { path: string }>(
  files: T[],
): SkillFileFolder<T>[] {
  const byFolder = new Map<string, T[]>();
  const rootFiles: T[] = [];
  for (const file of files) {
    const separator = file.path.indexOf("/");
    if (separator === -1) {
      rootFiles.push(file);
      continue;
    }
    const folder = file.path.slice(0, separator);
    const entries = byFolder.get(folder);
    if (entries) {
      entries.push(file);
    } else {
      byFolder.set(folder, [file]);
    }
  }

  const groups: SkillFileFolder<T>[] = [...byFolder.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((folder) => ({ folder, files: byFolder.get(folder) ?? [] }));
  if (rootFiles.length > 0) groups.push({ folder: null, files: rootFiles });
  return groups;
}
