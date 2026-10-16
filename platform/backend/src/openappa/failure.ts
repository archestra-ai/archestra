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

/**
 * The notice that replaces one tool call whose annotator gave no answer, or
 * null for any other failure.
 *
 * The runtime cannot rule on that call, so it does not run and nothing is
 * recorded for it. The failure belongs to that call alone: the other calls of
 * the response were ruled on their own and still stand, including one that
 * spent an approval. Failing the whole response would cancel them after the
 * approval was spent. The notice names the annotator and a plain reason, never
 * the runtime's detail, which can quote the helper's own error.
 */
export function unansweredAnnotationNotice(error: unknown): string | null {
  const message =
    error instanceof ApiError && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "";
  const match = UNANSWERED_ANNOTATION.exec(message);
  if (!match) return null;
  const [, annotator, reason, status] = match;
  const name = JSON.stringify(summarize(annotator, MAX_NAME));
  // A helper error without a status may pass; one more attempt costs little,
  // and the notice stops the model after it fails the same way.
  const transient =
    TRANSIENT_NO_ANSWER.has(reason) ||
    (reason === "non_success" &&
      (status === undefined || status === "429" || status.startsWith("5")));
  const head = `[appa] Not checked: OpenAPPA could not rule on this call because its annotator ${name} ${NO_ANSWER_REASON[reason] ?? "gave no answer"}. The call did not run.`;
  return transient
    ? `${head} Make the same call again to retry. If it fails the same way again, stop and tell the user that Guardrails could not check this call.`
    : `${head} Retrying it will not help. Tell the user that Guardrails could not check this call. An administrator can check the annotator on the ${POLICY_PAGE} page.`;
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

/**
 * The organization's text was refused and no composition ever opened, so the
 * runtime has nothing to enforce: every governed call is refused.
 */
export class OpenappaRootOnlyError extends Error {
  constructor(readonly refusal: string) {
    super("no composition of the organization's policy has opened");
    this.name = "OpenappaRootOnlyError";
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
  /^a hosted document declares /,
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
  if (error instanceof OpenappaRootOnlyError)
    return {
      statusCode: 500,
      detail: `the organization's guardrails policy was refused and no earlier composition exists (${summarize(error.refusal)}). An administrator can fix it on the ${POLICY_PAGE} page.`,
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

/**
 * The runtime's refusal of a call whose annotator gave no answer:
 * `annotator=<name> error=<reason>`, where a non-success reason carries the
 * HTTP status the helper answered with.
 */
const UNANSWERED_ANNOTATION =
  /^OpenAPPA processing interrupted: annotator=(\S+) error=([a-z_]+)(?: status=(\d+))?/;

/** No-answer reasons a second attempt can get past. */
const TRANSIENT_NO_ANSWER = new Set(["timeout", "unreachable", "transport"]);

const NO_ANSWER_REASON: Record<string, string> = {
  timeout: "did not answer in time",
  unreachable: "could not be reached",
  transport: "could not be reached",
  non_success: "returned an error",
  unregistered: "is not set up in this deployment",
  malformed: "returned an answer OpenAPPA could not read",
  oversized: "returned an answer that was too large",
};

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
