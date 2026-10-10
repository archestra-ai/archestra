import { ApiError } from "@archestra/shared/types";

/** A stored credential is unavailable until its encryption key or value is restored. */
export class SecretDecryptionError extends ApiError {
  constructor(message: string, cause: unknown) {
    super(
      409,
      `${message}. Restore the previous encryption key and migrate stored secrets, or re-enter all affected credentials.`,
    );
    this.cause = cause;
    this.shouldRetry = false;
  }
}
