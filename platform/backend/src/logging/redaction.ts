import pino from "pino";

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
  // The launch spec's system prompt parts hold the Agent's instructions,
  // as private as the copy in secretEnv.
  "systemPromptParts",
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
  "github_token",
  "githubToken",
  "clientSecret",
  "client_secret",
  "secret",
  "password",
]
  .flatMap((key) => [key, `*.${key}`, `*.headers.${key}`])
  .concat([
    ...[
      "api-key",
      "Api-Key",
      "API-Key",
      "x-api-key",
      "x-archestra-virtual-key",
      "x-authenticateresponse",
      "X-AuthenticateResponse",
    ].flatMap((key) => [`["${key}"]`, `*["${key}"]`, `*.headers["${key}"]`]),
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
    '["x-archestra-a2a-oauth-execution"]',
    '*["x-archestra-a2a-oauth-execution"]',
    '*.headers["x-archestra-a2a-oauth-execution"]',
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
  for (const key of [
    "stack",
    "rawErrorJson",
    "parsedError",
    "errorBody",
    "upstreamError",
    "errorMessage",
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
  return result;
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
}: {
  value: unknown;
  ancestors: WeakSet<object>;
  depth: number;
}): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return "[not stored: log content mode]";
  if (ancestors.has(value) || depth > 5) return "[Circular or nested error]";
  ancestors.add(value);
  const error = value as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
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
  for (const key of ["cause", "lastError"]) {
    if (error[key] !== undefined)
      metadata[key] = errorMetadata({
        value: error[key],
        ancestors,
        depth: depth + 1,
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
