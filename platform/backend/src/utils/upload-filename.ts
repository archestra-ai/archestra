import { safeSegment, UnsafePathError } from "@/skills-sandbox/file-path";
import { ApiError } from "@/types";

// Matches the object store's MAX_SEGMENT_BYTES (file-path.ts) so a renamed
// candidate never exceeds what the filesystem/S3 backends accept.
const MAX_FILENAME_BYTES = 255;
const TRAILING_INDEX_SUFFIX = / \(\d+\)$/;

/**
 * Normalize and validate a user-supplied upload filename before it reaches the
 * object store / DB row. Strips any directory component (the upload is a single
 * file, never a path) and then applies the same {@link safeSegment} policy the
 * filesystem/S3 backends enforce, so a name that passes here writes cleanly on
 * every storage provider (not just the inline `db` one). Throws {@link ApiError}
 * 400 on an unusable name — the message is user-facing.
 */
export function sanitizeUploadFilename(name: string): string {
  // Take the basename: a dropped file's name must never carry a path.
  const base = name.split(/[/\\]/).pop() ?? "";
  try {
    return safeSegment(base);
  } catch (error) {
    if (error instanceof UnsafePathError) {
      throw new ApiError(400, `Invalid file name: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Produce the `attempt`-th auto-rename candidate for a colliding filename, e.g.
 * `nextAvailableName("report.pdf", 1)` -> `"report (1).pdf"`. The extension is
 * the last dot that isn't the first character, so dotfiles (`.gitignore`) and
 * extensionless names (`README`) keep their whole name as the base. Any existing
 * ` (n)` suffix on the base is stripped first so re-uploading an already-renamed
 * file yields `report (n).pdf`, never `report (1) (n).pdf`. The base — and, in
 * the degenerate case of an enormous extension, the extension — is truncated so
 * the result always stays within {@link MAX_FILENAME_BYTES}, guaranteeing every
 * candidate passes {@link safeSegment} on every storage provider.
 */
export function nextAvailableName(name: string, attempt: number): string {
  const lastDot = name.lastIndexOf(".");
  const hasExtension = lastDot > 0;
  const rawBase = hasExtension ? name.slice(0, lastDot) : name;
  const base = rawBase.replace(TRAILING_INDEX_SUFFIX, "");
  const suffix = ` (${attempt})`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  // The suffix is non-negotiable (it's what makes the name unique); truncate the
  // extension only if it alone wouldn't leave room for it.
  const extension = truncateToBytes(
    hasExtension ? name.slice(lastDot) : "",
    Math.max(MAX_FILENAME_BYTES - suffixBytes, 0),
  );
  const budget =
    MAX_FILENAME_BYTES - suffixBytes - Buffer.byteLength(extension, "utf8");
  const safeBase = truncateToBytes(base, Math.max(budget, 0));
  return `${safeBase}${suffix}${extension}`;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result + char, "utf8") > maxBytes) break;
    result += char;
  }
  return result;
}
