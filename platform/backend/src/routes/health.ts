import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { isDatabaseHealthy } from "@/database";
import { HEALTH_PATH, READY_PATH } from "./route-paths";

const { name, version } = config.api;

const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Lightweight liveness check — only verifies the HTTP server is running.
   */
  fastify.get(
    HEALTH_PATH,
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

  /**
   * Readiness check — verifies database connectivity.
   * Returns 200 if ready to receive traffic, 503 otherwise.
   */
  fastify.get(
    READY_PATH,
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
};

export default healthRoutes;
