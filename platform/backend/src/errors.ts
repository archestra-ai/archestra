/**
 * Domain errors. Thrown by models (translating driver errors at the DB
 * boundary) and services (business-rule violations).
 *
 * The `message` is user-facing — it is returned verbatim in the API response.
 * Never include IDs, internal state, or stack details.
 *
 * For engineering context — the upstream error, a pg `DatabaseError`, etc. —
 * use the `cause` option, which every `Error` already supports:
 *
 *  throw new ValidationError("Email already in use", { cause: pgError });
 *
 *  Avoid adding a new error type without a good reason.
 */

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

export class PreconditionFailedError extends Error {
  override readonly name = "PreconditionFailedError";
}

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

export class UnauthenticatedError extends Error {
  override readonly name = "UnauthenticatedError";
}

export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";
}

export class InternalError extends Error {
  override readonly name = "InternalError";
}
