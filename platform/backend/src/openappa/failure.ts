import { trace } from "@opentelemetry/api";
import { z } from "zod";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import { isPolicyMoved } from "./policy-moved";

/**
 * The error every OpenAPPA operation throws when it cannot decide safely.
 *
 * The native cause stays on `cause` for the logs. The client sees a short,
 * classified message that says what happened, one action that helps, and the
 * trace id an operator finds the full cause under. Each status has one rule:
 *
 * - 400: the request's own content or the model's arguments cannot be
 *   processed. The same request fails the same way.
 * - 409: this conversation or subagent cannot continue. Start a new one.
 * - 500: the deployment or its policy needs an administrator or operator, or
 *   the failure is a defect. The message names the code to report.
 * - 503 with `retry-after`: a transient failure. The retry can succeed.
 *
 * Only a 503 tells clients to retry (`x-should-retry: true`). Every other
 * status tells them not to, so a client does not resend a request that cannot
 * succeed. Runtime detail stays out of the message unless the runtime wrote it
 * for the model: storage and defect detail can carry connection strings, tool
 * names and member addresses.
 */
export function openappaFailure(error: unknown): ApiError {
  if (error instanceof OpenappaFailure) return error;
  const failure = classify(error);
  logCause(error, failure);
  const reference = trace.getActiveSpan()?.spanContext().traceId;
  const trailer = [
    failure.code ? `code: ${failure.code}` : null,
    reference ? `ref: ${reference}` : null,
  ].filter((part) => part !== null);
  const message = trailer.length
    ? `${failure.detail} (${trailer.join(", ")})`
    : failure.detail;
  const apiError = new OpenappaFailure(failure.statusCode, message);
  apiError.shouldRetry = failure.statusCode === 503;
  if (failure.statusCode === 503) apiError.retryAfterSeconds = RETRY_AFTER;
  apiError.cause = error;
  return apiError;
}

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
  // Only a dispatch's refusal replaces one call; a remedy's fails the request.
  if (!message.startsWith(PROCESSING_INTERRUPTED)) return null;
  const refusal = unansweredAnnotation(message);
  if (!refusal) return null;
  const name = JSON.stringify(summarize(refusal.annotator, MAX_NAME));
  const head = `[appa] Not checked: OpenAPPA could not rule on this call because its annotator ${name} ${NO_ANSWER_REASON[refusal.reason] ?? "gave no answer"}. The call did not run.`;
  return refusal.transient
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

/** What {@link openappaFailure} returns: an OpenAPPA failure already classified. */
class OpenappaFailure extends ApiError {}

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

type Failure = {
  statusCode: 400 | 409 | 500 | 503;
  detail: string;
  /** Named in the message, so a reported failure says which one it was. */
  code?: RuntimeFailureCode | "unknown";
  /** The database's error class, for the operator log. */
  sqlstate?: string;
};

/**
 * Logs the native cause with its classification and the trace id the logger
 * adds, its URL credentials removed. The error handler logs only the
 * classified message. A failure the request's content caused is a warning;
 * one the conversation's state caused is information, so a session another
 * user presented still leaves a record; the rest are errors.
 */
function logCause(error: unknown, failure: Failure): void {
  const fields = {
    code: runtimeFailureCode(error),
    status: failure.statusCode,
    ...(failure.sqlstate ? { sqlstate: failure.sqlstate } : {}),
    cause: summarize(
      error instanceof Error ? error.message : String(error),
      MAX_CAUSE,
    ),
  };
  const line = "OpenAPPA could not safely complete an operation";
  if (failure.statusCode === 400) logger.warn(fields, line);
  else if (failure.statusCode === 409) logger.info(fields, line);
  else logger.error(fields, line);
}

function classify(error: unknown): Failure {
  const code = runtimeFailureCode(error);
  if (code !== null)
    return classifyCode(code, error instanceof Error ? error.message : "");
  if (error instanceof OpenappaRootOnlyError)
    return {
      statusCode: 500,
      detail: `Guardrails refused the organization's policy, and no earlier version of it can run (${summarize(error.refusal)}). An administrator can fix it on the ${POLICY_PAGE} page.`,
    };
  if (error instanceof OpenappaCredentialError)
    return {
      statusCode: 500,
      detail: `Guardrails could not resolve a credential the policy needs: ${error.message}. An administrator can rebind it on the ${POLICY_PAGE} page.`,
    };
  // A runtime whose refusal carries no policy-moved class yet reports it in text.
  if (isPolicyMoved(error)) return POLICY_MOVED;
  // A credential provider or another upstream the host called answered with
  // an outage of its own, relayed as the provider's status.
  if (
    error instanceof ApiError &&
    UPSTREAM_OUTAGE_STATUSES.has(error.statusCode)
  )
    return SERVICE_UNREACHABLE;
  // The host's own database or network failed while it served the runtime.
  switch (transientHostFailure(error)) {
    case "database":
      return STORAGE_TRANSIENT;
    case "network":
      return SERVICE_UNREACHABLE;
    default:
      return UNKNOWN;
  }
}

function classifyCode(code: RuntimeFailureCode, message: string): Failure {
  switch (code) {
    case "storage":
      return classifyStorage(message);
    case "remedy":
    case "trajectory":
      return classifyMasked(message, code);
    case "annotation_refused":
      return classifyAnnotation(message);
    // The runtime refuses the organization's policy document itself.
    case "policy_refused":
      return {
        statusCode: 500,
        detail: `Guardrails refused the organization's policy (${summarize(message)}). An administrator can fix it on the ${POLICY_PAGE} page.`,
      };
    // The policy needs a setting of this deployment, not of the document.
    case "runtime_misconfigured":
      return {
        statusCode: 500,
        detail: `The Guardrails policy needs a deployment setting this server lacks (${summarize(message)}). The operator of this deployment must set it.`,
      };
    case "undeclared_tool": {
      // The runtime names the tool; a tool name carries no credential.
      const tool = UNDECLARED_TOOL.exec(message)?.[1];
      return {
        statusCode: 500,
        detail: `Guardrails cannot check ${tool ? `the tool ${JSON.stringify(summarize(tool, MAX_NAME))}` : "a tool of this request"} because the organization's policy does not declare it. An administrator can add it on the ${POLICY_PAGE} page.`,
        code,
      };
    }
    case "resolution_diverged":
      return {
        statusCode: 500,
        detail: `Guardrails could not check this request because the helpers its policy consults did not agree on an answer. An administrator can check the policy's helpers on the ${POLICY_PAGE} page.`,
        code,
      };
    case "replay_timed_out":
      return {
        statusCode: 500,
        detail:
          "Guardrails stopped this policy test because it ran longer than its time limit. Make the test smaller and run it again.",
        code,
      };
    case "principal":
      return MALFORMED_PRINCIPAL.test(message)
        ? {
            statusCode: 500,
            detail: `Guardrails cannot check this request because the user's email address is not valid. An administrator must correct the user's email address.`,
            code,
          }
        : {
            statusCode: 409,
            detail:
              "Guardrails opened this conversation for another user. Start a new conversation.",
          };
    case "peer_message":
      return modelRefusal("Guardrails refused this message", message);
    // The runtime cannot rebuild the conversation's trajectory from its
    // stored record, or no longer has the policy it opened under. Every later
    // request fails the same way.
    case "untrusted_log":
      return {
        statusCode: 409,
        detail:
          "Guardrails cannot read the stored record of this conversation. Start a new conversation.",
      };
    case "policy_unavailable":
      return {
        statusCode: 409,
        detail:
          "This conversation started under a Guardrails policy that can no longer be loaded. Start a new conversation.",
      };
    case "legacy_family":
      return {
        statusCode: 409,
        detail:
          "This conversation was opened under an earlier Guardrails policy model. Start a new conversation.",
      };
    case "trajectory_ended":
      return CONVERSATION_ENDED;
    // The subagent's fork is bound elsewhere, ambiguous, or never existed.
    case "spawn":
      return SUBAGENT_ENDED;
    case "spawn_not_taken":
    case "unstarted_parent":
      return {
        statusCode: 409,
        detail:
          "Guardrails refuses this subagent because it did not start through a checked spawn, for example because it started while Guardrails was off. Start a new subagent to continue its work.",
      };
    case "pool_exhausted":
      return {
        statusCode: 503,
        detail:
          "Guardrails has no free database connection right now. Retry the request in a few seconds.",
      };
    case "contended":
      return {
        statusCode: 503,
        detail:
          "Guardrails could not record this request because other requests of this conversation kept changing its record. Retry the request in a few seconds.",
      };
    case "replay_busy":
      return {
        statusCode: 503,
        detail:
          "Too many Guardrails policy tests are running. Retry in a few seconds.",
      };
    // Another dispatch took over the operation while this one was cut off
    // from the ledger. That dispatch answers the retry.
    case "lease_lost":
      return {
        statusCode: 503,
        detail:
          "Another request of this conversation took over this Guardrails check. Retry the request.",
      };
    // A retry sent while the first attempt still runs gets that attempt's
    // answer. The first attempt can wait minutes for a reviewer.
    case "held_elsewhere":
      return {
        statusCode: 503,
        detail:
          "Another request of this conversation is still working on this Guardrails check, for example while a reviewer decides on an approval. Retry the request later.",
      };
    case "policy_moved":
      return POLICY_MOVED;
    // A defect of the host or the runtime: the same request fails the same
    // way, and its detail can name tools and members.
    case "panicked":
    case "engine_invariant":
    case "inventory_refused":
    case "invalid_input":
    case "dispatch":
    case "outstanding_call":
    case "call_id_reused":
    case "undeclared_spawn":
      return defect(code);
    default:
      return code satisfies never;
  }
}

/**
 * Classifies a storage failure by its shape. OpenAPPA reports a database
 * error as `PostgreSQL <severity> (SQLSTATE <code>)` and keeps the server's
 * text out, so the SQLSTATE is the one reliable signal. A failure without a
 * SQLSTATE is a connection, pool or contention failure, or a shape this
 * classifier does not know. Only the known persistent shapes are not retried.
 */
function classifyStorage(message: string): Failure {
  const sqlstate = SQLSTATE.exec(message)?.[1];
  if (sqlstate !== undefined) {
    if (NUL_SQLSTATES.has(sqlstate))
      return { statusCode: 400, detail: NUL_TEXT, sqlstate };
    if (isTransientSqlstate(sqlstate))
      return { ...STORAGE_TRANSIENT, sqlstate };
    return {
      statusCode: 500,
      detail: `Guardrails could not save its decision for this request because its database refused the write (SQLSTATE ${sqlstate}). Retrying will not help. Give this reference to your administrator.`,
      code: "storage",
      sqlstate,
    };
  }
  if (ENCRYPTED_PEER_VIEW.test(message))
    return {
      statusCode: 400,
      detail:
        "Guardrails cannot share messages between sessions while conversation encryption is on. Send the content another way.",
    };
  if (PERSISTENT_STORAGE.some((shape) => shape.test(message)))
    return {
      statusCode: 500,
      detail:
        "Guardrails found a stored record of this request that it cannot use. Retrying will not help. Give this reference to your administrator.",
      code: "storage",
    };
  return STORAGE_TRANSIENT;
}

/**
 * The binding reports some failures under the class of the operation that
 * failed, `remedy` or `trajectory`, with the runtime's own error as text. The
 * runtime renders each of its errors with a fixed prefix, so the cause is read
 * from that text. A remedy refusal is shown only in the shapes the runtime
 * writes for the model: its `[appa]` notices and its refusals of the
 * arguments of `execute_remedy_plan`. Any other remedy text is a defect, and
 * its detail stays out.
 */
function classifyMasked(
  message: string,
  code: "remedy" | "trajectory",
): Failure {
  const inner = message.replace(MASK_PREFIX, "");
  const masked = MASKED_CLASSES.find(([text]) => text.test(inner));
  // A trajectory text inside a trajectory failure names no other class.
  if (masked && masked[1] !== code) return classifyCode(masked[1], inner);
  if (code === "trajectory") return CONVERSATION_ENDED;
  if (MODEL_REMEDY_TEXTS.some((text) => text.test(inner)))
    return modelRefusal("Guardrails could not complete this remedy", inner);
  return defect(code);
}

/**
 * An annotator that gave no answer: a reason that can pass on a second
 * attempt is retryable, any other needs an administrator. The replay-only
 * `appa/do_something` refuses the model's own arguments.
 */
function classifyAnnotation(message: string): Failure {
  const inner = message.replace(MASK_PREFIX, "");
  if (inner.startsWith(`annotator=${DO_SOMETHING} error=`))
    return modelRefusal(
      `Guardrails refused the arguments of ${DO_SOMETHING}`,
      inner.slice(`annotator=${DO_SOMETHING} error=`.length),
    );
  const refusal = unansweredAnnotation(message);
  const name = refusal
    ? JSON.stringify(summarize(refusal.annotator, MAX_NAME))
    : null;
  const what = name ? `its annotator ${name}` : "an annotator";
  const why = refusal
    ? (NO_ANSWER_REASON[refusal.reason] ?? "gave no answer")
    : "gave no answer";
  if (refusal?.transient)
    return {
      statusCode: 503,
      detail: `Guardrails could not check this request because ${what} ${why}. Retry the request in a few seconds.`,
    };
  return {
    statusCode: 500,
    detail: `Guardrails could not check this request because ${what} ${why}. An administrator can check the annotator on the ${POLICY_PAGE} page.`,
    code: "annotation_refused",
  };
}

/**
 * A refusal the runtime wrote for the model about what it sent. It carries no
 * storage or host detail, so it is shown, bounded and without URL credentials.
 */
function modelRefusal(head: string, message: string): Failure {
  const inner = message.replace(MASK_PREFIX, "");
  // An `[appa]` notice already says what to do next.
  const notice = inner.startsWith(APPA_NOTICE);
  const text = sentence(
    summarize(inner.slice(notice ? APPA_NOTICE.length : 0)),
  );
  const reason = text ? `${head}: ${text}` : `${head}.`;
  return {
    statusCode: 400,
    detail: notice ? reason : `${reason} Change the request and try again.`,
  };
}

/** Ends `text` with a period, unless it is empty, punctuated or cut short. */
function sentence(text: string): string {
  return text === "" || /[.!?…]$/.test(text) ? text : `${text}.`;
}

function defect(code: RuntimeFailureCode): Failure {
  return {
    statusCode: 500,
    detail:
      "Guardrails failed unexpectedly while checking this request. Retrying will not help. Give this reference to your administrator.",
    code,
  };
}

/**
 * The runtime's refusal of a call whose annotator gave no answer:
 * `annotator=<name> error=<reason>`, where a non-success reason carries the
 * HTTP status the helper answered with. A reason the runtime does not name
 * with a fixed word, such as a refusal of `appa/do_something` arguments, is
 * not an unanswered annotator.
 */
function unansweredAnnotation(message: string): {
  annotator: string;
  reason: string;
  transient: boolean;
} | null {
  const match = UNANSWERED_ANNOTATION.exec(message.replace(MASK_PREFIX, ""));
  if (!match) return null;
  const [, annotator, reason, status] = match;
  if (annotator === DO_SOMETHING) return null;
  // A helper error without a status may pass; one more attempt costs little,
  // and the notice stops the model after it fails the same way.
  const transient =
    TRANSIENT_NO_ANSWER.has(reason) ||
    (reason === "non_success" &&
      (status === undefined || status === "429" || status.startsWith("5")));
  return { annotator, reason, transient };
}

/**
 * How the host itself failed transiently while it served the runtime, on the
 * error or a cause it wraps: a PostgreSQL error class a retry can get past
 * (`database`), or a network error reaching any service (`network`), which
 * can be the database, a credential store or a helper. A request that ran
 * out of time (`AbortSignal.timeout`) carries no code, only its name.
 */
function transientHostFailure(
  error: unknown,
  depth = 0,
): "database" | "network" | null {
  if (!(error instanceof Error) || depth > MAX_CAUSE_DEPTH) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (/^[0-9A-Z]{5}$/.test(code) && isTransientSqlstate(code))
      return "database";
    if (TRANSIENT_NETWORK_CODES.has(code)) return "network";
  }
  if (error.name === "TimeoutError") return "network";
  return transientHostFailure(error.cause, depth + 1);
}

/**
 * PostgreSQL error classes a retry can get past: a lost connection (08), a
 * serialization failure or deadlock (40001, 40P01), exhausted resources (53),
 * a lock not available (55P03), a cancelled statement (57014), an
 * administrator or crash shutdown (57P0x), and a read-only transaction during
 * a failover (25006).
 */
function isTransientSqlstate(sqlstate: string): boolean {
  return (
    sqlstate.startsWith("08") ||
    sqlstate.startsWith("53") ||
    sqlstate.startsWith("57P0") ||
    TRANSIENT_SQLSTATES.has(sqlstate)
  );
}

const TRANSIENT_SQLSTATES = new Set([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "25006",
]);

/**
 * A NUL character PostgreSQL cannot store: in `text` (22021, invalid byte
 * sequence for the encoding) or as `\u0000` in `jsonb` (22P05).
 */
const NUL_SQLSTATES = new Set(["22021", "22P05"]);

const SQLSTATE = /\(SQLSTATE ([0-9A-Z]{5})\)/;

/** Socket, DNS and undici codes a retry can get past. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** The statuses an upstream's own outage is relayed with. */
const UPSTREAM_OUTAGE_STATUSES = new Set([429, 502, 503, 504]);

const MAX_CAUSE_DEPTH = 5;

/** Storage failures without a SQLSTATE that fail the same way on every retry. */
const PERSISTENT_STORAGE = [
  /has an invalid status/,
  /lacks call context/,
  /requires its conversation key/,
];

const ENCRYPTED_PEER_VIEW =
  /peer sharing is unavailable for an encrypted storage view/;

const NUL_TEXT =
  "Guardrails cannot store this conversation because it contains a NUL character (U+0000), usually from a tool that printed binary data. Every retry sends the same conversation and fails the same way. Rewind the conversation to before that tool output, or start a new conversation.";

const STORAGE_TRANSIENT: Failure = {
  statusCode: 503,
  detail:
    "Guardrails could not save its decision for this request because its database was busy or unreachable. Retry the request in a few seconds.",
};

const SERVICE_UNREACHABLE: Failure = {
  statusCode: 503,
  detail:
    "Guardrails could not reach a service it needs. Retry the request in a few seconds.",
};

const POLICY_MOVED: Failure = {
  statusCode: 503,
  detail:
    "The organization's Guardrails policy changed while this request was checked. Retry the request.",
};

const CONVERSATION_ENDED: Failure = {
  statusCode: 409,
  detail: "Guardrails cannot continue this conversation. Start a new one.",
};

const SUBAGENT_ENDED: Failure = {
  statusCode: 409,
  detail: "Guardrails cannot continue this subagent. Start a new subagent.",
};

const UNKNOWN: Failure = {
  statusCode: 500,
  detail:
    "Guardrails failed unexpectedly while checking this request. Give this reference to your administrator.",
  code: "unknown",
};

/** The prefixes the binding puts before the runtime's own error text. */
const MASK_PREFIX =
  /^(?:OpenAPPA (?:processing|remedy) interrupted: |the root fork could not be opened: )+/;

/** The runtime's mark on text it writes for the model. */
const APPA_NOTICE = "[appa] ";

/**
 * The remedy refusals the runtime writes for the model: its `[appa]`
 * notices, an offer that no longer stands, and its refusals of the arguments
 * of `execute_remedy_plan` (the return declaration, the files and peer
 * messages a plan names, and malformed argument input).
 */
const MODEL_REMEDY_TEXTS: ReadonlyArray<RegExp> = [
  /^\[appa\] /,
  /^no live offer with this id exists/,
  /^`(?:label|return_schema)` /,
  /^this plan (?:takes no return|declares the subagent's return|attests the subagent's return|does not attest the subagent's return)/,
  /^file tracking: /,
  /^no peer message \S+ is held for this session/,
  /^(?:tool-call input must be|argument input |duplicate object key |trailing data after the argument object|array exceeds |number token exceeds )/,
];

/**
 * The start of each of the runtime's error texts that has a class of its own,
 * mapped to that class. A remedy or fork failure carries one of these texts
 * in place of its class.
 */
const MASKED_CLASSES: ReadonlyArray<readonly [RegExp, RuntimeFailureCode]> = [
  [/^storage failure: /, "storage"],
  [/^the persisted log is refused: /, "untrusted_log"],
  [/^the policy is unavailable: /, "policy_unavailable"],
  [
    /^this trajectory family was opened before live policy revisions/,
    "legacy_family",
  ],
  [/^deployment \S+ moved to policy revision /, "policy_moved"],
  [/^annotator=/, "annotation_refused"],
  [/^external resolution did not settle/, "resolution_diverged"],
  [/^the family log stayed contended/, "contended"],
  [/^engine invariant breach: /, "engine_invariant"],
  [/^the engine returned a follow-up/, "engine_invariant"],
  [/^host tool inventory is invalid: /, "inventory_refused"],
  [/^tool \S+ is not declared in this policy/, "undeclared_tool"],
  [/^delegation to \S+ is not declared by the policy/, "undeclared_spawn"],
  [/^a peer message of \d+ bytes exceeds/, "peer_message"],
  [/^the session principal /, "principal"],
  [/^the session already acts for another principal/, "principal"],
  [/^a call without a host id is already outstanding/, "outstanding_call"],
  [/^an earlier subagent spawn is still waiting/, "outstanding_call"],
  [/^a fan-out spawn released under this prompt/, "outstanding_call"],
  [/^the child has a call still open/, "outstanding_call"],
  [/^the host reused a call id/, "call_id_reused"],
  [/^the trajectory has ended/, "trajectory_ended"],
  [/^no trajectory with this id exists/, "trajectory"],
  [/^a trajectory with this id already exists/, "trajectory"],
  [/^this session started under an APPA version/, "trajectory"],
  [/^no open dispatch with this id exists/, "dispatch"],
  [/^this outcome does not match the open dispatch/, "dispatch"],
  [/^the spawn did not take/, "spawn_not_taken"],
  [/^only a child trajectory submits a return/, "spawn"],
  [/^a fan-out spawn needs the host's call id/, "spawn"],
  [/^the family has more than one spawn in flight/, "spawn"],
  [/^the fork and the child are already bound elsewhere/, "spawn"],
];

const MALFORMED_PRINCIPAL = /the session principal .* is not an address/;

const UNDECLARED_TOOL = /tool (\S+) is not declared in this policy/;

/** The replay-only call whose annotator refuses the model's own arguments. */
const DO_SOMETHING = "appa/do_something";

const UNANSWERED_ANNOTATION =
  /^annotator=(\S+) error=([a-z_]+)(?=$|[\s;])(?: status=(\d+))?/;

const PROCESSING_INTERRUPTED = "OpenAPPA processing interrupted: ";

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
