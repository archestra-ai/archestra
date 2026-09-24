import { trace } from "@opentelemetry/api";
import { ApiError } from "@/types";

/**
 * The error every OpenAPPA operation throws when it cannot decide safely.
 *
 * The native cause stays on `cause` for the logs. The client sees only a short,
 * classified detail: a policy the runtime refuses is the organization's own
 * configuration and names what to fix, while storage and runtime failures can
 * carry connection strings and stay generic. Every message ends with the trace
 * id so an operator can find the full cause in the logs.
 *
 * A refused policy fails the same way on every request, so clients are told
 * not to retry it (`x-should-retry: false` on a 500). An unavailable runtime
 * may recover, so it stays a retryable 503.
 */
export function openappaFailure(error: unknown): ApiError {
  if (error instanceof ApiError && error.message.startsWith(FAILURE_PREFIX))
    return error;
  const failure = classify(error);
  const reference = trace.getActiveSpan()?.spanContext().traceId;
  const message = `${FAILURE_PREFIX}: ${failure.detail}${
    reference ? ` (ref: ${reference})` : ""
  }`;
  const apiError = new ApiError(failure.statusCode, message);
  apiError.shouldRetry = failure.statusCode === 503;
  if (failure.statusCode === 503) apiError.retryAfterSeconds = RETRY_AFTER;
  apiError.cause = error;
  return apiError;
}

/**
 * A credential the organization's policy binds that could not be read for it:
 * its configuration, not the runtime, so retrying cannot help.
 */
export class OpenappaCredentialError extends Error {
  constructor(
    readonly variable: string,
    cause: unknown,
  ) {
    super(`the credential bound to ${variable} could not be resolved`, {
      cause,
    });
    this.name = "OpenappaCredentialError";
  }
}

// ===

const FAILURE_PREFIX = "OpenAPPA could not safely complete this operation";
const RETRY_AFTER = 5;
const MAX_DETAIL = 240;

/**
 * Opening refusals the runtime reports for the policy text itself (the
 * runtime's `OpenError` variants and the host's composition prefixes). Storage
 * and damage variants are deliberately absent.
 */
const POLICY_REFUSALS = [
  /^configuration refused: /,
  /^builtin modules refused: /,
  /^policy refused: /,
  /^unsupported policy: /,
  /^policy declares reserved tool name /,
  /^the adapter spells no name for the control tool/,
  /^the policy names tool /,
  /^policy names \S+ \S+, which has no \[externals\] binding/,
  /^\[externals\] binds /,
  /^annotator \S+ names /,
  /^root policy: /,
  /^battery \S+: /,
];

function classify(error: unknown): { statusCode: 500 | 503; detail: string } {
  if (error instanceof OpenappaCredentialError)
    return {
      statusCode: 500,
      detail: `${error.message}. An administrator can rebind it on the OpenAPPA page.`,
    };
  const message = error instanceof Error ? error.message : "";
  if (POLICY_REFUSALS.some((pattern) => pattern.test(message)))
    return {
      statusCode: 500,
      detail: `the organization's guardrails policy was refused (${summarize(message)}). An administrator can fix it on the OpenAPPA page.`,
    };
  if (message.startsWith("OpenAPPA had no free PostgreSQL connection"))
    return {
      statusCode: 503,
      detail: "the policy runtime has no free database connection.",
    };
  return { statusCode: 503, detail: "the policy runtime is unavailable." };
}

/** One line, bounded, with any URL credentials removed. */
function summarize(message: string): string {
  const line = message
    .replace(/\s+/g, " ")
    .replace(/\/\/[^/\s@]+@/g, "//")
    .trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}
