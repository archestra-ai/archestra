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
 * The machine-readable `type` of an API error (e.g. `"api_not_found_error"`),
 * if present. Lets a caller branch on the kind of failure — e.g. treat a
 * not-found as an expected empty state instead of toasting it as an error.
 */
export function getApiErrorType(error: unknown): string | undefined {
  const unwrapped = unwrapApiError(error);
  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "type" in unwrapped &&
    typeof (unwrapped as { type?: unknown }).type === "string"
  ) {
    return (unwrapped as { type: string }).type;
  }
  return undefined;
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

/**
 * Fail a query loud when the generated SDK returns an error, so the query
 * enters its error state instead of swallowing a failed fetch into a default
 * value. A swallowed error makes an outage indistinguishable from a genuinely
 * empty result, which is how "Add an LLM Provider Key" showed up offline.
 *
 * Call right after the SDK call and keep the existing success return:
 *
 *   const { data, error } = await getApiKeys();
 *   throwOnApiError(error);
 *   return data ?? [];
 *
 * Toasts via `handleApiError` by default; screens that render their own error
 * state (and would otherwise double-notify, plus re-toast on every retry) pass
 * `toastOnError: false`. Detail endpoints where a 404 is a legitimate "does not
 * exist" rather than an outage pass `allowNotFound: true` so the caller keeps
 * returning its null default for that case.
 */
export function throwOnApiError(
  error: unknown,
  options?: { toastOnError?: boolean; allowNotFound?: boolean },
): void {
  if (!error) {
    return;
  }
  if (
    options?.allowNotFound &&
    getApiErrorType(error) === "api_not_found_error"
  ) {
    return;
  }
  if (options?.toastOnError ?? true) {
    handleApiError(error);
  }
  throw toApiError(error);
}
