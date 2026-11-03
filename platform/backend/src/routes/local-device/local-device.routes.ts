import { RouteId } from "@archestra/shared";
import { DeviceMcpConfigSchema } from "@archestra/shared/device-mcp";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deviceMcpService } from "@/services/device-mcp";
import { deviceMcpWorkerBundle } from "@/services/device-mcp-worker";
import { localDeviceService } from "@/services/local-device";
import { localDeviceInstallService } from "@/services/local-device-install";
import { constructResponseSchema } from "@/types";
import { LocalDeviceStatusSchema } from "@/types/local-device";

const CodeSchema = z.string().regex(/^[A-Za-z0-9_-]{40,128}$/);
const NameSchema = z.string().trim().min(1).max(128);
const SuccessSchema = z.object({ success: z.literal(true) });
const SessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
const localDeviceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/local-devices",
    {
      schema: {
        operationId: RouteId.ListLocalDevices,
        tags: ["Local devices"],
        response: constructResponseSchema(z.array(LocalDeviceStatusSchema)),
      },
    },
    async (request) =>
      localDeviceService.list(request.organizationId, request.user.id),
  );
  fastify.post(
    "/api/local-devices/enroll",
    {
      schema: {
        operationId: RouteId.EnrollLocalDevice,
        tags: ["Local devices"],
        body: z.object({ name: NameSchema }).strict(),
        response: constructResponseSchema(
          z.object({
            id: z.string().uuid(),
            code: CodeSchema,
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return localDeviceService.enroll(
        request.organizationId,
        request.user.id,
        request.body.name,
      );
    },
  );
  fastify.patch(
    "/api/local-devices/:id",
    {
      schema: {
        operationId: RouteId.RenameLocalDevice,
        tags: ["Local devices"],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ name: NameSchema }).strict(),
        response: constructResponseSchema(LocalDeviceStatusSchema),
      },
    },
    async (request) =>
      localDeviceService.rename(
        request.organizationId,
        request.user.id,
        request.params.id,
        request.body.name,
      ),
  );
  fastify.delete(
    "/api/local-devices/:id",
    {
      schema: {
        operationId: RouteId.RevokeLocalDevice,
        tags: ["Local devices"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(SuccessSchema),
      },
    },
    async (request) =>
      localDeviceService.revoke(
        request.organizationId,
        request.user.id,
        request.params.id,
      ),
  );
  fastify.post(
    "/api/local-devices/install",
    {
      schema: {
        operationId: RouteId.InstallLocalDeviceAgent,
        tags: ["Local devices"],
        body: z
          .object({
            code: CodeSchema,
            platform: z.enum(["darwin", "win32", "linux"]),
            arch: z.enum(["arm64", "x64"]),
            appVersion: z.string().min(1).max(128),
          })
          .strict(),
        response: constructResponseSchema(
          z.object({
            deviceId: z.string().uuid(),
            name: z.string(),
            token: z.string(),
            expiresAt: z.string(),
            created: z.boolean(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return localDeviceInstallService.install(
        request.body,
        request.headers.authorization,
      );
    },
  );
  fastify.post(
    "/api/local-devices/remove-agent",
    {
      schema: {
        operationId: RouteId.RemoveLocalDeviceAgent,
        tags: ["Local devices"],
        body: z.object({}).strict(),
        response: constructResponseSchema(SuccessSchema),
      },
    },
    async (request) =>
      localDeviceService.revokeCredential(request.headers.authorization),
  );
  fastify.post(
    "/api/local-devices/mcp-sync",
    {
      schema: {
        operationId: RouteId.SyncManagedDeviceMcps,
        tags: ["Local devices"],
        body: z.object({}).strict(),
        response: constructResponseSchema(
          z.object({
            installations: z.array(
              z.object({
                id: z.string().uuid(),
                config: DeviceMcpConfigSchema,
                configDigest: z.string(),
              }),
            ),
            workerSha256: z.string().nullable(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = await deviceMcpService.managedManifest(
        request.headers.authorization,
      );
      const worker = result.installations.length
        ? await deviceMcpWorkerBundle()
        : null;
      return { ...result, workerSha256: worker?.sha256 ?? null };
    },
  );
  fastify.post(
    "/api/local-devices/mcp-open",
    {
      schema: {
        operationId: RouteId.OpenManagedDeviceMcp,
        tags: ["Local devices"],
        body: z
          .object({
            id: z.string().uuid(),
            configDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        response: constructResponseSchema(
          z.object({
            token: z.string(),
            config: DeviceMcpConfigSchema,
            configDigest: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return deviceMcpService.openManaged(
        request.headers.authorization,
        request.body.id,
        request.body.configDigest,
      );
    },
  );
  fastify.post(
    "/api/local-devices/mcp-worker",
    {
      schema: {
        operationId: RouteId.GetManagedDeviceMcpWorker,
        tags: ["Local devices"],
        body: z.object({}).strict(),
        response: constructResponseSchema(
          z.object({ source: z.string(), sha256: z.string() }),
        ),
      },
    },
    async (request, reply) => {
      await localDeviceService.authenticate(request.headers.authorization);
      reply.header("Cache-Control", "no-store");
      return deviceMcpWorkerBundle();
    },
  );
  // Proof routes deliberately do not accept a browser session as a device credential.
  fastify.post(
    "/api/local-devices/inspect",
    {
      schema: {
        operationId: RouteId.InspectLocalDeviceEnrollment,
        tags: ["Local devices"],
        body: z.object({ code: CodeSchema }).strict(),
        response: constructResponseSchema(
          z.object({
            deviceId: z.string().uuid(),
            name: z.string(),
            organizationName: z.string(),
            ownerName: z.string(),
            capabilities: z.array(z.literal("local_mcp")),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return localDeviceService.inspect(request.body.code);
    },
  );
  fastify.post(
    "/api/local-devices/redeem",
    {
      schema: {
        operationId: RouteId.RedeemLocalDeviceEnrollment,
        tags: ["Local devices"],
        body: z
          .object({
            code: CodeSchema,
            platform: z.enum(["darwin", "win32", "linux"]),
            arch: z.enum(["arm64", "x64"]),
            appVersion: z.string().trim().min(1).max(128),
          })
          .strict(),
        response: constructResponseSchema(
          z.object({
            deviceId: z.string().uuid(),
            name: z.string(),
            token: z.string(),
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return localDeviceService.redeem(request.body);
    },
  );
  fastify.post(
    "/api/local-devices/session",
    {
      schema: {
        operationId: RouteId.OpenLocalDeviceSession,
        tags: ["Local devices"],
        body: z.object({}).strict(),
        response: constructResponseSchema(SessionSchema),
      },
    },
    async (request) =>
      localDeviceService.session(request.headers.authorization),
  );
  fastify.post(
    "/api/local-devices/heartbeat",
    {
      schema: {
        operationId: RouteId.HeartbeatLocalDevice,
        tags: ["Local devices"],
        body: SessionSchema,
        response: constructResponseSchema(
          SuccessSchema.extend({ name: z.string() }),
        ),
      },
    },
    async (request) =>
      localDeviceService.heartbeat(
        request.headers.authorization,
        request.body.sessionId,
      ),
  );
  fastify.post(
    "/api/local-devices/disconnect",
    {
      schema: {
        operationId: RouteId.DisconnectLocalDevice,
        tags: ["Local devices"],
        body: SessionSchema,
        response: constructResponseSchema(SuccessSchema),
      },
    },
    async (request) =>
      localDeviceService.disconnect(
        request.headers.authorization,
        request.body.sessionId,
      ),
  );
};
export default localDeviceRoutes;
