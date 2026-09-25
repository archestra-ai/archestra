import metricsPlugin from "fastify-metrics";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { HEALTH_PATH, READY_PATH } from "@/routes/route-paths";

const { observability } = config;

/**
 * Register the metrics plugin on a Fastify instance. Default and route metrics
 * must only be registered once across the main and dedicated listeners.
 */
export const registerMetricsPlugin = async (
  fastify: FastifyInstanceWithZod,
  endpointEnabled: boolean,
): Promise<void> => {
  const metricsEnabled = !endpointEnabled;

  await fastify.register(metricsPlugin, {
    endpoint: endpointEnabled ? observability.metrics.endpoint : null,
    defaultMetrics: { enabled: metricsEnabled },
    routeMetrics: {
      enabled: metricsEnabled,
      methodBlacklist: ["OPTIONS", "HEAD"],
      routeBlacklist: [HEALTH_PATH, READY_PATH],
    },
  });
};

export const registerStandaloneMetricsEndpoint = async (params: {
  fastify: FastifyInstanceWithZod;
  enableDefaultMetrics: boolean;
}): Promise<void> => {
  const { fastify, enableDefaultMetrics } = params;
  addMetricsAuthenticationHook(fastify);

  await fastify.register(metricsPlugin, {
    endpoint: observability.metrics.endpoint,
    defaultMetrics: { enabled: enableDefaultMetrics },
    routeMetrics: { enabled: false },
  });
};

export const addMetricsAuthenticationHook = (
  fastify: FastifyInstanceWithZod,
): void => {
  const { secret: metricsSecret } = observability.metrics;

  if (!metricsSecret) {
    return;
  }

  const metricsPath = observability.metrics.endpoint;

  fastify.addHook("preHandler", async (request, reply) => {
    if (
      request.url !== metricsPath &&
      !request.url.startsWith(`${metricsPath}?`)
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized: Bearer token required" });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== metricsSecret) {
      reply.code(401).send({ error: "Unauthorized: Invalid token" });
      return;
    }
  });
};
