import OpenAI from "openai";
import { ApiError } from "@/types/api";

/** SDK errors can contain echoed credentials, upload bytes, and response headers. */
export function mediaProviderError(
  error: unknown,
  operation: string,
  provider = "Azure",
): ApiError {
  if (error instanceof ApiError) return error;
  // Gemini and OpenAI SDK errors both expose numeric HTTP status.
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? error.status
      : undefined;
  const safe = new ApiError(
    typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
      ? status
      : error instanceof Error &&
          ["AbortError", "APIUserAbortError"].includes(error.name)
        ? 499
        : error instanceof OpenAI.APIConnectionTimeoutError
          ? 504
          : 502,
    `${provider} ${operation} request failed.`,
  );
  safe.upstream = true;
  const retry =
    error instanceof OpenAI.APIError
      ? error.headers?.get("retry-after")?.trim()
      : undefined;
  if (retry && (/^\d+$/.test(retry) || Number.isFinite(Date.parse(retry)))) {
    const seconds = /^\d+$/.test(retry)
      ? Number(retry)
      : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000));
    if (Number.isSafeInteger(seconds)) safe.retryAfterSeconds = seconds;
    Object.assign(safe, { headers: new Headers({ "retry-after": retry }) });
  }
  return safe;
}
