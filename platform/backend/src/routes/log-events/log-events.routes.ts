import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listLogEvents } from "@/services/log-events";
import { constructResponseSchema } from "@/types";
import {
  LogEventsQuerySchema,
  LogEventsResponseSchema,
} from "@/types/log-events";

const logEventsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/logs/events",
    {
      schema: {
        operationId: RouteId.GetLogEvents,
        description:
          "Every log type in one timeline, newest first: LLM Proxy requests, MCP Gateway tool calls, Guardrails consults and yells, client connection events, and audit events. Each type is filtered by its own permission and left out when the caller cannot read it. Returns a page of events with facets and 48 time buckets over the window.",
        tags: ["Logs"],
        querystring: LogEventsQuerySchema,
        response: constructResponseSchema(LogEventsResponseSchema),
      },
    },
    async ({ query, user, organizationId }, reply) =>
      reply.send(
        await listLogEvents({ organizationId, userId: user.id, query }),
      ),
  );
};

export default logEventsRoutes;
