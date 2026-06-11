/**
 * Validate a PFS folder name. Returns an error message, or null when valid.
 * One validator for every entry point (route schema, agent tools, storage), so
 * a name that passes here is safe to use as a single on-disk directory segment
 * under the user's storage folder.
 */
export function validateSandboxFolderName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "folder name must not be empty";
  if (name.length > 128) return "folder name must be at most 128 characters";
  if (name.includes("/") || name.includes("\\")) {
    return "folder name must not contain slashes";
  }
  if (name.startsWith(".")) {
    return "folder name must not start with a dot";
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return "folder name must not contain control characters";
  }
  return null;
}

/** Trimmed canonical form of a (valid) folder name. */
export function normalizeSandboxFolderName(raw: string): string {
  return raw.trim();
}

// === internal ===

// C0 controls, DEL, C1 controls — built via RegExp so the source file
// contains no raw control bytes.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;
