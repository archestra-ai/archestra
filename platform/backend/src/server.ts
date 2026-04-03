const isMainModule =
  process.argv[1]?.includes("server.mjs") ||
  process.argv[1]?.includes("server.ts") ||
  process.argv[1]?.endsWith("/server");

/**
 * Import sentry for error-tracking
 *
 * THEN import tracing to ensure auto-instrumentation works properly (must import sentry before tracing as
 * some of Sentry's auto-instrumentations rely on the sentry client being initialized)
 *
 * Only do this if the server is being run directly (not imported)
 */
if (isMainModule) {
  await import("./observability/sentry");
  await import("./observability/tracing/sdk");
}

import { readFileSync } from "node:fs";
import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import fastifySwagger from "@fastify/swagger";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import * as Sentry from "@sentry/node";
import Fastify from "fastify";
import metricsPlugin from "fastify-metrics";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import {
  cleanupEmailProvider,
  cleanupOldProcessedEmails,
  EMAIL_SUBSCRIPTION_RENEWAL_INTERVAL,
  initializeEmailProvider,
  PROCESSED_EMAIL_CLEANUP_INTERVAL_MS,
  renewEmailSubscriptionIfNeeded,
} from "@/agents/incoming-email";
import { fastifyAuthPlugin } from "@/auth";
import { cacheManager } from "@/cache-manager";
import config, { shouldRunWebServer, shouldRunWorker } from "@/config";
import { initializeDatabase, isDatabaseHealthy } from "@/database";
import { seedRequiredStartingData } from "@/database/seed";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import { enterpriseLicenseMiddleware } from "@/middleware";
import OrganizationModel from "@/models/organization";
import { initializeObservabilityMetrics } from "@/observability";
import { enrichOpenApiWithRbac } from "@/openapi/enrich-openapi-with-rbac";
import { systemKeyManager } from "@/services/system-key-manager";
import { taskQueueService } from "@/task-queue";
import { registerTaskHandlers } from "@/task-queue/handlers";
import {
  Anthropic,
  ApiError,
  Cerebras,
  Cohere,
  DeepSeek,
  Gemini,
  Groq,
  Minimax,
  Mistral,
  Ollama,
  OpenAi,
  Openrouter,
  Perplexity,
  Vllm,
  Xai,
  Zhipuai,
} from "@/types";
import websocketService from "@/websocket";
import * as routes from "./routes";
import {
  HEALTH_PATH,
  MCP_GATEWAY_PREFIX,
  READY_PATH,
} from "./routes/route-paths";

/** Max time to wait for cleanup operations during graceful shutdown before exiting */
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 3000;

// Load enterprise routes if license is activated OR if running in codegen mode
// (codegen mode ensures OpenAPI spec always includes all enterprise routes)
const eeRoutes =
  config.enterpriseFeatures.core || config.codegenMode
    ? // biome-ignore lint/style/noRestrictedImports: conditional schema
      await import("./routes/index.ee")
    : ({} as Record<string, never>);

const {
  api: {
    port,
    name,
    version,
    host,
    corsOrigins,
    apiKeyAuthorizationHeaderName,
  },
  test: { enableE2eTestEndpoints, testValue },
  observability,
} = config;

/**
 * Register schemas in global zod registry for OpenAPI generation.
 * This enables proper $ref generation in the OpenAPI spec.
 */
export function registerOpenApiSchemas() {
  z.globalRegistry.add(OpenAi.API.ChatCompletionRequestSchema, {
    id: "OpenAiChatCompletionRequest",
  });
  z.globalRegistry.add(OpenAi.API.ChatCompletionResponseSchema, {
    id: "OpenAiChatCompletionResponse",
  });
  z.globalRegistry.add(Gemini.API.GenerateContentRequestSchema, {
    id: "GeminiGenerateContentRequest",
  });
  z.globalRegistry.add(Gemini.API.GenerateContentResponseSchema, {
    id: "GeminiGenerateContentResponse",
  });
  z.globalRegistry.add(Anthropic.API.MessagesRequestSchema, {
    id: "AnthropicMessagesRequest",
  });
  z.globalRegistry.add(Anthropic.API.MessagesResponseSchema, {
    id: "AnthropicMessagesResponse",
  });
  z.globalRegistry.add(Cerebras.API.ChatCompletionRequestSchema, {
    id: "CerebrasChatCompletionRequest",
  });
  z.globalRegistry.add(Cerebras.API.ChatCompletionResponseSchema, {
    id: "CerebrasChatCompletionResponse",
  });
  z.globalRegistry.add(Cohere.API.ChatRequestSchema, {
    id: "CohereChatRequest",
  });
  z.globalRegistry.add(Cohere.API.ChatResponseSchema, {
    id: "CohereChatResponse",
  });
  z.globalRegistry.add(Mistral.API.ChatCompletionRequestSchema, {
    id: "MistralChatCompletionRequest",
  });
  z.globalRegistry.add(Mistral.API.ChatCompletionResponseSchema, {
    id: "MistralChatCompletionResponse",
  });
  z.globalRegistry.add(Perplexity.API.ChatCompletionRequestSchema, {
    id: "PerplexityChatCompletionRequest",
  });
  z.globalRegistry.add(Perplexity.API.ChatCompletionResponseSchema, {
    id: "PerplexityChatCompletionResponse",
  });
  z.globalRegistry.add(Groq.API.ChatCompletionRequestSchema, {
    id: "GroqChatCompletionRequest",
  });
  z.globalRegistry.add(Groq.API.ChatCompletionResponseSchema, {
    id: "GroqChatCompletionResponse",
  });
  z.globalRegistry.add(Openrouter.API.ChatCompletionRequestSchema, {
    id: "OpenrouterChatCompletionRequest",
  });
  z.globalRegistry.add(Openrouter.API.ChatCompletionResponseSchema, {
    id: "OpenrouterChatCompletionResponse",
  });
  z.globalRegistry.add(Vllm.API.ChatCompletionRequestSchema, {
    id: "VllmChatCompletionRequest",
  });
  z.globalRegistry.add(Vllm.API.ChatCompletionResponseSchema, {
    id: "VllmChatCompletionResponse",
  });
  z.globalRegistry.add(Ollama.API.ChatCompletionRequestSchema, {
    id: "OllamaChatCompletionRequest",
  });
  z.globalRegistry.add(Ollama.API.ChatCompletionResponseSchema, {
    id: "OllamaChatCompletionResponse",
  });
  z.globalRegistry.add(Zhipuai.API.ChatCompletionRequestSchema, {
    id: "ZhipuaiChatCompletionRequest",
  });
  z.globalRegistry.add(Zhipuai.API.ChatCompletionResponseSchema, {
    id: "ZhipuaiChatCompletionResponse",
  });
  z.globalRegistry.add(DeepSeek.API.ChatCompletionRequestSchema, {
    id: "DeepSeekChatCompletionRequest",
  });
  z.globalRegistry.add(DeepSeek.API.ChatCompletionResponseSchema, {
    id: "DeepSeekChatCompletionResponse",
  });
  z.globalRegistry.add(Minimax.API.ChatCompletionRequestSchema, {
    id: "MinimaxChatCompletionRequest",
  });
  z.globalRegistry.add(Minimax.API.ChatCompletionResponseSchema, {
    id: "MinimaxChatCompletionResponse",
  });
  z.globalRegistry.add(Xai.API.ChatCompletionRequestSchema, {
    id: "XaiChatCompletionRequest",
  });
  z.globalRegistry.add(Xai.API.ChatCompletionResponseSchema, {
    id: "XaiChatCompletionResponse",
  });
}

// Register schemas at module load time
registerOpenApiSchemas();

/** Type for the Fastify instance with Zod type provider */
export type FastifyInstanceWithZod = ReturnType<typeof createFastifyInstance>;

/**
 * Register the OpenAPI/Swagger plugin on a Fastify instance.
 * @param fastify - The Fastify instance to register the plugin on
 * @param options - Optional overrides for the OpenAPI spec (e.g., servers)
 */
export async function registerSwaggerPlugin(fastify: FastifyInstanceWithZod) {
  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: name,
        version,
      },
    },
    hideUntagged: true,
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
}

/**
 * Register all API routes on a Fastify instance.
 * @param fastify - The Fastify instance to register routes on
 */
export async function registerApiRoutes(fastify: FastifyInstanceWithZod) {
  for (const route of Object.values(routes)) {
    fastify.register(route);
  }
  for (const route of Object.values(eeRoutes)) {
    fastify.register(route);
  }
}

/**
 * Sets up logging and zod type provider + request validation & response serialization
 */
export const createFastifyInstance = () =>
  Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    trustProxy: config.api.trustProxy,
  })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    // https://fastify.dev/docs/latest/Reference/Server/#seterrorhandler
    .setErrorHandler<ApiError | Error>(function (error, _request, reply) {
      // Handle response serialization errors (when response doesn't match schema)
      if (isResponseSerializationError(error)) {
        const issues = error.cause?.issues ?? [];
        const validationErrors = issues.map((issue) => ({
          path: issue.path?.join("."),
          code: issue.code,
          message: issue.message,
        }));

        this.log.error(
          {
            statusCode: 500,
            method: error.method,
            url: error.url,
            validationErrors,
          },
          `Response serialization error on ${error.method} ${error.url}: ${JSON.stringify(validationErrors)}`,
        );

        // Explicitly capture in Sentry with full validation details
        Sentry.captureException(error, {
          extra: {
            method: error.method,
            url: error.url,
            validationErrors,
          },
          tags: {
            error_type: "response_serialization",
          },
        });

        return reply.status(500).send({
          error: {
            message: "Response doesn't match the schema",
            type: "api_internal_server_error",
          },
        });
      }

      // Handle Zod validation errors (from fastify-type-provider-zod)
      if (hasZodFastifySchemaValidationErrors(error)) {
        const message = error.message || "Validation error";
        this.log.info(
          { error: message, statusCode: 400 },
          "HTTP 400 validation error occurred",
        );

        return reply.status(400).send({
          error: {
            message,
            type: "api_validation_error",
          },
        });
      }

      // Handle ApiError objects
      if (error instanceof ApiError) {
        const { statusCode, message, type } = error;

        if (statusCode >= 500) {
          this.log.error(
            { error: message, statusCode },
            "HTTP 50x request error occurred",
          );
        } else if (statusCode >= 400) {
          this.log.info(
            { error: message, statusCode },
            "HTTP 40x request error occurred",
          );
        } else {
          this.log.error(
            { error: message, statusCode },
            "HTTP request error occurred",
          );
        }

        return reply.status(statusCode).send({
          error: {
            message,
            type,
          },
        });
      }

      // Handle standard Error objects
      const message = error.message || "Internal server error";
      const statusCode = 500;

      this.log.error(
        { error: message, statusCode },
        "HTTP 50x request error occurred",
      );

      return reply.status(statusCode).send({
        error: {
          message,
          type: "api_internal_server_error",
        },
      });
    });

/**
 * Helper function to register the metrics plugin on a fastify instance.
 *
 * Basically we need to ensure that we are only registering "default" and "route" metrics ONCE
 * If we instantiate a fastify instance and start duplicating the collection of metrics, we will
 * get a fatal error as such:
 *
 * Error: A metric with the name http_request_duration_seconds has already been registered.
 * at Registry.registerMetric (/app/node_modules/.pnpm/prom-client@15.1.3/node_modules/prom-client/lib/registry.js:103:10)
 */
const registerMetricsPlugin = async (
  fastify: ReturnType<typeof createFastifyInstance>,
  endpointEnabled: boolean,
): Promise<void> => {
  const metricsEnabled = !endpointEnabled;

  await fastify.register(metricsPlugin, {
    endpoint: endpointEnabled ? observability.metrics.endpoint : null,
    defaultMetrics: { enabled: metricsEnabled },
    routeMetrics: {
      enabled: metricsEnabled,
      methodBlacklist: ["OPTIONS", "HEAD"],
      routeBlacklist: [HEALTH_PATH, READY_PATH],
    },
  });
};

const addMetricsAuthenticationHook = (
  fastify: FastifyInstanceWithZod,
): void => {
  const { secret: metricsSecret } = observability.metrics;

  if (!metricsSecret) {
    return;
  }

  fastify.addHook("preHandler", async (request, reply) => {
    if (
      request.url === HEALTH_PATH ||
      request.url === READY_PATH ||
      request.url.startsWith(`${HEALTH_PATH}?`) ||
      request.url.startsWith(`${READY_PATH}?`)
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized: Bearer token required" });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== metricsSecret) {
      reply.code(401).send({ error: "Unauthorized: Invalid token" });
      return;
    }
  });
};

const registerStandaloneMetricsEndpoint = async (params: {
  fastify: FastifyInstanceWithZod;
  enableDefaultMetrics: boolean;
}): Promise<void> => {
  const { fastify, enableDefaultMetrics } = params;
  addMetricsAuthenticationHook(fastify);

  await fastify.register(metricsPlugin, {
    endpoint: observability.metrics.endpoint,
    defaultMetrics: { enabled: enableDefaultMetrics },
    routeMetrics: { enabled: false },
  });
};

/**
 * Create separate Fastify instance for metrics on a separate port
 *
 * This is to avoid exposing the metrics endpoint, by default, the metrics endpoint
 */
let metricsServerInstance: Awaited<
  ReturnType<typeof createFastifyInstance>
> | null = null;

const startMetricsServer = async () => {
  const metricsServer = createFastifyInstance();
  metricsServerInstance = metricsServer;

  metricsServer.get(HEALTH_PATH, () => ({ status: "ok" }));

  await registerStandaloneMetricsEndpoint({
    fastify: metricsServer,
    // The web process already registers default metrics on its main Fastify
    // instance. The dedicated metrics server must only expose that registry.
    enableDefaultMetrics: false,
  });

  // Start metrics server on dedicated port
  await metricsServer.listen({
    port: observability.metrics.port,
    host,
  });
  metricsServer.log.info(
    `Metrics server started on port ${observability.metrics.port}${
      observability.metrics.secret
        ? " (with authentication)"
        : " (no authentication)"
    }`,
  );
};

// ============ MCP Sandbox Server ============

/**
 * Allowlist-validate CSP domain entries.
 * Only permits valid hostnames and wildcard-subdomain patterns (e.g. *.example.com).
 * Blocks dangerous CSP sources like *, data:, blob:, https: that a denylist would miss.
 */
// Matches bare domains (esm.sh), wildcard subdomains (*.esm.sh),
// scheme-prefixed domains (https://esm.sh, wss://esm.sh), and optional port (:8443).
const VALID_CSP_DOMAIN =
  /^(wss?:\/\/|https?:\/\/)?(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+(:\d{1,5})?$/;

export function sanitizeCspDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return domains.filter(
    (d) => typeof d === "string" && VALID_CSP_DOMAIN.test(d),
  );
}

export function buildCspHeader(csp?: McpUiResourceCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
  const baseUriDomains =
    sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ];

  return directives.join("; ");
}

/**
 * Read and prepare the sandbox proxy HTML at startup.
 * Returns null if the file is not found (non-fatal — sandbox route won't be registered).
 */
const loadSandboxHtml = (): string | null => {
  const { filePath } = config.mcpSandbox;
  try {
    const rawHtml = readFileSync(filePath, "utf-8");
    // Inject allowed origins at startup (comes from env config, doesn't change at runtime).
    // The placeholder is replaced with a JSON array; empty array = allow any origin (dev/open mode).
    // Escape < and > to prevent </script> breakout when embedded in HTML.
    const safeJson = JSON.stringify(config.mcpSandbox.allowedOrigins)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");
    return rawHtml.replace("__ARCHESTRA_ALLOWED_ORIGINS__", safeJson);
  } catch (err) {
    logger.warn(
      { err, filePath },
      "MCP sandbox proxy HTML not found — /_sandbox/ route will not be registered",
    );
    return null;
  }
};

const sandboxHtml = loadSandboxHtml();

/**
 * Register the sandbox proxy route on the main Fastify instance.
 *
 * Serves the sandbox proxy HTML under /_sandbox/ with frame-ancestors header.
 * CSP for guest content is handled entirely by the proxy HTML (meta tag injection).
 * Isolation comes from cross-origin (localhost swap or domain) or opaque origin fallback.
 */
const registerSandboxRoute = (
  fastify: ReturnType<typeof createFastifyInstance>,
) => {
  if (!sandboxHtml) return;

  if (process.env.ARCHESTRA_MCP_SANDBOX_PORT) {
    logger.warn(
      "ARCHESTRA_MCP_SANDBOX_PORT is deprecated and no longer used. " +
        "The sandbox is now served from the main backend on /_sandbox/. " +
        "Remove this env var from your configuration.",
    );
  }

  fastify.get("/_sandbox/mcp-sandbox-proxy.html", async (request, reply) => {
    // When a sandbox domain is configured, validate the Host header matches
    // *.{domain} to prevent the sandbox route from being abused on the main origin.
    if (config.mcpSandbox.domain) {
      const host = request.hostname;
      if (!host.endsWith(`.${config.mcpSandbox.domain}`)) {
        return reply.status(403).send("Invalid sandbox host");
      }
    }

    // frame-ancestors restricts which origins can embed this sandbox iframe.
    // This is the only CSP directive set via HTTP header — it cannot be set via meta tag.
    // Guest content CSP is handled by the proxy HTML (meta tag injection from sandbox-resource-ready message).
    const frameAncestorsList = [...config.mcpSandbox.allowedOrigins];
    if (config.mcpSandbox.domain) {
      frameAncestorsList.push(`*.${config.mcpSandbox.domain}`);
    }
    const frameAncestors =
      frameAncestorsList.length > 0 ? frameAncestorsList.join(" ") : "*";
    void reply.header(
      "Content-Security-Policy",
      `frame-ancestors ${frameAncestors}`,
    );

    // Prevent caching to ensure fresh CSP on each load
    void reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
    void reply.header("Pragma", "no-cache");
    void reply.header("Expires", "0");

    void reply.type("text/html");
    return reply.send(sandboxHtml);
  });
};

const startMcpServerRuntime = async (
  fastify: ReturnType<typeof createFastifyInstance>,
) => {
  // Initialize MCP Server Runtime (K8s-based)
  if (McpServerRuntimeManager.isEnabled) {
    try {
      // Set up callbacks for runtime initialization
      McpServerRuntimeManager.onRuntimeStartupSuccess = () => {
        fastify.log.info("MCP Server Runtime initialized successfully");
      };

      McpServerRuntimeManager.onRuntimeStartupError = (error: Error) => {
        fastify.log.error(
          `MCP Server Runtime failed to initialize: ${error.message}`,
        );
        // Don't exit the process, allow the server to continue
        // MCP servers can be started manually later
      };

      // Start the runtime in the background (non-blocking)
      McpServerRuntimeManager.start().catch((error) => {
        fastify.log.error("Failed to start MCP Server Runtime:", error.message);
      });
    } catch (error) {
      fastify.log.error(
        `Failed to import MCP Server Runtime: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
      // Continue server startup even if MCP runtime fails
    }
  } else {
    fastify.log.info(
      "MCP Server Runtime is disabled as there is no K8s config available. Local MCP servers will not be available.",
    );
  }
};

const startWebServer = async () => {
  const fastify = createFastifyInstance();

  /**
   * Custom request logging hook that excludes noisy endpoints:
   * - /health: Kubernetes liveness probe
   * - /ready: Kubernetes readiness probe (checks database connectivity)
   * - GET /v1/mcp/*: MCP Gateway SSE polling (happens every second)
   */
  const shouldSkipRequestLogging = (url: string, method: string): boolean => {
    if (url === HEALTH_PATH || url === READY_PATH) return true;
    // Skip MCP Gateway SSE polling (GET requests to /v1/mcp/*)
    if (method === "GET" && url.startsWith(`${MCP_GATEWAY_PREFIX}/`))
      return true;
    return false;
  };

  fastify.addHook("onRequest", (request, _reply, done) => {
    if (!shouldSkipRequestLogging(request.url, request.method)) {
      request.log.info(
        { url: request.url, method: request.method },
        "incoming request",
      );
    }
    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    if (!shouldSkipRequestLogging(request.url, request.method)) {
      request.log.info(
        {
          url: request.url,
          method: request.method,
          statusCode: reply.statusCode,
          responseTime: reply.elapsedTime,
        },
        "request completed",
      );
    }
    done();
  });

  /**
   * Setup Sentry error handler for Fastify
   * This should be done after creating the instance but before registering routes
   */
  if (observability.sentry.enabled) {
    Sentry.setupFastifyErrorHandler(fastify);
  }

  /**
   * The auth plugin is responsible for authentication and authorization checks
   *
   * In addition, it decorates the request object with the user and organizationId
   * such that they can easily be handled inside route handlers
   * by simply using the request.user and request.organizationId decorators
   */
  fastify.register(fastifyAuthPlugin);

  /**
   * Enterprise license middleware to enforce license requirements on certain routes.
   * This should be registered before routes to ensure enterprise-only features are checked properly.
   */
  fastify.register(enterpriseLicenseMiddleware);

  try {
    // Initialize database connection first
    await initializeDatabase();

    await seedRequiredStartingData();

    // Sync system API keys for keyless providers (Vertex AI, vLLM, Ollama, Bedrock)
    const defaultOrg = await OrganizationModel.getFirst();
    if (defaultOrg) {
      await systemKeyManager.syncSystemKeys(defaultOrg.id).catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to sync system API keys on startup",
        );
      });
    }

    // Start cache manager's background cleanup interval
    cacheManager.start();

    // Initialize metrics with keys of custom agent labels
    // Set OpenMetrics content type to enable exemplar support on histograms
    const promClient = await import("prom-client");
    // eslint-disable-next-line -- default register is typed as Registry<PrometheusContentType> but setContentType accepts both at runtime
    (promClient.default.register.setContentType as (ct: string) => void)(
      promClient.default.Registry.OPENMETRICS_CONTENT_TYPE,
    );

    const labelKeys = await initializeObservabilityMetrics();

    // Start metrics server
    await startMetricsServer();

    // Register sandbox proxy route on the main server (single-port setup).
    // Iframe isolation comes from the sandbox attribute (no allow-same-origin → opaque origin).
    registerSandboxRoute(fastify);

    logger.info(
      `Observability initialized with ${labelKeys.length} agent label keys`,
    );

    startMcpServerRuntime(fastify);

    // Initialize incoming email provider (if configured)
    // This handles auto-setup of webhook subscription if ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL is set
    await initializeEmailProvider();

    // Initialize chatops providers (MS Teams, Slack, etc.)
    // Seeds DB from env vars on first run, then loads config from DB.
    await chatOpsManager.initialize();

    // Start task queue worker for knowledge base connector syncs and embeddings
    // In "web" mode, a separate worker Deployment handles background jobs
    if (shouldRunWorker) {
      registerTaskHandlers(taskQueueService);
      await taskQueueService.seedPeriodicTasks();
      taskQueueService.startWorker();
    }

    // Background job to renew email subscriptions before they expire
    const emailRenewalIntervalId = setInterval(() => {
      renewEmailSubscriptionIfNeeded().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to run email subscription renewal check",
        );
      });
    }, EMAIL_SUBSCRIPTION_RENEWAL_INTERVAL);

    // Background job to clean up old processed email records
    const processedEmailCleanupIntervalId = setInterval(() => {
      cleanupOldProcessedEmails().catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to run processed email cleanup",
        );
      });
    }, PROCESSED_EMAIL_CLEANUP_INTERVAL_MS);

    /**
     * Here we don't expose the metrics endpoint on the main API port, but we do collect metrics
     * inside of this server instance. Metrics are actually exposed on a different port
     * (9050; see above in startMetricsServer)
     */
    await registerMetricsPlugin(fastify, false);

    // Register CORS plugin to allow cross-origin requests
    await fastify.register(fastifyCors, {
      origin: corsOrigins,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "X-Requested-With",
        "Cookie",
        apiKeyAuthorizationHeaderName,
      ],
      exposedHeaders: ["Set-Cookie"],
      credentials: true,
    });

    logger.info(
      {
        corsOrigins: corsOrigins.map((o) =>
          o instanceof RegExp ? o.toString() : o,
        ),
        trustedOrigins: config.auth.trustedOrigins,
      },
      "CORS and trusted origins configured",
    );

    // Register formbody plugin to parse application/x-www-form-urlencoded bodies
    // This is required for SAML callbacks which use form POST binding
    await fastify.register(fastifyFormbody);

    /**
     * Register openapi spec
     * https://github.com/fastify/fastify-swagger?tab=readme-ov-file#usage
     *
     * NOTE: Note: @fastify/swagger must be registered before any routes to ensure proper route discovery. Routes
     * registered before this plugin will not appear in the generated documentation.
     */
    await registerSwaggerPlugin(fastify);

    // Register routes
    fastify.get("/openapi.json", async () =>
      enrichOpenApiWithRbac(fastify.swagger()),
    );

    if (enableE2eTestEndpoints) {
      fastify.get("/test", async () => ({
        value: testValue,
      }));
    }

    // Register all API routes (eeRoutes already loaded at module level)
    await registerApiRoutes(fastify);

    await fastify.listen({ port, host });
    fastify.log.info(`${name} started on port ${port}`);

    // Start WebSocket server using the same HTTP server
    websocketService.start(fastify.server);
    fastify.log.info("WebSocket service started");

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
      fastify.log.info(`Received ${signal}, shutting down gracefully...`);

      try {
        // PRIORITY: Close servers FIRST to release ports immediately
        // This prevents EADDRINUSE errors during hot-reload when the new server starts
        // before cleanup operations complete

        // Close metrics server (releases port 9050)
        if (metricsServerInstance) {
          await metricsServerInstance.close();
          fastify.log.info("Metrics server closed");
        }

        // Close main server (releases port 9000)
        await fastify.close();
        fastify.log.info("Main server closed");

        // Close WebSocket server
        websocketService.stop();

        // Clear email subscription renewal interval
        clearInterval(emailRenewalIntervalId);
        clearInterval(processedEmailCleanupIntervalId);
        fastify.log.info("Email background job intervals cleared");

        // Stop cache manager's background cleanup
        cacheManager.shutdown();

        // Stop task queue worker (waits for in-flight tasks to drain)
        if (shouldRunWorker) {
          await taskQueueService.stopWorker();
        }

        // Track which cleanup operations have completed
        const completedCleanups = new Set<"emailProvider" | "chatOps">();

        // Run remaining cleanup in parallel with a timeout to avoid blocking shutdown
        const cleanupPromise = Promise.allSettled([
          cleanupEmailProvider().then(() => {
            completedCleanups.add("emailProvider");
            fastify.log.info("Email provider cleanup completed");
          }),
          chatOpsManager.cleanup().then(() => {
            completedCleanups.add("chatOps");
            fastify.log.info("ChatOps provider cleanup completed");
          }),
        ]).then(() => "completed" as const);

        // Wait for cleanup with timeout, then exit anyway
        const allCleanupNames = ["emailProvider", "chatOps"] as const;
        const result = await Promise.race([
          cleanupPromise,
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), SHUTDOWN_CLEANUP_TIMEOUT_MS),
          ),
        ]);

        if (result === "timeout") {
          const pendingCleanups = allCleanupNames.filter(
            (name) => !completedCleanups.has(name),
          );
          fastify.log.warn(
            { pendingCleanups },
            "Cleanup timed out, proceeding with shutdown",
          );
        }

        process.exit(0);
      } catch (error) {
        fastify.log.error({ error }, "Error during shutdown");
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

/**
 * Starts the process in worker-only mode.
 * Processes background jobs from the postgres queue without starting the HTTP API server.
 * Used in Helm deployments where the worker runs as a separate Deployment.
 */
const startWorker = async () => {
  logger.info("Starting in worker-only mode (ARCHESTRA_PROCESS_TYPE=worker)");

  try {
    await initializeDatabase();
    cacheManager.start();

    // Set OpenMetrics content type to enable exemplar support
    const promClient = await import("prom-client");
    // eslint-disable-next-line -- default register is typed as Registry<PrometheusContentType> but setContentType accepts both at runtime
    (promClient.default.register.setContentType as (ct: string) => void)(
      promClient.default.Registry.OPENMETRICS_CONTENT_TYPE,
    );

    const labelKeys = await initializeObservabilityMetrics({
      includeMcpMetrics: false,
      includeAgentExecutionMetrics: false,
    });

    registerTaskHandlers(taskQueueService);
    await taskQueueService.seedPeriodicTasks();
    taskQueueService.startWorker();

    // Minimal worker server for Kubernetes probes and Prometheus scraping
    const healthServer = createFastifyInstance();

    healthServer.get("/health", async () => ({ status: "ok" }));
    healthServer.get("/ready", async (_request, reply) => {
      const dbHealthy = await isDatabaseHealthy();
      if (!dbHealthy) {
        return reply.status(503).send({ status: "error", reason: "database" });
      }
      return { status: "ok" };
    });

    await registerStandaloneMetricsEndpoint({
      fastify: healthServer,
      enableDefaultMetrics: true,
    });

    await healthServer.listen({ port: port, host });
    logger.info(
      `Worker server started on port ${port} with ${labelKeys.length} agent label keys`,
    );

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Worker received ${signal}, shutting down...`);

      // Force exit if cleanup takes too long (e.g., long-running task doesn't respect cancellation).
      // Must exceed taskWorkerShutdownTimeoutSeconds so stopWorker() has time to drain
      // in-flight tasks and release them back to the queue.
      const forceExitTimeoutMs =
        (config.kb.taskWorkerShutdownTimeoutSeconds + 5) * 1000;
      const forceExitTimeout = setTimeout(() => {
        logger.warn("Worker shutdown timed out, forcing exit");
        process.exit(1);
      }, forceExitTimeoutMs);

      try {
        await healthServer.close();
        cacheManager.shutdown();
        await taskQueueService.stopWorker();
        clearTimeout(forceExitTimeout);
        process.exit(0);
      } catch (error) {
        clearTimeout(forceExitTimeout);
        logger.error({ error }, "Worker shutdown error");
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  } catch (err) {
    logger.error(err, "Worker failed to start");
    process.exit(1);
  }
};

/**
 * Only start the server if this file is being run directly (not imported)
 * This allows other scripts to import helper functions without starting the server
 */
if (isMainModule) {
  if (shouldRunWorker && !shouldRunWebServer) {
    startWorker();
  } else if (shouldRunWebServer) {
    startWebServer();
  }
}
