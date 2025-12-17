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
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { fastifyAuthPlugin } from "@/auth";
import config from "@/config";
import { seedRequiredStartingData } from "@/database/seed";
import { initializeMetrics } from "@/llm-metrics";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { enterpriseLicenseMiddleware } from "@/middleware";
import AgentLabelModel from "@/models/agent-label";
import {
  Anthropic,
  ApiError,
  Gemini,
  OpenAi,
  WebSocketMessageSchema,
} from "@/types";
import websocketService from "@/websocket";
import * as routes from "./routes";

const eeRoutes = config.enterpriseLicenseActivated
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
  })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    // https://fastify.dev/docs/latest/Reference/Server/#seterrorhandler
    .setErrorHandler<ApiError | Error>(function (error, _request, reply) {
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
      routeBlacklist: ["/health"],
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
      // Skip auth for health endpoint
      if (request.url === "/health") {
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
    await seedRequiredStartingData();

    // Initialize metrics with keys of custom agent labels
    const labelKeys = await AgentLabelModel.getAllKeys();
    initializeMetrics(labelKeys);

    // Start metrics server
    await startMetricsServer();

    logger.info(
      `Observability initialized with ${labelKeys.length} agent label keys`,
    );

    startMcpServerRuntime(fastify);

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
        // Close WebSocket server
        websocketService.stop();

        // Close metrics server
        if (metricsServerInstance) {
          await metricsServerInstance.close();
          fastify.log.info("Metrics server closed");
        }

        // Close main server
        await fastify.close();
        fastify.log.info("Main server closed");

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
