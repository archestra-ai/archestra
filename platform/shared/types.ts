import { z } from "zod";

export type ErrorExtended = {
  message: string;
  request?: {
    method: string;
    url: string;
  };
  data?: object;
  stack?: string;
};

/**
 * Supported secrets manager types
 */
export enum SecretsManagerType {
  DB = "DB",
  Vault = "Vault",
  /** BYOS (Bring Your Own Secrets) - Vault with external team folder support */
  BYOS_VAULT = "BYOS_VAULT",
}

export const ApiErrorTypeSchema = z.enum([
  "api_internal_server_error",
  "api_validation_error",
  "api_authentication_error",
  "api_authorization_error",
  "api_not_found_error",
  "unknown_api_error",
  "api_conflict_error",
  "api_payload_too_large_error",
  "api_rate_limit_error",
  "api_service_unavailable_error",
]);

/**
 * https://stackoverflow.com/a/70765851
 */
export class ApiError extends Error {
  type: z.infer<typeof ApiErrorTypeSchema>;
  statusCode: number;
  internalCode?: string;
  /**
   * True when this error relays a failure returned by an upstream provider
   * (the provider's own HTTP error, not a fault of ours). Error tracking
   * drops upstream 5xx relays as non-actionable noise.
   */
  upstream?: boolean;
  /**
   * Seconds the caller should wait before retrying, surfaced as the
   * `Retry-After` response header by the central error handler.
   *
   * Set it on any throttling error whose clear-time is known: without it a
   * client sees a bare 429 and falls back to its own escalating backoff, which
   * for the LLM proxy's native clients means minutes of waiting for a limit
   * that clears in under one window.
   */
  retryAfterSeconds?: number;

  constructor(statusCode: number, message: string, internalCode?: string) {
    super(message);
    this.statusCode = statusCode;
    this.internalCode = internalCode;

    switch (statusCode) {
      case 500:
        this.type = "api_internal_server_error";
        break;
      case 400:
        this.type = "api_validation_error";
        break;
      case 401:
        this.type = "api_authentication_error";
        break;
      case 403:
        this.type = "api_authorization_error";
        break;
      case 404:
        this.type = "api_not_found_error";
        break;
      case 409:
        this.type = "api_conflict_error";
        break;
      case 413:
        this.type = "api_payload_too_large_error";
        break;
      case 429:
        this.type = "api_rate_limit_error";
        break;
      // Anthropic uses 529 for the same transient condition as 503.
      case 503:
      case 529:
        this.type = "api_service_unavailable_error";
        break;
      default:
        this.type = "unknown_api_error";
        break;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}
