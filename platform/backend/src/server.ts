import fastifySwagger from "@fastify/swagger";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import chatRoutes from "./routes/chat";
import llmProviderProxyRoutes from "./routes/proxy";

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

// Run the server!
const start = async () => {
  try {
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
          title: "Archestra API",
          version: "0.0.1", // x-release-please-version
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
      status: "Archestra Backend API",
      version: "0.0.1",
    }));

    fastify.register(chatRoutes);
    fastify.register(llmProviderProxyRoutes);

    await fastify.listen({ port: 9000, host: "0.0.0.0" });
    fastify.log.info("Archestra Backend API started on port 9000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
