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
 * Split rows destined for one multi-row statement into statement-sized batches.
 *
 * Postgres caps a statement at 65535 bind parameters, so a bulk
 * `UPDATE … FROM (VALUES …)` cannot take an unbounded row list. 1000 rows
 * stays well under the cap for any realistic column count (65 columns) while
 * keeping the statement count low.
 */
export function chunkForBulkStatement<T>(rows: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += BULK_STATEMENT_MAX_ROWS) {
    chunks.push(rows.slice(i, i + BULK_STATEMENT_MAX_ROWS));
  }
  return chunks;
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

// ===== Internal =====

const BULK_STATEMENT_MAX_ROWS = 1000;
