import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import {
  Gemini,
  OpenAi,
  SupportedProvidersDiscriminatorSchema,
  SupportedProvidersSchema,
} from "@/types";
import { seedDatabase } from "./database/seed";
import * as routes from "./routes";

const {
  api: { port, name, version, host },
} = config;

const fastify = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
}).withTypeProvider<ZodTypeProvider>();

// Set up Zod validation and serialization
fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

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

const start = async () => {
  try {
    // Seed database with demo data
    await seedDatabase();

    /**
     * Register CORS plugin to allow cross-origin requests from frontend
     * (running on any port in case the default (3000) is taken)
     */
    await fastify.register(fastifyCors, {
      origin: [/http:\/\/localhost:\d+/],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
    fastify.get("/health", async () => ({
      status: name,
      version,
    }));

    fastify.register(routes.agentRoutes);
    fastify.register(routes.interactionRoutes);
    fastify.register(routes.openAiProxyRoutes);
    fastify.register(routes.geminiProxyRoutes);
    fastify.register(routes.toolRoutes);
    fastify.register(routes.autonomyPolicyRoutes);
    fastify.register(routes.dualLlmConfigRoutes);
    fastify.register(routes.dualLlmResultRoutes);

    await fastify.listen({ port, host });
    fastify.log.info(`${name} started on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
