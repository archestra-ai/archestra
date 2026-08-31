import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_RECORDING_DEFAULT_MAX_FINAL_CUT_MS,
  BM25_B_DEFAULT,
  BM25_B_MAX,
  BM25_B_MIN,
  BM25_K1_DEFAULT,
  BM25_K1_MAX,
  BM25_K1_MIN,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
  DEFAULT_APP_NAME,
  DEFAULT_CHAT_ATTACHMENT_INLINE_BYTES,
  DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
  DEFAULT_CHILD_CHUNK_SIZE_TOKENS,
  DEFAULT_CHUNK_SIZE_TOKENS,
  DEFAULT_CONTEXT_EXPANSION_RADIUS,
  DEFAULT_MODELS,
  DEFAULT_VAULT_TOKEN,
  isValidK8sCpuQuantity,
  isValidK8sMemoryQuantity,
  MAX_CHUNK_SIZE_TOKENS,
  MAX_CONTEXT_EXPANSION_RADIUS,
  MCP_ORCHESTRATOR_DEFAULTS,
  MIN_CHILD_CHUNK_SIZE_TOKENS,
  MIN_CHUNK_SIZE_TOKENS,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import type { OTLPExporterNodeConfigBase } from "@opentelemetry/otlp-exporter-base";
import dotenv from "dotenv";
import logger from "@/logging";
import { SKILL_MARKETPLACE_PREFIX } from "@/routes/route-paths";
import {
  type EmailProviderType,
  EmailProviderTypeSchema,
} from "@/types/email-provider-type";
import packageJson from "../../package.json";

type ProcessType = "web" | "worker" | "renderer" | "all";
type FileStorageProviderType = "db" | "filesystem" | "s3";

/**
 * Resolved S3 byte-store config (validated only when provider === "s3").
 * @public — consumed by the S3 file-storage provider in a later task
 */
export type FileStorageS3Config = {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  forcePathStyle: boolean;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  keyPrefix: string;
};

/**
 * Load .env from platform root
 *
 * This is a bit of a hack for now to avoid having to have a duplicate .env file in the backend subdirectory
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

const sentryDsn = process.env.ARCHESTRA_SENTRY_BACKEND_DSN || "";
const environment = process.env.NODE_ENV?.toLowerCase() ?? "";
const isProduction = ["production", "prod"].includes(environment);
const isDevelopment = !isProduction;

const appVersion = process.env.ARCHESTRA_VERSION || packageJson.version;

/**
 * Developer-only convenience: when set (and NOT in production), the login screen
 * is skipped by minting a real session for the user with this email (see the
 * dev-auto-login Better Auth plugin). Hard-disabled in production so it can never
 * bypass authentication on a real deployment. The session is an ordinary one for
 * that user — RBAC is unchanged.
 */
const devAutoAuthenticateEmail = isProduction
  ? undefined
  : process.env.ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL?.trim() || undefined;

if (devAutoAuthenticateEmail) {
  logger.warn(
    { email: devAutoAuthenticateEmail },
    "[config] ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL is set: the login screen is skipped by auto-minting a session for this user. Developer-only, ignored in production.",
  );
}

/**
 * Parse `ARCHESTRA_FRONTEND_URL` into the canonical frontend base URL.
 *
 * Trailing slashes are stripped: every consumer appends its own path
 * (`${frontendBaseUrl}/settings`), and the OAuth issuer identifier is this
 * exact string — RFC 8414 requires the metadata issuer to be byte-identical
 * to the URL clients resolved the well-known document from, and better-auth
 * derives the RFC 9207 `iss` authorization-response parameter from it with
 * any trailing slash stripped. A slashed value here would re-introduce the
 * issuer mismatch that makes strict clients abort authorization.
 * @public — exported for testability
 */
export function parseFrontendBaseUrl(rawValue: string | undefined): string {
  const trimmed = rawValue?.trim();
  return (trimmed || "http://localhost:3000").replace(/\/+$/, "");
}

const frontendBaseUrl = parseFrontendBaseUrl(
  process.env.ARCHESTRA_FRONTEND_URL,
);
const DEFAULT_POSTHOG_KEY = "phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * Determines OTLP authentication headers based on environment variables
 * Returns undefined if authentication is not properly configured
 * @public — exported for testability
 */
export const getOtlpAuthHeaders = (): Record<string, string> | undefined =>
  buildOtlpAuthHeaders("ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH");

/**
 * OTLP authentication headers for the RUM (product-usage telemetry) export
 * pipeline — same contract as getOtlpAuthHeaders, separate credentials.
 * @public — exported for testability
 */
export const getRumOtlpAuthHeaders = (): Record<string, string> | undefined =>
  buildOtlpAuthHeaders("ARCHESTRA_RUM_EXPORTER_OTLP_AUTH");

const buildOtlpAuthHeaders = (
  envPrefix: string,
): Record<string, string> | undefined => {
  const username = process.env[`${envPrefix}_USERNAME`]?.trim();
  const password = process.env[`${envPrefix}_PASSWORD`]?.trim();
  const bearer = process.env[`${envPrefix}_BEARER`]?.trim();

  // Bearer token takes precedence
  if (bearer) {
    return {
      Authorization: `Bearer ${bearer}`,
    };
  }

  // Basic auth requires both username and password
  if (username || password) {
    if (!username || !password) {
      logger.warn(
        `OTEL authentication misconfigured: both ${envPrefix}_USERNAME and ${envPrefix}_PASSWORD must be provided for basic auth`,
      );
      return undefined;
    }

    const credentials = Buffer.from(`${username}:${password}`).toString(
      "base64",
    );
    return {
      Authorization: `Basic ${credentials}`,
    };
  }

  // No authentication configured
  return undefined;
};

/**
 * Get database URL (prefer ARCHESTRA_DATABASE_URL, fallback to DATABASE_URL)
 * @public — exported for testability
 */
export const getDatabaseUrl = (): string => {
  const databaseUrl =
    process.env.ARCHESTRA_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
    );
  }
  return databaseUrl;
};

/**
 * Parse port from ARCHESTRA_INTERNAL_API_BASE_URL if provided
 */
const getPortFromUrl = (): number => {
  const url = process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
  const defaultPort = 9000;

  if (!url) {
    return defaultPort;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : defaultPort;
  } catch {
    return defaultPort;
  }
};

/**
 * Networking & Origin Validation Strategy
 * ========================================
 *
 * Development mode:
 *   - Backend and frontend bind to 127.0.0.1 (loopback only).
 *   - Only local processes can reach the server, so CORS and origin
 *     checks are unnecessary. All origins are accepted.
 *
 * Quickstart mode (Docker):
 *   - Inside the container the app binds to 0.0.0.0.
 *   - Quickstart examples bind host ports to 127.0.0.1 by default.
 *     Users can opt into LAN access with explicit `0.0.0.0` port bindings.
 *   - Quickstart is designed for quick evaluation, so all origins are
 *     accepted without checks. It's ok if someone will decide to
 *     access Archestra from the mobile phone.
 *
 * Production mode:
 *   - Origin validation is OFF by default. All origins are accepted.
 *   - Origin checks are only enforced when explicitly configured via:
 *       ARCHESTRA_FRONTEND_URL              — primary frontend origin
 *       ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS — comma-separated extra origins
 *   - Setting either variable signals that origin validation should be
 *     performed. Only the configured origins will be allowed.
 */

/**
 * Collect all explicitly configured origins from environment variables.
 */
const getConfiguredOrigins = (): string[] => {
  const origins: string[] = [];

  const frontendUrl = process.env.ARCHESTRA_FRONTEND_URL?.trim();
  if (frontendUrl) {
    origins.push(frontendUrl);
  }

  const ngrokDomain = process.env.ARCHESTRA_NGROK_DOMAIN?.trim();
  if (ngrokDomain) {
    origins.push(ngrokDomain);
  }

  const additional =
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS?.trim();
  if (additional) {
    origins.push(
      ...additional
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    );
  }

  return origins;
};

/**
 * For each origin containing "localhost", add the equivalent "127.0.0.1" origin (and vice versa).
 */
const addLoopbackEquivalents = (origins: string[]): string[] => {
  const result = new Set(origins);
  for (const origin of origins) {
    if (origin.includes("localhost")) {
      result.add(origin.replace("localhost", "127.0.0.1"));
    } else if (origin.includes("127.0.0.1")) {
      result.add(origin.replace("127.0.0.1", "localhost"));
    }
  }
  return [...result];
};

/**
 * Where the offline video renderer reaches this deployment's own frontend to
 * load the replay page it films.
 *
 * Falls back to this deployment's first configured origin before loopback.
 * That set is the same one CORS, auth and the app sandbox are built from, so
 * whichever way a deployment spells its frontend — a public hostname, a
 * tunnel, an extra trusted origin — the renderer targets something already
 * trusted rather than an address nothing was configured for. Defaulting
 * straight to loopback is what makes a tunnelled deployment film an empty app
 * pane: the sandbox declines to be framed by an untrusted origin, and the
 * render cannot tell that apart from an app that drew nothing.
 *
 * The backend's own base URL is deliberately not a candidate: the page being
 * filmed is a frontend route.
 *
 * @public — exported for testability
 */
export function resolveRenderBaseUrl(params: {
  explicit: string | undefined;
  configuredOrigins: string[];
}): string {
  return (
    params.explicit?.trim() ||
    params.configuredOrigins[0] ||
    "http://localhost:3000"
  );
}

/**
 * Base URL for the `ollama-native` transport.
 *
 * Same Ollama server as the OpenAI-compatible provider, different endpoint: the
 * native API is rooted at `/`, not `/v1`. So the native URL defaults from
 * `ARCHESTRA_OLLAMA_BASE_URL` with any trailing slashes and `/v1` suffix
 * stripped, letting a deployment configure one variable and get both providers.
 *
 * @public — exported for testability
 */
export function deriveOllamaNativeBaseUrl(params: {
  nativeBaseUrl: string | undefined;
  ollamaBaseUrl: string | undefined;
}): string {
  return stripOllamaV1Suffix(
    params.nativeBaseUrl ?? params.ollamaBaseUrl ?? "http://localhost:11434",
  );
}

/**
 * Strip a trailing `/v1` (and any trailing slashes) so an OpenAI-compatible
 * Ollama URL becomes the native root. Shared with the model fetcher, which
 * normalizes the same way.
 *
 * @public — exported for testability
 */
export function stripOllamaV1Suffix(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const hackathonRecorderRenderBaseUrl = resolveRenderBaseUrl({
  // Undocumented on purpose, like the rest of the Apps Hackathon recorder (a
  // temporary, hackathon-only feature — see the recorder flag below). Do not add
  // this to .env.example or the deployment docs. It rarely needs setting anyway:
  // the fallback already targets a trusted configured origin.
  explicit: process.env.ARCHESTRA_HACKATHON_RECORDER_RENDER_BASE_URL,
  configuredOrigins: getConfiguredOrigins(),
});

/**
 * Get CORS origin configuration for Fastify.
 * When no origin env vars are set, accepts all origins.
 * When configured, only allows the specified origins.
 * @public — exported for testability
 */
export const getCorsOrigins = (): (string | RegExp)[] => {
  const origins = getConfiguredOrigins();

  if (origins.length === 0) {
    return [/.*/];
  }

  return addLoopbackEquivalents(origins);
};

/**
 * Get trusted origins for better-auth.
 * When no origin env vars are set, accepts all origins.
 * When configured, only allows the specified origins.
 * @public — exported for testability
 */
export const getTrustedOrigins = (): string[] => {
  const origins = getConfiguredOrigins();

  if (origins.length === 0) {
    return ["http://*:*", "https://*:*", "http://*", "https://*"];
  }

  return addLoopbackEquivalents(origins);
};

/**
 * Parse incoming email provider from environment variable
 */
const parseIncomingEmailProvider = (): EmailProviderType | undefined => {
  const provider =
    process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER?.toLowerCase();
  const result = EmailProviderTypeSchema.safeParse(provider);
  return result.success ? result.data : undefined;
};

/**
 * Parse body limit from environment variable.
 * Supports numeric bytes (e.g., "52428800") or human-readable format (e.g., "50MB", "100KB").
 * @public — exported for testability
 */
export const parseBodyLimit = (
  envValue: string | undefined,
  defaultValue: number,
): number => {
  if (!envValue) {
    return defaultValue;
  }

  const trimmed = envValue.trim();

  // Try parsing human-readable format first (e.g., "50MB", "100KB")
  // This must come first because parseInt("50MB") would return 50
  const match = trimmed.match(/^(\d+)(KB|MB|GB)$/i);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2].toUpperCase();
    switch (unit) {
      case "KB":
        return value * 1024;
      case "MB":
        return value * 1024 * 1024;
      case "GB":
        return value * 1024 * 1024 * 1024;
    }
  }

  // Try parsing as plain number (bytes) - must be all digits
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return defaultValue;
};

/**
 * Parse the idle keep-alive timeout (ms) an HTTP server holds a connection open
 * for after finishing a response.
 *
 * This is a "must be longer than whatever proxies you" setting, not a tuning
 * knob: when a reverse proxy or cloud load balancer pools connections to the
 * origin, and the origin closes an idle one first, the proxy can dispatch a
 * request onto a socket that is being torn down at that instant. That race
 * surfaces to the end client as an intermittent dropped connection or 502 on a
 * request that would otherwise have succeeded — rare enough to look like a flaky
 * network, frequent enough to interrupt long agent sessions.
 *
 * Only a positive integer is honoured. Zero cannot express "never close" here
 * (Fastify coerces a falsy `keepAliveTimeout` back to its own default, and the
 * Next.js standalone server likewise ignores `0`), so any non-positive or
 * unparsable value falls back to the default rather than silently producing a
 * different timeout than the operator asked for.
 *
 * Digits only, rather than parseInt, and it matters more here than it does for
 * `parseOutputTokenCeiling`: parseInt stops at the first non-digit, so a
 * plausible typo — "620_000", "620s", "1.5" — would yield a sub-second
 * keep-alive rather than the default. That is not a mildly wrong value; it is two orders of
 * magnitude below Node's own 5s default, so a typo would make the very failure
 * this setting exists to prevent dramatically worse, silently. Invalid input is
 * logged rather than swallowed, because the symptom (an occasional dropped
 * request) gives an operator nothing to trace back to the typo.
 *
 * @public — exported for testability
 */
export const parseKeepAliveTimeoutMs = (
  envValue: string | undefined,
  defaultValue: number,
): number => {
  const value = envValue?.trim();
  if (!value) {
    return defaultValue;
  }

  // Digits only, like `parseBodyLimit`'s plain-number path. Number() alone
  // would still admit two hazards it reads as valid integers: "0x1" parses to
  // a 1ms keep-alive — the very sub-second window this guard exists to reject —
  // and "1e6" parses to 1000000 while the container entrypoint, which screens
  // on the same digits-only rule, rejects it and exports the default. Accepting
  // a form the entrypoint refuses reintroduces the split between the two
  // servers that normalizing there was meant to close.
  if (!/^\d+$/.test(value)) {
    logger.warn(
      `Invalid ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS value "${value}", using default ${defaultValue}ms`,
    );
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS value "${value}", using default ${defaultValue}ms`,
    );
    return defaultValue;
  }

  return parsed;
};

// 70MB body limit: accommodates the 50MB user-facing file cap with
// headroom for base64 encoding overhead (~33%) on chat attachment uploads.
const DEFAULT_BODY_LIMIT = 70 * 1024 * 1024;

/**
 * Idle keep-alive window for every HTTP server we run (the Fastify API and, via
 * `KEEP_ALIVE_TIMEOUT`, the Next.js server).
 *
 * Node's own default is 5s and Fastify's is 72s — both below the keep-alive
 * timeout used by common load balancers, which is what makes the reuse race
 * described on {@link parseKeepAliveTimeoutMs} reachable. The Google Cloud
 * external Application Load Balancer is the strictest of the usual suspects: it
 * holds backend connections for a fixed 600s and does not let you lower that, so
 * the origin has to outlast it. 620s clears 600s with enough margin to absorb
 * scheduling jitter, and comfortably clears the shorter windows used by AWS ALB
 * (60s) and nginx (75s).
 */
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 620_000;

const DEFAULT_DATABASE_POOL_MAX = 50;
const MAX_DATABASE_POOL_MAX = 500;

// Upper bound applied to every agent turn's output-token budget. Defaults high
// enough to unblock large tool-call payloads while capping cost; the real
// per-model output ceiling still applies when it is lower.
const DEFAULT_CHAT_MAX_OUTPUT_TOKENS = 32_768;
const MAX_CHAT_MAX_OUTPUT_TOKENS = 1_000_000;

// Output-token budget for providers that charge a request's `max_tokens`
// reservation against a per-minute token bucket (see the provider set in
// agents/agent-output-budget.ts). Sized to leave prompt room inside the small
// buckets those providers' entry tiers hand out — at 32_768 a single one-word
// message is rejected before generating a token, and no amount of shortening
// the conversation helps. Operators on higher tiers should raise it: the cost
// of this cap is truncated long generations, the cost of not having it is that
// every request fails.
const DEFAULT_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS = 4_096;

// Per-connection statement timeout (ms). Defense-in-depth: kills runaway
// queries instead of letting them hang a connection indefinitely. 0 disables.
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MILLIS = 30000;

// Default OTEL OTLP endpoint for HTTP/Protobuf (4318). For gRPC, the typical port is 4317.
const DEFAULT_OTEL_ENDPOINT = "http://localhost:4318";
const DEFAULT_OTEL_CONTENT_MAX_LENGTH = 10_000; // 10KB
const DEFAULT_REFRESH_TOKEN_REUSE_GRACE_SECONDS = 60;
const DEFAULT_METRICS_PORT = 9050;
const DEFAULT_ACTIVE_USERS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_ACTIVE_USERS_REFRESH_INTERVAL_MS = 30 * 1000;
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;
const OTEL_TRACES_PATH = "/v1/traces";
const OTEL_LOGS_PATH = "/v1/logs";

// RUM export is opt-in: no endpoint means the feature is off entirely (the
// frontend never loads its RUM module, the ingest route accepts nothing).
const rumExporterOtlpEndpoint =
  process.env.ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT?.trim() || "";

/**
 * Get OTEL exporter endpoint for traces.
 * Reads from ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT and intelligently ensures
 * the URL ends with /v1/traces.
 *
 * @param envValue - The environment variable value (for testing)
 * @returns The full OTEL endpoint URL with /v1/traces suffix
 * @public — exported for testability
 */
export const getOtelExporterOtlpEndpoint = (
  envValue?: string | undefined,
): string => {
  const rawValue =
    envValue ?? process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT;
  const value = rawValue?.trim();

  if (!value) {
    return `${DEFAULT_OTEL_ENDPOINT}${OTEL_TRACES_PATH}`;
  }

  // Remove trailing slashes for consistent comparison
  const normalizedUrl = value.replace(/\/+$/, "");

  // If already ends with /v1/traces, return as-is
  if (normalizedUrl.endsWith(OTEL_TRACES_PATH)) {
    return normalizedUrl;
  }

  // Fix common typo: /v1/trace (missing 's') -> /v1/traces
  if (normalizedUrl.endsWith("/v1/trace")) {
    return `${normalizedUrl}s`;
  }

  // If ends with /v1, just append /traces
  if (normalizedUrl.endsWith("/v1")) {
    return `${normalizedUrl}/traces`;
  }

  // Otherwise, append the full /v1/traces path
  return `${normalizedUrl}${OTEL_TRACES_PATH}`;
};

/**
 * Get OTEL exporter endpoint for logs.
 * Reuses the same base ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT env var, but appends /v1/logs.
 *
 * @param envValue - The environment variable value (for testing)
 * @returns The full OTEL endpoint URL with /v1/logs suffix
 * @public — exported for testability
 */
export const getOtelExporterOtlpLogEndpoint = (
  envValue?: string | undefined,
): string => {
  const rawValue =
    envValue ?? process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT;
  const value = rawValue?.trim();

  if (!value) {
    return `${DEFAULT_OTEL_ENDPOINT}${OTEL_LOGS_PATH}`;
  }

  const normalizedUrl = value.replace(/\/+$/, "");

  if (normalizedUrl.endsWith(OTEL_LOGS_PATH)) {
    return normalizedUrl;
  }

  if (normalizedUrl.endsWith("/v1")) {
    return `${normalizedUrl}/logs`;
  }

  return `${normalizedUrl}${OTEL_LOGS_PATH}`;
};

/** @public — exported for testability */
export const parseContentMaxLength = (
  envValue?: string | undefined,
): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_OTEL_CONTENT_MAX_LENGTH;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid ARCHESTRA_OTEL_CONTENT_MAX_LENGTH value "${value}", using default ${DEFAULT_OTEL_CONTENT_MAX_LENGTH}`,
    );
    return DEFAULT_OTEL_CONTENT_MAX_LENGTH;
  }

  return parsed;
};

/**
 * Fraction of RUM sessions to record, 0–1. Invalid or out-of-range values
 * fall back to 1 (record everything) so a typo never silently disables RUM.
 *
 * @public — exercised by config.rum.test.ts
 */
export const parseRumSampleRate = (value?: string): number => {
  if (!value) return 1;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
};

/**
 * A positive-integer RUM setting (batch tuning, ingest budget); anything
 * else falls back to the given default.
 *
 * @public — exercised by config.rum.test.ts
 */
export const parseRumBatchSetting = (
  value: string | undefined,
  defaultValue: number,
): number => {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
};

/**
 * Grace window (seconds) during which a replayed — i.e. already-rotated —
 * refresh token is treated as a benign rotation race (a lost token-exchange
 * response the client retried) and a fresh pair is re-issued, rather than a
 * reuse attack. See services/oauth-refresh-replay.ts. `0` disables the grace,
 * so every replay is treated as reuse immediately.
 *
 * @public — exercised by config.test.ts
 */
export const parseRefreshTokenReuseGraceSeconds = (
  envValue?: string | undefined,
): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_REFRESH_TOKEN_REUSE_GRACE_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn(
      `Invalid ARCHESTRA_AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS value "${value}", using default ${DEFAULT_REFRESH_TOKEN_REUSE_GRACE_SECONDS}`,
    );
    return DEFAULT_REFRESH_TOKEN_REUSE_GRACE_SECONDS;
  }

  return parsed;
};

/** @public — exported for testability */
export const parseLogFormat = (
  envValue?: string | undefined,
): "json" | "pretty" => {
  const value = envValue?.toLowerCase().trim();
  if (value === "pretty" || value === "json") return value;
  if (value && value.length > 0) {
    logger.warn(
      `Invalid ARCHESTRA_LOGGING_FORMAT value "${envValue}", using default "json"`,
    );
  }
  return "json";
};

/** @public — exported for testability */
export const parseDatabasePoolMax = (envValue?: string | undefined): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_DATABASE_POOL_MAX;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_DATABASE_POOL_MAX) {
    logger.warn(
      `Invalid ARCHESTRA_DATABASE_POOL_MAX value "${value}", using default ${DEFAULT_DATABASE_POOL_MAX}`,
    );
    return DEFAULT_DATABASE_POOL_MAX;
  }

  return parsed;
};

/** @public — exported for testability */
export const parseChatMaxOutputTokens = (
  envValue?: string | undefined,
): number =>
  parseOutputTokenCeiling({
    envValue,
    envName: "ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS",
    fallback: DEFAULT_CHAT_MAX_OUTPUT_TOKENS,
  });

/** @public — exported for testability */
export const parseChatRateMeteredMaxOutputTokens = (
  envValue?: string | undefined,
): number =>
  parseOutputTokenCeiling({
    envValue,
    envName: "ARCHESTRA_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS",
    fallback: DEFAULT_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS,
  });

const parseOutputTokenCeiling = (params: {
  envValue: string | undefined;
  envName: string;
  fallback: number;
}): number => {
  const { envValue, envName, fallback } = params;
  const value = envValue?.trim();
  if (!value) {
    return fallback;
  }

  // Number() (not parseInt) so trailing garbage ("32768abc") and fractions
  // ("1.5") are rejected rather than silently truncated to a tiny cap.
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_CHAT_MAX_OUTPUT_TOKENS
  ) {
    logger.warn(
      `Invalid ${envName} value "${value}", using default ${fallback}`,
    );
    return fallback;
  }

  return parsed;
};

/** @public — exported for testability */
export const parseDatabaseStatementTimeoutMillis = (
  envValue?: string | undefined,
): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_DATABASE_STATEMENT_TIMEOUT_MILLIS;
  }

  const parsed = Number.parseInt(value, 10);
  // 0 disables the timeout; negative/NaN falls back to the default.
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn(
      `Invalid ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS value "${value}", using default ${DEFAULT_DATABASE_STATEMENT_TIMEOUT_MILLIS}`,
    );
    return DEFAULT_DATABASE_STATEMENT_TIMEOUT_MILLIS;
  }

  return parsed;
};

/** @public — exported for testability */
export interface AnthropicWifConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  workspaceId?: string;
  identityTokenFile?: string;
  /**
   * Inline identity token (a JWT). Held in the config singleton, so prefer
   * `identityTokenFile` in production — only the path is stored, not the secret,
   * and the file is re-read on every exchange to pick up rotation.
   */
  identityToken?: string;
}

/**
 * Parse Anthropic Workload Identity Federation (keyless auth) configuration.
 * Enabled only when the federation rule ID, organization ID, service account
 * ID, and an identity token source are all present; a partial configuration
 * logs a warning and disables WIF rather than failing at request time.
 *
 * @public — exported for testability
 */
export const parseAnthropicWifConfig = (env: {
  federationRuleId?: string | undefined;
  organizationId?: string | undefined;
  serviceAccountId?: string | undefined;
  workspaceId?: string | undefined;
  identityTokenFile?: string | undefined;
  identityToken?: string | undefined;
}): AnthropicWifConfig | null => {
  const federationRuleId = env.federationRuleId?.trim();
  const organizationId = env.organizationId?.trim();
  const serviceAccountId = env.serviceAccountId?.trim();
  const workspaceId = env.workspaceId?.trim();
  const identityTokenFile = env.identityTokenFile?.trim();
  const identityToken = env.identityToken?.trim();

  const anySet = Boolean(
    federationRuleId ||
      organizationId ||
      serviceAccountId ||
      workspaceId ||
      identityTokenFile ||
      identityToken,
  );
  if (!anySet) {
    return null;
  }

  if (
    !federationRuleId ||
    !organizationId ||
    !serviceAccountId ||
    !(identityTokenFile || identityToken)
  ) {
    logger.warn(
      "Anthropic Workload Identity Federation is partially configured and will be disabled. Set ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID, ARCHESTRA_ANTHROPIC_ORGANIZATION_ID, ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID, and one of ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE or ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN.",
    );
    return null;
  }

  return {
    federationRuleId,
    organizationId,
    serviceAccountId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(identityTokenFile ? { identityTokenFile } : {}),
    ...(identityToken ? { identityToken } : {}),
  };
};

/**
 * Parse an optional dedicated-port env var (e.g. ARCHESTRA_PUBLIC_ENDPOINTS_PORT).
 * Unset/empty means the feature is disabled (returns undefined); an invalid
 * value also disables it (with a warning) rather than falling back to a
 * default, since accidentally listening on a wrong port would silently
 * expose endpoints somewhere unintended.
 * @public — exported for testability
 */
export const parseOptionalPort = (params: {
  envVarName: string;
  envValue: string | undefined;
}): number | undefined => {
  const value = params.envValue?.trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < MIN_TCP_PORT || parsed > MAX_TCP_PORT) {
    logger.warn(
      `Invalid ${params.envVarName} value "${value}", the dedicated listener will not be started`,
    );
    return undefined;
  }

  return parsed;
};

/** @public — exported for testability */
export const parseMetricsPort = (envValue?: string | undefined): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_METRICS_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < MIN_TCP_PORT || parsed > MAX_TCP_PORT) {
    logger.warn(
      `Invalid ARCHESTRA_METRICS_PORT value "${value}", using default ${DEFAULT_METRICS_PORT}`,
    );
    return DEFAULT_METRICS_PORT;
  }

  return parsed;
};

/**
 * Parse the refresh interval for the `llm_active_users` gauge (milliseconds).
 * `0` disables collection entirely. The value is clamped to a floor because the
 * underlying query is a DISTINCT count over the (very large) interactions
 * table, and every replica runs it — a small interval turns into steady
 * background load for a number that barely moves.
 * @public — exported for testability
 */
export const parseActiveUsersRefreshIntervalMs = (
  envValue?: string | undefined,
): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_ACTIVE_USERS_REFRESH_INTERVAL_MS;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn(
      `Invalid ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS value "${value}", using default ${DEFAULT_ACTIVE_USERS_REFRESH_INTERVAL_MS}`,
    );
    return DEFAULT_ACTIVE_USERS_REFRESH_INTERVAL_MS;
  }

  if (parsed === 0) {
    return 0;
  }

  if (parsed < MIN_ACTIVE_USERS_REFRESH_INTERVAL_MS) {
    logger.warn(
      `ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS value "${value}" is below the ${MIN_ACTIVE_USERS_REFRESH_INTERVAL_MS}ms floor, using the floor`,
    );
    return MIN_ACTIVE_USERS_REFRESH_INTERVAL_MS;
  }

  return parsed;
};

/**
 * Parse virtual key default expiration from environment variable.
 * Must be a non-negative integer (seconds). 0 means "never expires".
 * Returns the default (30 days) for invalid or negative values.
 * Capped at 1 year (31,536,000 seconds) to prevent unreasonably long expirations.
 * @public — exported for testability
 */
export const parseVirtualKeyDefaultExpiration = (
  envValue: string | undefined,
): number => {
  const DEFAULT_EXPIRATION = 2592000; // 30 days in seconds
  const MAX_EXPIRATION = 31_536_000; // 1 year in seconds
  if (!envValue) return DEFAULT_EXPIRATION;

  const trimmed = envValue.trim();
  if (!trimmed) return DEFAULT_EXPIRATION;

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn(
      `Invalid ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS value "${trimmed}", using default ${DEFAULT_EXPIRATION}`,
    );
    return DEFAULT_EXPIRATION;
  }

  if (parsed === 0) {
    logger.info(
      "ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS set to 0: virtual keys will not expire by default",
    );
    return 0;
  }

  if (parsed > MAX_EXPIRATION) {
    logger.warn(
      `ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS value "${trimmed}" exceeds maximum (${MAX_EXPIRATION}s / 1 year), capping to ${MAX_EXPIRATION}`,
    );
    return MAX_EXPIRATION;
  }

  return parsed;
};

/**
 * Parse a positive integer from an environment variable string, with a default fallback.
 */
const parsePositiveInt = (
  envValue: string | undefined,
  defaultValue: number,
): number => {
  if (!envValue) return defaultValue;
  const parsed = Number.parseInt(envValue, 10);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : defaultValue;
};

/**
 * Like {@link parsePositiveInt} but accepts 0, for knobs where zero is a
 * meaningful setting rather than a missing one — a retention window of 0
 * means "keep forever", not "use the default".
 *
 * @public — exported for testability
 */
export const parseNonNegativeInt = (
  envValue: string | undefined,
  defaultValue: number,
): number => {
  if (!envValue) return defaultValue;
  const parsed = Number.parseInt(envValue, 10);
  return !Number.isNaN(parsed) && parsed >= 0 ? parsed : defaultValue;
};

/**
 * Parse an integer knob that only makes sense inside a fixed range, clamping
 * out-of-range values to the nearest bound rather than falling back to the
 * default. A chunk size of 8 is a typo, not a request for 512 — clamping keeps
 * the corpus indexable and the intent ("smaller") visible, where a silent
 * fallback to the default would look like the setting was ignored.
 *
 * @public — exported for testability
 */
export const parseClampedInt = (
  envValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number => {
  if (!envValue) return defaultValue;
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
};

/**
 * Like {@link parseClampedInt} for a setting whose "off" value sits outside its
 * own valid range — a child-chunk size of 0 means "do not subdivide", while any
 * size that IS set has a floor below which a chunk cannot carry a coherent
 * passage.
 *
 * Clamping alone cannot express that: a plain clamp into [min, max] would turn
 * an explicit 0 into the floor and silently switch the feature ON. So 0 is
 * honoured exactly, and every other value is clamped into [min, max] — which
 * also means a too-small non-zero value is corrected upward rather than
 * disabling the feature by accident.
 *
 * @public — exported for the config unit tests; used within this module.
 */
export const parseClampedIntOrZero = (
  envValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number => {
  if (!envValue) return defaultValue;
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  if (parsed <= 0) return 0;
  return Math.min(Math.max(parsed, min), max);
};

/**
 * Like {@link parseClampedInt} for values that are genuinely fractional — the
 * BM25 tuning constants, where `b` lives entirely in [0, 1] and rounding to an
 * integer would collapse it to "off" or "full".
 *
 * Non-finite input (`Infinity`, `NaN`) falls back to the default rather than
 * clamping, because clamping `NaN` silently yields `NaN` and would poison every
 * score computed from it.
 *
 * @public — exported for testability
 */
export const parseClampedFloat = (
  envValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number => {
  if (!envValue) return defaultValue;
  const parsed = Number.parseFloat(envValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Parses `ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS`.
 *
 * The env var is no longer the on/off switch — idle hibernation is an
 * enterprise feature an organization opts into. What is left here is the
 * operator's two decisions:
 *
 *  - an explicit "0" is a HARD kill switch: hibernation is off platform-wide
 *    no matter what the organization has enabled, for deployments that must
 *    never see a scaled-to-zero MCP pod;
 *  - anything else configures the idle WINDOW. Unset or unparseable falls
 *    back to 30 minutes; a parsed value is floored at 120 seconds, because a
 *    lower threshold could hibernate a server in the gap between normal
 *    consecutive tool calls of one conversation and thrash pods. The optional
 *    lower minimum is used only by the E2E-gated config builder below.
 *
 * @public — exported for testability
 */
export const parseMcpIdleHibernationSeconds = (
  envValue: string | undefined,
  minimumSeconds = 120,
): { windowSeconds: number; hardDisabled: boolean } => {
  // Parse BEFORE testing for zero: "00", "0.0" and "+0" are all an operator
  // writing zero, and a numerically-zero spelling that silently ARMED
  // hibernation with the default window — instead of killing it — would be
  // the worst possible reading of their intent.
  if (envValue?.trim() && Number.parseInt(envValue, 10) === 0) {
    return {
      windowSeconds: DEFAULT_MCP_IDLE_HIBERNATION_SECONDS,
      hardDisabled: true,
    };
  }
  const parsed = parsePositiveInt(envValue, 0);
  return {
    windowSeconds:
      parsed === 0
        ? DEFAULT_MCP_IDLE_HIBERNATION_SECONDS
        : Math.max(minimumSeconds, parsed),
    hardDisabled: false,
  };
};

/** 30 minutes — the idle window when the operator configures none. */
const DEFAULT_MCP_IDLE_HIBERNATION_SECONDS = 1800;

function getMcpIdleHibernationConfig() {
  const e2eTestEndpointsEnabled =
    process.env.ENABLE_E2E_TEST_ENDPOINTS === "true";
  const parsed = parseMcpIdleHibernationSeconds(
    process.env.ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS,
    e2eTestEndpointsEnabled ? 8 : 120,
  );
  const acceleratedE2eTiming =
    e2eTestEndpointsEnabled && parsed.windowSeconds < 120;

  return {
    ...parsed,
    betaEnabled: betaFeatureEnabled(
      process.env.ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_ENABLED,
    ),
    lastUsedRefreshIntervalMs: acceleratedE2eTiming ? 1_000 : 30_000,
    demandHeartbeatIntervalMs: acceleratedE2eTiming ? 500 : 15_000,
  };
}
// SPDX-SnippetEnd

/** @public — exported for testability */
export const parseSampleRate = (
  envValue: string | undefined,
  defaultRate: number,
): number => {
  if (!envValue) return defaultRate;
  const parsed = Number.parseFloat(envValue);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) return defaultRate;
  return parsed;
};

/** @public — exported for testability */
export function parseActiveChatRunPollIntervalMs(params: {
  value: string | undefined;
  defaultValue: number;
  envName: string;
}): number {
  const trimmed = params.value?.trim();
  if (!trimmed) {
    return params.defaultValue;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid ${params.envName} value "${trimmed}", using default ${params.defaultValue}`,
    );
    return params.defaultValue;
  }

  return parsed;
}

/**
 * Hostnames that `getPublicRequestOrigin` is willing to return when forwarded
 * headers are trusted. Always contains the frontend origin (`frontendBaseUrl`,
 * which defaults to http://localhost:3000 when ARCHESTRA_FRONTEND_URL is
 * unset) plus every URL in `ARCHESTRA_API_BASE_URL` — the same
 * comma-separated list the frontend's `getExternalProxyUrls` reads (after
 * supervisord re-exports it as `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL` for the
 * Next.js process). The backend inherits the canonical `ARCHESTRA_API_BASE_URL`
 * directly, so we read that here.
 *
 * Returned as a set of normalized `host` strings (lowercased; default ports
 * stripped — i.e. matching what `new URL(...).host` produces).
 * @public — exported for testability
 */
/**
 * Raw URL sources a /connection setup baseUrl may come from: the frontend
 * origin, every URL in `ARCHESTRA_API_BASE_URL`, and the in-cluster
 * `ARCHESTRA_INTERNAL_API_BASE_URL` (the connection page falls back to the
 * internal URL when every external URL is hidden). Returned unparsed; callers
 * normalize and compare full URLs, not just hosts.
 * @public — exported for testability
 */
export const getConnectionBaseUrlSources = (): string[] => {
  const sources = [frontendBaseUrl];
  const internalUrl = process.env.ARCHESTRA_INTERNAL_API_BASE_URL?.trim();
  if (internalUrl) sources.push(internalUrl);
  const externalUrls = process.env.ARCHESTRA_API_BASE_URL?.trim();
  if (externalUrls) {
    for (const url of externalUrls.split(",")) {
      const trimmed = url.trim();
      if (trimmed) sources.push(trimmed);
    }
  }
  return sources;
};

/**
 * Absolute origin the backend serves its `/_sandbox/*` assets on. Used to build
 * absolute SDK/stylesheet URLs in the owned-app envelope so they resolve from a
 * foreign MCP host's opaque-origin iframe (a relative `/_sandbox/...` has no
 * base there). This URL is handed to the browser as a script source and CSP
 * source, so it must be the public origin the app is viewed on.
 *
 * Resolution order:
 *  1. A public `https://` entry in `ARCHESTRA_API_BASE_URL` — that var is an
 *     internal-first list (e.g. `http://archestra.default.svc:9000,https://api…`),
 *     so a public entry is preferred over a cluster-internal one.
 *  2. Any `ARCHESTRA_API_BASE_URL` entry.
 *  3. `frontendBaseUrl` (`ARCHESTRA_FRONTEND_URL`) — the origin the browser
 *     actually loads the app on, and whose Next.js rewrite proxies `/_sandbox/*`
 *     to the backend. Falling back here (rather than to a loopback API origin)
 *     keeps the assets same-origin with the page, so the browser's Private
 *     Network Access policy never blocks them when the app is served over a
 *     tunnel or any public origin. The old loopback fallback only ever loaded
 *     when the browser itself was on localhost; over a public origin it was
 *     refused, taking the injected recorder/replay SDK down with it.
 *
 * This only widens the CSP's fixed asset-URL host from loopback to the trusted,
 * operator-configured frontend origin — it does not touch the network lockdown
 * (`connect-src 'none'`, CDN allowlist), and is never request-derived (those are
 * spoofable, see request-origin.ts). Each candidate is parsed to its
 * `URL.origin` (dropping any path). Foreign-host renders inline their assets
 * (`selfContained`) and set `ARCHESTRA_API_BASE_URL` explicitly, so this
 * fallback is confined to Archestra's own session render.
 * @public — consumed by the owned-app SDK injection
 */
export const getAppAssetBaseOrigin = (): string => {
  const entries =
    process.env.ARCHESTRA_API_BASE_URL?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  const candidates = [
    ...entries.filter((entry) => entry.startsWith("https://")),
    ...entries,
    frontendBaseUrl,
  ];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).origin;
    } catch {
      // skip a malformed entry and try the next candidate
    }
  }
  // `frontendBaseUrl` itself defaults to http://localhost:3000, so this is only
  // reached if it was overridden with a malformed value.
  return new URL("http://localhost:3000").origin;
};

export const getMCPGatewayOauthAllowedPublicHosts = (): Set<string> => {
  const hosts = new Set<string>();

  const addHostFromUrl = (raw: string) => {
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch {
      // ignore malformed values
    }
  };

  addHostFromUrl(frontendBaseUrl);

  // In local development the Next.js dev server always serves on
  // http://localhost:3000, even when ARCHESTRA_FRONTEND_URL points elsewhere
  // (e.g. an ngrok tunnel configured for webhooks). Allow-list it so an MCP
  // client connecting to the local origin can still complete the gateway OAuth
  // handshake without extra config. Never enabled in production, where the
  // allowlist must stay restricted to the configured public hosts.
  if (isDevelopment) {
    addHostFromUrl("http://localhost:3000");
    addHostFromUrl("http://127.0.0.1:3000");
  }

  const externalUrls = process.env.ARCHESTRA_API_BASE_URL?.trim();
  if (externalUrls) {
    for (const url of externalUrls.split(",")) {
      const trimmed = url.trim();
      if (trimmed) addHostFromUrl(trimmed);
    }
  }

  return hosts;
};

/**
 * Parse ARCHESTRA_TRUST_PROXY into the value Fastify's trustProxy option accepts.
 *
 * Fastify supports:
 *   - true  – trust all proxies
 *   - false – trust no proxies (default)
 *   - a comma-separated string of IPs/CIDRs – trust specific proxies
 *
 * This maps the env var as follows:
 *   undefined / ""  → false
 *   "true"          → true
 *   "false"         → false
 *   anything else   → trimmed string passed directly to Fastify (IP/CIDR list)
 * @public — exported for testability
 */
export const parseTrustProxy = (
  envValue: string | undefined,
): boolean | string => {
  const trimmed = envValue?.trim();
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
};

/** @public — exported for testability */
export function parseFileStorageProvider(
  value: string | undefined,
): FileStorageProviderType {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "filesystem") return "filesystem";
  if (normalized === "s3") return "s3";
  return "db";
}

/** @public — exported for testability */
export function parseFileStorageFilesystemRoot(params: {
  provider: FileStorageProviderType;
  value: string | undefined;
}): string {
  const root = params.value?.trim() ?? "";
  if (params.provider !== "filesystem") return root;
  if (!root) {
    throw new Error(
      "ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT is required when ARCHESTRA_FILE_STORAGE_PROVIDER=filesystem",
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      "ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT must be an absolute path",
    );
  }
  return root;
}

/** @public — exported for testability */
export function parseFileStorageS3Config(params: {
  provider: FileStorageProviderType;
  env: {
    bucket: string | undefined;
    region: string | undefined;
    endpoint: string | undefined;
    forcePathStyle: string | undefined;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    keyPrefix: string | undefined;
  };
}): FileStorageS3Config {
  const { env } = params;
  const bucket = env.bucket?.trim() ?? "";
  if (params.provider === "s3" && !bucket) {
    throw new Error(
      "ARCHESTRA_FILE_STORAGE_S3_BUCKET is required when ARCHESTRA_FILE_STORAGE_PROVIDER=s3",
    );
  }
  const accessKeyId = env.accessKeyId?.trim() || undefined;
  const secretAccessKey = env.secretAccessKey?.trim() || undefined;
  // Static credentials are all-or-nothing: a half-set pair would silently fall
  // back to the AWS default credential chain (a different identity), so reject it
  // loudly rather than resolve an unintended identity against the bucket.
  if (
    params.provider === "s3" &&
    Boolean(accessKeyId) !== Boolean(secretAccessKey)
  ) {
    throw new Error(
      "ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID and ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY must be set together, or both omitted to use the AWS default credential chain",
    );
  }
  return {
    bucket,
    region: env.region?.trim() || "us-east-1",
    endpoint: env.endpoint?.trim() || undefined,
    forcePathStyle: env.forcePathStyle?.trim().toLowerCase() === "true",
    accessKeyId,
    secretAccessKey,
    keyPrefix: env.keyPrefix?.trim().replace(/^\/+|\/+$/g, "") ?? "",
  };
}

/**
 * Parse the per-run sync work budget (seconds). A run stops at ~90% of this,
 * checkpoints, and a continuation resumes from there. Invalid or non-positive
 * values disable the budget (a run then goes to completion in one pass).
 * @public — exported for testability
 */
export function parseConnectorSyncMaxDuration(
  value: string | undefined,
): number | undefined {
  const DEFAULT = 3300; // 55 minutes
  const seconds = Number.parseInt(value || String(DEFAULT), 10);
  if (Number.isNaN(seconds) || seconds <= 0) return undefined;
  return seconds;
}

/** @public — exported for testability */
export function parseProcessType(value: string | undefined): ProcessType {
  const normalized = value?.toLowerCase();
  if (
    normalized === "web" ||
    normalized === "worker" ||
    normalized === "renderer"
  ) {
    return normalized;
  }
  return "all";
}

/**
 * Parse a `*_RETENTION_DAYS` env var into a non-negative integer.
 * Default is 0 (retention disabled — rows are never auto-deleted).
 * Operators opt in by setting a positive number of days.
 * @public — exported for testability
 */
export const parseRetentionDays = (
  envVarName: string,
  envValue: string | undefined,
): number => {
  const DEFAULT_RETENTION_DAYS = 0;
  const value = envValue?.trim();
  if (!value) return DEFAULT_RETENTION_DAYS;
  // Strictly digits: retention drives deletion, so a typo like "30days" or
  // "1.5" must disable the sweep, never silently truncate to an unintended
  // window.
  if (!/^\d+$/.test(value)) {
    logger.warn(
      `Invalid ${envVarName} value "${value}", using default ${DEFAULT_RETENTION_DAYS} (disabled)`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return Number.parseInt(value, 10);
};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Whether OTel spans may carry message/tool content (gen_ai.content.*).
 *
 * Content encryption at rest flips the DEFAULT to false: exporting the same
 * content in plaintext to a telemetry backend would bypass the at-rest
 * guarantee through a side door. An EXPLICIT `true` still wins — the operator
 * may run an equally protected telemetry pipeline — and the encryption boot
 * guard logs a warning for that combination so the choice is always visible.
 * @public — exported for testability
 */
export const parseOtelCaptureContent = (params: {
  envValue: string | undefined;
  contentEncryptionConfigured: boolean;
}): boolean => {
  const value = params.envValue?.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return !params.contentEncryptionConfigured;
};
// SPDX-SnippetEnd

/**
 * Parse a Kubernetes resource quantity (memory/CPU/ephemeral-storage) from an
 * environment variable, falling back to the default when unset or invalid.
 *
 * @public — exported for testability
 */
export function parseK8sResourceQuantity(params: {
  envName: string;
  value: string | undefined;
  validator: (value: string) => boolean;
  defaultValue: string;
}): string {
  const trimmed = params.value?.trim();
  if (!trimmed) {
    return params.defaultValue;
  }
  if (!params.validator(trimmed)) {
    logger.warn(
      `Invalid ${params.envName} value "${trimmed}", using default "${params.defaultValue}"`,
    );
    return params.defaultValue;
  }
  return trimmed;
}

/** @public — consumed by config.test.ts */
export function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @public — exported for testability */
export const getAnalyticsConfig = () => {
  const analyticsEnv = process.env.ARCHESTRA_ANALYTICS?.trim();
  // Evaluated at call time (not the module-level `isProduction`) so tests can
  // exercise both environments.
  const isProductionEnv = ["production", "prod"].includes(
    process.env.NODE_ENV?.toLowerCase() ?? "",
  );
  return {
    // Analytics (PostHog product analytics, instance heartbeats, and backend
    // error tracking) defaults to on only in production builds. Local dev and
    // test runs (bare `pnpm dev`, vitest — where NODE_ENV isn't "production")
    // stay silent unless ARCHESTRA_ANALYTICS is explicitly set, which always
    // wins in both directions ("disabled" → off, any other value → on).
    enabled: analyticsEnv ? analyticsEnv !== "disabled" : isProductionEnv,
    posthog: {
      key:
        process.env.ARCHESTRA_ANALYTICS_POSTHOG_KEY?.trim() ||
        DEFAULT_POSTHOG_KEY,
      host:
        process.env.ARCHESTRA_ANALYTICS_POSTHOG_HOST?.trim() ||
        DEFAULT_POSTHOG_HOST,
    },
  };
};

const mcpServerBaseImage =
  process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE ||
  `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:${appVersion}`;

/**
 * Default resource requests/limits applied to generated MCP server
 * containers. Ephemeral-storage governance is required so the scheduler
 * accounts for disk usage — without it nodes get over-packed until kubelet
 * DiskPressure eviction cascades kick in.
 */
const mcpServerResources = {
  requests: {
    cpu: parseK8sResourceQuantity({
      envName: "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_CPU_REQUEST",
      value: process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_CPU_REQUEST,
      validator: isValidK8sCpuQuantity,
      defaultValue: MCP_ORCHESTRATOR_DEFAULTS.resourceRequestCpu,
    }),
    memory: parseK8sResourceQuantity({
      envName: "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_REQUEST",
      value: process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_REQUEST,
      validator: isValidK8sMemoryQuantity,
      defaultValue: MCP_ORCHESTRATOR_DEFAULTS.resourceRequestMemory,
    }),
    ephemeralStorage: parseK8sResourceQuantity({
      envName: "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_REQUEST",
      value:
        process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_REQUEST,
      validator: isValidK8sMemoryQuantity,
      defaultValue: MCP_ORCHESTRATOR_DEFAULTS.resourceRequestEphemeralStorage,
    }),
  },
  limits: {
    memory: parseK8sResourceQuantity({
      envName: "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_LIMIT",
      value: process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_LIMIT,
      validator: isValidK8sMemoryQuantity,
      defaultValue: MCP_ORCHESTRATOR_DEFAULTS.resourceLimitMemory,
    }),
    ephemeralStorage: parseK8sResourceQuantity({
      envName: "ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_LIMIT",
      value:
        process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_LIMIT,
      validator: isValidK8sMemoryQuantity,
      defaultValue: MCP_ORCHESTRATOR_DEFAULTS.resourceLimitEphemeralStorage,
    }),
  },
};

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * The pre-pull DaemonSet's own footprint. It runs `true` once per image and
 * then sleeps, so the requests are deliberately minimal — they are paid on
 * EVERY node in the cluster, and anything larger would distort scheduling for
 * the real workloads pre-pulling exists to serve.
 */
const MCP_IMAGE_PREPULL_DEFAULTS = {
  // Copied into arbitrary MCP images, so this must be static rather than
  // inheriting the chart's generic init-container BusyBox.
  bootstrapImage: "docker.io/library/busybox:1.36-musl",
  resourceRequestCpu: "10m",
  resourceRequestMemory: "16Mi",
  resourceLimitMemory: "64Mi",
} as const;

/**
 * The OPERATOR half of MCP image pre-pulling: the DaemonSet that keeps every
 * node's image cache warm so a hibernated MCP server can wake without reaching
 * the container registry.
 *
 * `enabled` is a KILL SWITCH, not a feature gate — pre-pulling follows idle
 * hibernation (beta flag + enterprise licence + organization toggle), and this
 * only lets an operator turn the extra per-node pod off while keeping
 * hibernation on. Hence default-on and an explicit `"false"` to disable, the
 * mirror of the hibernation flag's default-off shape.
 *
 * `priorityClassName` is unset by default (the namespace default applies).
 * Point it at a low or negative-priority class so warming a cache can never
 * preempt a real workload.
 *
 * @public — exported for testability
 */
export const getMcpImagePrepullConfig = () => ({
  enabled:
    process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_ENABLED?.trim() !==
    "false",
  /**
   * Image for the DaemonSet's OWN containers — the noop bootstrap and the
   * keepalive. Deliberately independent of the configurable MCP server base
   * image: that one is an operator's choice (a pinned older release, a custom
   * derivative), and assuming anything about its contents wedges every
   * pre-pull pod in init. Override alongside
   * `archestra.initContainers.busyboxImage` on clusters that mirror images.
   */
  bootstrapImage:
    process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE?.trim() ||
    MCP_IMAGE_PREPULL_DEFAULTS.bootstrapImage,
  bootstrapImagePullSecrets: Array.from(
    new Set(
      parseCommaSeparatedList(
        process.env
          .ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE_PULL_SECRETS ??
          "",
      ),
    ),
  ),
  priorityClassName:
    process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_PRIORITY_CLASS_NAME?.trim() ||
    undefined,
  resources: {
    requests: {
      cpu: parseK8sResourceQuantity({
        envName: "ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_CPU_REQUEST",
        value: process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_CPU_REQUEST,
        validator: isValidK8sCpuQuantity,
        defaultValue: MCP_IMAGE_PREPULL_DEFAULTS.resourceRequestCpu,
      }),
      memory: parseK8sResourceQuantity({
        envName: "ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_REQUEST",
        value:
          process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_REQUEST,
        validator: isValidK8sMemoryQuantity,
        defaultValue: MCP_IMAGE_PREPULL_DEFAULTS.resourceRequestMemory,
      }),
    },
    limits: {
      memory: parseK8sResourceQuantity({
        envName: "ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_LIMIT",
        value:
          process.env.ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_LIMIT,
        validator: isValidK8sMemoryQuantity,
        defaultValue: MCP_IMAGE_PREPULL_DEFAULTS.resourceLimitMemory,
      }),
    },
  },
});
// SPDX-SnippetEnd

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * The Helm release this platform was installed as, injected by the chart
 * (`ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME`) rather than inferred from the
 * cluster. It names cluster objects the platform creates for itself but Helm
 * does not template — today the MCP image pre-pull DaemonSet — so that two
 * releases sharing a namespace never fight over one object.
 *
 * A name that is not a valid Helm release name resolves to `undefined` rather
 * than to something approximate: the consumers of this value name a cluster
 * object with it, and a name guessed from a bad value creates a SECOND object
 * that nothing afterwards will ever look for, delete, or upgrade. Not knowing
 * is a state they can handle; being wrong is not.
 *
 * @public — exported for testability
 */
export const parseHelmReleaseName = (
  envValue: string | undefined,
): string | undefined => {
  const releaseName = envValue?.trim();
  if (!releaseName) return undefined;
  // Helm's own rule: a DNS-1123 label, at most 53 characters so the release
  // name still fits the names generated from it.
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(releaseName)) {
    logger.warn(
      `Ignoring ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME "${releaseName}": not a valid Helm release name (lowercase alphanumerics and "-")`,
    );
    return undefined;
  }
  if (releaseName.length > 53) {
    logger.warn(
      `Ignoring ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME "${releaseName}": longer than the 53 characters Helm allows`,
    );
    return undefined;
  }
  return releaseName;
};
// SPDX-SnippetEnd

/**
 * resolves the Dagger runner host. A misconfigured host returns `undefined`
 * (and logs) rather than throwing — config is built at module import, so a
 * throw here would crash the whole backend over one optional feature.
 *
 * @public — exported for testability
 */
export const parseCodeRuntimeDaggerRunnerHost = (
  envValue: string | undefined,
): string | undefined => {
  const runnerHost = envValue?.trim();

  // No host configured is the normal "this deployment runs no code sandbox"
  // case, not a misconfiguration — stay silent and leave the sandbox off.
  if (!runnerHost) {
    return undefined;
  }

  // A host that's set but malformed is a genuine misconfiguration (unlike an
  // absent host, which just means "no sandbox here") — surface it loudly.
  if (!isSupportedDaggerRunnerHost(runnerHost)) {
    logger.error(
      "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST must use tcp:// or kube-pod:// — code runtime disabled",
    );
    return undefined;
  }

  return runnerHost;
};

const isSupportedDaggerRunnerHost = (runnerHost: string): boolean =>
  runnerHost.startsWith("tcp://") || runnerHost.startsWith("kube-pod://");

/**
 * Extra IPv4 CIDRs an unrestricted engine may not reach. A malformed entry would
 * be rejected by the Kubernetes API when the egress NetworkPolicy is applied —
 * and because the engine StatefulSet is created before its policy, that would
 * leave a privileged engine running with no egress policy at all. Drop the bad
 * entries loudly instead: the engine still gets its built-in RFC1918,
 * link-local and metadata denials, and the operator sees what was ignored.
 *
 * @public — exported for testability
 */
export const parseEngineDeniedCidrs = (
  envValue: string | undefined,
): string[] => {
  const entries = parseCommaSeparatedList(envValue ?? "");
  const valid = entries.filter((entry) => IPV4_CIDR.test(entry));
  const invalid = entries.filter((entry) => !IPV4_CIDR.test(entry));
  if (invalid.length > 0) {
    logger.error(
      `ARCHESTRA_DAGGER_RUNTIME_ENGINE_ADDITIONAL_DENIED_CIDRS ignoring invalid IPv4 CIDRs: ${invalid.join(", ")}`,
    );
  }
  return valid;
};

/**
 * Bytes in a Kubernetes memory quantity (`4Gi`, `512Mi`, `1G`, `1048576`), or
 * undefined when it is not one.
 *
 * @public — exported for testability
 */
export const k8sMemoryQuantityToBytes = (
  quantity: string,
): number | undefined => {
  const match = quantity
    .trim()
    .match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/);
  if (!match) return undefined;
  const multipliers: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  // Floored because the only consumers are a cgroup limit and a byte
  // comparison, neither of which takes a fraction.
  return Math.floor(Number(match[1]) * (match[2] ? multipliers[match[2]] : 1));
};

const DEFAULT_ENGINE_SANDBOX_MEMORY_MAX_BYTES = 5 * 1024 ** 3;

/**
 * The sandbox memory ceiling, checked against the engine's memory request.
 *
 * The sandboxes are charged to a cgroup the scheduler cannot see, so the
 * request is the only thing reserving node capacity for them. A ceiling at or
 * above the request means the engine can hold more than it reserved and the
 * shortfall lands on whatever else the node is running. Lowering the request
 * alone is enough to get there, so say so rather than let it pass silently.
 *
 * @public — exported for testability
 */
export const parseSandboxMemoryMaxBytes = (
  envValue: string | undefined,
  memoryRequest: string,
): number => {
  let bytes = DEFAULT_ENGINE_SANDBOX_MEMORY_MAX_BYTES;
  const configured = envValue?.trim();
  if (configured) {
    const parsed = k8sMemoryQuantityToBytes(configured);
    // Falling back beats honouring a half-understood value: a ceiling read as a
    // handful of bytes would kill every sandbox the moment it allocated.
    if (parsed === undefined || parsed <= 0) {
      logger.error(
        `ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX is not a Kubernetes quantity (${configured}); using the default`,
      );
    } else {
      bytes = parsed;
    }
  }
  const requestBytes = k8sMemoryQuantityToBytes(memoryRequest);
  if (requestBytes !== undefined && bytes >= requestBytes) {
    logger.error(
      `ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX (${configured ?? "default"}) is not below ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST (${memoryRequest}): the engine can hold more memory than it reserves on the node`,
    );
  }
  return bytes;
};

/**
 * Parse a `key=value,key2=value2` label selector into matchLabels. A malformed
 * entry falls back to the default rather than silently producing a selector
 * that matches nothing — an egress policy selecting no destination would leave
 * every runner unable to reach the platform.
 *
 * @public — exported for testability
 */
export function parseLabelSelector(
  value: string | undefined,
  defaultValue: Record<string, string>,
): Record<string, string> {
  const raw = value?.trim();
  if (!raw) return defaultValue;
  const parsed: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    const label = key?.trim();
    const labelValue = rest.join("=").trim();
    if (!label || !labelValue) {
      logger.error(
        `ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_POD_SELECTOR is not a key=value list (${raw}); using the default`,
      );
      return defaultValue;
    }
    parsed[label] = labelValue;
  }
  return parsed;
}

const IPV4_CIDR =
  /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(3[0-2]|[12]?\d)$/;

/**
 * Whether the code execution sandbox is enabled.
 *
 * - `ARCHESTRA_CODE_RUNTIME_ENABLED=false` is the documented kill switch and
 *   wins over everything, including an operator-supplied runner host.
 * - Otherwise an explicit Dagger runner host turns it on and no engine is
 *   provisioned in code. Whether that needs Kubernetes depends on the scheme: a
 *   `kube-pod://` host is reached by exec'ing into a pod (the quickstart image
 *   does this against its embedded cluster), while a `tcp://` host needs no
 *   Kubernetes at all and is the only way to run the sandbox without it.
 * - Otherwise `ARCHESTRA_CODE_RUNTIME_ENABLED=true` plus a configured
 *   orchestrator turns it on, and the backend provisions a per-organization
 *   engine in code. Kubernetes is required because that mode has to create
 *   StatefulSets and reach them over `kube-pod://`; without it no engine can
 *   exist, so the runtime would report ready and then fail on the first command.
 *   Requiring the explicit flag also keeps an orchestrator configured purely for
 *   MCP server pods from silently provisioning privileged Dagger engines.
 *
 * The K8s-configured test mirrors `isK8sConfigured()` (`k8s/shared.ts`) but is
 * computed from raw env here: `k8s/shared.ts` imports this config module at load,
 * so importing it back would be a circular dependency.
 *
 * @public — exported for testability
 */
export const isCodeRuntimeEnabled = ({
  runnerHost,
  runnerHostEnv,
  codeRuntimeEnabledEnv,
  kubeconfig,
  loadKubeconfigFromCurrentCluster,
}: {
  runnerHost: string | undefined;
  runnerHostEnv: string | undefined;
  codeRuntimeEnabledEnv: string | undefined;
  kubeconfig: string | undefined;
  loadKubeconfigFromCurrentCluster: string | undefined;
}): boolean => {
  if (codeRuntimeEnabledEnv === "false") return false;
  if (runnerHost !== undefined) return true;
  // A runner host that was set but rejected by the parser reaches here as
  // `undefined`, indistinguishable from "unset" without the raw value. Falling
  // through would provision code-managed engines an operator who named a runner
  // never asked for, contradicting the parser's own "code runtime disabled" log.
  const runnerHostRejected = (runnerHostEnv?.trim().length ?? 0) > 0;
  if (runnerHostRejected) return false;
  const k8sConfigured =
    loadKubeconfigFromCurrentCluster === "true" ||
    (kubeconfig?.trim().length ?? 0) > 0;
  return codeRuntimeEnabledEnv === "true" && k8sConfigured;
};

/**
 * Resolve an off-by-default `ARCHESTRA_*_ENABLED` feature gate with the
 * `ARCHESTRA_BETA` master switch as the fallback. An explicit per-flag value
 * always wins (`"true"`/`"false"`); a blank or unset value falls back to
 * `ARCHESTRA_BETA`, so `ARCHESTRA_BETA=true` turns on every gate wired through
 * this helper while a per-feature flag keeps its own opt-out. Backs *product*
 * features only, never credential/auth-mode toggles (e.g. Bedrock IAM,
 * Azure/Vertex Entra).
 *
 * @public — the shared gate for a product feature that ships off by default; also exported for testability
 */
export function betaFeatureEnabled(envValue: string | undefined): boolean {
  if (envValue === undefined || envValue === "") {
    return process.env.ARCHESTRA_BETA === "true";
  }
  return envValue === "true";
}

/**
 * The hackathon recorder (record/replay/edit app demo sessions).
 *
 * On for every community deployment, and NEVER on for a deployment running an
 * activated enterprise license: a licensed customer must not be shown a
 * temporary community promotion. There is no deployment opt-out flag, because
 * the two gates above this one already cover "when" and "whether" — the
 * hackathon date window keeps it hidden outside the event, and the
 * per-organization toggle lets an admin switch it off — so a community
 * deployment needs no third switch of its own.
 *
 * `enterpriseOverride` is the single escape hatch: it turns the recorder on for
 * Archestra's own licensed staging. It affects this deployment gate only — the
 * date window and the organization toggle still apply. It is documented
 * nowhere and named as an enterprise override on purpose, so no customer
 * stumbles onto the enterprise path.
 *
 * This is the DEPLOYMENT gate only. Two more gates sit above it at request
 * time — the organization's own toggle, and the hackathon date window —
 * because neither can be decided once at boot. See `assertAppsHackathonAvailable`.
 *
 * @public — exported for testability
 */
export function parseHackathonRecorderEnabled(params: {
  enterpriseLicenseActivated: boolean;
  enterpriseOverride: string | undefined;
}): boolean {
  if (params.enterpriseLicenseActivated) {
    return params.enterpriseOverride === "true";
  }
  return true;
}

/**
 * The longest final cut a recording may be submitted or exported at, in ms.
 *
 * One bound behind every length surface — the submit button, the submission
 * flow's own backstop, the video export, the editor's trim-to-limit control and
 * the tour's "keep it under N" note — so a deployment that raises it raises all
 * of them together and no surface can quote a number the checks disagree with.
 *
 * Rejects a value that is not a positive integer number of milliseconds rather
 * than silently falling back: a typo here would otherwise read as the platform
 * ignoring the operator's limit. A hard floor keeps a fat-fingered tiny value
 * from making every recording unsubmittable.
 *
 * Undocumented on purpose, like the rest of the recorder — not in .env.example
 * or the deployment docs.
 *
 * @public — exported for testability
 */
export function parseHackathonRecorderMaxFinalCutMs(
  value: string | undefined,
): number {
  const raw = value?.trim();
  if (!raw) return APP_RECORDING_DEFAULT_MAX_FINAL_CUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_HACKATHON_FINAL_CUT_MS) {
    throw new Error(
      `ARCHESTRA_HACKATHON_RECORDER_MAX_FINAL_CUT_MS must be a whole number of milliseconds >= ${MIN_HACKATHON_FINAL_CUT_MS}, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Floor for the configurable final-cut limit. Below a few seconds nothing is a
 * demo and every recording would be born over the line.
 */
const MIN_HACKATHON_FINAL_CUT_MS = 5_000;

/**
 * Defaults for the "Archestra App Gallery" sharing surface — the PUBLIC
 * device-flow OAuth client id and the public gallery repository. Baked in so
 * every non-enterprise deployment (local dev and OSS included) offers sharing
 * to the official gallery out of the box; an env override repoints a fork
 * elsewhere. Enterprise has the whole hackathon recorder disabled, so these
 * never surface there.
 *
 * @public — exported for testability
 */
export const DEFAULT_HACKATHON_GALLERY_GITHUB_CLIENT_ID =
  "Ov23liqkaqAROe7B7ZZ4";
/** @public — exported for testability (see the client-id default above) */
export const DEFAULT_HACKATHON_GALLERY_REPO = "archestra-ai/apps-gallery";

/**
 * The App Gallery repository a shared recording is submitted to, as
 * `owner/name` on github.com. Unset means sharing is not offered — the
 * recorder itself works without it (record/replay/download stay local).
 *
 * Undocumented on purpose, like the rest of the recorder — not in
 * .env.example or the deployment docs.
 *
 * @public — exported for testability
 */
export function parseHackathonGalleryRepo(
  envValue: string | undefined,
): { owner: string; name: string } | undefined {
  const raw = envValue?.trim();
  if (!raw) {
    return undefined;
  }
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (!match) {
    throw new Error(
      `ARCHESTRA_HACKATHON_GALLERY_GITHUB_REPO must be "owner/name" (a github.com repository), got "${raw}"`,
    );
  }
  return { owner: match[1], name: match[2] };
}

/**
 * The public App Gallery sharing config: each value is the env override, else
 * the baked default (see DEFAULT_HACKATHON_GALLERY_*), so every non-enterprise
 * deployment offers sharing to the official gallery out of the box. The
 * explicit optional types are load-bearing: the values are never actually
 * undefined here, but the route's "not configured" guard and its tests still
 * drive them to undefined, and an object-property annotation (unlike an
 * annotated const, which CFA narrows to its string initializer) keeps that
 * assignable.
 */
const hackathonGallery: {
  githubClientId: string | undefined;
  repo: { owner: string; name: string } | undefined;
} = {
  githubClientId:
    process.env.ARCHESTRA_HACKATHON_GALLERY_GITHUB_CLIENT_ID?.trim() ||
    DEFAULT_HACKATHON_GALLERY_GITHUB_CLIENT_ID,
  repo: parseHackathonGalleryRepo(
    process.env.ARCHESTRA_HACKATHON_GALLERY_GITHUB_REPO?.trim() ||
      DEFAULT_HACKATHON_GALLERY_REPO,
  ),
};

// The code execution sandbox (run_command / upload_file / download_file, plus
// skill activation-mounts) runs on a Dagger engine. Two ways it turns on:
//   1. An explicit ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST — an operator-
//      supplied engine (BYO tcp:// or external kube-pod://). When set it both
//      enables the sandbox and serves as the process-default engine.
//   2. ARCHESTRA_CODE_RUNTIME_ENABLED=true with the orchestrator (Kubernetes)
//      configured — the backend then provisions a per-organization engine in
//      code and routes each unbound run to its org's engine.
// It is independent of the skills *read* feature — skills can be listed/
// activated/read with the sandbox off.
const skillsSandboxDaggerRunnerHost = parseCodeRuntimeDaggerRunnerHost(
  process.env.ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST,
);
const skillsSandboxEnabled = isCodeRuntimeEnabled({
  runnerHost: skillsSandboxDaggerRunnerHost,
  runnerHostEnv: process.env.ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST,
  codeRuntimeEnabledEnv: process.env.ARCHESTRA_CODE_RUNTIME_ENABLED,
  kubeconfig: process.env.ARCHESTRA_ORCHESTRATOR_KUBECONFIG,
  loadKubeconfigFromCurrentCluster:
    process.env.ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER,
});
// the Dagger runtime fronts the sandbox; enabling the sandbox lights it up.
// runnerHost is the optional process-default/BYO engine — unset in the
// code-managed per-organization mode, where each run carries its own target.
// Read before the config object so the sandbox ceiling can be checked against it.
const daggerEngineMemoryRequest =
  process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST || "6Gi";
const daggerRuntimeRunnerHost = skillsSandboxDaggerRunnerHost;
const daggerRuntimeEnabled = skillsSandboxEnabled;

// persistent "My Files" byte storage backend; the root is validated (required +
// absolute) eagerly so a misconfigured filesystem provider fails boot loudly.
const fileStorageProvider = parseFileStorageProvider(
  process.env.ARCHESTRA_FILE_STORAGE_PROVIDER,
);
const fileStorageFilesystemRoot = parseFileStorageFilesystemRoot({
  provider: fileStorageProvider,
  value: process.env.ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT,
});
const fileStorageS3Config = parseFileStorageS3Config({
  provider: fileStorageProvider,
  env: {
    bucket: process.env.ARCHESTRA_FILE_STORAGE_S3_BUCKET,
    region: process.env.ARCHESTRA_FILE_STORAGE_S3_REGION,
    endpoint: process.env.ARCHESTRA_FILE_STORAGE_S3_ENDPOINT,
    forcePathStyle: process.env.ARCHESTRA_FILE_STORAGE_S3_FORCE_PATH_STYLE,
    accessKeyId: process.env.ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY,
    keyPrefix: process.env.ARCHESTRA_FILE_STORAGE_S3_KEY_PREFIX,
  },
});

const config = {
  frontendBaseUrl,
  api: {
    host: isDevelopment ? "127.0.0.1" : "0.0.0.0",
    port: getPortFromUrl(),
    name: DEFAULT_APP_NAME,
    version: appVersion,
    corsOrigins: getCorsOrigins(),
    apiKeyAuthorizationHeaderName: "Authorization",
    /**
     * Maximum request body size for LLM proxy and chat routes.
     * Default Fastify limit is 1MB, which is too small for long conversations
     * with large context windows (100k+ tokens) or file attachments.
     * Configurable via ARCHESTRA_API_BODY_LIMIT environment variable.
     */
    bodyLimit: parseBodyLimit(
      process.env.ARCHESTRA_API_BODY_LIMIT,
      DEFAULT_BODY_LIMIT,
    ),
    trustProxy: parseTrustProxy(process.env.ARCHESTRA_TRUST_PROXY),
    /**
     * How long an idle keep-alive connection is held open before the server
     * closes it. Must stay above the keep-alive timeout of anything proxying
     * this server — see {@link parseKeepAliveTimeoutMs}. Configurable via
     * ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS, which also drives the Next.js
     * server (mapped to KEEP_ALIVE_TIMEOUT in the container's supervisord
     * config) so both processes share one setting.
     */
    keepAliveTimeoutMs: parseKeepAliveTimeoutMs(
      process.env.ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS,
      DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    ),
    /**
     * When set, a dedicated Fastify listener additionally serves the
     * publicly-exposable endpoints (currently the MS Teams incoming webhook)
     * on this port. Same handlers as the main API port — just an alias, so a
     * firewall can expose only these endpoints publicly without exposing the
     * whole API. The main API port keeps serving them either way.
     */
    publicEndpointsPort: parseOptionalPort({
      envVarName: "ARCHESTRA_PUBLIC_ENDPOINTS_PORT",
      envValue: process.env.ARCHESTRA_PUBLIC_ENDPOINTS_PORT,
    }),
  },
  websocket: {
    path: "/ws",
  },
  mcpGateway: {
    endpoint: "/v1/mcp",
    /**
     * Per-request timeout (ms) for an upstream MCP tool call made through the
     * gateway. The MCP SDK defaults to 60s, which is too short for tools that
     * do slow work (long-running scrapers, report builders, etc.). Raise this
     * env var to give such tools more time before the request times out.
     */
    toolCallTimeoutMs: parsePositiveInt(
      process.env.ARCHESTRA_MCP_GATEWAY_TOOL_CALL_TIMEOUT_MS,
      60000,
    ),
    /**
     * Both directions of the draft MCP Skills extension: publishing local
     * Skills through gateways and projecting external Skills from installed
     * servers. Deployment-global; blank falls back to ARCHESTRA_BETA.
     */
    skillsEnabled: betaFeatureEnabled(process.env.ARCHESTRA_MCP_SKILLS_ENABLED),
  },
  mcpServer: {
    /**
     * BETA: operational attention facets, issue diagnostics and per-viewer
     * dismissals. Off by default; blank falls back to ARCHESTRA_BETA.
     */
    alertingEnabled: betaFeatureEnabled(
      process.env.ARCHESTRA_MCP_SERVER_ALERTING_ENABLED,
    ),
    /**
     * Opt-in periodic re-discovery of installed MCP servers' tools. Every N
     * minutes each installed server's catalog tool snapshot is re-synced from
     * the live server (add/update/remove — same as the reload-tools endpoint,
     * no pod restart). Unset or 0 disables the refresher (the default).
     */
    toolsRefreshIntervalMinutes: parsePositiveInt(
      process.env.ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES,
      0,
    ),
  },
  skillMarketplace: {
    endpoint: SKILL_MARKETPLACE_PREFIX,
    /**
     * Cache directory for materialized share-link git repos. The cache is a
     * derived view of the `skill_share_link_revision` history — wiping it is
     * safe and replays produce byte-identical SHAs. For prod, point this at a
     * persistent volume so reboots don't trigger an unnecessary rebuild.
     */
    cacheDir:
      process.env.ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR?.trim() ||
      path.join(homedir(), ".archestra", "skill-marketplace-cache"),
  },
  agentBackgroundExecution: {
    /**
     * Background execution: delegated Agent tasks run in one Kubernetes pod
     * each and remain attachable and steerable while they run.
     *
     * Deliberately an independent switch rather than `betaFeatureEnabled`:
     * the feature spawns compute holding a user's personal credentials, so
     * flipping the ARCHESTRA_BETA master switch must never turn it on by
     * implication. It also needs the Kubernetes runtime configured — without
     * that, `orchestratorK8sRuntime` is false and background runs stay unavailable
     * regardless of this value.
     */
    enabled:
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENABLED === "true",
    /**
     * Privileged pods have node-level impact. Agent administrators cannot
     * enable them unless the deployment operator explicitly opts in too.
     */
    allowPrivileged:
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ALLOW_PRIVILEGED ===
      "true",
    /** Built-in execution loop used when an Agent enables the capability. */
    defaultImage:
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_BASE_IMAGE?.trim() ||
      "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/agent-archestra:latest",
    /** Fallback lifetime cap for runners whose agent sets none. */
    defaultTtlHours: parsePositiveInt(
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_DEFAULT_TTL_HOURS,
      72,
    ),
    /**
     * Fallback idle stop for runners whose agent sets none. An idle runner is
     * stopped rather than scaled to zero: its in-memory session state cannot
     * survive the pod, so the loss is made explicit instead of silent.
     */
    defaultIdleTimeoutMinutes: parsePositiveInt(
      process.env
        .ARCHESTRA_AGENT_BACKGROUND_EXECUTION_DEFAULT_IDLE_TIMEOUT_MINUTES,
      180,
    ),
    resources: {
      cpuRequest:
        process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_CPU_REQUEST?.trim() ||
        "500m",
      memoryRequest:
        process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MEMORY_REQUEST?.trim() ||
        "1Gi",
      /**
       * No CPU limit by default, matching the MCP server runtime: throttling
       * an agent mid-turn surfaces as confusing timeouts rather than
       * back-pressure. Memory is limited because a runaway agent process
       * should die rather than take the node with it.
       */
      memoryLimit:
        process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MEMORY_LIMIT?.trim() ||
        "4Gi",
    },
    ephemeralStorageLimit: parseK8sResourceQuantity({
      envName: "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_EPHEMERAL_STORAGE_LIMIT",
      value:
        process.env
          .ARCHESTRA_AGENT_BACKGROUND_EXECUTION_EPHEMERAL_STORAGE_LIMIT,
      validator: isValidK8sMemoryQuantity,
      defaultValue: "10Gi",
    }),
    /**
     * Base URL a background execution pod uses to reach this deployment's LLM
     * proxy and MCP gateway. Must be reachable from inside the cluster, so it
     * defaults to the internal API URL rather than the browser-facing one.
     *
     * Empty means background executions cannot start: a session which silently
     * bypasses the proxy loses all observability, so a missing URL fails the
     * spawn loudly instead of falling back to a direct provider call.
     */
    platformBaseUrl:
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_BASE_URL?.trim() ||
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL?.trim() ||
      "",
    /**
     * Selects the platform's own API-serving pods, so a runner's egress policy
     * can allow exactly that destination and nothing else. The default is the
     * label the Helm chart already stamps on both the platform and worker
     * deployments; override it if your deployment labels them differently, or
     * when the platform runs outside the cluster.
     */
    platformPodSelector: parseLabelSelector(
      process.env.ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_POD_SELECTOR,
      { "archestra.io/p4-shim-client": "true" },
    ),
    /** How often the reconciler syncs runner state and applies TTL/idle stops. */
    reconcileIntervalSeconds: parsePositiveInt(
      process.env
        .ARCHESTRA_AGENT_BACKGROUND_EXECUTION_RECONCILE_INTERVAL_SECONDS,
      30,
    ),
  },
  plugins: {
    /**
     * Opaque plugins execute on connected developer machines, so
     * authoring and automatic connection delivery ship off by default. Blank
     * follows the ARCHESTRA_BETA master switch; an explicit false wins.
     */
    enabled: betaFeatureEnabled(process.env.ARCHESTRA_PLUGINS_ENABLED),
  },
  git: {
    binaryPath: process.env.ARCHESTRA_GIT_BINARY_PATH?.trim() || "git",
  },
  a2aGateway: {
    endpoint: "/v1/a2a",
  },
  a2aV2Gateway: {
    endpoint: "/v2/a2a",
    /**
     * How long a terminal A2A task is retained before the reaper deletes it
     * (with its artifacts and stream events). Its messages are detached
     * first, so the conversation history they belong to is never affected.
     * 0 keeps tasks forever.
     */
    taskRetentionDays: parseNonNegativeInt(
      process.env.ARCHESTRA_A2A_TASK_RETENTION_DAYS,
      90,
    ),
  },
  agents: {
    incomingEmail: {
      provider: parseIncomingEmailProvider(),
      outlook: {
        tenantId:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_TENANT_ID || "",
        clientId:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_ID || "",
        clientSecret:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_SECRET ||
          "",
        mailboxAddress:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS ||
          "",
        emailDomain:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_EMAIL_DOMAIN ||
          undefined,
        webhookUrl:
          process.env.ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL ||
          undefined,
      },
    },
  },
  auth: {
    // Session-signing secret (better-auth session/cookie HMAC). Prefer the
    // dedicated ARCHESTRA_AUTH_SESSION_SECRET; fall back to the legacy combined
    // ARCHESTRA_AUTH_SECRET so existing single-secret deployments keep working.
    // The new var is trimmed; the legacy fallback is deliberately left as-is —
    // trimming it would change the key existing deployments already derive from
    // it and break decryption of already-stored data. (Same for the
    // encryption secrets below.)
    secret:
      process.env.ARCHESTRA_AUTH_SESSION_SECRET?.trim() ||
      process.env.ARCHESTRA_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(),
    adminDefaultEmail:
      process.env[DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME] || DEFAULT_ADMIN_EMAIL,
    adminDefaultPassword:
      process.env[DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME] ||
      DEFAULT_ADMIN_PASSWORD,
    cookieDomain: process.env.ARCHESTRA_AUTH_COOKIE_DOMAIN,
    /**
     * Prefix for auth cookie names (`<prefix>.session_token` etc.). Browsers
     * scope cookies to the host without the port, so parallel local instances
     * on different localhost ports clobber each other's sessions unless each
     * uses a distinct prefix.
     */
    cookiePrefix:
      process.env.ARCHESTRA_AUTH_COOKIE_PREFIX?.trim() || "archestra",
    disableBasicAuth: process.env.ARCHESTRA_AUTH_DISABLE_BASIC_AUTH === "true",
    disableInvitations:
      process.env.ARCHESTRA_AUTH_DISABLE_INVITATIONS === "true",
    /**
     * Kill switch for user impersonation ("View as user" role debugging).
     * Blocks starting new impersonated sessions and hides the pickers;
     * stopping an in-flight impersonation always stays possible.
     */
    disableImpersonation:
      process.env.ARCHESTRA_AUTH_DISABLE_IMPERSONATION === "true",
    /**
     * OAuth Dynamic Client Registration (DCR, RFC 7591) and CIMD auto-registration.
     * Enabled by default. Set ARCHESTRA_AUTH_DCR_ENABLED=false to allow only
     * pre-registered OAuth clients (e.g. manually registered MCP OAuth clients) to
     * run OAuth flows — runtime self-registration is then rejected. Instance-level
     * because unauthenticated DCR has no org to scope a per-org toggle to.
     */
    dynamicClientRegistrationEnabled:
      process.env.ARCHESTRA_AUTH_DCR_ENABLED !== "false",
    /**
     * Grace window (seconds) for the OAuth refresh-token replay shield: a
     * replayed refresh token revoked within this window is treated as a benign
     * rotation race and re-issued instead of triggering reuse invalidation.
     * See services/oauth-refresh-replay.ts.
     */
    refreshTokenReuseGraceSeconds: parseRefreshTokenReuseGraceSeconds(
      process.env.ARCHESTRA_AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS,
    ),
    devAutoAuthenticateEmail,
  },
  analytics: getAnalyticsConfig(),
  database: {
    url: getDatabaseUrl(),
    poolMax: parseDatabasePoolMax(process.env.ARCHESTRA_DATABASE_POOL_MAX),
    statementTimeoutMillis: parseDatabaseStatementTimeoutMillis(
      process.env.ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS,
    ),
  },
  // Cost/billing behavior for LLM interactions. Kept separate from `llm` (which
  // is a per-provider config map iterated as provider descriptors).
  llmCost: {
    // When on (default), traffic robustly attributed to a Claude client AND
    // forwarding an OAuth Bearer token (Claude Code/Desktop on a Max/Pro
    // subscription) is classified `subscription` and reported as $0 billed spend
    // while retaining its list-price estimate. Set to "false" to treat all
    // raw-passthrough traffic as metered and rely solely on the per-provider-key
    // billing-mode override. See resolveInteractionBillingMode.
    subscriptionAutodetect:
      process.env.ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT !== "false",
  },
  llm: {
    openai: {
      baseUrl:
        process.env.ARCHESTRA_OPENAI_BASE_URL || "https://api.openai.com/v1",
      /**
       * "ChatGPT subscription" (Codex) auth mode on the OpenAI provider: reuse a
       * user's ChatGPT/Codex subscription for chat instead of a static API key.
       * The defaults are the first-party Codex CLI values (the same OAuth client
       * and endpoints the `codex` CLI uses), overridable for testing.
       */
      codex: {
        /** Codex backend serving the subscription Responses API (`/responses`). */
        apiBaseUrl:
          process.env.ARCHESTRA_OPENAI_CODEX_API_BASE_URL ||
          "https://chatgpt.com/backend-api/codex",
        /** OAuth issuer hosting the authorize/token/device endpoints. */
        issuer:
          process.env.ARCHESTRA_OPENAI_CODEX_ISSUER ||
          "https://auth.openai.com",
        /** Public OAuth client id used for the ChatGPT/Codex login flow. */
        clientId:
          process.env.ARCHESTRA_OPENAI_CODEX_CLIENT_ID ||
          "app_EMoamEEZ73f0CkXaXp7hrann",
        /**
         * `originator` header value the Codex backend attributes traffic by.
         * Defaults to Archestra's own identity — matching OpenCode, which sends
         * its own `opencode` originator rather than impersonating the CLI (proof
         * the backend accepts non-CLI originators). Overridable to `codex_cli_rs`
         * if OpenAI ever restricts unknown originators.
         */
        originator:
          process.env.ARCHESTRA_OPENAI_CODEX_ORIGINATOR || "archestra",
      },
    },
    openrouter: {
      baseUrl:
        process.env.ARCHESTRA_OPENROUTER_BASE_URL ||
        "https://openrouter.ai/api/v1",
      // OpenRouter attribution must always identify the product, never the
      // deployment host (which would leak `localhost`/internal URLs).
      referer:
        process.env.ARCHESTRA_OPENROUTER_REFERER?.trim() ||
        "https://archestra.ai",
      title: process.env.ARCHESTRA_OPENROUTER_TITLE || DEFAULT_APP_NAME,
      // Comma-separated OpenRouter marketplace categories for app attribution.
      categories:
        process.env.ARCHESTRA_OPENROUTER_CATEGORIES?.trim() ||
        "general-chat,personal-agent",
    },
    anthropic: {
      baseUrl:
        process.env.ARCHESTRA_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      azureFoundryEntraIdEnabled:
        process.env.ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED ===
        "true",
      // Workload Identity Federation (keyless upstream auth); null when not configured.
      wif: parseAnthropicWifConfig({
        federationRuleId: process.env.ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID,
        organizationId: process.env.ARCHESTRA_ANTHROPIC_ORGANIZATION_ID,
        serviceAccountId: process.env.ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID,
        workspaceId: process.env.ARCHESTRA_ANTHROPIC_WORKSPACE_ID,
        identityTokenFile: process.env.ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE,
        identityToken: process.env.ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN,
      }),
    },
    gemini: {
      baseUrl:
        process.env.ARCHESTRA_GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
      vertexAi: {
        enabled: process.env.ARCHESTRA_GEMINI_VERTEX_AI_ENABLED === "true",
        project: process.env.ARCHESTRA_GEMINI_VERTEX_AI_PROJECT || "",
        location:
          process.env.ARCHESTRA_GEMINI_VERTEX_AI_LOCATION || "us-central1",
        /**
         * Whether models Vertex AI serves only from `locations/global` (the
         * Gemini 3+ generations) may be reached there while `location` stays
         * pinned to an ordinary region for everything else.
         *
         * Off by default and deliberately opt-in: the global endpoint gives up
         * any control over which region processes a request, so turning it on
         * for a deployment that pinned a region for data-residency reasons
         * would quietly move part of its traffic offshore. Left off, global-only
         * models simply stay out of the catalog.
         */
        allowGlobalEndpoint:
          process.env.ARCHESTRA_GEMINI_VERTEX_AI_ALLOW_GLOBAL_ENDPOINT ===
          "true",
        // Path to service account JSON key file for authentication (optional)
        // If not set, uses default ADC (Workload Identity, attached service account, etc.)
        credentialsFile:
          process.env.ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE || "",
      },
    },
    cohere: {
      enabled: Boolean(process.env.ARCHESTRA_COHERE_BASE_URL),
      baseUrl: process.env.ARCHESTRA_COHERE_BASE_URL || "https://api.cohere.ai",
    },
    // Embeddings-only provider: this base URL roots both /v1/embeddings and
    // /v1/multimodalembeddings; there is no chat endpoint to configure.
    voyage: {
      enabled: Boolean(process.env.ARCHESTRA_VOYAGE_BASE_URL),
      baseUrl:
        process.env.ARCHESTRA_VOYAGE_BASE_URL || "https://api.voyageai.com/v1",
    },
    cerebras: {
      baseUrl:
        process.env.ARCHESTRA_CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
    },
    mistral: {
      baseUrl:
        process.env.ARCHESTRA_MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
    },
    perplexity: {
      baseUrl:
        process.env.ARCHESTRA_PERPLEXITY_BASE_URL ||
        "https://api.perplexity.ai",
    },
    groq: {
      baseUrl:
        process.env.ARCHESTRA_GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    },
    xai: {
      baseUrl: process.env.ARCHESTRA_XAI_BASE_URL || "https://api.x.ai/v1",
      /**
       * "SuperGrok" subscription auth mode on the xAI provider:
       * reuse a user's SuperGrok subscription for chat instead of a metered
       * console API key. xAI serves OAuth sessions through the Grok CLI chat
       * proxy, separately from the metered `api.x.ai` API-key surface above.
       */
      subscription: {
        /** OpenAI-compatible inference/model endpoint for OAuth sessions. */
        baseUrl:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_BASE_URL ||
          "https://cli-chat-proxy.grok.com/v1",
        /** OAuth issuer; its OIDC discovery document supplies the endpoints. */
        issuer:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_ISSUER || "https://auth.x.ai",
        /** Browser origin allowed for the device-flow verification page. */
        verificationOrigin:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_VERIFICATION_ORIGIN ||
          "https://accounts.x.ai",
        /** First-party session protocol version this integration targets. */
        clientVersion:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_VERSION || "1.0.0",
        /** Public OAuth client id used for the SuperGrok device-code login. */
        clientId:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_ID ||
          "b1a00492-073a-47ea-816f-4c329264a828",
        /**
         * Scopes requested at device-authorization time, space-separated.
         * `offline_access` is what yields the long-lived refresh token the
         * provider key stores; `grok-cli:access` authorizes the session proxy.
         * Overridable because xAI gates some
         * scopes by plan — an operator whose accounts are refused
         * `grok-cli:access` can drop it without a code change.
         */
        scopes:
          process.env.ARCHESTRA_XAI_SUBSCRIPTION_SCOPES ||
          "openid profile email offline_access api:access grok-cli:access",
      },
    },
    vllm: {
      enabled: Boolean(process.env.ARCHESTRA_VLLM_BASE_URL),
      baseUrl: process.env.ARCHESTRA_VLLM_BASE_URL,
    },
    ollama: {
      // Always on: unlike vLLM (which has no usable default endpoint, hence
      // `Boolean(env)` above), Ollama falls back to localhost, so there is
      // always a base URL to try. Stated literally — `Boolean(env ?? literal)`
      // read as a real check while being unconditionally true.
      enabled: true,
      baseUrl:
        process.env.ARCHESTRA_OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    },
    // Ollama native `/api/chat` transport. Same server as `ollama`, different
    // endpoint (root, no `/v1`), so it defaults from the Ollama base URL with the
    // `/v1` suffix stripped. Lets Archestra send/display num_ctx, num_predict,
    // top_k, think, etc. that the OpenAI-compatible `/v1` endpoint discards.
    "ollama-native": {
      baseUrl: deriveOllamaNativeBaseUrl({
        nativeBaseUrl: process.env.ARCHESTRA_OLLAMA_NATIVE_BASE_URL,
        ollamaBaseUrl: process.env.ARCHESTRA_OLLAMA_BASE_URL,
      }),
    },
    zhipuai: {
      baseUrl:
        process.env.ARCHESTRA_ZHIPUAI_BASE_URL ||
        "https://api.z.ai/api/paas/v4",
    },
    deepseek: {
      baseUrl:
        process.env.ARCHESTRA_DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    },
    archestra: {
      // The "archestra" provider targets another Archestra instance's OpenAI-
      // compatible LLM proxy. There is no meaningful global default — the
      // upstream endpoint is supplied per key as a base URL. A global base URL
      // only enables raw passthrough at the /v1/archestra proxy prefix.
      enabled: Boolean(process.env.ARCHESTRA_ARCHESTRA_BASE_URL),
      baseUrl: process.env.ARCHESTRA_ARCHESTRA_BASE_URL,
    },
    kimi: {
      baseUrl:
        process.env.ARCHESTRA_KIMI_BASE_URL || "https://api.moonshot.ai/v1",
    },
    "github-copilot": {
      baseUrl:
        process.env.ARCHESTRA_GITHUB_COPILOT_BASE_URL ||
        "https://api.githubcopilot.com",
      /**
       * Endpoint exchanging a long-lived GitHub OAuth token for a short-lived
       * Copilot API bearer. Overridable for GitHub Enterprise
       * (https://copilot-api.<ghe-domain>/copilot_internal/v2/token) and e2e tests.
       */
      tokenExchangeUrl:
        process.env.ARCHESTRA_GITHUB_COPILOT_TOKEN_EXCHANGE_URL ||
        "https://api.github.com/copilot_internal/v2/token",
      /**
       * Host serving the GitHub OAuth device-flow endpoints
       * (/login/device/code and /login/oauth/access_token).
       */
      deviceAuthBaseUrl:
        process.env.ARCHESTRA_GITHUB_COPILOT_DEVICE_AUTH_BASE_URL ||
        "https://github.com",
      /**
       * GitHub App client id used for the device flow. Defaults to the
       * community-standard VS Code client id accepted by the Copilot token
       * exchange; organizations with their own GitHub App can override it.
       */
      clientId:
        process.env.ARCHESTRA_GITHUB_COPILOT_CLIENT_ID ||
        "Iv1.b507a08c87ecfe98",
    },
    "microsoft-365-copilot": {
      /** Microsoft Graph base URL serving the Microsoft 365 Copilot Chat API (beta). */
      baseUrl:
        process.env.ARCHESTRA_MICROSOFT_365_COPILOT_BASE_URL ||
        "https://graph.microsoft.com/beta",
      /**
       * Host serving the Entra ID OAuth endpoints
       * (/{tenant}/oauth2/v2.0/devicecode and /{tenant}/oauth2/v2.0/token).
       * Overridable for sovereign clouds and e2e tests.
       */
      authBaseUrl:
        process.env.ARCHESTRA_MICROSOFT_365_COPILOT_AUTH_BASE_URL ||
        "https://login.microsoftonline.com",
      /**
       * Entra tenant segment of the OAuth endpoints. "organizations" allows any
       * work/school account; operators can pin their own tenant id to restrict
       * sign-in to one directory.
       */
      tenantId:
        process.env.ARCHESTRA_MICROSOFT_365_COPILOT_TENANT_ID ||
        "organizations",
      /**
       * Application (client) ID of the operator's Entra app registration (a
       * public client with "Allow public client flows" enabled and the Graph
       * delegated scopes the Chat API requires). No community default exists,
       * so device-flow sign-in is unavailable until this is set.
       */
      clientId: process.env.ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID || "",
    },
    bedrock: {
      enabled: Boolean(process.env.ARCHESTRA_BEDROCK_BASE_URL),
      baseUrl: process.env.ARCHESTRA_BEDROCK_BASE_URL || "",
      /** Enable AWS IAM authentication (IRSA, env vars, instance profile) instead of API key */
      iamAuthEnabled: process.env.ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED === "true",
      /** Explicit AWS region override; falls back to extracting from base URL */
      region: process.env.ARCHESTRA_BEDROCK_REGION || "",
      /** Comma-separated list of provider prefixes to include (e.g., "anthropic,amazon"). Empty = allow all. */
      allowedProviders: parseCommaSeparatedList(
        process.env.ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS || "",
      ),
      /** Comma-separated list of inference region prefixes to include (e.g., "us,global"). Empty = allow all. */
      allowedInferenceRegions: parseCommaSeparatedList(
        process.env.ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS || "",
      ),
    },
    minimax: {
      baseUrl:
        process.env.ARCHESTRA_MINIMAX_BASE_URL || "https://api.minimax.io/v1",
    },
    azure: {
      baseUrl: process.env.ARCHESTRA_AZURE_OPENAI_BASE_URL || "",
      apiVersion:
        process.env.ARCHESTRA_AZURE_OPENAI_API_VERSION || "2024-02-01",
      responsesApiVersion:
        process.env.ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION ||
        "2025-04-01-preview",
      entraIdEnabled:
        process.env.ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED === "true",
    },
  },
  chat: {
    openai: {
      apiKey: process.env.ARCHESTRA_CHAT_OPENAI_API_KEY || "",
    },
    openrouter: {
      apiKey: process.env.ARCHESTRA_CHAT_OPENROUTER_API_KEY || "",
    },
    anthropic: {
      apiKey: process.env.ARCHESTRA_CHAT_ANTHROPIC_API_KEY || "",
    },
    gemini: {
      apiKey: process.env.ARCHESTRA_CHAT_GEMINI_API_KEY || "",
    },
    cerebras: {
      apiKey: process.env.ARCHESTRA_CHAT_CEREBRAS_API_KEY || "",
    },
    mistral: {
      apiKey: process.env.ARCHESTRA_CHAT_MISTRAL_API_KEY || "",
    },
    perplexity: {
      apiKey: process.env.ARCHESTRA_CHAT_PERPLEXITY_API_KEY || "",
    },
    groq: {
      apiKey: process.env.ARCHESTRA_CHAT_GROQ_API_KEY || "",
    },
    xai: {
      apiKey: process.env.ARCHESTRA_CHAT_XAI_API_KEY || "",
    },
    vllm: {
      apiKey: process.env.ARCHESTRA_CHAT_VLLM_API_KEY || "",
    },
    ollama: {
      apiKey: process.env.ARCHESTRA_CHAT_OLLAMA_API_KEY || "",
    },
    "ollama-native": {
      apiKey: process.env.ARCHESTRA_CHAT_OLLAMA_API_KEY || "",
    },
    cohere: {
      apiKey: process.env.ARCHESTRA_CHAT_COHERE_API_KEY || "",
    },
    // Keeps the env-seeded-key naming uniform across providers even though
    // Voyage serves embeddings rather than chat.
    voyage: {
      apiKey: process.env.ARCHESTRA_CHAT_VOYAGE_API_KEY || "",
    },
    zhipuai: {
      apiKey: process.env.ARCHESTRA_CHAT_ZHIPUAI_API_KEY || "",
    },
    deepseek: {
      apiKey: process.env.ARCHESTRA_CHAT_DEEPSEEK_API_KEY || "",
    },
    archestra: {
      apiKey: process.env.ARCHESTRA_CHAT_ARCHESTRA_API_KEY || "",
    },
    kimi: {
      apiKey: process.env.ARCHESTRA_CHAT_KIMI_API_KEY || "",
    },
    "github-copilot": {
      apiKey: process.env.ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY || "",
    },
    "microsoft-365-copilot": {
      // Per-user provider: every env-key consumer skips it (resolution
      // fallback, env seeding, system defaults), so no env var is read.
      apiKey: "",
    },
    bedrock: {
      apiKey: process.env.ARCHESTRA_CHAT_BEDROCK_API_KEY || "",
    },
    minimax: {
      apiKey: process.env.ARCHESTRA_CHAT_MINIMAX_API_KEY || "",
    },
    azure: {
      apiKey: process.env.ARCHESTRA_CHAT_AZURE_OPENAI_API_KEY || "",
    },
    defaultModel:
      process.env.ARCHESTRA_CHAT_DEFAULT_MODEL || DEFAULT_MODELS.anthropic,
    defaultProvider: ((): SupportedProvider => {
      const provider = process.env.ARCHESTRA_CHAT_DEFAULT_PROVIDER;
      if (
        provider &&
        SupportedProviders.includes(provider as SupportedProvider)
      ) {
        return provider as SupportedProvider;
      }
      return "anthropic";
    })(),
    activeRun: {
      replayPollIntervalMs: parseActiveChatRunPollIntervalMs({
        value: process.env.ARCHESTRA_CHAT_ACTIVE_RUN_REPLAY_POLL_INTERVAL_MS,
        defaultValue: 500,
        envName: "ARCHESTRA_CHAT_ACTIVE_RUN_REPLAY_POLL_INTERVAL_MS",
      }),
      // One value, not one per mode: this is the fallback a stream wants when
      // notifications are being delivered. When they are not, the notify hub
      // tightens its own fallback, so nothing here has to know whether the
      // database endpoint can hold a listener.
      stopPollIntervalMs: parseActiveChatRunPollIntervalMs({
        value: process.env.ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS,
        defaultValue: 30_000,
        envName: "ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS",
      }),
      pollingCompatibilityEnabled:
        process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED ===
        "true",
      notifyDatabaseUrl:
        process.env.ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL?.trim() || "",
    },
    secretScanEnabled:
      process.env.ARCHESTRA_CHAT_SECRET_SCAN_ENABLED !== "false",
    maxOutputTokensCeiling: parseChatMaxOutputTokens(
      process.env.ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS,
    ),
    rateMeteredMaxOutputTokensCeiling: parseChatRateMeteredMaxOutputTokens(
      process.env.ARCHESTRA_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS,
    ),
    /**
     * Largest single upload a chat turn may store as a conversation
     * attachment. Independent of the sandbox artifact limit: bigger files skip
     * sandbox staging but still land in the Files panel. Raising this needs
     * `ARCHESTRA_API_BODY_LIMIT` raised too — uploads arrive base64-encoded
     * (~4/3 of the byte size) alongside the conversation JSON.
     */
    attachmentStorageBytesLimit: parsePositiveInt(
      process.env.ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT,
      DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
    ),
    /**
     * Largest attachment that may be embedded in a provider request. Separate
     * from the storage cap on purpose: a file over this is still stored and
     * downloadable, it just never reaches the model. Keeps a big upload from
     * inflating a request past what the provider accepts.
     */
    attachmentInlineBytesLimit: parsePositiveInt(
      process.env.ARCHESTRA_CHAT_ATTACHMENT_INLINE_BYTES_LIMIT,
      DEFAULT_CHAT_ATTACHMENT_INLINE_BYTES,
    ),
  },
  enterpriseFeatures: {
    core: process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
    knowledgeBase:
      process.env.ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED ===
      "true",
    fullWhiteLabeling:
      process.env.ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING === "true",
  },
  hackathonRecorder: {
    enabled: parseHackathonRecorderEnabled({
      enterpriseLicenseActivated:
        process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
      // Undocumented on purpose — see parseHackathonRecorderEnabled. Do not
      // add this to .env.example or the deployment docs.
      enterpriseOverride:
        process.env.ARCHESTRA_HACKATHON_RECORDER_ENTERPRISE_OVERRIDE,
    }),
    /**
     * Offering the offline VIDEO export (the player's download button and the
     * render endpoints behind it). Off unless a deployment opts in: a render
     * drives a headless Chromium for as long as the cut runs, which is a cost
     * no deployment should pay by surprise — and the gallery submission, which
     * is what the hackathon actually needs, does not depend on it.
     *
     * Undocumented on purpose, like the rest of the recorder — not in
     * .env.example or the deployment docs.
     */
    videoDownloadEnabled:
      process.env.ARCHESTRA_HACKATHON_RECORDER_VIDEO_DOWNLOAD_ENABLED ===
      "true",
    /** The longest final cut that may be submitted or exported (see the parser). */
    maxFinalCutMs: parseHackathonRecorderMaxFinalCutMs(
      process.env.ARCHESTRA_HACKATHON_RECORDER_MAX_FINAL_CUT_MS,
    ),
    /**
     * Sharing a recording to the public App Gallery (a PR filed on the
     * participant's own GitHub account). Both values default to the official
     * Archestra gallery + its public device-flow OAuth client (see
     * DEFAULT_HACKATHON_GALLERY_*), so every non-enterprise deployment offers
     * sharing out of the box; an env override repoints a fork elsewhere.
     *
     * `githubClientId` is the PUBLIC client id of the "Archestra App Gallery"
     * GitHub OAuth app with the device flow enabled — the device flow needs no
     * client secret, which is what lets community deployments offer sharing
     * with nothing but this id. Register a classic OAuth app, not a GitHub
     * App: a GitHub App's user token cannot write to the participant's fork
     * unless they also install the app on their account.
     *
     * Undocumented on purpose, like the rest of the recorder — not in
     * .env.example or the deployment docs.
     */
    gallery: hackathonGallery,
    /**
     * Escape hatch, not a requirement: the renderer finds or installs its own
     * Chromium (see app-recording-render-runtime). Set this only to pin a
     * specific browser — it must be a FULL Chromium, since Playwright's
     * headless shell carries no WebCodecs encoder.
     *
     * Undocumented on purpose, like the rest of the recorder — not in
     * .env.example or the deployment docs.
     */
    chromiumPath:
      process.env.ARCHESTRA_HACKATHON_RECORDER_CHROMIUM_PATH?.trim() ||
      undefined,
    /**
     * Where the renderer reaches this deployment's own frontend to load the
     * replay page it films.
     */
    renderBaseUrl: hackathonRecorderRenderBaseUrl,
    /**
     * The origins that base URL may be reached as, so the app sandbox can name
     * them as permitted frame ancestors. Loopback is spelled two ways and they
     * are distinct origins to a browser: a render that loads `127.0.0.1` is
     * refused by a policy naming only `localhost`, and the app pane films
     * empty.
     */
    renderFrameAncestors: addLoopbackEquivalents([
      hackathonRecorderRenderBaseUrl,
    ]),
    /**
     * The in-cluster URL of the dedicated render service, when video rendering
     * runs as its own single-replica deployment (see startRenderer). Set it and
     * the web tier stops rendering in-process and proxies render/status/
     * download/cancel there instead — so a multi-replica web tier no longer
     * scatters a render's follow-up requests across pods that never held its
     * (in-memory) job. Unset — the OSS single container, local dev — and the web
     * process renders in-process exactly as before.
     *
     * Undocumented on purpose, like the rest of the recorder — not in
     * .env.example or the deployment docs.
     */
    rendererUrl:
      process.env.ARCHESTRA_APP_RECORDING_RENDERER_URL?.trim() || undefined,
  },
  /**
   * Codegen mode is set when running `pnpm codegen` via turbo.
   * This ensures enterprise routes are always included in generated API specs,
   * regardless of whether the enterprise license is activated locally.
   */
  codegenMode: process.env.CODEGEN === "true",
  orchestrator: {
    mcpServerBaseImage,
    mcpServerResources,
    /**
     * How often (in seconds) to sweep Failed/Evicted MCP server pods.
     * DiskPressure eviction cascades can leave hundreds of Failed pod
     * corpses behind that nothing else cleans up. Set to 0 to disable.
     */
    failedPodReapIntervalSeconds:
      process.env.ARCHESTRA_ORCHESTRATOR_FAILED_POD_REAP_INTERVAL_SECONDS?.trim() ===
      "0"
        ? 0
        : parsePositiveInt(
            process.env.ARCHESTRA_ORCHESTRATOR_FAILED_POD_REAP_INTERVAL_SECONDS,
            600,
          ),
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    /**
     * The OPERATOR half of idle hibernation: `windowSeconds` is how long an
     * MCP server must sit unused before it is scaled to zero (default 30 min,
     * floored at 120 s), `hardDisabled` is the kill switch set by an explicit
     * `…MCP_IDLE_HIBERNATION_SECONDS=0`, and `betaEnabled` is the BETA gate
     * the whole feature ships behind — off by default, a blank value falling
     * back to the ARCHESTRA_BETA master switch (see betaFeatureEnabled).
     * Whether hibernation runs at all is decided together with the enterprise
     * licence and the organization's own toggle — see
     * `k8s/mcp-server-runtime/hibernation.ee`.
     */
    mcpIdleHibernation: getMcpIdleHibernationConfig(),
    /**
     * The pre-pull DaemonSet's kill switch, priority class and footprint — see
     * {@link getMcpImagePrepullConfig}. The reconciler that acts on it lives in
     * `k8s/mcp-server-runtime/image-prepuller.ee`.
     */
    mcpImagePrepull: getMcpImagePrepullConfig(),
    // SPDX-SnippetEnd
    kubernetes: {
      namespace: process.env.ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE || "default",
      runtimeOwnerRoleName:
        process.env.ARCHESTRA_ORCHESTRATOR_MCP_RUNTIME_OWNER_ROLE?.trim() ||
        undefined,
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      /**
       * The Helm release this platform was installed as — see
       * {@link parseHelmReleaseName}. `undefined` when the chart did not inject
       * it (a non-Helm deployment, or local development), which is a state the
       * features that name objects after it must handle by doing nothing.
       */
      helmReleaseName: parseHelmReleaseName(
        process.env.ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME,
      ),
      // SPDX-SnippetEnd
      kubeconfig: process.env.ARCHESTRA_ORCHESTRATOR_KUBECONFIG,
      loadKubeconfigFromCurrentCluster:
        process.env
          .ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER ===
        "true",
      k8sNodeHost:
        process.env.ARCHESTRA_ORCHESTRATOR_K8S_NODE_HOST || undefined,
      clusterDomain:
        process.env.ARCHESTRA_ORCHESTRATOR_K8S_CLUSTER_DOMAIN ||
        "cluster.local",
      // Namespaces the platform ServiceAccount is granted RBAC in (Helm
      // rbac.environmentNamespaces). Surfaced to the UI so the environment
      // editor can offer a namespace dropdown instead of free text.
      environmentNamespaces: parseCommaSeparatedList(
        process.env.ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES ?? "",
      ),
    },
  },
  /**
   * code execution sandbox runtime — the per-conversation Dagger container that
   * runs commands, holds uploaded files, and materializes activated skills.
   * On when a Dagger runner host is configured, or `ARCHESTRA_CODE_RUNTIME_ENABLED`
   * is set with the orchestrator (Kubernetes) configured.   */
  /**
   * Knowledge file repository. Uploads are held as Postgres bytea, so the cap
   * bounds a single request's memory as well as row size.
   */
  knowledgeFiles: {
    maxUploadBytes: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_FILES_MAX_UPLOAD_BYTES,
      25 * 1024 * 1024,
    ),
    /** Ceiling on how many files one directory selection expands to. */
    maxFilesPerIndexRequest: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_FILES_MAX_FILES_PER_INDEX_REQUEST,
      500,
    ),
  },
  skillsSandbox: {
    enabled: skillsSandboxEnabled,
    cpuLimit: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_CPU_LIMIT_SECONDS,
      30,
    ),
    memoryLimit: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_MEMORY_LIMIT_BYTES,
      1024 * 1024 * 1024,
    ),
    wallClockSeconds: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_WALL_CLOCK_SECONDS,
      120,
    ),
    outputBytesLimit: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_OUTPUT_BYTES_LIMIT,
      256 * 1024,
    ),
    /**
     * Per-file byte cap at the sandbox boundary: attachment staging, uploads,
     * saves/edits, inline reads, and artifact export. Defaults to the chat
     * attachment storage cap so any stored attachment can be staged for the
     * agent; tune independently via env.
     */
    artifactBytesLimit: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT,
      DEFAULT_CHAT_ATTACHMENT_STORAGE_BYTES,
    ),
  },
  /**
   * agent lifecycle hooks — user scripts run at chat lifecycle events.
   * Available whenever the agent runtime (the code execution sandbox) is on,
   * since hooks execute in the conversation sandbox; off otherwise. This
   * `enabled` is the fully-resolved flag — the dispatcher, the `/debug` toggle,
   * and the chip read-gate all key off it.
   */
  hooks: {
    enabled: skillsSandboxEnabled,
  },
  /**
   * unified Dagger runtime — a per-target pool of pre-warmed base-container
   * sessions that host the code execution sandbox commands. The Rust crate
   * (`@archestra/sandbox-rs`) owns the sessions; this block only carries
   * enable + connection knobs. `runnerHost` is the optional process-default
   * engine; it is unset in the code-managed per-organization mode.
   */
  daggerRuntime: {
    enabled: daggerRuntimeEnabled,
    runnerHost: daggerRuntimeRunnerHost,
    cliBin:
      process.env.ARCHESTRA_DAGGER_RUNTIME_CLI_BIN ||
      process.env.ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN ||
      undefined,
    maxConcurrent: parsePositiveInt(
      process.env.ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT,
      10,
    ),
    maxQueueLength: parsePositiveInt(
      process.env.ARCHESTRA_DAGGER_RUNTIME_MAX_QUEUE_LENGTH,
      50,
    ),
    // Resource requests/limits for a code-managed engine StatefulSet (K8s
    // quantity strings). Two separate budgets, because the workloads live in
    // two separate cgroups: the pod's request/limit cover the buildkit daemon,
    // while `sandboxMemoryMaxBytes` caps the sandbox containers buildkit runs
    // beside it. The memory request is sized to hold node capacity for both,
    // since the sandbox cgroup sits outside the pod's accounting and the
    // scheduler cannot see it; the limit tracks the request because Kubernetes
    // requires `request <= limit`, and it stays far above the daemon's own
    // footprint so ordinary sandbox load can never OOM-kill the engine.
    engine: {
      cpuRequest:
        process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_CPU_REQUEST || "2",
      memoryRequest: daggerEngineMemoryRequest,
      memoryLimit:
        process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_LIMIT || "6Gi",
      cacheStorage:
        process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_CACHE_STORAGE || "50Gi",
      // Ceiling on everything the sandboxes hold at once. Without it nothing
      // bounds them: the per-run cap is an RLIMIT_AS, which the kernel applies
      // per process, so one run that spawns N processes holds N times it. It is
      // an engine-wide ceiling rather than a per-run allowance, so
      // `maxConcurrent` runs each at the per-run limit can reach it; raise this
      // and `memoryRequest` together, or lower `maxConcurrent`, for deployments
      // that sustain that. Resolved to bytes because it lands in a cgroup.
      sandboxMemoryMaxBytes: parseSandboxMemoryMaxBytes(
        process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX,
        daggerEngineMemoryRequest,
      ),
      // Extra IPv4 CIDRs to block from an unrestricted engine's public-egress
      // floor (on top of the built-in RFC1918/link-local/metadata ranges). Set
      // to the cluster's Service/Pod CIDRs when they fall outside RFC1918 so
      // sandboxed code can't reach in-cluster ClusterIP services.
      additionalDeniedCidrs: parseEngineDeniedCidrs(
        process.env.ARCHESTRA_DAGGER_RUNTIME_ENGINE_ADDITIONAL_DENIED_CIDRS,
      ),
    },
  },
  /**
   * Persistent "My Files" byte storage backend. `db` (Postgres bytea, the
   * default) and `filesystem` (a mounted volume / PVC) are co-equal: the active
   * provider is used for new writes while reads dispatch per row, so a
   * deployment can hold a mix. `filesystemRoot` is the absolute mount path,
   * required + validated when `provider === "filesystem"`.
   */
  fileStorage: {
    provider: fileStorageProvider,
    filesystemRoot: fileStorageFilesystemRoot,
    s3: fileStorageS3Config,
  },
  vault: {
    token: process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN || DEFAULT_VAULT_TOKEN,
  },
  mcpSandbox: {
    /**
     * Optional wildcard domain for per-server sandbox origins.
     * When set (e.g. "mcp.example.com"), each MCP server gets a hash-based
     * subdomain (e.g. "a1b2c3d4e5f6.mcp.example.com") with a real origin,
     * enabling localStorage, CORS, and OAuth for MCP Apps.
     * Requires wildcard DNS + TLS for *.{domain}.
     * When null (default), sandbox uses opaque origin (single-port, zero config).
     */
    domain: process.env.ARCHESTRA_MCP_SANDBOX_DOMAIN || null,
    /** Path to the sandbox proxy HTML file (co-located in backend static dir). */
    filePath: path.resolve(__dirname, "static/mcp-sandbox-proxy.html"),
    /**
     * Explicitly configured origins that are allowed to embed the sandbox iframe.
     * Empty array means no restriction (open / dev deployment).
     * Mirrors the CORS/trusted-origin configuration so all three stay in sync.
     */
    allowedOrigins: addLoopbackEquivalents(getConfiguredOrigins()),
  },
  logging: {
    format: parseLogFormat(process.env.ARCHESTRA_LOGGING_FORMAT),
  },
  observability: {
    otel: {
      captureContent: parseOtelCaptureContent({
        envValue: process.env.ARCHESTRA_OTEL_CAPTURE_CONTENT,
        contentEncryptionConfigured: Boolean(
          process.env.ARCHESTRA_CONTENT_ENCRYPTION_SECRET,
        ),
      }),
      contentMaxLength: parseContentMaxLength(
        process.env.ARCHESTRA_OTEL_CONTENT_MAX_LENGTH,
      ),
      tracesSampleRate: parseSampleRate(
        process.env.ARCHESTRA_OTEL_TRACES_SAMPLE_RATE,
        1.0,
      ),
      verboseTracing: process.env.ARCHESTRA_OTEL_VERBOSE_TRACING === "true",
      traceExporter: {
        url: getOtelExporterOtlpEndpoint(),
        headers: getOtlpAuthHeaders(),
      } satisfies Partial<OTLPExporterNodeConfigBase>,
      logExporter: {
        url: getOtelExporterOtlpLogEndpoint(),
        headers: getOtlpAuthHeaders(),
      } satisfies Partial<OTLPExporterNodeConfigBase>,
    },
    /**
     * RUM (Real User Monitoring): product-usage events emitted by the web
     * frontend, forwarded as OTLP log records to a customer-controlled
     * collector. Off unless an endpoint is configured, and deliberately a
     * separate pipeline from `otel` above — that one carries this backend's
     * traces/logs, this one carries browser usage events.
     */
    rum: {
      enabled: Boolean(rumExporterOtlpEndpoint),
      sampleRate: parseRumSampleRate(process.env.ARCHESTRA_RUM_SAMPLE_RATE),
      logExporter: {
        url: rumExporterOtlpEndpoint
          ? getOtelExporterOtlpLogEndpoint(rumExporterOtlpEndpoint)
          : "",
        headers: getRumOtlpAuthHeaders(),
        // OTLP/HTTP with gzip: log-record batches are highly repetitive and
        // compress roughly an order of magnitude.
        compression: "gzip" as OTLPExporterNodeConfigBase["compression"],
      } satisfies Partial<OTLPExporterNodeConfigBase>,
      // BatchLogRecordProcessor knobs. The SDK defaults drain ~100 records/s;
      // large deployments raise batch size / lower the delay to keep up.
      batchProcessor: {
        maxQueueSize: parseRumBatchSetting(
          process.env.ARCHESTRA_RUM_EXPORTER_MAX_QUEUE_SIZE,
          2048,
        ),
        maxExportBatchSize: parseRumBatchSetting(
          process.env.ARCHESTRA_RUM_EXPORTER_MAX_EXPORT_BATCH_SIZE,
          512,
        ),
        scheduledDelayMillis: parseRumBatchSetting(
          process.env.ARCHESTRA_RUM_EXPORTER_SCHEDULE_DELAY_MS,
          5000,
        ),
      },
      // Per-user ceiling on accepted ingest batches; with the per-batch event
      // cap this bounds what one runaway client can push to the collector.
      ingestMaxBatchesPerMinute: parseRumBatchSetting(
        process.env.ARCHESTRA_RUM_INGEST_MAX_BATCHES_PER_MINUTE,
        120,
      ),
    },
    metrics: {
      endpoint: "/metrics",
      port: parseMetricsPort(process.env.ARCHESTRA_METRICS_PORT),
      secret: process.env.ARCHESTRA_METRICS_SECRET,
      activeUsersRefreshIntervalMs: parseActiveUsersRefreshIntervalMs(
        process.env.ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS,
      ),
    },
    sentry: {
      enabled: sentryDsn !== "",
      dsn: sentryDsn,
      environment:
        process.env.ARCHESTRA_SENTRY_ENVIRONMENT?.toLowerCase() || environment,
      tracesSampleRate: parseSampleRate(
        process.env.ARCHESTRA_SENTRY_TRACES_SAMPLE_RATE,
        0.1,
      ),
      mcpGatewayTracesSampleRate: parseSampleRate(
        process.env.ARCHESTRA_SENTRY_MCP_GATEWAY_TRACES_SAMPLE_RATE,
        0.01,
      ),
      profilesSampleRate: parseSampleRate(
        process.env.ARCHESTRA_SENTRY_PROFILES_SAMPLE_RATE,
        0.2,
      ),
    },
  },
  debug: isDevelopment,
  production: isProduction,
  environment,
  llmProxy: {
    maxVirtualKeysPerApiKey: parsePositiveInt(
      process.env.ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS,
      10,
    ),
    virtualKeyDefaultExpirationSeconds: parseVirtualKeyDefaultExpiration(
      process.env.ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS,
    ),
    upstreamTimeoutMs: process.env.ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS
      ? parsePositiveInt(
          process.env.ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS,
          300000,
        )
      : undefined,
  },
  kb: {
    // BETA gate for the auto-sync-permissions connector visibility: the
    // permission-sync passes, the connector Permissions tab APIs, and manual
    // member overrides. Off by default; a blank value falls back to the
    // ARCHESTRA_BETA master switch (see betaFeatureEnabled).
    autoSyncPermissionsEnabled: betaFeatureEnabled(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_AUTO_SYNC_PERMISSIONS_ENABLED,
    ),
    // BETA gate for the M-Files connector: hides the connector type in the
    // frontend, rejects creating connectors of the type, and disables the VAF
    // Add On distribution endpoints. Off by default; a blank value falls back
    // to the ARCHESTRA_BETA master switch (see betaFeatureEnabled).
    mfilesConnectorEnabled: betaFeatureEnabled(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED,
    ),
    // Gate for the M-Files Application Account (OAuth client-credentials)
    // auth method. Deliberately NOT wired through betaFeatureEnabled: the
    // method stays hidden until this flag is set explicitly, even on
    // deployments running with the ARCHESTRA_BETA master switch on.
    // Intentionally undocumented while the method is being validated.
    mfilesOauthEnabled:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_MFILES_OAUTH_ENABLED === "true",
    /**
     * The p4 shim: the in-cluster pod that executes allowlisted Perforce CLI
     * commands for Perforce permission sync (k8s/p4-shim-runtime). The image
     * contains no Perforce software; the backend downloads the pinned `p4`
     * binary from `p4Binary.<arch>.url`, verifies its sha256, and pushes it to
     * the pod at provision time. Air-gapped installs point the URL at an
     * internal mirror (the checksum must then match that mirror's binary).
     */
    perforceShim: {
      image:
        process.env.ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE ||
        `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/p4-shim:${appVersion}`,
      p4Binary: {
        x64: {
          url:
            process.env.ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_AMD64 ||
            "https://cdist2.perforce.com/perforce/r25.2/bin.linux26x86_64/p4",
          sha256:
            process.env.ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_AMD64 ||
            "ba4b931bd37a1fd073785c3194a608906934f62b52d407178121a8184bee8ae6",
        },
        arm64: {
          url:
            process.env.ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_ARM64 ||
            "https://cdist2.perforce.com/perforce/r25.2/bin.linux26aarch64/p4",
          sha256:
            process.env.ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_ARM64 ||
            "a67bcae67dd810fdc099525289457ab6af6f647f6e3aceadc0260f42d19cbc93",
        },
      },
    },
    hybridSearchEnabled:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED !== "false",
    /**
     * Verifiable citations (issue #7161): in the internal chat, check the
     * verbatim quotes the model tags with a chunk ref against the chunks
     * `query_knowledge_sources` returned, and log + meter any quote that matches
     * no returned chunk. Log-only — never blocks or alters the answer — so it is
     * safe on by default; set to "false" to disable the pass entirely.
     */
    quoteVerificationEnabled:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_QUOTE_VERIFICATION_ENABLED !==
      "false",
    /**
     * Token budget for one chunk, inclusive of its title prefix and metadata
     * suffix. Applies at ingest only: existing chunks keep the size they were
     * written at until their connector re-syncs.
     */
    chunkSizeTokens: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS,
      DEFAULT_CHUNK_SIZE_TOKENS,
      MIN_CHUNK_SIZE_TOKENS,
      MAX_CHUNK_SIZE_TOKENS,
    ),
    /**
     * Parent/child (multi-granularity) indexing. When set, each chunk produced
     * at `chunkSizeTokens` is subdivided into children of this size, and only
     * the children are indexed and embedded. A search hit then resolves back to
     * its parent, so matching happens at the finer size while the model reads
     * the same passage it would have read before.
     *
     * 0 (the default) disables the second pass entirely: one chunk per parent,
     * byte-for-byte the single-pass behaviour.
     *
     * Ingest-only, like `chunkSizeTokens`: chunks already written keep their
     * granularity until their connector re-syncs, and a chunk written without a
     * parent link is served through context expansion as before.
     */
    childChunkSizeTokens: parseClampedIntOrZero(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CHILD_CHUNK_SIZE_TOKENS,
      DEFAULT_CHILD_CHUNK_SIZE_TOKENS,
      MIN_CHILD_CHUNK_SIZE_TOKENS,
      MAX_CHUNK_SIZE_TOKENS,
    ),
    /**
     * How many neighbouring chunks either side of a search hit are stitched
     * back onto it before the result is returned. Retrieval still ranks single
     * chunks — this only widens what the model gets to read, so a hit that
     * lands mid-sentence or mid-table still arrives with the passage around it.
     * 0 disables it and returns bare chunks.
     */
    contextExpansionRadius: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CONTEXT_EXPANSION_RADIUS,
      DEFAULT_CONTEXT_EXPANSION_RADIUS,
      0,
      MAX_CONTEXT_EXPANSION_RADIUS,
    ),
    /**
     * Contextual retrieval: summarize each document once at ingest and index
     * that summary alongside every one of its chunks, so a chunk that never
     * names its subject still matches a query that does. Costs one LLM call per
     * document per sync, billed against the configured reranking model.
     */
    contextualRetrievalEnabled:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CONTEXTUAL_RETRIEVAL_ENABLED ===
      "true",
    /**
     * Ceiling on how many textless pages of a single PDF the OCR pass will
     * transcribe. Each page is one vision-model request billed against the
     * organization's configured OCR model, so this bounds the worst-case cost
     * of one document (a 500-page scan stops at this many pages and the
     * document is indexed with an honest partial-extraction warning).
     */
    ocrMaxPagesPerDocument: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_OCR_MAX_PAGES_PER_DOCUMENT,
      100,
    ),
    taskWorkerPollIntervalSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_POLL_INTERVAL_SECONDS,
      5,
    ),
    taskWorkerMaxConcurrent: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT,
      2,
    ),
    // Concurrency cap for the runtime-isolated permission-sync lane. Separate
    // from the content lane so permission passes can neither starve nor be
    // starved by content ingestion.
    permissionSyncWorkerMaxConcurrent: parsePositiveInt(
      process.env
        .ARCHESTRA_KNOWLEDGE_BASE_PERMISSION_SYNC_WORKER_MAX_CONCURRENT,
      1,
    ),
    taskWorkerShutdownTimeoutSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS,
      30,
    ),
    /**
     * Per-statement timeout for the chunk search lanes (vector + keyword),
     * tighter than the pool-wide statement_timeout. Retrieval fans out into
     * several parallel search statements per tool call, so a corpus where one
     * lane degenerates (e.g. a keyword query matching most of a large corpus)
     * would otherwise burn the full pool timeout once per lane and fail the
     * whole call. A lane that exceeds this budget is dropped and the remaining
     * lanes' results are merged instead. 0 disables the override (lanes
     * inherit the pool-wide statement_timeout).
     */
    searchStatementTimeoutMillis: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_SEARCH_STATEMENT_TIMEOUT_MILLIS,
      8_000,
      0,
      120_000,
    ),
    /**
     * Deployment default for BM25 term-frequency saturation. Higher means
     * repeated terms keep earning score for longer; 0 makes a term's
     * contribution binary (present/absent). 1.2 is the Lucene/Elasticsearch
     * default. An organization can override it from Knowledge settings
     * (`organization.kb_bm25_k1`); this applies where that is unset.
     */
    bm25K1: parseClampedFloat(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_BM25_K1,
      BM25_K1_DEFAULT,
      BM25_K1_MIN,
      BM25_K1_MAX,
    ),
    /**
     * Deployment default for BM25 document-length normalization. 0 ignores
     * chunk length entirely (which is what `ts_rank` does today); 1 normalizes
     * fully. 0.75 is the Lucene/Elasticsearch default. An organization can
     * override it from Knowledge settings (`organization.kb_bm25_b`); this
     * applies where that is unset.
     */
    bm25B: parseClampedFloat(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_BM25_B,
      BM25_B_DEFAULT,
      BM25_B_MIN,
      BM25_B_MAX,
    ),
    /**
     * How many candidates the BM25 ranker rescores per query.
     *
     * BM25 is a scoring function, not an index: the GIN index finds candidates
     * and this bounds how many of them get scored. Cost is linear in the cap
     * (~0.03 ms per candidate measured on a 60k-chunk corpus), so this trades
     * latency against fidelity. Uncapped, the ranking is exactly BM25; capped,
     * a query matching more chunks than the cap can only reorder what
     * `ts_rank` surfaced first. 2000 keeps the rescoring near 60 ms while
     * covering all but pathologically broad queries.
     *
     * It bounds the rescoring only. Choosing the candidates still ranks every
     * matching chunk with `ts_rank`, which the GIN index cannot do for us, so
     * a query whose terms match a large fraction of the corpus stays expensive
     * however low this is set — the per-statement search timeout is what
     * bounds that half.
     */
    bm25RecallCap: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_BM25_RECALL_CAP,
      2_000,
      10,
      100_000,
    ),
    /**
     * Statement timeout for one statistics rebuild.
     *
     * Deliberately far above the pool default: the rebuild is a full,
     * read-only corpus scan on a timer, not a request, and a rebuild killed by
     * the request-path timeout would leave keyword search on the `ts_rank`
     * fallback indefinitely — it never gets further on the next attempt.
     */
    bm25StatsRefreshTimeoutMillis: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_TIMEOUT_MS,
      15 * 60 * 1_000,
      30_000,
      6 * 60 * 60 * 1_000,
    ),
    /**
     * How often the BM25 corpus statistics are rebuilt.
     *
     * The statistics are a derived cache and may lag the corpus: stale values
     * perturb scores slightly rather than making them wrong (measured: 20%
     * corpus growth without a refresh left 99.2% of top-10 results unchanged),
     * which is why nothing maintains them on the ingestion hot path. The
     * refresh is a full read-only scan, so its cost scales with the corpus.
     */
    bm25StatsRefreshIntervalSeconds: parseClampedInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_INTERVAL_SECONDS,
      3_600,
      60,
      86_400,
    ),
    // Liveness lease for connector sync runs. The owning worker renews the
    // lease every `heartbeatInterval`; a run whose lease is not renewed within
    // `leaseTtl` is treated as orphaned and reclaimed. TTL must be several times
    // the heartbeat interval so a missed beat (GC pause, slow batch) doesn't
    // falsely expire a live run.
    connectorRunLeaseTtlSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_LEASE_TTL_SECONDS,
      300,
    ),
    connectorRunHeartbeatIntervalSeconds: parsePositiveInt(
      process.env
        .ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_HEARTBEAT_INTERVAL_SECONDS,
      90,
    ),
    // Max wall-clock time a single sync run works before it checkpoints and
    // yields; a continuation then resumes from that checkpoint. This bounds how
    // long one run holds a worker and chunks large syncs into resumable pieces.
    // A run stops at ~90% of this, so 3300s (55m) yields ~49m of work per run.
    // Liveness is enforced by the lease/heartbeat, not by this budget. (Retains
    // the older env var name so existing custom configs keep working.)
    connectorSyncMaxDurationSeconds: parseConnectorSyncMaxDuration(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS,
    ),
    /**
     * Development override for where the Archestra VAF Add On install script
     * gets the add-on from. Set to a git ref of archestra-ai/archestra (a
     * pushed commit SHA, branch, or tag) to have the script compile the
     * add-on from that source instead of downloading a release package, or
     * to the special value `local` to use this backend checkout's HEAD
     * commit. Unset (the default, and the right value for production), the
     * script downloads the package of the release matching this platform
     * version, falling back to the latest release.
     */
    mfilesVafAddOnSourceRef:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF?.trim() ||
      null,
    /**
     * GitHub token used to download the source ref's CI-built add-on package
     * (GitHub requires authentication for Actions artifact downloads even on
     * public repositories). Only read when the source-ref override above is
     * set; without it the install script compiles the add-on from source
     * instead. Never sent to clients — the backend proxies the package.
     */
    mfilesVafAddOnGithubToken:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_GITHUB_TOKEN?.trim() ||
      null,
    // A document still `pending`/`processing` this long after its last touch has
    // no live `batch_embedding` task behind it: a task exhausts its 5 retries in
    // ~8 min (30s * 2^(attempt-1) backoff), so past that it is stalled and the
    // recovery sweep re-enqueues it. Kept comfortably above that ~8 min span (not
    // at it) so a slow-but-live embedding batch is never reset out from under its
    // worker, which would double-embed and waste embedding-API cost.
    stalledEmbeddingAgeSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_STALLED_EMBEDDING_AGE_SECONDS,
      15 * 60,
    ),
    /**
     * Google OAuth client backing the Google Drive connector's individual
     * ("connect my own Drive") auth mode. Deployment-level rather than
     * per-connector because the redirect URI has to be registered against one
     * client in the Google Cloud Console anyway — so every Drive connector on
     * this deployment authorizes through the same client, and whoever connects
     * only has to click a button.
     *
     * Either one unset ⇒ the mode is unavailable, and the UI names the
     * variables to set rather than failing at connect time. The
     * service-account modes do not use this and are unaffected.
     *
     * Only the client id is stored per connector (next to the refresh token,
     * so a client swap is detectable); the secret is read from here on every
     * refresh, so rotating just the secret needs no reconnect.
     */
    googleDriveOAuth: {
      clientId:
        process.env.ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID?.trim() ||
        undefined,
      clientSecret:
        process.env.ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?.trim() ||
        undefined,
    },
  },
  secretsManager: {
    type: process.env.ARCHESTRA_SECRETS_MANAGER?.toUpperCase() || "DB",
    vaultKvVersion: process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION || "2",
    /**
     * Secret from which the AES key that encrypts DB-stored secrets is derived.
     * Split out from the session-signing secret so the two rotate
     * independently; falls back to the legacy combined ARCHESTRA_AUTH_SECRET so
     * existing deployments are unchanged until they opt into the split.
     */
    encryptionSecret:
      process.env.ARCHESTRA_SECRETS_ENCRYPTION_SECRET?.trim() ||
      process.env.ARCHESTRA_AUTH_SECRET,
    /**
     * Previous encryption secret — used ONLY by the re-encryption migration to
     * decrypt rows written under the prior key. Falls back to
     * ARCHESTRA_AUTH_SECRET (the combined secret in use before the split).
     */
    encryptionSecretPrevious:
      process.env.ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS?.trim() ||
      process.env.ARCHESTRA_AUTH_SECRET,
    /**
     * One-boot escape hatch for a deliberate encryption-secret rotation:
     * lets startup accept an encryption key that cannot decrypt previously
     * stored secrets instead of aborting.
     */
    acceptNewEncryptionKey:
      process.env.ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY === "true",
  },
  /**
   * Enterprise content-encryption-at-rest for interactions and chat messages
   * (content-encryption/). Both secrets are operator-supplied with NO
   * fallback: an unset current secret means the feature is off for writes,
   * deliberately unlike the secrets-manager key. `secretPrevious` is an
   * additional decrypt-only key — it makes enabling and rotating safe across
   * rolling deployments (distribute a key to every replica as decrypt-capable
   * first, then activate it for writes) and lets the backfill re-encrypt
   * rotated rows.
   */
  contentEncryption: {
    secret:
      process.env.ARCHESTRA_CONTENT_ENCRYPTION_SECRET?.trim() || undefined,
    secretPrevious:
      process.env.ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS?.trim() ||
      undefined,
  },
  /**
   * Locked chats: per-conversation encryption under a browser-held key.
   * Configuring `escrowPublicKey` is the whole switch — the feature is off
   * until one is set, and unsetting it turns the feature off again.
   */
  lockedChat: {
    /**
     * The PEM (or base64-of-PEM) RSA public key conversation keys are escrowed
     * to for break-glass recovery; the private half stays offline with the
     * customer's security team. Setting it enables locked chats; an
     * unparseable or undersized key fails startup (see
     * verifyLockedChatConfig).
     */
    escrowPublicKey:
      process.env.ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY?.trim() ||
      // Former name, still honored so an existing deployment does not silently
      // lose the feature between the config rollout and the image rollout.
      process.env.ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY?.trim() ||
      undefined,
  },
  test: {
    enableE2eTestEndpoints: process.env.ENABLE_E2E_TEST_ENDPOINTS === "true",
    enableTestMcpServer: process.env.ENABLE_TEST_MCP_SERVER === "true",
    testValue: process.env.TEST_VALUE ?? null,
  },
  authRateLimitDisabled:
    process.env.ARCHESTRA_AUTH_RATE_LIMIT_DISABLED === "true",
  isQuickstart: process.env.ARCHESTRA_QUICKSTART === "true",
  /**
   * ARCHESTRA_BETA master switch (the same flag betaFeatureEnabled() falls back
   * to). Surfaced to the frontend via /api/config so beta-gated UI — e.g. making
   * the new connection page the default Connect destination — can key off it.
   */
  beta: process.env.ARCHESTRA_BETA === "true",
  ngrok: {
    // When set, the backend brings up an ngrok tunnel in-process (via the ngrok
    // agent SDK) so the instance is reachable from the Internet for inbound
    // chatops webhooks (MS Teams, Slack).
    authToken: process.env.ARCHESTRA_NGROK_AUTH_TOKEN || "",
    // Optional reserved domain for a stable public URL across restarts. Without
    // it ngrok assigns an ephemeral domain that rotates on each restart.
    domain: process.env.ARCHESTRA_NGROK_DOMAIN || "",
  },
  chatops: {
    // The Telegram integration is generally available: on by default, with
    // ARCHESTRA_CHATOPS_TELEGRAM_ENABLED=false as the operator opt-out.
    // Off = the provider never starts (even with a token saved in the DB),
    // the config endpoint rejects updates, and the frontend hides the
    // Telegram messaging channel.
    telegramEnabled: process.env.ARCHESTRA_CHATOPS_TELEGRAM_ENABLED !== "false",
    // Signup welcome for auto-provisioned chatops users: on by default, with
    // ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false as the operator opt-out
    // for deployments whose chatops users don't get web app access — the
    // "finish signing up to use the web app" DM/link is just noise there.
    // Off = users are still auto-provisioned, but no welcome message is ever
    // sent. See resolveSignupWelcomeMode for how the welcome adapts to SSO
    // and disabled invitations/basic sign-in when this is on.
    signupWelcomeEnabled:
      process.env.ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED !== "false",
    // Per-process cap on concurrent chatops file downloads + image shrinking.
    // Chatops events are acked to the provider before processing, so an OOM
    // during a burst of attachment-heavy messages means silent message loss —
    // this bounds the transient memory (JS buffer + native copy + decode
    // alloc) a burst can hold. 4 matches libuv's default threadpool, which
    // already serializes the native image decodes. Currently gates Slack only:
    // MS Teams has no image-shrink path and enforces a flat 10 MB per-file cap.
    maxConcurrentFileTransfers: parsePositiveInt(
      process.env.ARCHESTRA_CHATOPS_MAX_CONCURRENT_FILE_TRANSFERS,
      4,
    ),
  },
  processType: parseProcessType(process.env.ARCHESTRA_PROCESS_TYPE),
  maintenanceMode: process.env.ARCHESTRA_MAINTENANCE_MODE_MESSAGE || null,
  // Instance-wide banner (markdown) shown at the top of the UI. Unlike
  // maintenanceMode it does not affect request handling.
  siteNotificationMessage:
    process.env.ARCHESTRA_SITE_NOTIFICATION_MESSAGE || null,
  // Enterprise-licensed like the `retention` block below — the boot-time
  // assertion in data-retention/license-gate.ee.ts covers this window too.
  auditLog: {
    retentionDays: parseRetentionDays(
      "ARCHESTRA_AUDIT_LOG_RETENTION_DAYS",
      process.env.ARCHESTRA_AUDIT_LOG_RETENTION_DAYS,
    ),
  },
  // Data-retention windows for content-bearing tables. All default to 0
  // (disabled). Enterprise-licensed — the boot-time assertion in
  // data-retention/license-gate.ee.ts fails startup when any of these is set
  // without an active enterprise license.
  retention: {
    llmLogsDays: parseRetentionDays(
      "ARCHESTRA_LLM_LOGS_RETENTION_DAYS",
      process.env.ARCHESTRA_LLM_LOGS_RETENTION_DAYS,
    ),
    mcpLogsDays: parseRetentionDays(
      "ARCHESTRA_MCP_LOGS_RETENTION_DAYS",
      process.env.ARCHESTRA_MCP_LOGS_RETENTION_DAYS,
    ),
    chatConversationsDays: parseRetentionDays(
      "ARCHESTRA_CHAT_CONVERSATIONS_RETENTION_DAYS",
      process.env.ARCHESTRA_CHAT_CONVERSATIONS_RETENTION_DAYS,
    ),
  },
};

// "all" runs the web server and the worker in one process; "web"/"worker" run
// exactly one. "renderer" is neither — it runs only the isolated app-recording
// video render service (see startRenderer), so a multi-replica web tier can
// offload rendering to a single stable pod that owns every in-memory job.
export const shouldRunWebServer =
  config.processType === "web" || config.processType === "all";
export const shouldRunWorker =
  config.processType === "worker" || config.processType === "all";
export const shouldRunRenderer = config.processType === "renderer";

export default config;

// ===== Internal helpers =====

/**
 * Get the environment variable API key for a provider.
 * Centralizes the config.chat[provider].apiKey lookup to avoid duplication.
 */
export function getProviderEnvApiKey(
  provider: SupportedProvider,
): string | undefined {
  const entry = config.chat[provider as keyof typeof config.chat];
  if (typeof entry === "object" && entry !== null && "apiKey" in entry) {
    return entry.apiKey || undefined;
  }
  return undefined;
}

/**
 * Get the configured base URL for a provider, normalized to undefined when empty.
 * Centralizes the config.llm[provider].baseUrl lookup; mirrors getProviderEnvApiKey.
 */
export function getProviderConfiguredBaseUrl(
  provider: SupportedProvider,
): string | undefined {
  const entry = config.llm[provider as keyof typeof config.llm];
  if (typeof entry === "object" && entry !== null && "baseUrl" in entry) {
    const baseUrl = entry.baseUrl?.trim();
    return baseUrl || undefined;
  }
  return undefined;
}
