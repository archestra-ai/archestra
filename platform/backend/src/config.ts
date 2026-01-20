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
 * Parse additional trusted origins from environment variable.
 * Used to add extra trusted origins beyond the frontend URL (e.g., external IdPs for SSO).
 *
 * Format: Comma-separated list of origins (e.g., "http://idp.example.com:8080,https://auth.example.com")
 * Whitespace around each origin is trimmed.
 *
 * @returns Array of additional trusted origins
 */
export const getAdditionalTrustedOrigins = (): string[] => {
  const envValue =
    process.env.ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS?.trim();

  if (!envValue) {
    return [];
  }

  return envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
};

/**
 * Get trusted origins for better-auth.
 * Returns wildcard patterns for localhost (development) or specific origins for production.
 * Also includes any additional trusted origins from ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS.
 */
export const getTrustedOrigins = (): string[] => {
  const origins = parseAllowedOrigins();
  const additionalOrigins = getAdditionalTrustedOrigins();

  // Default: allow localhost wildcards for development
  if (origins.length === 0) {
    return [
      "http://localhost:*",
      "https://localhost:*",
      "http://127.0.0.1:*",
      "https://127.0.0.1:*",
      ...additionalOrigins,
    ];
  }

  // Production: use configured origins plus additional origins
  return [...origins, ...additionalOrigins];
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

export default {
  frontendBaseUrl,
  api: {
    host: "0.0.0.0",
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
      appPassword: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_APP_PASSWORD || "",
      // Optional: Set for single-tenant Azure Bot (leave empty for multi-tenant)
      tenantId: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID || "",
      graph: {
        tenantId: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID || "",
        clientId: process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID || "",
        clientSecret:
          process.env.ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET || "",
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
      useV2Routes: process.env.ARCHESTRA_OPENAI_USE_V2_ROUTES !== "false",
    },
    anthropic: {
      baseUrl:
        process.env.ARCHESTRA_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      useV2Routes: process.env.ARCHESTRA_ANTHROPIC_USE_V2_ROUTES !== "false",
    },
    gemini: {
      baseUrl:
        process.env.ARCHESTRA_GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
      useV2Routes: process.env.ARCHESTRA_GEMINI_USE_V2_ROUTES !== "false",
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
    cerebras: {
      baseUrl:
        process.env.ARCHESTRA_CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
      useV2Routes: process.env.ARCHESTRA_CEREBRAS_USE_V2_ROUTES !== "false",
    },
    vllm: {
      enabled: Boolean(process.env.ARCHESTRA_VLLM_BASE_URL),
      baseUrl: process.env.ARCHESTRA_VLLM_BASE_URL,
      useV2Routes: process.env.ARCHESTRA_VLLM_USE_V2_ROUTES !== "false",
    },
    ollama: {
      enabled: Boolean(process.env.ARCHESTRA_OLLAMA_BASE_URL),
      baseUrl: process.env.ARCHESTRA_OLLAMA_BASE_URL,
      useV2Routes: process.env.ARCHESTRA_OLLAMA_USE_V2_ROUTES !== "false",
    },
    zhipuai: {
      baseUrl:
        process.env.ARCHESTRA_ZHIPUAI_BASE_URL ||
        "https://api.z.ai/api/paas/v4",
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
      baseUrl:
        process.env.ARCHESTRA_CHAT_CEREBRAS_BASE_URL ||
        "https://api.cerebras.ai/v1",
    },
    vllm: {
      apiKey: process.env.ARCHESTRA_CHAT_VLLM_API_KEY || "",
    },
    ollama: {
      apiKey: process.env.ARCHESTRA_CHAT_OLLAMA_API_KEY || "",
    },
    zhipuai: {
      apiKey: process.env.ARCHESTRA_CHAT_ZHIPUAI_API_KEY || "",
      baseUrl:
        process.env.ARCHESTRA_CHAT_ZHIPUAI_BASE_URL ||
        "https://api.z.ai/api/paas/v4",
    },
    mcp: {
      remoteServerUrl: process.env.ARCHESTRA_CHAT_MCP_SERVER_URL || "",
      remoteServerHeaders: process.env.ARCHESTRA_CHAT_MCP_SERVER_HEADERS
        ? JSON.parse(process.env.ARCHESTRA_CHAT_MCP_SERVER_HEADERS)
        : undefined,
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
    browserStreamingEnabled:
      process.env.FEATURES_BROWSER_STREAMING_ENABLED === "true",
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
