/**
 * Validate a project name. Returns an error message, or null when valid. One
 * validator for every entry point (route schema, agent tools), so a name that
 * passes here is safe to use as a single path-safe segment when a project owns
 * files.
 */
export function validateProjectName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "project name must not be empty";
  if (name.length > 128) return "project name must be at most 128 characters";
  if (name.includes("/") || name.includes("\\")) {
    return "project name must not contain slashes";
  }
  if (name.startsWith(".")) {
    return "project name must not start with a dot";
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return "project name must not contain control characters";
  }
  return null;
}

// === internal ===

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
// C0 controls, DEL, C1 controls.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above
