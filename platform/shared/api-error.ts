/**
 * User-facing API error copy, shared by the backend (when it builds error
 * responses) and the frontend (when it renders them). The goal is that a raw
 * status message like "Forbidden" or "Internal Server Error" never reaches the
 * user: the backend should send a descriptive message, and any client that
 * still receives a bare status token can translate it into readable copy here.
 */

import type { z } from "zod";
import type { ApiErrorTypeSchema } from "./types";

type ApiErrorType = z.infer<typeof ApiErrorTypeSchema>;

/**
 * Extract a human-readable message from anything an API call can produce: the
 * generated SDK's `{ error: { error: { message, type } } }` nesting, a plain
 * `{ message }` body, an `Error` instance, or a raw string. Bare HTTP status
 * tokens ("Forbidden", "Unauthorized", ...) and empty messages are replaced
 * with readable copy based on the error's `type` (or the token itself), so
 * callers can surface the result directly in a toast.
 */
export function getUserFacingApiErrorMessage(
  error: unknown,
  fallback: string = DEFAULT_FALLBACK_MESSAGE,
): string {
  const { message, type } = extractApiErrorParts(error);

  if (message && !isRawStatusMessage(message)) {
    return message;
  }

  // A bare status token implies the error category even when `type` is absent
  // (e.g. an Error("Forbidden") thrown far from the API layer).
  const impliedType = message
    ? RAW_STATUS_MESSAGE_TO_TYPE[message.trim().toLowerCase()]
    : undefined;

  const friendly =
    FRIENDLY_MESSAGE_BY_TYPE[
      (type as ApiErrorType | undefined) ?? impliedType ?? "unknown_api_error"
    ];
  return friendly ?? fallback;
}

// === Internal helpers

const DEFAULT_FALLBACK_MESSAGE = "Something went wrong. Please try again.";

const FRIENDLY_MESSAGE_BY_TYPE: Partial<Record<ApiErrorType, string>> = {
  api_authorization_error:
    "You don't have permission to perform this action. Contact your administrator if you need access.",
  api_authentication_error: "You need to sign in to perform this action.",
  api_not_found_error: "The requested resource could not be found.",
  api_validation_error:
    "The request was invalid. Please check your input and try again.",
  api_conflict_error:
    "This conflicts with the current state. Refresh and try again.",
  api_payload_too_large_error: "The uploaded content is too large.",
  api_service_unavailable_error:
    "The service is temporarily unavailable. Please try again shortly.",
  api_internal_server_error:
    "Something went wrong on our side. Please try again.",
};

/**
 * Bare status-line tokens that carry no information beyond the error category.
 * Keys are lowercase; values map the token to the matching error type.
 */
const RAW_STATUS_MESSAGE_TO_TYPE: Record<string, ApiErrorType> = {
  forbidden: "api_authorization_error",
  unauthorized: "api_authentication_error",
  unauthenticated: "api_authentication_error",
  "not found": "api_not_found_error",
  "bad request": "api_validation_error",
  conflict: "api_conflict_error",
  "payload too large": "api_payload_too_large_error",
  "service unavailable": "api_service_unavailable_error",
  "internal server error": "api_internal_server_error",
  "internal error": "api_internal_server_error",
};

function isRawStatusMessage(message: string): boolean {
  return message.trim().toLowerCase() in RAW_STATUS_MESSAGE_TO_TYPE;
}

/**
 * Peel the `{ error: ... }` wrappers (the SDK result and the API body each add
 * one) and read `message`/`type` from whatever is inside.
 */
function extractApiErrorParts(error: unknown): {
  message?: string;
  type?: string;
} {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current === "string") {
      return current.trim().length > 0 ? { message: current } : {};
    }
    if (current instanceof Error) {
      return current.message.trim().length > 0
        ? { message: current.message }
        : {};
    }
    if (typeof current !== "object" || current === null) {
      return {};
    }

    const record = current as Record<string, unknown>;
    if (
      typeof record.message === "string" &&
      record.message.trim().length > 0
    ) {
      return {
        message: record.message,
        type: typeof record.type === "string" ? record.type : undefined,
      };
    }
    if (record.error === undefined) {
      return {};
    }
    current = record.error;
  }
  return {};
}
