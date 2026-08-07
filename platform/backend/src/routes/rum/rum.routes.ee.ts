import {
  pickAllowedRumAttributes,
  RouteId,
  RUM_EVENT_NAMES,
  RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
  RUM_MAX_ATTRIBUTES_PER_EVENT,
  RUM_MAX_EVENTS_PER_BATCH,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import { rumExporter } from "@/observability/rum/exporter.ee";
import { ApiError, constructResponseSchema } from "@/types";

const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

const RumEventSchema = z
  .object({
    name: z.enum(RUM_EVENT_NAMES),
    timestampMs: z.number().int().positive(),
    sessionId: z.string().min(8).max(64),
    previousSessionId: z.string().min(8).max(64).optional(),
    attributes: z
      .record(
        z.string(),
        z.union([
          z.string().max(RUM_MAX_ATTRIBUTE_VALUE_LENGTH),
          z.number(),
          z.boolean(),
        ]),
      )
      .optional(),
  })
  .superRefine((event, ctx) => {
    const keys = Object.keys(event.attributes ?? {});
    if (keys.length > RUM_MAX_ATTRIBUTES_PER_EVENT) {
      ctx.addIssue({
        code: "custom",
        path: ["attributes"],
        message: `At most ${RUM_MAX_ATTRIBUTES_PER_EVENT} attributes per event`,
      });
    }
    for (const key of keys) {
      if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["attributes", key],
          message: "Invalid attribute key",
        });
      }
    }
  });

const rumRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/rum/events",
    {
      schema: {
        operationId: RouteId.IngestRumEvents,
        description:
          "Ingest a batch of product-usage (RUM) events from the web client. Events are forwarded as OTLP log records to the deployment-configured collector; when no RUM export endpoint is configured the batch is acknowledged and dropped.",
        tags: ["RUM"],
        body: z.object({
          events: z.array(RumEventSchema).min(1).max(RUM_MAX_EVENTS_PER_BATCH),
        }),
        response: constructResponseSchema(z.object({ accepted: z.number() })),
      },
    },
    async ({ user, body }) => {
      // Per-user flood control: a runaway or hostile client must not amplify
      // unbounded volume into the customer's collector. Keyed on the
      // authenticated user, not the session id, which a client can rotate at
      // will. Fails open — losing telemetry protection during a cache outage
      // beats losing the telemetry.
      const limited = await isRateLimited(
        `${CacheKey.RumIngestRateLimit}-${user.id}`,
        {
          windowMs: 60_000,
          maxRequests: config.observability.rum.ingestMaxBatchesPerMinute,
        },
      ).catch(() => false);
      if (limited) {
        throw new ApiError(429, "Too many requests");
      }

      return {
        // Server-side half of the attribute firewall: the client filters too,
        // but only this strip guarantees a stale or modified client cannot
        // push entity ids or free text into the customer-facing export.
        accepted: rumExporter.emit(
          body.events.map((event) => ({
            ...event,
            attributes: pickAllowedRumAttributes(event.name, event.attributes),
          })),
          { userId: user.id },
        ),
      };
    },
  );
};

export default rumRoutes;
