import { trace } from "@opentelemetry/api";
import { z } from "zod";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import { isPolicyMoved } from "./policy-moved";

/**
 * The error every OpenAPPA operation throws when it cannot decide safely.
 *
 * The native cause stays on `cause` for the logs. The client sees only a short,
 * classified detail: a policy the runtime refuses is the organization's own
 * configuration and names what to fix, while storage and runtime failures can
 * carry connection strings and stay generic. Every message ends with the trace
 * id so an operator can find the full cause in the logs. A generic runtime
 * failure also names its code, or `unknown` when it carries none, so the
 * error card says which failure it was.
 *
 * A refused policy fails the same way on every request, so clients are told
 * not to retry it (`x-should-retry: false` on a 500). So do a missing
 * deployment setting and a request the binding cannot read, and a
 * conversation the runtime cannot continue (a 409), such as one opened under
 * an earlier policy model or one that holds content the database refuses to
 * store. An unavailable runtime may recover, so it stays a retryable 503, as
 * does a failure that carries no code (the addon did not load, or the host
 * failed). A storage failure logs its cause whatever the client is told.
 */
export function openappaFailure(error: unknown): ApiError {
  if (error instanceof OpenappaFailure) return error;
  const failure = classify(error);
  if (failure.statusCode >= 500 || runtimeFailureCode(error) === "storage")
    logCause(error);
  const reference = trace.getActiveSpan()?.spanContext().traceId;
  const message = `${FAILURE_PREFIX}: ${failure.detail}${
    reference ? ` (ref: ${reference})` : ""
  }`;
  const apiError = new OpenappaFailure(failure.statusCode, message);
  apiError.shouldRetry = failure.statusCode === 503;
  if (failure.statusCode === 503) apiError.retryAfterSeconds = RETRY_AFTER;
  apiError.cause = error;
  return apiError;
}

/**
 * Logs the native cause with the trace id the logger adds, its URL
 * credentials removed. The error handler logs only the classified message.
 */
function logCause(error: unknown): void {
  logger.error(
    {
      code: runtimeFailureCode(error),
      cause: summarize(
        error instanceof Error ? error.message : String(error),
        MAX_CAUSE,
      ),
    },
    "OpenAPPA could not safely complete an operation",
  );
}

/** What {@link openappaFailure} returns: an OpenAPPA failure already classified. */
class OpenappaFailure extends ApiError {}

/** The class the native binding stamped on `error`, if it carries one. */
export function runtimeFailureCode(error: unknown): RuntimeFailureCode | null {
  const code = RuntimeFailureCode.safeParse(
    error instanceof Error ? (error as { code?: unknown }).code : undefined,
  );
  return code.success ? code.data : null;
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
const MAX_CAUSE = 2000;
/** The title the frontend gives the page an administrator edits the policy on. */
const POLICY_PAGE = "Guardrails";

/**
 * The class the native binding stamps on a runtime failure as `error.code`:
 * the runtime's refusal classes, plus the binding's own lease, session,
 * policy-load, storage and input failures.
 */
const RuntimeFailureCode = z.enum([
  "storage",
  "untrusted_log",
  "policy_unavailable",
  "inventory_refused",
  "engine_invariant",
  "contended",
  "resolution_diverged",
  "annotation_refused",
  "undeclared_tool",
  "undeclared_spawn",
  "peer_message",
  "principal",
  "outstanding_call",
  "call_id_reused",
  "trajectory_ended",
  "trajectory",
  "dispatch",
  "remedy",
  "spawn",
  "spawn_not_taken",
  "lease_lost",
  "held_elsewhere",
  "unstarted_parent",
  "policy_moved",
  "legacy_family",
  "policy_refused",
  "runtime_misconfigured",
  "pool_exhausted",
  "replay_busy",
  "replay_timed_out",
  "invalid_input",
  "panicked",
]);
type RuntimeFailureCode = z.infer<typeof RuntimeFailureCode>;

type Failure = { statusCode: 409 | 500 | 503; detail: string };

function classify(error: unknown): Failure {
  const code = runtimeFailureCode(error);
  if (code !== null)
    return classifyCode(code, error instanceof Error ? error.message : "");
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
  // A runtime whose refusal carries no policy-moved class yet reports it in text.
  if (isPolicyMoved(error)) return POLICY_MOVED;
  return unavailable("unknown");
}

function classifyCode(code: RuntimeFailureCode, message: string): Failure {
  switch (code) {
    // The runtime refuses the organization's policy document itself.
    case "policy_refused":
      return {
        statusCode: 500,
        detail: `the organization's guardrails policy was refused (${summarize(message)}). An administrator can fix it on the ${POLICY_PAGE} page.`,
      };
    // The policy needs a setting of this deployment, not of the document.
    case "runtime_misconfigured":
      return {
        statusCode: 500,
        detail: `the guardrails policy needs a deployment setting this server lacks (${summarize(message)}). The operator of this deployment must set it.`,
      };
    // The host sent a request the binding cannot read: a defect, not an outage.
    case "invalid_input":
      return {
        statusCode: 500,
        detail: "the policy runtime refused a malformed request.",
      };
    case "pool_exhausted":
      return {
        statusCode: 503,
        detail: "the policy runtime has no free database connection.",
      };
    // A stored record of the conversation no longer decodes, so the runtime
    // cannot rebuild its trajectory. Every later request fails the same way.
    case "untrusted_log":
      return {
        statusCode: 409,
        detail:
          "the policy runtime cannot read this conversation's stored guardrails record. Start a new conversation.",
      };
    // The stored opening policy is gone or no longer compiles to the identity
    // the opening recorded.
    case "policy_unavailable":
      return {
        statusCode: 409,
        detail:
          "this conversation started under a guardrails policy that the policy runtime cannot reopen. Start a new conversation.",
      };
    // The conversation opened pinned to the policy it started under, which no
    // longer exists in the policy model. Every later request fails the same way.
    case "legacy_family":
      return {
        statusCode: 409,
        detail:
          "This conversation was opened under an earlier policy model. Start a new conversation.",
      };
    // No fork exists for the subagent to open, whatever the retry.
    case "spawn_not_taken":
    case "unstarted_parent":
      return {
        statusCode: 409,
        detail:
          "this subagent did not start through a checked spawn. This can happen when it started while Guardrails enforcement was off. OpenAPPA refuses its requests. To continue its work, start a new subagent.",
      };
    // Another dispatch took over the operation while this one was cut off
    // from the ledger. That dispatch answers the retry.
    case "lease_lost":
      return {
        statusCode: 503,
        detail:
          "another request of this session took over this operation. Retry the request.",
      };
    // The organization's policy changed while this request was decided, and
    // the backend's own retries did not catch up with it. Nothing was
    // recorded; the retry decides under the current policy.
    case "policy_moved":
      return POLICY_MOVED;
    // A retry sent while the first attempt still runs gets that attempt's answer.
    case "held_elsewhere":
      return {
        statusCode: 503,
        detail:
          "another request of this session is still working on this operation. Retry the request.",
      };
    // The database refuses the content itself, so the same request fails the
    // same way on every retry. Any other storage failure can pass.
    case "storage": {
      const state = REFUSED_CHARACTER.exec(message)?.[1];
      return state ? refusedContent(state) : unavailable(code);
    }
    case "panicked":
    case "replay_busy":
    case "replay_timed_out":
    case "inventory_refused":
    case "engine_invariant":
    case "contended":
    case "resolution_diverged":
    case "annotation_refused":
    case "undeclared_tool":
    case "undeclared_spawn":
    case "peer_message":
    case "principal":
    case "outstanding_call":
    case "call_id_reused":
    case "trajectory_ended":
    case "trajectory":
    case "dispatch":
    case "remedy":
    case "spawn":
      return unavailable(code);
    default:
      return code satisfies never;
  }
}

const POLICY_MOVED: Failure = {
  statusCode: 503,
  detail:
    "the organization's guardrails policy changed while this request was checked. Retry the request.",
};

/**
 * A character the database cannot store: 22021 in `text`, 22P05 in `jsonb`.
 * The stored content, not the database, is the cause. Any other data
 * exception can come from the host, so it is not blamed on the content.
 */
const REFUSED_CHARACTER = /\bSQLSTATE (22021|22P05)\b/;

function refusedContent(state: string): Failure {
  return {
    statusCode: 409,
    detail: `the database refused content in this conversation (code: storage, SQLSTATE ${state}). The same request fails again. Remove that content or start a new conversation.`,
  };
}

/**
 * The generic runtime failure, naming its code: a fixed name, never the
 * runtime's text. `unknown` marks a failure that carries no code.
 */
function unavailable(code: RuntimeFailureCode | "unknown"): Failure {
  return {
    statusCode: 503,
    detail: `the policy runtime is unavailable (code: ${code}).`,
  };
}

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

/** One line, bounded, with any URL credentials removed. */
function summarize(message: string, max = MAX_DETAIL): string {
  const line = message
    .replace(/\s+/g, " ")
    .replace(/\/\/[^/\s@]+@/g, "//")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
