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
 * not to retry it (`x-should-retry: false` on a 500). So does a conversation
 * whose opening policy the runtime cannot reopen (a 409). An unavailable
 * runtime may recover, so it stays a retryable 503.
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

/** A conversation whose opening policy names an annotator the served policy does not answer. */
export class OpenappaRetiredAnnotatorError extends Error {
  constructor(readonly annotator: string) {
    super(
      "the served policy does not answer an annotator from the opening policy",
    );
    this.name = "OpenappaRetiredAnnotatorError";
  }
}

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
  if (error instanceof OpenappaRetiredAnnotatorError)
    return {
      statusCode: 409,
      detail: `this conversation started under a policy that no longer declares annotator "${summarize(error.annotator, MAX_NAME)}". Start a new conversation, or an administrator can declare "${summarize(error.annotator, MAX_NAME)}" again on the ${POLICY_PAGE} page.`,
    };
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
  // The runtime cannot reopen the policy this conversation started under: the
  // stored file is gone or no longer compiles to the identity the opening
  // recorded. Every later request of the conversation fails the same way.
  if (message.includes(OPENING_POLICY_UNAVAILABLE))
    return {
      statusCode: 409,
      detail:
        "this conversation started under a guardrails policy that the policy runtime cannot reopen. Start a new conversation.",
    };
  // Every later request of the subagent fails the same way: no fork exists
  // for it to open, whatever the retry.
  if (message.includes(UNFORKED_CHILD) || message === UNSTARTED_PARENT)
    return {
      statusCode: 409,
      detail:
        "this subagent did not start through a checked spawn. This can happen when it started while Guardrails enforcement was off. OpenAPPA refuses its requests. To continue its work, start a new subagent.",
    };
  return { statusCode: 503, detail: "the policy runtime is unavailable." };
}

/** The runtime's report of a dispatch that no longer owns its operation. */
const LEASE_LOST =
  "OpenAPPA lost its lease on this operation; retry the request";

/** The runtime's report of an operation another live request is working on. */
const HELD_ELSEWHERE =
  "OpenAPPA is processing this operation in another request; retry the request";

/** The runtime's refusal of a root whose opening policy it cannot load or verify. */
const OPENING_POLICY_UNAVAILABLE = "the opening policy is unavailable: ";

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
