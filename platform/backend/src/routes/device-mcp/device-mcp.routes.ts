import { RouteId } from "@archestra/shared";
import { DeviceMcpConfigSchema } from "@archestra/shared/device-mcp";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import { deviceMcpService } from "@/services/device-mcp";
import { constructResponseSchema } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

const CodeSchema = z.string().min(40).max(128);
const ConfigResponseSchema = z.object({
  config: DeviceMcpConfigSchema,
  configDigest: z.string(),
});
const SuccessSchema = z.object({ success: z.literal(true) });
const SessionSchema = z.object({ sessionId: z.string().uuid() });
const StatusSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  configVersion: z.string(),
  lastSeenAt: z.string().nullable(),
  status: z.enum([
    "setup_required",
    "offline",
    "online",
    "update_required",
    "revoked",
  ]),
});

const deviceMcpRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const cleanupTimer = setInterval(() => {
    trackBackgroundWork(
      deviceMcpService
        .cleanupExpired()
        .catch((error) =>
          logger.error({ err: error }, "Device relay cleanup failed"),
        ),
    );
  }, 30_000);
  cleanupTimer.unref();
  fastify.addHook("onClose", async () => clearInterval(cleanupTimer));

  fastify.get(
    "/api/device-mcp",
    {
      schema: {
        operationId: RouteId.ListDeviceMcpConnections,
        tags: ["Device MCP"],
        querystring: z.object({ catalogId: z.string().uuid() }),
        response: constructResponseSchema(z.array(StatusSchema)),
      },
    },
    async ({ organizationId, user, query }) =>
      deviceMcpService.list({
        organizationId,
        userId: user.id,
        catalogId: query.catalogId,
      }),
  );

  fastify.post(
    "/api/device-mcp/pair",
    {
      schema: {
        operationId: RouteId.PairDeviceMcp,
        tags: ["Device MCP"],
        body: z
          .object({
            catalogId: z.string().uuid(),
            name: z.string().trim().min(1).max(128),
            replaceExisting: z.boolean().default(false),
          })
          .strict(),
        response: constructResponseSchema(
          ConfigResponseSchema.extend({
            id: z.string().uuid(),
            code: z.string(),
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      reply.header("Cache-Control", "no-store");
      return deviceMcpService.pair({
        organizationId,
        userId: user.id,
        ...body,
      });
    },
  );

  fastify.delete(
    "/api/device-mcp/:id",
    {
      schema: {
        operationId: RouteId.RevokeDeviceMcp,
        tags: ["Device MCP"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(SuccessSchema),
      },
    },
    async ({ organizationId, user, params }) =>
      deviceMcpService.revoke({
        organizationId,
        userId: user.id,
        id: params.id,
      }),
  );

  // These routes use pairing proofs / device credentials, never browser cookies.
  // Only these exact POST paths bypass ordinary API authentication.
  fastify.post(
    "/api/device-mcp/inspect",
    {
      schema: {
        operationId: RouteId.InspectDeviceMcpPairing,
        tags: ["Device MCP"],
        body: z.object({ code: CodeSchema }).strict(),
        response: constructResponseSchema(ConfigResponseSchema),
      },
    },
    async ({ body }, reply) => {
      reply.header("Cache-Control", "no-store");
      return deviceMcpService.inspect(body.code);
    },
  );

  fastify.post(
    "/api/device-mcp/redeem",
    {
      schema: {
        operationId: RouteId.RedeemDeviceMcpPairing,
        tags: ["Device MCP"],
        body: z
          .object({
            code: CodeSchema,
            configDigest: z.string().length(64),
            platform: z.enum(["darwin", "win32"]),
            protocolVersion: z.literal(1),
          })
          .strict(),
        response: constructResponseSchema(
          ConfigResponseSchema.extend({
            deviceId: z.string().uuid(),
            token: z.string(),
          }),
        ),
      },
    },
    async ({ body }, reply) => {
      reply.header("Cache-Control", "no-store");
      return deviceMcpService.redeem(body);
    },
  );

  fastify.post(
    "/api/device-mcp/session",
    {
      schema: {
        operationId: RouteId.OpenDeviceMcpSession,
        tags: ["Device MCP"],
        body: z
          .object({
            configDigest: z.string().length(64),
            protocolVersion: z.literal(1),
          })
          .strict(),
        response: constructResponseSchema(SessionSchema),
      },
    },
    async ({ headers, body }) =>
      deviceMcpService.session(
        await deviceMcpService.authenticate(headers.authorization),
        body.configDigest,
      ),
  );

  fastify.post(
    "/api/device-mcp/poll",
    {
      schema: {
        operationId: RouteId.PollDeviceMcp,
        tags: ["Device MCP"],
        body: SessionSchema.extend({
          ready: z.boolean().default(true),
        }).strict(),
        response: constructResponseSchema(
          z.object({
            command: z
              .object({
                id: z.string().uuid(),
                toolName: z.string(),
                arguments: z.record(z.string(), z.unknown()),
                expiresAt: z.string(),
              })
              .nullable(),
          }),
        ),
      },
    },
    async ({ headers, body }) =>
      deviceMcpService.poll(
        await deviceMcpService.authenticate(headers.authorization),
        body.sessionId,
        body.ready,
      ),
  );

  fastify.post(
    "/api/device-mcp/result",
    {
      bodyLimit: 2 * 1024 * 1024 + 4096,
      schema: {
        operationId: RouteId.SubmitDeviceMcpResult,
        tags: ["Device MCP"],
        body: SessionSchema.extend({
          commandId: z.string().uuid(),
          result: z.record(z.string(), z.unknown()),
        }).strict(),
        response: constructResponseSchema(SuccessSchema),
      },
    },
    async ({ headers, body }) =>
      deviceMcpService.result(
        await deviceMcpService.authenticate(headers.authorization),
        body.sessionId,
        body.commandId,
        body.result,
      ),
  );
};
export default deviceMcpRoutes;
