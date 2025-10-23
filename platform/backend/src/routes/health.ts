import type { FastifyPluginAsync } from "fastify";
import config from "../config";
import db from "../database";
import { systemHealthStatus } from "../metrics";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => {
    const healthCheck = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: config.api.version,
      name: config.api.name,
    };

    systemHealthStatus.set({ component: "system" }, 1);

    return healthCheck;
  });

  fastify.get("/ready", async () => {
    try {
      await db.execute("SELECT 1");

      return {
        status: "ready",
        timestamp: new Date().toISOString(),
      };
    } catch (_error) {
      return {
        status: "not ready",
        timestamp: new Date().toISOString(),
        error: "Database not accessible",
      };
    }
  });

  fastify.get("/live", async () => {
    return {
      status: "alive",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
};

export default healthRoutes;
