/**
 * Parse a raw requirements textarea value into a clean list of python
 * dependency strings. Entries can be separated by commas and/or newlines;
 * surrounding whitespace is trimmed and empty entries are dropped.
 */
export function parseRequirementsInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
