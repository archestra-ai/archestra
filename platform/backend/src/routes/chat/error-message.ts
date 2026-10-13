/**
 * Readable text for anything a stream or tool can throw. Tools and MCP clients
 * also reject with plain `{ code, message }` objects, which `String()` turns
 * into "[object Object]".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
