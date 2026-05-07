/**
 * Parses MCP server arguments from a string input.
 * Supports both newline-separated strings and JSON arrays of strings.
 * 
 * If the input is valid JSON and represents an array, it returns the array of strings.
 * Otherwise, it falls back to splitting by newline and trimming each line.
 */
export function parseMcpArguments(input: string): string[] {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return [];
  }

  // Attempt JSON parsing if it looks like an array
  if (trimmedInput.startsWith("[") && trimmedInput.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmedInput);
      if (Array.isArray(parsed)) {
        return parsed.map((arg) => String(arg).trim()).filter((arg) => arg.length > 0);
      }
    } catch (e) {
      // Fallback to newline splitting if JSON parsing fails
    }
  }

  // Default behavior: newline-separated strings
  return trimmedInput
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}
