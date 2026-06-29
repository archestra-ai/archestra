/**
 * Check if an error (or its cause) is a PostgreSQL unique constraint violation.
 * Drizzle wraps database errors, so we need to check the cause chain.
 *
 * Pass `constraint` to match only a specific unique index by name; omit it to
 * match any unique violation.
 */
export function isUniqueConstraintError(
  error: unknown,
  constraint?: string,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as { code?: string }).code;
  const errorConstraint = (error as { constraint?: string }).constraint;
  const errorMessage = error.message.toLowerCase();

  const isUniqueViolation =
    errorCode === "23505" || // PostgreSQL unique_violation error code
    errorMessage.includes("duplicate key") ||
    errorMessage.includes("unique constraint") ||
    errorMessage.includes("unique_violation");

  if (
    isUniqueViolation &&
    (constraint === undefined || errorConstraint === constraint)
  ) {
    return true;
  }

  // the constraint name lives on the driver-level cause Drizzle wraps
  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isUniqueConstraintError(cause, constraint);
  }

  return false;
}

/**
 * Check if an error (or its cause) is a PostgreSQL foreign-key constraint
 * violation. Drizzle wraps database errors, so the cause chain is walked.
 */
export function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as { code?: string }).code;
  const errorMessage = error.message.toLowerCase();

  const isForeignKeyViolation =
    errorCode === "23503" || // PostgreSQL foreign_key_violation error code
    errorMessage.includes("foreign key constraint") ||
    errorMessage.includes("foreign_key_violation");

  if (isForeignKeyViolation) {
    return true;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    return isForeignKeyConstraintError(cause);
  }

  return false;
}
