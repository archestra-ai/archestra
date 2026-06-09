/**
 * Pretty-print a hook payload's JSON string for the debug chip. Returns the
 * input unchanged when it isn't valid JSON — a capped payload has a
 * `…[truncated N chars]` marker appended and no longer parses, and we'd still
 * rather show it than nothing.
 */
export function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
