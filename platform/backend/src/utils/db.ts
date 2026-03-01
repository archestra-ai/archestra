/**
 * Check if an error (or its cause) is a PostgreSQL unique constraint violation.
 * Drizzle wraps database errors, so we need to check the cause chain.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Check the error itself
  const errorCode = (error as { code?: string }).code;
  const errorMessage = error.message.toLowerCase();

  if (
    errorCode === "23505" || // PostgreSQL unique_violation error code
    errorMessage.includes("duplicate key") ||
    errorMessage.includes("unique constraint") ||
    errorMessage.includes("unique_violation")
  ) {
    return true;
  }

  // Check the cause (Drizzle wraps errors)
  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isUniqueConstraintError(cause);
  }

  return false;
}
