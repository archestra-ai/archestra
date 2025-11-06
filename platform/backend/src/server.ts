// Import tracing first to ensure auto-instrumentation works properly
import "./tracing";

import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
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
import config from "@/config";
import { seedRequiredStartingData } from "@/database/seed";
import { initializeMetrics } from "@/llm-metrics";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { authMiddleware } from "@/middleware/auth";
import {
  Anthropic,
  Gemini,
  OpenAi,
  SupportedProvidersDiscriminatorSchema,
  SupportedProvidersSchema,
} from "@/types";
import AgentLabelModel from "./models/agent-label";
import * as routes from "./routes";

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

// Register schemas in global registry for OpenAPI generation
z.globalRegistry.add(SupportedProvidersSchema, {
  id: "SupportedProviders",
});
z.globalRegistry.add(SupportedProvidersDiscriminatorSchema, {
  id: "SupportedProvidersDiscriminator",
});
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

/**
 * Sets up logging and zod type provider + request validation & response serialization
 */
const createFastifyInstance = () =>
  Fastify({
    loggerInstance: logger,
  })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler);

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
const startMetricsServer = async () => {
  const { secret: metricsSecret } = observability.metrics;

  const metricsServer = createFastifyInstance();

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

const start = async () => {
  const fastify = createFastifyInstance();

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

    // Initialize MCP Server Runtime (K8s-based)
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
        `Failed to import MCP Server Runtime: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      // Continue server startup even if MCP runtime fails
    }

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

    /**
     * Register openapi spec
     * https://github.com/fastify/fastify-swagger?tab=readme-ov-file#usage
     *
     * NOTE: Note: @fastify/swagger must be registered before any routes to ensure proper route discovery. Routes
     * registered before this plugin will not appear in the generated documentation.
     */
    await fastify.register(fastifySwagger, {
      openapi: {
        openapi: "3.0.0",
        info: {
          title: name,
          version,
        },
      },

      /**
       * basically we use this hide untagged option to NOT include fastify-http-proxy routes in the OpenAPI spec
       * (ex. we use this in several spots, as of this writing, under ./routes/proxy/)
       */
      hideUntagged: true,

      /**
       * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-use-together-with-fastifyswagger
       */
      transform: jsonSchemaTransform,
      /**
       * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
       */
      transformObject: jsonSchemaTransformObject,
    });

    // Register routes
    fastify.get("/openapi.json", async () => fastify.swagger());
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

    fastify.addHook("preHandler", authMiddleware.handle);

    for (const route of Object.values(routes)) {
      fastify.register(route);
    }

    await fastify.listen({ port, host });
    fastify.log.info(`${name} started on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
