import { DrizzleQueryError } from "drizzle-orm/errors";
import pino from "pino";
import { FAILED_QUERY_PREFIX } from "@/utils/db";

/**
 * Credential-shaped keys censored in every log record, at the top level and
 * one level deep (fast-redact `*` matches a single level). Nothing in the
 * codebase legitimately logs these key names with non-secret values.
 */
export const REDACTED_LOG_PATHS = [
  "authorization",
  "cookie",
  "rawToken",
  "deviceCode",
  "passthroughHeaders",
  "secretEnv",
  "bindingToken",
  "ARCHESTRA_AGENT_RUNTIME_BINDING",
  "apiKey",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "access_token",
  "refresh_token",
  "id_token",
  "clientSecret",
  "client_secret",
  "secret",
  "password",
]
  .flatMap((key) => [key, `*.${key}`, `*.headers.${key}`])
  .concat([
    ...["x-authenticateresponse", "X-AuthenticateResponse"].flatMap((key) => [
      `["${key}"]`,
      `*["${key}"]`,
      `*.headers["${key}"]`,
    ]),
    // The browser-held encrypted chat key rides this request header;
    // the server must never persist it, logs included. Hyphenated keys need
    // fast-redact's bracket syntax (same three shapes as above).
    '["x-archestra-openappa-context"]',
    '*["x-archestra-openappa-context"]',
    '*.headers["x-archestra-openappa-context"]',
    '["x-archestra-encrypted-chat-key"]',
    '*["x-archestra-encrypted-chat-key"]',
    '*.headers["x-archestra-encrypted-chat-key"]',
    '["x-archestra-internal-call"]',
    '*["x-archestra-internal-call"]',
    '*.headers["x-archestra-internal-call"]',
    '["x-archestra-guardrail-call"]',
    '*["x-archestra-guardrail-call"]',
    '*.headers["x-archestra-guardrail-call"]',
    '["x-archestra-runtime-binding"]',
    '*["x-archestra-runtime-binding"]',
    '*.headers["x-archestra-runtime-binding"]',
    '["X-Archestra-Runtime-Binding"]',
    '*["X-Archestra-Runtime-Binding"]',
    '*.headers["X-Archestra-Runtime-Binding"]',
    '["x-archestra-client-runtime-token"]',
    '*["x-archestra-client-runtime-token"]',
    '*.headers["x-archestra-client-runtime-token"]',
    '["X-Archestra-Client-Runtime-Token"]',
    '*["X-Archestra-Client-Runtime-Token"]',
    '*.headers["X-Archestra-Client-Runtime-Token"]',
  ]);

/**
 * Pino's default err serializer copies every enumerable own property of the
 * error. Upstream HTTP client errors (provider SDKs, our fetch wrappers that
 * attach `responseBody`) can therefore drag credentials (`headers`, `config`)
 * or the full conversation (`requestBodyValues`) into the log. Strip request
 * bodies and credential carriers, and bound response payload fields. Apply
 * the same policy to nested errors, including SDK retry histories.
 * Non-Error values pass through untouched so
 * `{ error: "some message" }` call sites keep working.
 */
export function serializeErrorBounded(value: unknown): unknown {
  return serializeError(value, new WeakSet());
}

/** Provider-controlled text can echo prompts even in a short message or stack. */
export function serializeErrorMetadata(value: unknown): unknown {
  return errorMetadata({ value, ancestors: new WeakSet(), depth: 0 });
}

/** Separate raw diagnostic fields bypass the Error serializers. */
export function withholdErrorContent(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...record };
  // Pino's err/error serializers miss ordinary mapped errors and standalone
  // diagnostics such as lastErrorType. Apply one policy to error-named fields
  // rather than trusting text because a call site gave it a different alias.
  // The exact `error` key is handled by its serializer below.
  for (const [key, value] of Object.entries(result)) {
    if (
      key !== "error" &&
      key.toLowerCase().includes("error") &&
      value !== null &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    ) {
      result[key] = serializeErrorMetadata(value);
    }
  }
  // Codex terminal diagnostics copy these fields from the upstream response.
  // Only the protocol's terminal classifications are metadata; an unexpected
  // status can be arbitrary provider text just like its code and reason.
  if (
    "incompleteReason" in result &&
    result.status !== "failed" &&
    result.status !== "incomplete"
  ) {
    result.status = "[not stored: log content mode]";
  }
  for (const key of [
    "stack",
    // Raw provider frames and request/response diagnostics can be logged next
    // to an error rather than attached to it, including at debug level.
    "line",
    "linePreview",
    "data",
    "event",
    "chunk",
    "body",
    "payload",
    "text",
    "content",
    "prompt",
    "messages",
    "arguments",
    "params",
    "parameters",
    "query",
    "request",
    "response",
    "result",
    "toolArguments",
    "toolResult",
    // Raw SDK usage objects can hold malformed provider text in token fields.
    "usage",
    "incompleteReason",
    "rawFinishReason",
    "responseBody",
    "requestBody",
    "requestBodyValues",
  ]) {
    if (key in result) result[key] = "[not stored: log content mode]";
  }
  // SDK error codes can be provider-controlled free text too. Numeric protocol
  // codes are safe; local classifications use mappedCode instead.
  if (typeof result.code === "string")
    result.code = "[not stored: log content mode]";
  // Errors under any other key or nested deeper, and failed-query text copied
  // into a string field, bypass the policies above. The exact err/error keys
  // are handled by their serializers.
  for (const [key, value] of Object.entries(result)) {
    if (key !== "err" && key !== "error")
      result[key] = withholdNestedErrorContent(value);
  }
  return result;
}

/**
 * Removes error content from values pino does not pass through the record
 * formatter: child bindings, and the message and printf arguments, which call
 * sites often build from `${error}` or `error.message`. The ORM's failed-query
 * text lists every bound value, such as the chat messages being stored.
 */
export function withholdNestedErrorContent(value: unknown): unknown {
  return withholdNested({ value, ancestors: new WeakSet(), depth: 0 });
}

/** A message or printf argument; `%s` would print an Error's message. */
export function withholdLogArgument(value: unknown): unknown {
  if (value instanceof Error)
    return `${value.constructor.name}: ${WITHHELD_CONTENT}`;
  return withholdNestedErrorContent(value);
}

// === Internal ===

function serializeError(value: unknown, ancestors: WeakSet<Error>): unknown {
  if (!(value instanceof Error)) return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);

  const serialized = pino.stdSerializers.err(value) as Record<string, unknown>;
  delete serialized.headers;
  delete serialized.config;
  delete serialized.request;
  delete serialized.requestBody;
  delete serialized.requestBodyValues;

  // Pino recursively serializes Error properties using its own serializer,
  // bypassing ours. Reapply our policy to those children (e.g. lastError).
  // Work on the serialized copy; callers still need the original payload
  // for retries, error handling and interaction records.
  for (const key of Object.keys(serialized)) {
    const original = (value as unknown as Record<string, unknown>)[key];
    if (original instanceof Error) {
      serialized[key] = serializeError(original, ancestors);
    }
  }

  // Pino emits aggregateErrors for both AggregateError and SDK RetryError;
  // the latter also exposes the same history under its enumerable errors key.
  const errors = (value as Error & { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const sanitized = errors.map((error) => serializeError(error, ancestors));
    serialized.aggregateErrors = sanitized;
    if (Object.hasOwn(serialized, "errors")) serialized.errors = sanitized;
  }

  for (const key of ["responseBody", "body", "responseText"]) {
    const field = serialized[key];
    if (
      typeof field === "string" &&
      field.length > MAX_SERIALIZED_ERROR_FIELD_LENGTH
    ) {
      serialized[key] =
        `${field.slice(0, MAX_SERIALIZED_ERROR_FIELD_LENGTH)}…[truncated]`;
    }
  }

  ancestors.delete(value);
  return serialized;
}

/**
 * Longest string kept for upstream error payload fields. Provider SDK errors
 * carry the parsed error body; enough of it must survive to diagnose the
 * failure, but an unbounded body can echo whole requests.
 */
const MAX_SERIALIZED_ERROR_FIELD_LENGTH = 2_000;

function errorMetadata({
  value,
  ancestors,
  depth,
  databaseError = false,
}: {
  value: unknown;
  ancestors: WeakSet<object>;
  depth: number;
  databaseError?: boolean;
}): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return "[not stored: log content mode]";
  if (ancestors.has(value) || depth > 5) return "[Circular or nested error]";
  ancestors.add(value);
  const error = value as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  databaseError ||= value instanceof DrizzleQueryError;
  if (value instanceof DrizzleQueryError) {
    // SQL itself may contain literals; only keep its statement classification.
    const statement = sqlStatementKind(value.query);
    if (statement) metadata.statement = statement;
    metadata.parameterCount = value.params.length;
  }
  if (databaseError) {
    // Only trust protocol fields in a database error chain, not provider codes
    // or the driver's message/detail/where, which may echo bound values.
    if (typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code))
      metadata.code = error.code;
    if (
      typeof error.severity === "string" &&
      /^(ERROR|FATAL|PANIC|WARNING|NOTICE|DEBUG|INFO|LOG)$/.test(error.severity)
    )
      metadata.severity = error.severity;
    // This is a schema identifier, not the constraint's rejected value.
    if (
      typeof error.constraint === "string" &&
      /^[a-z_][a-z0-9_$]{0,62}$/i.test(error.constraint)
    )
      metadata.constraint = error.constraint;
  }
  // Constructor identity comes from code, whereas SDK name/type/code fields
  // can be populated directly from the provider's response.
  if (value instanceof Error) metadata.type = value.constructor.name;
  if (
    error.reason === "maxRetriesExceeded" ||
    error.reason === "errorNotRetryable" ||
    error.reason === "abort"
  ) {
    metadata.reason = error.reason;
  }
  for (const key of ["status", "statusCode", "isRetryable"]) {
    const field = error[key];
    if (typeof field === "number" || typeof field === "boolean")
      metadata[key] = field;
  }
  for (const key of ["cause", "lastError", "originalError"]) {
    if (error[key] !== undefined)
      metadata[key] = errorMetadata({
        value: error[key],
        ancestors,
        depth: depth + 1,
        databaseError,
      });
  }
  if (Array.isArray(error.errors)) {
    metadata.errors = error.errors
      .slice(0, 10)
      .map((child) =>
        errorMetadata({ value: child, ancestors, depth: depth + 1 }),
      );
  }
  ancestors.delete(value);
  return metadata;
}

const WITHHELD_CONTENT = "[not stored: log content mode]";

/** Deep enough for ordinary log context, bounded for hostile or cyclic data. */
const MAX_NESTED_LOG_DEPTH = 8;

function withholdNested({
  value,
  ancestors,
  depth,
}: {
  value: unknown;
  ancestors: WeakSet<object>;
  depth: number;
}): unknown {
  if (typeof value === "string") return withholdFailedQueryText(value);
  if (value instanceof Error) return serializeErrorMetadata(value);
  if (typeof value !== "object" || value === null) return value;
  // Class instances (dates, buffers, URLs) serialize without error content.
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_NESTED_LOG_DEPTH) return WITHHELD_CONTENT;
  ancestors.add(value);
  const next = (child: unknown) =>
    withholdNested({ value: child, ancestors, depth: depth + 1 });
  const result = isArray
    ? value.map(next)
    : Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, next(child)]),
      );
  ancestors.delete(value);
  return result;
}

/**
 * Keeps the text before a failed query and its statement kind; the SQL can
 * hold literals and the params line holds every bound value.
 */
function withholdFailedQueryText(text: string): string {
  const index = text.indexOf(FAILED_QUERY_PREFIX);
  if (index === -1) return text;
  const statement = sqlStatementKind(
    text.slice(index + FAILED_QUERY_PREFIX.length),
  );
  return `${text.slice(0, index)}${FAILED_QUERY_PREFIX} ${statement ? `${statement} ` : ""}${WITHHELD_CONTENT}`;
}

function sqlStatementKind(sql: string): string | undefined {
  return /^\s*(select|insert|update|delete|with|create|alter|drop|truncate)\b/i
    .exec(sql)?.[1]
    .toUpperCase();
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
