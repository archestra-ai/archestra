import type { ApiError } from "@archestra/shared";
// Subpath import (not the barrel) so tests that factory-mock
// "@archestra/shared" for the SDK don't erase this helper.
import { getUserFacingApiErrorMessage } from "@archestra/shared/api-error";
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

/**
 * User-facing message for an API error. Delegates to the shared helper so a
 * bare status token from the server ("Forbidden", "Not Found", ...) is
 * replaced with readable copy instead of surfacing raw in a toast.
 */
export function getApiErrorMessage(error: unknown): string {
  return getUserFacingApiErrorMessage(error, "API request failed");
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
 * The machine-readable `internal_code` of an API error, if present. Lets a caller
 * branch on a specific failure (e.g. which field's validation failed) to show the
 * message inline instead of a generic toast.
 */
export function getApiErrorInternalCode(error: unknown): string | undefined {
  const unwrapped = unwrapApiError(error);
  if (
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "internal_code" in unwrapped &&
    typeof (unwrapped as { internal_code?: unknown }).internal_code === "string"
  ) {
    return (unwrapped as { internal_code: string }).internal_code;
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

/**
 * API error types that describe the request, the caller's session, or their
 * permissions — not a fault of ours. The backend already drops the matching
 * 4xx from its own exception reporting (see classifyErrorForTracking); without
 * the same rule here the client reported them a second time from the other
 * side of the wire, so an expected "sign in first" on a page opened while
 * logged out was filed as an application error.
 *
 * They are still toasted and logged: the user needs to see them, they just are
 * not defects to triage.
 */
const NON_REPORTABLE_API_ERROR_TYPES = new Set([
  "api_authentication_error",
  "api_authorization_error",
  "api_not_found_error",
  "api_validation_error",
  "api_conflict_error",
  "api_payload_too_large_error",
]);

export function handleApiError(error: ApiSdkError) {
  const sentryError = toApiError(error);
  const errorType = getApiErrorType(error);

  // Mandatory-2FA lockout: every API call fails with this code until the
  // member enrolls, so route them to the dedicated enrollment page instead of
  // raining error toasts.
  if (
    typeof window !== "undefined" &&
    getApiErrorInternalCode(error) === "two_factor_setup_required" &&
    !window.location.pathname.startsWith("/auth/two-factor")
  ) {
    window.location.assign("/auth/two-factor-setup");
    return;
  }

  if (typeof window !== "undefined") {
    // Errors stay long enough to read and copy; the close button dismisses early.
    // The toast shows the humanized message; Sentry keeps the raw error.
    // Keyed by message so a repeating failure (retries, several queries hitting
    // the same missing permission) refreshes one toast instead of stacking.
    const message = getApiErrorMessage(error);
    toast.error(message, { duration: 12000, id: message });
  }

  if (
    errorType === undefined ||
    !NON_REPORTABLE_API_ERROR_TYPES.has(errorType)
  ) {
    void import("@sentry/nextjs")
      .then(({ captureException }) => {
        captureException(sentryError, { extra: { originalError: error } });
      })
      .catch(() => undefined);
  }
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

/**
 * An API failure whose message is already in front of the user.
 *
 * Write hooks toast the API's own refusal through `handleApiError`
 * and then reject, so the caller can stop; a caller that also toasts in its
 * catch says the same sentence twice. `toApiError` yields a plain `Error`,
 * indistinguishable from one a component built for itself — and those are
 * exactly the failures nothing else has reported — so the rejection carries
 * this type instead, and a caller can tell the two apart.
 */
class ReportedApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReportedApiError";
  }
}

/** Toast an API failure, and give back the error to reject with. */
export function reportApiError(error: unknown): Error {
  handleApiError(error);
  return new ReportedApiError(toApiError(error).message, { cause: error });
}

/**
 * Whether this failure came back from a write that has already told the user.
 * A caller with a catch of its own toasts only what this returns false for.
 */
export function isReportedApiError(error: unknown): boolean {
  // By name rather than `instanceof`, so a module boundary (or a test double)
  // cannot un-mark an error that was reported.
  return error instanceof Error && error.name === "ReportedApiError";
}
