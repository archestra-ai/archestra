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
import config from "./config";
import agentRoutes from "./routes/agent";
import autonomyPolicyRoutes from "./routes/autonomy-policies";
import chatRoutes from "./routes/chat";
import openAiProxyRoutes from "./routes/proxy/openai";
import toolRoutes from "./routes/tool";

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

const start = async () => {
  try {
    // Register CORS plugin to allow cross-origin requests from frontend
    await fastify.register(fastifyCors, {
      origin: ["http://localhost:3000"],
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

    fastify.register(agentRoutes);
    fastify.register(chatRoutes);
    fastify.register(openAiProxyRoutes);
    fastify.register(toolRoutes);
    fastify.register(autonomyPolicyRoutes);

    await fastify.listen({ port, host });
    fastify.log.info(`${name} started on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
