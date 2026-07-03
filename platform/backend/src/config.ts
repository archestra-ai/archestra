import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
  DEFAULT_APP_NAME,
  DEFAULT_MODELS,
  DEFAULT_VAULT_TOKEN,
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

type ProcessType = "web" | "worker" | "all";
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

const frontendBaseUrl =
  process.env.ARCHESTRA_FRONTEND_URL?.trim() || "http://localhost:3000";
const DEFAULT_POSTHOG_KEY = "phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7";
const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * Determines OTLP authentication headers based on environment variables
 * Returns undefined if authentication is not properly configured
 * @public — exported for testability
 */
export const getOtlpAuthHeaders = (): Record<string, string> | undefined => {
  const username =
    process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME?.trim();
  const password =
    process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD?.trim();
  const bearer = process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER?.trim();

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
        "OTEL authentication misconfigured: both ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME and ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD must be provided for basic auth",
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

// 70MB body limit: accommodates the 50MB user-facing file cap with
// headroom for base64 encoding overhead (~33%) on chat attachment uploads.
const DEFAULT_BODY_LIMIT = 70 * 1024 * 1024;

const DEFAULT_DATABASE_POOL_MAX = 50;
const MAX_DATABASE_POOL_MAX = 500;

// Upper bound applied to every agent turn's output-token budget. Defaults high
// enough to unblock large tool-call payloads while capping cost; the real
// per-model output ceiling still applies when it is lower.
const DEFAULT_CHAT_MAX_OUTPUT_TOKENS = 32_768;
const MAX_CHAT_MAX_OUTPUT_TOKENS = 1_000_000;

// Per-connection statement timeout (ms). Defense-in-depth: kills runaway
// queries instead of letting them hang a connection indefinitely. 0 disables.
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MILLIS = 30000;

// Default OTEL OTLP endpoint for HTTP/Protobuf (4318). For gRPC, the typical port is 4317.
const DEFAULT_OTEL_ENDPOINT = "http://localhost:4318";
const DEFAULT_OTEL_CONTENT_MAX_LENGTH = 10_000; // 10KB
const DEFAULT_METRICS_PORT = 9050;
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;
const OTEL_TRACES_PATH = "/v1/traces";
const OTEL_LOGS_PATH = "/v1/logs";

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
): number => {
  const value = envValue?.trim();
  if (!value) {
    return DEFAULT_CHAT_MAX_OUTPUT_TOKENS;
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
      `Invalid ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS value "${value}", using default ${DEFAULT_CHAT_MAX_OUTPUT_TOKENS}`,
    );
    return DEFAULT_CHAT_MAX_OUTPUT_TOKENS;
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
 * origin plus every URL in `ARCHESTRA_API_BASE_URL` (the same list the
 * frontend's connection page derives its endpoint candidates from). Returned
 * unparsed; callers normalize and compare full URLs, not just hosts.
 * @public — exported for testability
 */
export const getConnectionBaseUrlSources = (): string[] => {
  const sources = [frontendBaseUrl];
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
 * source, so it must be the public origin: `ARCHESTRA_API_BASE_URL` is an
 * internal-first list (e.g. `http://archestra.default.svc:9000,https://api…`),
 * so a public `https://` entry is preferred over a cluster-internal one. Each
 * candidate is parsed to its `URL.origin` (dropping any path and normalizing),
 * falling back to the local API origin. Never derived from request headers —
 * those are spoofable (see request-origin.ts).
 * @public — consumed by the owned-app SDK injection
 */
export const getAppAssetBaseOrigin = (): string => {
  const localFallback = `http://127.0.0.1:${getPortFromUrl()}`;
  const entries =
    process.env.ARCHESTRA_API_BASE_URL?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  const candidates = [
    ...entries.filter((entry) => entry.startsWith("https://")),
    ...entries,
    localFallback,
  ];
  for (const candidate of candidates) {
    try {
      return new URL(candidate).origin;
    } catch {
      // skip a malformed entry and try the next candidate
    }
  }
  return new URL(localFallback).origin;
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

/** @public — exported for testability */
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
  if (normalized === "web" || normalized === "worker") return normalized;
  return "all";
}

/**
 * Parse ARCHESTRA_AUDIT_LOG_RETENTION_DAYS into a non-negative integer.
 * Default is 0 (retention disabled — audit rows are never auto-deleted).
 * Org admins opt in by setting a positive number of days.
 * @public — exported for testability
 */
export const parseAuditLogRetentionDays = (
  envValue: string | undefined,
): number => {
  const DEFAULT_RETENTION_DAYS = 0;
  const value = envValue?.trim();
  if (!value) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.warn(
      `Invalid ARCHESTRA_AUDIT_LOG_RETENTION_DAYS value "${value}", using default ${DEFAULT_RETENTION_DAYS} (disabled)`,
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
};

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
 * resolves the Dagger runner host. A misconfigured host returns `undefined`
 * (and logs) rather than throwing — config is built at module import, so a
 * throw here would crash the whole backend over one optional feature.
 *
 * @public — exported for testability
 */
export const parseCodeRuntimeDaggerRunnerHost = ({
  enabled,
  envValue,
}: {
  enabled: boolean;
  envValue: string | undefined;
}): string | undefined => {
  const runnerHost = envValue?.trim();
  if (!enabled) return runnerHost || undefined;

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

// the code execution sandbox (run_command / upload_file / download_file, plus
// skill activation-mounts) needs a Dagger runner host: it runs when a host is
// configured and stays off otherwise — presence of the host is the switch. it
// is independent of the skills *read* feature — skills can be listed/activated/
// read with the sandbox off.
const skillsSandboxDaggerRunnerHost = parseCodeRuntimeDaggerRunnerHost({
  enabled: true,
  envValue: process.env.ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST,
});
const skillsSandboxEnabled = skillsSandboxDaggerRunnerHost !== undefined;

// the Dagger runtime fronts the sandbox; enabling the sandbox lights up the
// shared session + warm base.
const daggerRuntimeRunnerHost = skillsSandboxDaggerRunnerHost;
const daggerRuntimeEnabled =
  skillsSandboxEnabled && daggerRuntimeRunnerHost !== undefined;

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
  },
  websocket: {
    path: "/ws",
  },
  mcpGateway: {
    endpoint: "/v1/mcp",
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
  git: {
    binaryPath: process.env.ARCHESTRA_GIT_BINARY_PATH?.trim() || "git",
  },
  a2aGateway: {
    endpoint: "/v1/a2a",
  },
  a2aV2Gateway: {
    endpoint: "/v2/a2a",
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
    secret: process.env.ARCHESTRA_AUTH_SECRET,
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
     * OAuth Dynamic Client Registration (DCR, RFC 7591) and CIMD auto-registration.
     * Enabled by default. Set ARCHESTRA_AUTH_DCR_ENABLED=false to allow only
     * pre-registered OAuth clients (e.g. manually registered MCP OAuth clients) to
     * run OAuth flows — runtime self-registration is then rejected. Instance-level
     * because unauthenticated DCR has no org to scope a per-org toggle to.
     */
    dynamicClientRegistrationEnabled:
      process.env.ARCHESTRA_AUTH_DCR_ENABLED !== "false",
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
  llm: {
    openai: {
      baseUrl:
        process.env.ARCHESTRA_OPENAI_BASE_URL || "https://api.openai.com/v1",
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
    },
    vllm: {
      enabled: Boolean(process.env.ARCHESTRA_VLLM_BASE_URL),
      baseUrl: process.env.ARCHESTRA_VLLM_BASE_URL,
    },
    ollama: {
      enabled: Boolean(
        process.env.ARCHESTRA_OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      ),
      baseUrl:
        process.env.ARCHESTRA_OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
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
    cohere: {
      apiKey: process.env.ARCHESTRA_CHAT_COHERE_API_KEY || "",
    },
    zhipuai: {
      apiKey: process.env.ARCHESTRA_CHAT_ZHIPUAI_API_KEY || "",
    },
    deepseek: {
      apiKey: process.env.ARCHESTRA_CHAT_DEEPSEEK_API_KEY || "",
    },
    "github-copilot": {
      apiKey: process.env.ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY || "",
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
      stopPollIntervalMs: parseActiveChatRunPollIntervalMs({
        value: process.env.ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS,
        defaultValue:
          process.env
            .ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED === "true"
            ? 500
            : 30_000,
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
  },
  enterpriseFeatures: {
    core: process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
    knowledgeBase:
      process.env.ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED ===
      "true",
    fullWhiteLabeling:
      process.env.ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING === "true",
  },
  /**
   * Codegen mode is set when running `pnpm codegen` via turbo.
   * This ensures enterprise routes are always included in generated API specs,
   * regardless of whether the enterprise license is activated locally.
   */
  codegenMode: process.env.CODEGEN === "true",
  orchestrator: {
    mcpServerBaseImage,
    kubernetes: {
      namespace: process.env.ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE || "default",
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
   * gated by `ARCHESTRA_CODE_RUNTIME_ENABLED` + a Dagger runner host.
   */
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
    artifactBytesLimit: parsePositiveInt(
      process.env.ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT,
      16 * 1024 * 1024,
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
   * unified Dagger runtime — one shared session with a pre-warmed base
   * container that hosts the code execution sandbox commands. The Rust crate
   * (`@archestra/sandbox-rs`) owns the session; this block only carries
   * enable + connection knobs.
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
    defaults: {
      outputBytesLimit: parsePositiveInt(
        process.env.ARCHESTRA_DAGGER_RUNTIME_OUTPUT_BYTES_LIMIT,
        256 * 1024,
      ),
      fileSizeLimitBytes: parsePositiveInt(
        process.env.ARCHESTRA_DAGGER_RUNTIME_FILE_SIZE_LIMIT_BYTES,
        16 * 1024 * 1024,
      ),
      cpuSeconds: parsePositiveInt(
        process.env.ARCHESTRA_DAGGER_RUNTIME_CPU_SECONDS,
        30,
      ),
      memoryBytes: parsePositiveInt(
        process.env.ARCHESTRA_DAGGER_RUNTIME_MEMORY_BYTES,
        1024 * 1024 * 1024,
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
      captureContent: process.env.ARCHESTRA_OTEL_CAPTURE_CONTENT !== "false",
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
    metrics: {
      endpoint: "/metrics",
      port: parseMetricsPort(process.env.ARCHESTRA_METRICS_PORT),
      secret: process.env.ARCHESTRA_METRICS_SECRET,
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
    hybridSearchEnabled:
      process.env.ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED !== "false",
    connectorSyncMaxDurationSeconds: parseConnectorSyncMaxDuration(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS,
    ),
    taskWorkerPollIntervalSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_POLL_INTERVAL_SECONDS,
      5,
    ),
    taskWorkerMaxConcurrent: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT,
      2,
    ),
    taskWorkerShutdownTimeoutSeconds: parsePositiveInt(
      process.env.ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS,
      30,
    ),
  },
  secretsManager: {
    type: process.env.ARCHESTRA_SECRETS_MANAGER?.toUpperCase() || "DB",
    vaultKvVersion: process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION || "2",
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
  auditLog: {
    retentionDays: parseAuditLogRetentionDays(
      process.env.ARCHESTRA_AUDIT_LOG_RETENTION_DAYS,
    ),
  },
};

export const shouldRunWebServer = config.processType !== "worker";
export const shouldRunWorker = config.processType !== "web";

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
