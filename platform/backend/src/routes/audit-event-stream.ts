import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auditEventPubsub } from "@/audit/audit-event-pubsub";
import { AuditEventModel } from "@/models";

const auditEventStreamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/audit-events/stream",
    {
      schema: {
        operationId: RouteId.StreamAuditEvents,
        description: "Stream audit events in real time (SSE)",
        tags: ["Audit"],
        querystring: z.object({
          /**
           * Optional: only stream events created after this timestamp (ISO string).
           * If omitted, the stream starts “now”.
           */
          after: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      // SSE headers
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      // Flush headers (node http)
      // biome-ignore lint/suspicious/noExplicitAny: raw is node response
      (reply.raw as any).flushHeaders?.();

      const organizationId = request.organizationId;
      const lastEventIdHeader = request.headers["last-event-id"];
      const lastEventId =
        typeof lastEventIdHeader === "string" && lastEventIdHeader.length > 0
          ? lastEventIdHeader
          : null;

      const afterFromQueryMs = request.query.after
        ? Date.parse(request.query.after)
        : Number.NaN;

      const afterMs = await resolveAfterMs({
        organizationId,
        lastEventId,
        afterFromQueryMs,
      });

      // Initial “connected” event
      writeSseEvent(reply.raw, {
        event: "connected",
        data: { now: new Date().toISOString() },
      });

      let backlogSent = false;
      const buffer: Array<
        ReturnType<typeof serializeAuditEvent> & { id: string }
      > = [];

      const unsubscribe = auditEventPubsub.subscribeCreated((event) => {
        // Enforce org scoping server-side
        if (event.organizationId !== organizationId) return;

        // Optional "after" filter
        if (!Number.isNaN(afterMs) && event.createdAt.getTime() <= afterMs)
          return;

        const data = serializeAuditEvent(event);
        if (!backlogSent) {
          buffer.push({ ...data, id: event.id });
          return;
        }

        writeSseEvent(reply.raw, { id: event.id, event: "auditEvent", data });
      });

      // Backfill any events that happened while the client was disconnected.
      // Subscribe first, then query, then flush buffer to minimize race window.
      if (!Number.isNaN(afterMs)) {
        const missed = await AuditEventModel.getCreatedAfter({
          organizationId,
          after: new Date(afterMs),
          limit: 250,
        });

        for (const event of missed) {
          writeSseEvent(reply.raw, {
            id: event.id,
            event: "auditEvent",
            data: serializeAuditEvent(event),
          });
        }
      }

      backlogSent = true;
      for (const buffered of buffer) {
        writeSseEvent(reply.raw, {
          id: buffered.id,
          event: "auditEvent",
          data: buffered,
        });
      }

      // Keepalive ping to prevent proxies from closing idle connections
      const keepalive = setInterval(() => {
        writeSseEvent(reply.raw, { event: "ping", data: { t: Date.now() } });
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });

      return reply;
    },
  );
};

export default auditEventStreamRoutes;

function writeSseEvent(
  res: NodeJS.WritableStream,
  params: { id?: string; event: string; data: unknown },
) {
  if (params.id) {
    res.write(`id: ${params.id}\n`);
  }
  res.write(`event: ${params.event}\n`);
  res.write(`data: ${JSON.stringify(params.data)}\n\n`);
}

function serializeAuditEvent(event: {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}) {
  return {
    ...event,
    createdAt: event.createdAt.toISOString(),
  };
}

async function resolveAfterMs(params: {
  organizationId: string;
  lastEventId: string | null;
  afterFromQueryMs: number;
}): Promise<number> {
  const { organizationId, lastEventId, afterFromQueryMs } = params;

  if (lastEventId) {
    try {
      const last = await AuditEventModel.getById({
        organizationId,
        id: lastEventId,
      });
      if (last) return last.createdAt.getTime();
    } catch {
      // ignore and fall back to query param
    }
  }

  return afterFromQueryMs;
}
