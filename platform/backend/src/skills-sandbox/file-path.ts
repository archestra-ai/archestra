import path from "node:path";

/**
 * Path safety for the filesystem byte backend. Caller-supplied names (a user's
 * email, a project name, a stored object key, a decoded disk ref) become path
 * segments under the storage root; these helpers keep them confined to a single
 * directory level and inside the root. They are lexical/prefix guards — symlink
 * following is additionally refused at open time (`O_NOFOLLOW`) by the storage
 * provider, and listings skip symlinks.
 */

/**
 * A name could not be turned into a safe path segment, or a path escaped root.
 *
 * @public — thrown by safeSegment/resolveWithinRoot; asserted by name in tests.
 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Validate a single path segment: no separators, traversal, leading dot, control
 * characters, or over-length. Returns the trimmed segment; throws otherwise.
 */
export function safeSegment(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new UnsafePathError("empty path segment");
  if (trimmed === "." || trimmed === "..") {
    throw new UnsafePathError(`reserved path segment "${trimmed}"`);
  }
  if (trimmed.startsWith(".")) {
    throw new UnsafePathError("path segment may not start with a dot");
  }
  if (/[/\\]/.test(trimmed)) {
    throw new UnsafePathError("path segment contains a path separator");
  }
  if (hasControlChar(trimmed)) {
    throw new UnsafePathError("path segment contains a control character");
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_SEGMENT_BYTES) {
    throw new UnsafePathError("path segment is too long");
  }
  return trimmed;
}

/**
 * Join `segments` (each validated by {@link safeSegment}) under `root` and return
 * the absolute path, guaranteed to stay within `root`. Pass a stored object key
 * as its split parts (`...objectKey.split("/")`).
 */
export function resolveWithinRoot(root: string, ...segments: string[]): string {
  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, ...segments.map(safeSegment));
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new UnsafePathError("resolved path escapes the storage root");
  }
  return full;
}

// === internal ===

const MAX_SEGMENT_BYTES = 255;

/** True if the string contains a NUL, a C0 control character, or DEL. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
