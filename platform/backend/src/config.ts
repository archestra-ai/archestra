import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OTLPExporterNodeConfigBase } from "@opentelemetry/otlp-exporter-base";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
  DEFAULT_VAULT_TOKEN,
} from "@shared";
import dotenv from "dotenv";
import logger from "@/logging";
import packageJson from "../../package.json";

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

const frontendBaseUrl =
  process.env.ARCHESTRA_FRONTEND_URL?.trim() || "http://localhost:3000";

/**
 * Determines OTLP authentication headers based on environment variables
 * Returns undefined if authentication is not properly configured
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
 * Parse port from ARCHESTRA_API_BASE_URL if provided
 */
const getPortFromUrl = (): number => {
  const url = process.env.ARCHESTRA_API_BASE_URL;
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

const parseAllowedOrigins = (): string[] => {
  // Development: use empty array to signal "use defaults" (localhost regex)
  if (isDevelopment) {
    return [];
  }

  // ARCHESTRA_FRONTEND_URL if set
  const frontendUrl = process.env.ARCHESTRA_FRONTEND_URL?.trim();
  if (frontendUrl && frontendUrl !== "") {
    return [frontendUrl];
  }

  return [];
};

/**
 * Get CORS origin configuration for Fastify.
 * Returns RegExp for localhost (development) or string[] for specific origins.
 */
const getCorsOrigins = (): RegExp | boolean | string[] => {
  const origins = parseAllowedOrigins();

  // Default: allow localhost on any port for development
  if (origins.length === 0) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  }

  return origins;
};

/**
 * Get trusted origins for better-auth.
 * Returns wildcard patterns for localhost (development) or specific origins for production.
 */
export const getTrustedOrigins = (): string[] => {
  const origins = parseAllowedOrigins();

  // Default: allow localhost wildcards for development
  if (origins.length === 0) {
    return [
      "http://localhost:*",
      "https://localhost:*",
      "http://127.0.0.1:*",
      "https://127.0.0.1:*",
    ];
  }

  // Production: use configured origins
  return origins;
};

/**
 * Parse additional trusted SSO provider IDs from environment variable.
 * These will be appended to the default SSO_TRUSTED_PROVIDER_IDS from @shared.
 *
 * Format: Comma-separated list of provider IDs (e.g., "okta,auth0,custom-provider")
 * Whitespace around each provider ID is trimmed.
 *
 * @returns Array of additional trusted SSO provider IDs
 */
export const getAdditionalTrustedSsoProviderIds = (): string[] => {
  const envValue = process.env.ARCHESTRA_AUTH_TRUSTED_SSO_PROVIDER_IDS?.trim();

  if (!envValue) {
    return [];
  }

  return envValue
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
};

export default {
  frontendBaseUrl,
  api: {
    host: "0.0.0.0",
    port: getPortFromUrl(),
    name: "Archestra Platform API",
    version: process.env.ARCHESTRA_VERSION || packageJson.version,
    corsOrigins: getCorsOrigins(),
    apiKeyAuthorizationHeaderName: "Authorization",
  },
  websocket: {
    path: "/ws",
  },
  mcpGateway: {
    endpoint: "/v1/mcp",
  },
  a2aGateway: {
    endpoint: "/v1/a2a",
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
    disableInvitations:
      process.env.ARCHESTRA_AUTH_DISABLE_INVITATIONS === "true",
    additionalTrustedSsoProviderIds: getAdditionalTrustedSsoProviderIds(),
  },
  database: {
    url: getDatabaseUrl(),
  },
  llm: {
    openai: {
      baseUrl:
        process.env.ARCHESTRA_OPENAI_BASE_URL || "https://api.openai.com/v1",
      useV2Routes: process.env.ARCHESTRA_OPENAI_USE_V2_ROUTES === "true",
    },
    anthropic: {
      baseUrl:
        process.env.ARCHESTRA_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      useV2Routes: process.env.ARCHESTRA_ANTHROPIC_USE_V2_ROUTES === "true",
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
  },
  chat: {
    openai: {
      apiKey: process.env.ARCHESTRA_CHAT_OPENAI_API_KEY || "",
      baseUrl:
        process.env.ARCHESTRA_CHAT_OPENAI_BASE_URL ||
        "https://api.openai.com/v1",
    },
    anthropic: {
      apiKey: process.env.ARCHESTRA_CHAT_ANTHROPIC_API_KEY || "",
      baseUrl:
        process.env.ARCHESTRA_CHAT_ANTHROPIC_BASE_URL ||
        "https://api.anthropic.com",
    },
    gemini: {
      apiKey: process.env.ARCHESTRA_CHAT_GEMINI_API_KEY || "",
      baseUrl:
        process.env.ARCHESTRA_CHAT_GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
    },
    mcp: {
      remoteServerUrl: process.env.ARCHESTRA_CHAT_MCP_SERVER_URL || "",
      remoteServerHeaders: process.env.ARCHESTRA_CHAT_MCP_SERVER_HEADERS
        ? JSON.parse(process.env.ARCHESTRA_CHAT_MCP_SERVER_HEADERS)
        : undefined,
    },
    defaultModel:
      process.env.ARCHESTRA_CHAT_DEFAULT_MODEL || "claude-opus-4-1-20250805",
  },
  features: {
    /**
     * NOTE: use this object to read in environment variables pertaining to "feature flagged" features.. Example:
     * mcp_registry: process.env.FEATURES_MCP_REGISTRY_ENABLED === "true",
     */
  },
  enterpriseLicenseActivated:
    process.env.ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED === "true",
  /**
   * Codegen mode is set when running `pnpm codegen` via turbo.
   * This ensures enterprise routes are always included in generated API specs,
   * regardless of whether the enterprise license is activated locally.
   */
  codegenMode: process.env.CODEGEN === "true",
  orchestrator: {
    mcpServerBaseImage:
      process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE ||
      "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3",
    kubernetes: {
      namespace: process.env.ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE || "default",
      kubeconfig: process.env.ARCHESTRA_ORCHESTRATOR_KUBECONFIG,
      loadKubeconfigFromCurrentCluster:
        process.env
          .ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER ===
        "true",
      mcpK8sServiceAccountName:
        process.env.ARCHESTRA_ORCHESTRATOR_MCP_K8S_SERVICE_ACCOUNT_NAME ||
        // Default value matches the mcp-k8s-operator service account name from the official helm chart
        "archestra-platform-mcp-k8s-operator",
    },
  },
  vault: {
    token: process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN || DEFAULT_VAULT_TOKEN,
  },
  observability: {
    otel: {
      traceExporter: {
        url:
          process.env.ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT ||
          "http://localhost:4318/v1/traces",
        headers: getOtlpAuthHeaders(),
      } satisfies Partial<OTLPExporterNodeConfigBase>,
    },
    metrics: {
      endpoint: "/metrics",
      port: 9050,
      secret: process.env.ARCHESTRA_METRICS_SECRET,
    },
    sentry: {
      enabled: sentryDsn !== "",
      dsn: sentryDsn,
      environment:
        process.env.ARCHESTRA_SENTRY_ENVIRONMENT?.toLowerCase() || environment,
    },
  },
  debug: isDevelopment,
  production: isProduction,
  environment,
  benchmark: {
    mockMode: process.env.BENCHMARK_MOCK_MODE === "true",
  },
  authRateLimitDisabled:
    process.env.ARCHESTRA_AUTH_RATE_LIMIT_DISABLED === "true",
};
