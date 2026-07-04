/**
 * Parses the free-form "Arguments" textarea value into an array of argument
 * strings.
 *
 * Two input formats are supported:
 *
 * 1. One argument per line (the original format):
 *      /path/to/server.js
 *      --verbose
 *
 * 2. A JSON array, the way most MCP catalogs present args:
 *      ["-y", "@modelcontextprotocol/server-github"]
 *
 * A JSON array is detected when the trimmed input starts with "[". If it parses
 * to an array, its items are used (coerced to trimmed strings, blanks dropped).
 * Anything else - including malformed JSON - falls back to line-by-line
 * parsing, so existing one-per-line configs keep working unchanged.
 *
 * @param input - Raw textarea value (may be undefined/null)
 * @returns Array of non-empty, trimmed argument strings
 *
 * @example
 * parseArgumentsInput("--verbose\n/path/to/server.js")
 * // ["--verbose", "/path/to/server.js"]
 *
 * @example
 * parseArgumentsInput('["-y", "@modelcontextprotocol/server-github"]')
 * // ["-y", "@modelcontextprotocol/server-github"]
 */
export function parseArgumentsInput(
  input: string | undefined | null,
): string[] {
  if (!input) return [];

  const trimmed = input.trim();
  if (trimmed.length === 0) return [];

  // JSON array format, e.g. ["-y", "@scope/pkg", "--port", "8080"]
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (item): item is string | number =>
              typeof item === "string" || typeof item === "number",
          )
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      // Not valid JSON - fall through to line-by-line parsing.
    }
  }

  // Original format: one argument per line.
  return trimmed
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}
