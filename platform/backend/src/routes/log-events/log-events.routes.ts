import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getLogStats, listLogEvents } from "@/services/log-events";
import { constructResponseSchema } from "@/types";
import {
  LogEventsPageSchema,
  LogEventsQuerySchema,
  LogStatsQuerySchema,
  LogStatsSchema,
} from "@/types/log-events";

const logEventsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/logs/events",
    {
      schema: {
        operationId: RouteId.GetLogEvents,
        description:
          "Every log type in one timeline, newest first: LLM Proxy requests, MCP Gateway tool calls, Guardrails consults and yells, client connection events, and audit events. Each type is filtered by its own permission and left out when the caller cannot read it. Returns one page; pass `nextCursor` back as `cursor` for the next.",
        tags: ["Logs"],
        querystring: LogEventsQuerySchema,
        response: constructResponseSchema(LogEventsPageSchema),
      },
    },
    async ({ query, user, organizationId }, reply) =>
      reply.send(
        await listLogEvents({ organizationId, userId: user.id, query }),
      ),
  );

  fastify.get(
    "/api/logs/stats",
    {
      schema: {
        operationId: RouteId.GetLogStats,
        description:
          "Counts for the log events the filters match in the window: the total, each filter's values (counted as if that filter were off), and one bucket per hour. Each type is filtered by its own permission, as in the timeline.",
        tags: ["Logs"],
        querystring: LogStatsQuerySchema,
        response: constructResponseSchema(LogStatsSchema),
      },
    },
    async ({ query, user, organizationId }, reply) =>
      reply.send(await getLogStats({ organizationId, userId: user.id, query })),
  );
};

export default logEventsRoutes;
