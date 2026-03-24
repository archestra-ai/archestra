import * as Sentry from "@sentry/nextjs";
import type { ApiError } from "@shared";
import { toast } from "sonner";

/**
 * Convert an API SDK error object into a proper Error instance.
 * Use this instead of `throw error` to avoid Sentry's
 * "Object captured as exception with keys: error" warning.
 */
export function toApiError(error: { error: Partial<ApiError> | Error }): Error {
  if (error.error instanceof Error) return error.error;
  return new Error(error.error?.message ?? "API request failed");
}

export function handleApiError(error: { error: Partial<ApiError> | Error }) {
  if (typeof window !== "undefined") {
    toast.error(error.error?.message ?? "API request failed");
  }

  const sentryError =
    error.error instanceof Error
      ? error.error
      : new Error(error.error?.message ?? "API request failed");
  Sentry.captureException(sentryError, { extra: { originalError: error } });
  console.error(error);
}
