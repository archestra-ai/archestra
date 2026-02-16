import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OTLPExporterNodeConfigBase } from "@opentelemetry/otlp-exporter-base";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
  DEFAULT_VAULT_TOKEN,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import dotenv from "dotenv";
import logger from "@/logging";
import {
  type EmailProviderType,
  EmailProviderTypeSchema,
} from "@/types/email-provider-type";
import {
  type KnowledgeGraphProviderType,
  KnowledgeGraphProviderTypeSchema,
} from "@/types/knowledge-graph";
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
 *   - On the host, Docker's `-p 3000:3000` maps to 0.0.0.0 by default,
 *     making the app accessible from LAN IPs.
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
 */
export const getTrustedOrigins = (): string[] => {
  const origins = getConfiguredOrigins();

  if (origins.length === 0) {
    return ["http://*:*", "https://*:*", "http://*", "https://*"];
  }

  return addLoopbackEquivalents(origins);
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
 * Parse knowledge graph provider from environment variable
 */
const parseKnowledgeGraphProvider = ():
  | KnowledgeGraphProviderType
  | undefined => {
  const provider =
    process.env.ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER?.toLowerCase();
  const result = KnowledgeGraphProviderTypeSchema.safeParse(provider);
  return result.success ? result.data : undefined;
};

/**
 * Parse body limit from environment variable.
 * Supports numeric bytes (e.g., "52428800") or human-readable format (e.g., "50MB", "100KB").
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

const DEFAULT_BODY_LIMIT = 50 * 1024 * 1024; // 50MB

// Default OTEL OTLP endpoint for HTTP/Protobuf (4318). For gRPC, the typical port is 4317.
const DEFAULT_OTEL_ENDPOINT = "http://localhost:4318";
const OTEL_TRACES_PATH = "/v1/traces";

/**
 * Get OTEL exporter endpoint for traces.
 * Reads from ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT and intelligently ensures
 * the URL ends with /v1/traces.
 *
 * @param envValue - The environment variable value (for testing)
 * @returns The full OTEL endpoint URL with /v1/traces suffix
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

export default {
  frontendBaseUrl,
  api: {
    host: isDevelopment ? "127.0.0.1" : "0.0.0.0",
    port: getPortFromUrl(),
    name: "Archestra Platform API",
    version: process.env.ARCHESTRA_VERSION || packageJson.version,
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
  chatops: {
    msTeams: {
      enabled: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED === "true",
      appId: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID || "",
      appSecret: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET || "",
      // Optional: Set for single-tenant Azure Bot (leave empty for multi-tenant)
      tenantId: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID || "",
      // Graph API credentials for thread history (falls back to Bot credentials if not set)
      graph: {
        tenantId:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID ||
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID ||
          "",
        clientId:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID ||
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID ||
          "",
        clientSecret:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET ||
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET ||
          "",
      },
    },
  },
  knowledgeGraph: {
    provider: parseKnowledgeGraphProvider(),
    lightrag: {
      apiUrl: process.env.ARCHESTRA_KNOWLEDGE_GRAPH_LIGHTRAG_API_URL || "",
      apiKey: process.env.ARCHESTRA_KNOWLEDGE_GRAPH_LIGHTRAG_API_KEY,
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
    },
    anthropic: {
      baseUrl:
        process.env.ARCHESTRA_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
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
    bedrock: {
      enabled: Boolean(process.env.ARCHESTRA_BEDROCK_BASE_URL),
      baseUrl: process.env.ARCHESTRA_BEDROCK_BASE_URL || "",
      /** Prefix for cross-region inference profile models (e.g., "us." or "eu.") */
      inferenceProfilePrefix:
        process.env.ARCHESTRA_BEDROCK_INFERENCE_PROFILE_PREFIX || "",
    },
  },
  chat: {
    openai: {
      apiKey: process.env.ARCHESTRA_CHAT_OPENAI_API_KEY || "",
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
    bedrock: {
      apiKey: process.env.ARCHESTRA_CHAT_BEDROCK_API_KEY || "",
    },
    defaultModel:
      process.env.ARCHESTRA_CHAT_DEFAULT_MODEL || "claude-opus-4-1-20250805",
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
  },
  features: {
    /**
     * NOTE: use this object to read in environment variables pertaining to "feature flagged" features.. Example:
     * mcp_registry: process.env.FEATURES_MCP_REGISTRY_ENABLED === "true",
     */
    browserStreamingEnabled: true,
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
    // The MCP server base image version is automatically updated by release-please during releases.
    // See: https://github.com/googleapis/release-please/blob/main/docs/customizing.md#updating-arbitrary-files
    mcpServerBaseImage:
      process.env.ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE ||
      "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:1.0.44", // x-release-please-version
    kubernetes: {
      namespace: process.env.ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE || "default",
      kubeconfig: process.env.ARCHESTRA_ORCHESTRATOR_KUBECONFIG,
      loadKubeconfigFromCurrentCluster:
        process.env
          .ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER ===
        "true",
      k8sNodeHost:
        process.env.ARCHESTRA_ORCHESTRATOR_K8S_NODE_HOST || undefined,
    },
  },
  vault: {
    token: process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN || DEFAULT_VAULT_TOKEN,
  },
  observability: {
    otel: {
      traceExporter: {
        url: getOtelExporterOtlpEndpoint(),
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
  isQuickstart: process.env.ARCHESTRA_QUICKSTART === "true",
  ngrokDomain: process.env.ARCHESTRA_NGROK_DOMAIN || "",
};
