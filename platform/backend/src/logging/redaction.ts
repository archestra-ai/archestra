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
  "passthroughHeaders",
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
    // The browser-held incognito conversation key rides this request header;
    // the server must never persist it, logs included. Hyphenated keys need
    // fast-redact's bracket syntax (same three shapes as above).
    '["x-archestra-incognito-key"]',
    '*["x-archestra-incognito-key"]',
    '*.headers["x-archestra-incognito-key"]',
  ]);

/**
 * Pino's default err serializer copies every enumerable own property of the
 * error. Upstream HTTP client errors (provider SDKs, our fetch wrappers that
 * attach `responseBody`) can therefore drag credentials (`headers`, `config`)
 * or unbounded upstream payloads into the log. Strip the credential carriers
 * and bound the payload fields. Non-Error values pass through untouched so
 * `{ error: "some message" }` call sites keep working.
 */
export function serializeErrorBounded(value: unknown): unknown {
  if (!(value instanceof Error)) return value;

  const serialized = pino.stdSerializers.err(value) as Record<string, unknown>;
  delete serialized.headers;
  delete serialized.config;
  delete serialized.request;

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

  return serialized;
}

// === Internal ===

/**
 * Longest string kept for upstream error payload fields. Provider SDK errors
 * carry the parsed error body; enough of it must survive to diagnose the
 * failure, but an unbounded body can echo whole requests.
 */
const MAX_SERIALIZED_ERROR_FIELD_LENGTH = 2_000;
