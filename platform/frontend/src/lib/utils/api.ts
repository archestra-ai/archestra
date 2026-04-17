import * as Sentry from "@sentry/nextjs";
import type { ApiError } from "@shared";
import { toast } from "sonner";

type ApiSdkError = { error: Partial<ApiError> | Error };

export function getApiErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null &&
    "message" in error.error &&
    typeof error.error.message === "string"
  ) {
    return error.error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "API request failed";
}

/**
 * Convert an API SDK error object into a proper Error instance.
 * Use this instead of `throw error` to avoid Sentry's
 * "Object captured as exception with keys: error" warning.
 */
export function toApiError(error: ApiSdkError): Error {
  if (error.error instanceof Error) return error.error;
  return new Error(getApiErrorMessage(error));
}

export function handleApiError(error: ApiSdkError) {
  if (typeof window !== "undefined") {
    toast.error(getApiErrorMessage(error));
  }

  const sentryError =
    error.error instanceof Error
      ? error.error
      : new Error(getApiErrorMessage(error));
  Sentry.captureException(sentryError, { extra: { originalError: error } });
  console.error(error);
}
