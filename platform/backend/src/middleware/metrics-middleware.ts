import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { httpRequestDuration, httpRequestsTotal } from "../metrics";

declare module "fastify" {
  interface FastifyRequest {
    metricsStartTime?: number;
  }
}

export function registerMetricsMiddleware(fastify: FastifyInstance) {
  fastify.addHook(
    "onRequest",
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      request.metricsStartTime = Date.now();
      done();
    },
  );

  fastify.addHook(
    "onSend",
    (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const startTime = request.metricsStartTime;
      if (startTime) {
        const duration = (Date.now() - startTime) / 1000;
        const method = request.method;
        const route = request.routeOptions.url || request.url;
        const statusCode = reply.statusCode.toString();

        httpRequestsTotal.inc({
          method,
          status_code: statusCode,
          route,
        });

        httpRequestDuration.observe(
          {
            method,
            status_code: statusCode,
            route,
          },
          duration,
        );
      }

      return payload;
    },
  );
}
