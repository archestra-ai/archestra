import Fastify from "fastify";

import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { chatRoutes } from "./routes/chat";

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

// Health check route
fastify.get("/health", async function handler() {
  return { status: "Archestra Backend API", version: "0.0.1" };
});

// Register routes
fastify.register(chatRoutes);

// Run the server!
const start = async () => {
  try {
    await fastify.listen({ port: 9000, host: "0.0.0.0" });
    fastify.log.info("Archestra Backend API started on port 9000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
