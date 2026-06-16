import type { ApiError } from "@archestra/shared";
import { toast } from "sonner";

type ApiSdkError =
  | { error: Partial<ApiError> | Error | unknown }
  | Partial<ApiError>
  | Error
  | unknown;

function unwrapApiError(error: ApiSdkError): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    error.error !== undefined
  ) {
    return error.error;
  }

  return error;
}

export function getApiErrorMessage(error: unknown): string {
  const unwrapped = unwrapApiError(error);

  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "message" in unwrapped &&
    typeof unwrapped.message === "string"
  ) {
    return unwrapped.message;
  }

  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "error" in unwrapped &&
    typeof unwrapped.error === "object" &&
    unwrapped.error !== null &&
    "message" in unwrapped.error &&
    typeof unwrapped.error.message === "string"
  ) {
    return unwrapped.error.message;
  }

  if (typeof unwrapped === "string" && unwrapped.trim().length > 0) {
    return unwrapped;
  }

  return "API request failed";
}

/**
 * Convert an API SDK error object into a proper Error instance.
 * Use this instead of `throw error` to avoid Sentry's
 * "Object captured as exception with keys: error" warning.
 */
export function toApiError(error: ApiSdkError): Error {
  const unwrapped = unwrapApiError(error);
  if (unwrapped instanceof Error) return unwrapped;
  return new Error(getApiErrorMessage(error));
}

export function handleApiError(error: ApiSdkError) {
  const sentryError = toApiError(error);

  if (typeof window !== "undefined") {
    // Errors stay long enough to read and copy; the close button dismisses early.
    toast.error(sentryError.message, { duration: 12000 });
  }

  void import("@sentry/nextjs")
    .then(({ captureException }) => {
      captureException(sentryError, { extra: { originalError: error } });
    })
    .catch(() => undefined);
  console.error(sentryError);
}
