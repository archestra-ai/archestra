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
]);

/**
 * https://stackoverflow.com/a/70765851
 */
export class ApiError extends Error {
  type: z.infer<typeof ApiErrorTypeSchema>;
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;

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
      default:
        this.type = "unknown_api_error";
        break;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}
