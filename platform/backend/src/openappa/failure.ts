import { trace } from "@opentelemetry/api";
import { ApiError } from "@/types/api";

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
const MAX_NAME = 80;
/** The title the frontend gives the page an administrator edits the policy on. */
const POLICY_PAGE = "Guardrails";

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

function classify(error: unknown): {
  statusCode: 409 | 500 | 503;
  detail: string;
} {
  if (error instanceof OpenappaCredentialError)
    return {
      statusCode: 500,
      detail: `${error.message}. An administrator can rebind it on the ${POLICY_PAGE} page.`,
    };
  const message = error instanceof Error ? error.message : "";
  if (POLICY_REFUSALS.some((pattern) => pattern.test(message)))
    return {
      statusCode: 500,
      detail: `the organization's guardrails policy was refused (${summarize(message)}). An administrator can fix it on the ${POLICY_PAGE} page.`,
    };
  if (message.startsWith("OpenAPPA had no free PostgreSQL connection"))
    return {
      statusCode: 503,
      detail: "the policy runtime has no free database connection.",
    };
  // Another dispatch took over the operation while this one was cut off from
  // the ledger. That dispatch answers the retry.
  if (message === LEASE_LOST)
    return {
      statusCode: 503,
      detail:
        "another request of this session took over this operation. Retry the request.",
    };
  // Another request still works on the same operation, such as a retry sent
  // while the first attempt runs. The retry gets its answer.
  if (message === HELD_ELSEWHERE)
    return {
      statusCode: 503,
      detail:
        "another request of this session is still working on this operation. Retry the request.",
    };
  // Every later request of the subagent fails the same way: no fork exists
  // for it to open, whatever the retry.
  if (message.includes(UNFORKED_CHILD) || message === UNSTARTED_PARENT)
    return {
      statusCode: 409,
      detail:
        "this subagent did not start through a checked spawn. This can happen when it started while Guardrails enforcement was off. OpenAPPA refuses its requests. To continue its work, start a new subagent.",
    };
  // The session opened under a policy whose annotator the served policy no
  // longer declares. Every retry asks for the same name and fails the same way;
  // an unreachable or slow annotator that is still declared can recover.
  const retired = RETIRED_ANNOTATOR.exec(message);
  if (retired) {
    const name = summarize(retired[1], MAX_NAME);
    return {
      statusCode: 409,
      detail: `this conversation started under a policy that no longer declares annotator "${name}". Start a new conversation, or an administrator can declare "${name}" again on the ${POLICY_PAGE} page.`,
    };
  }
  return { statusCode: 503, detail: "the policy runtime is unavailable." };
}

/** The runtime's refusal of a consult no annotator of the served policy answers. */
const RETIRED_ANNOTATOR =
  /^OpenAPPA processing interrupted: annotator=(\S+) error=unregistered\b/;

/** The runtime's report of a dispatch that no longer owns its operation. */
const LEASE_LOST =
  "OpenAPPA lost its lease on this operation; retry the request";

/** The runtime's report of an operation another live request is working on. */
const HELD_ELSEWHERE =
  "OpenAPPA is processing this operation in another request; retry the request";

/** The runtime's refusal of a child that no approved spawn prepared. */
const UNFORKED_CHILD = "no prepared fork to open this child";
const UNSTARTED_PARENT = "parent session has not started";

/** One line, bounded, with any URL credentials removed. */
function summarize(message: string, max = MAX_DETAIL): string {
  const line = message
    .replace(/\s+/g, " ")
    .replace(/\/\/[^/\s@]+@/g, "//")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
