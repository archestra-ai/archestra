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
  await import("./sentry");
  await import("./tracing");
}

import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import fastifySwagger from "@fastify/swagger";
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
import config from "@/config";
import { initializeDatabase, isDatabaseHealthy } from "@/database";
import { seedRequiredStartingData } from "@/database/seed";
import {
  cleanupKnowledgeGraphProvider,
  initializeKnowledgeGraphProvider,
} from "@/knowledge-graph";
import { initializeMetrics } from "@/llm-metrics";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { enterpriseLicenseMiddleware } from "@/middleware";
import AgentLabelModel from "@/models/agent-label";
import OrganizationModel from "@/models/organization";
import { systemKeyManager } from "@/services/system-key-manager";
import {
  Anthropic,
  ApiError,
  Cerebras,
  Cohere,
  Gemini,
  Mistral,
  Ollama,
  OpenAi,
  Vllm,
  WebSocketMessageSchema,
  Zhipuai,
} from "@/types";
import websocketService from "@/websocket";
import * as routes from "./routes";

/** Max time to wait for cleanup operations during graceful shutdown before exiting */
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 3000;

// Load enterprise routes if license is activated OR if running in codegen mode
// (codegen mode ensures OpenAPI spec always includes all enterprise routes)
const eeRoutes =
  config.enterpriseLicenseActivated || config.codegenMode
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
  z.globalRegistry.add(WebSocketMessageSchema, {
    id: "WebSocketMessage",
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
 * Register the health endpoint on a Fastify instance.
 * This is a lightweight endpoint for liveness checks - it only verifies the HTTP server is running.
 */
export function registerHealthEndpoint(fastify: FastifyInstanceWithZod) {
  fastify.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.string(),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      name,
      status: "ok",
      version,
    }),
  );
}

/**
 * Register the readiness endpoint on a Fastify instance.
 * This endpoint checks database connectivity and should be used for readiness probes.
 * Returns 200 if the application is ready to receive traffic, 503 otherwise.
 */
export function registerReadinessEndpoint(fastify: FastifyInstanceWithZod) {
  fastify.get(
    "/ready",
    {
      schema: {
        tags: ["health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.string(),
            version: z.string(),
            database: z.string(),
          }),
          503: z.object({
            name: z.string(),
            status: z.string(),
            version: z.string(),
            database: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const dbHealthy = await isDatabaseHealthy();

      const response = {
        name,
        status: dbHealthy ? "ok" : "degraded",
        version,
        database: dbHealthy ? "connected" : "disconnected",
      };

      if (!dbHealthy) {
        request.log.warn("Database health check failed for readiness probe");
        return reply.status(503).send(response);
      }

      return reply.send(response);
    },
  );
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
  })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    // https://fastify.dev/docs/latest/Reference/Server/#seterrorhandler
    .setErrorHandler<ApiError | Error>(function (error, _request, reply) {
      // Handle response serialization errors (when response doesn't match schema)
      if (isResponseSerializationError(error)) {
        const issues = error.cause?.issues ?? [];
        this.log.error(
          {
            statusCode: 500,
            method: error.method,
            url: error.url,
            validationErrors: issues.map((issue) => ({
              path: issue.path?.join("."),
              code: issue.code,
              message: issue.message,
            })),
          },
          "Response serialization error: response doesn't match schema",
        );

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
      routeBlacklist: ["/health", "/ready"],
    },
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
  const { secret: metricsSecret } = observability.metrics;

  const metricsServer = createFastifyInstance();
  metricsServerInstance = metricsServer;

  // Add authentication hook for metrics endpoint if secret is configured
  if (metricsSecret) {
    metricsServer.addHook("preHandler", async (request, reply) => {
      // Skip auth for health and readiness endpoints
      if (request.url === "/health" || request.url === "/ready") {
        return;
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({ error: "Unauthorized: Bearer token required" });
        return;
      }

      const token = authHeader.slice(7); // Remove 'Bearer ' prefix
      if (token !== metricsSecret) {
        reply.code(401).send({ error: "Unauthorized: Invalid token" });
        return;
      }
    });
  }

  metricsServer.get("/health", () => ({ status: "ok" }));

  await registerMetricsPlugin(metricsServer, true);

  // Start metrics server on dedicated port
  await metricsServer.listen({
    port: observability.metrics.port,
    host,
  });
  metricsServer.log.info(
    `Metrics server started on port ${observability.metrics.port}${
      metricsSecret ? " (with authentication)" : " (no authentication)"
    }`,
  );
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

const start = async () => {
  const fastify = createFastifyInstance();

  /**
   * Custom request logging hook that excludes noisy endpoints:
   * - /health: Kubernetes liveness probe
   * - /ready: Kubernetes readiness probe (checks database connectivity)
   * - GET /v1/mcp/*: MCP Gateway SSE polling (happens every second)
   */
  const shouldSkipRequestLogging = (url: string, method: string): boolean => {
    if (url === "/health" || url === "/ready") return true;
    // Skip MCP Gateway SSE polling (GET requests to /v1/mcp/*)
    if (method === "GET" && url.startsWith("/v1/mcp/")) return true;
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
      systemKeyManager.syncSystemKeys(defaultOrg.id).catch((error) => {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Failed to sync system API keys on startup",
        );
      });
    }

    // Start cache manager's background cleanup interval
    cacheManager.start();

    // Initialize metrics with keys of custom agent labels
    const labelKeys = await AgentLabelModel.getAllKeys();
    initializeMetrics(labelKeys);

    // Start metrics server
    await startMetricsServer();

    logger.info(
      `Observability initialized with ${labelKeys.length} agent label keys`,
    );

    startMcpServerRuntime(fastify);

    // Initialize incoming email provider (if configured)
    // This handles auto-setup of webhook subscription if ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL is set
    await initializeEmailProvider();

    // Initialize chatops providers (MS Teams, Slack, etc.)
    await chatOpsManager.initialize();

    // Initialize knowledge graph provider (if configured)
    // This enables automatic document ingestion from chat uploads
    await initializeKnowledgeGraphProvider();

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
    fastify.get("/openapi.json", async () => fastify.swagger());
    registerHealthEndpoint(fastify);
    registerReadinessEndpoint(fastify);

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

        // Track which cleanup operations have completed
        const completedCleanups = new Set<
          "emailProvider" | "knowledgeGraph" | "chatOps"
        >();

        // Run remaining cleanup in parallel with a timeout to avoid blocking shutdown
        const cleanupPromise = Promise.allSettled([
          cleanupEmailProvider().then(() => {
            completedCleanups.add("emailProvider");
            fastify.log.info("Email provider cleanup completed");
          }),
          cleanupKnowledgeGraphProvider().then(() => {
            completedCleanups.add("knowledgeGraph");
            fastify.log.info("Knowledge graph provider cleanup completed");
          }),
          chatOpsManager.cleanup().then(() => {
            completedCleanups.add("chatOps");
            fastify.log.info("ChatOps provider cleanup completed");
          }),
        ]).then(() => "completed" as const);

        // Wait for cleanup with timeout, then exit anyway
        const allCleanupNames = [
          "emailProvider",
          "knowledgeGraph",
          "chatOps",
        ] as const;
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
 * Only start the server if this file is being run directly (not imported)
 * This allows other scripts to import helper functions without starting the server
 */
if (isMainModule) {
  start();
}
