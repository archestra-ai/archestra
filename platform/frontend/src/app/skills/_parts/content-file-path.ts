/** Longest path the server stores for a plugin or skill file. */
const MAX_CONTENT_FILE_PATH_LENGTH = 512;

/**
 * Why a new file cannot be added to the explorer under `path`, as a sentence
 * for the person typing it; null when it can.
 *
 * The server refuses these paths when the draft is saved, and its answer
 * arrives long after the name was typed, as one error for the whole form. The
 * explorer checks the name where it is typed instead, so a file that cannot be
 * saved never enters the list. Only new names pass through here: files that
 * are already stored keep whatever path they were stored under.
 */
export function contentFilePathProblem(params: {
  path: string;
  /** Paths already in the explorer, the manifest included. */
  existingPaths: readonly string[];
  /** The manifest's path, when the editor has one that cannot be re-added. */
  manifestPath?: string;
}): string | null {
  const { path, existingPaths, manifestPath } = params;
  if (path.length > MAX_CONTENT_FILE_PATH_LENGTH) {
    return `Use a path of at most ${MAX_CONTENT_FILE_PATH_LENGTH} characters.`;
  }
  if (path.includes("\\") || path.includes("\0")) {
    return "Use / between folders, not a backslash.";
  }
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((segment) => segment === "")) {
    return "Remove the extra / from the path.";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "A path cannot contain . or .. as a folder name.";
  }

  // Compared without case: the files land on macOS and Windows disks, where
  // `Notes.md` and `notes.md` are one file.
  const lower = path.toLowerCase();
  if (manifestPath && lower === manifestPath.toLowerCase()) {
    return `${manifestPath} is already in the list.`;
  }
  for (const existing of existingPaths) {
    const other = existing.toLowerCase();
    if (other === lower) return "A file with this name already exists.";
    if (other.startsWith(`${lower}/`)) {
      return "A folder with this name already exists.";
    }
    if (lower.startsWith(`${other}/`)) {
      return `${existing} is a file, so it cannot hold other files.`;
    }
  }
  return null;
}
