import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import { clientConnectionService } from "@/services/client-connection";
import { CLIENT_CONNECTION_INSTALLER } from "@/services/client-connection-installer";
import { ApiError, constructResponseSchema } from "@/types";
import {
  ConnectionSetupClientIdSchema,
  ConnectionSetupPlatformSchema,
} from "@/types/connection-setup";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/client-connections/installer",
    {
      schema: {
        operationId: RouteId.GetClientConnectionInstaller,
        tags: ["Connection Setups"],
        description:
          "Public, credential-free Node.js client connection installer.",
      },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .type("text/javascript")
        .send(CLIENT_CONNECTION_INSTALLER),
  );

  app.post(
    "/api/client-connections",
    {
      schema: {
        operationId: RouteId.StartClientConnection,
        tags: ["Connection Setups"],
        body: z.object({
          clientId: ConnectionSetupClientIdSchema,
          platform: ConnectionSetupPlatformSchema,
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            deviceCode: z.string(),
            userCode: z.string(),
            verificationPath: z.string(),
            expiresAt: z.string(),
            interval: z.number(),
          }),
        ),
      },
    },
    async (request, reply) => {
      await rateLimit({ ip: request.ip, action: "start", maxRequests: 10 });
      reply.header("Cache-Control", "no-store");
      return clientConnectionService.start(request.body);
    },
  );

  app.post(
    "/api/client-connections/poll",
    {
      schema: {
        operationId: RouteId.PollClientConnection,
        tags: ["Connection Setups"],
        body: z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["pending", "approved", "denied", "expired"]),
          }),
        ),
      },
    },
    async (request, reply) => {
      await rateLimit({ ip: request.ip, action: "poll", maxRequests: 120 });
      reply.header("Cache-Control", "no-store");
      return clientConnectionService.poll(request.body.deviceCode);
    },
  );

  app.get(
    "/api/client-connections/:id",
    {
      schema: {
        operationId: RouteId.GetClientConnection,
        tags: ["Connection Setups"],
        params: IdSchema,
        response: constructResponseSchema(
          z.object({
            clientId: ConnectionSetupClientIdSchema,
            platform: ConnectionSetupPlatformSchema,
            userCode: z.string(),
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return clientConnectionService.get(request.params.id);
    },
  );

  app.post(
    "/api/client-connections/:id/decision",
    {
      schema: {
        operationId: RouteId.DecideClientConnection,
        tags: ["Connection Setups"],
        params: IdSchema,
        body: z.discriminatedUnion("decision", [
          z.object({
            decision: z.literal("approve"),
            setupId: z.string().uuid(),
          }),
          z.object({ decision: z.literal("deny") }),
        ]),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["approved", "denied"]),
            clientId: ConnectionSetupClientIdSchema,
            platform: ConnectionSetupPlatformSchema,
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = await clientConnectionService.decide({
        id: request.params.id,
        setupId:
          request.body.decision === "approve"
            ? request.body.setupId
            : undefined,
        userId: request.user.id,
        organizationId: request.organizationId,
      });
      request.auditBefore = { status: "pending" };
      request.auditAfter = result;
      return result;
    },
  );
};

export default routes;

// === Internal helpers
const IdSchema = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/) });
async function rateLimit(params: {
  ip: string;
  action: string;
  maxRequests: number;
}) {
  if (
    await isRateLimited(
      `${CacheKey.ClientConnectionRateLimit}-${params.action}-${params.ip}`,
      { windowMs: 60_000, maxRequests: params.maxRequests },
    )
  ) {
    throw new ApiError(
      429,
      "Too many connection requests. Try again in one minute.",
    );
  }
}
