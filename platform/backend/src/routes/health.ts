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
        tags: ["Health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.literal("ok"),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      name,
      status: "ok" as const,
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
        tags: ["Health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.enum(["ok", "maintenance"]),
            version: z.string(),
            database: z.enum(["connected", "not_checked"]),
          }),
          503: z.object({
            name: z.string(),
            status: z.literal("degraded"),
            version: z.string(),
            database: z.literal("disconnected"),
          }),
        },
      },
    },
    async (request, reply) => {
      // Maintenance mode must stay available while the database is offline or
      // being upgraded, so readiness intentionally skips the DB probe here.
      if (config.maintenanceMode) {
        return reply.send({
          name,
          status: "maintenance",
          version,
          database: "not_checked",
        });
      }

      const dbHealthy = await isDatabaseHealthy();

      if (!dbHealthy) {
        request.log.warn("Database health check failed for readiness probe");
        return reply.status(503).send({
          name,
          status: "degraded",
          version,
          database: "disconnected",
        });
      }

      return reply.send({
        name,
        status: "ok",
        version,
        database: "connected",
      });
    },
  );
};

export default healthRoutes;
