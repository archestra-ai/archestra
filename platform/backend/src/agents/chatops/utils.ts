/**
 * Shared chatops utility functions.
 */

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error (could not serialize)";
    }
  }
}
