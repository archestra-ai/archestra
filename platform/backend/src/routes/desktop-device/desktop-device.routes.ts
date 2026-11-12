import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import DesktopDeviceModel from "@/models/desktop-device";
import {
  DESKTOP_DEVICE_SIGN_IN_PATH,
  DESKTOP_DEVICES_PATH,
} from "@/routes/route-paths";
import { desktopBridgeControlService } from "@/services/desktop-mcp/desktop-bridge-control";
import {
  assertServerOfDevice,
  getDesktopDeviceOfUser,
  listDesktopDevicesForUser,
  updateDesktopDeviceServer,
} from "@/services/desktop-mcp/desktop-device";
import { desktopDeviceSignInService } from "@/services/desktop-mcp/desktop-device-sign-in";
import {
  ApiError,
  ConnectionSetupPlatformSchema,
  constructResponseSchema,
  type DesktopDevice,
  DesktopMcpServerStateSchema,
} from "@/types";

/**
 * Devices: the computers that run the tunnel client (the "MCP bridge") for
 * desktop MCP servers. A user signs a device in with an approval in the
 * browser, sees it here with the state of its MCP servers, controls each MCP
 * server, and can remove the device. The program itself is downloaded from
 * the archestra-cli routes.
 */
const desktopDeviceRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    DESKTOP_DEVICES_PATH,
    {
      schema: {
        operationId: RouteId.GetDesktopDevices,
        description:
          "The signed-in user's devices, with the state of each desktop MCP catalog item on them.",
        tags: ["Desktop Devices"],
        response: constructResponseSchema(z.array(DesktopDeviceViewSchema)),
      },
    },
    async (request) => listDesktopDevicesForUser({ userId: request.user.id }),
  );

  fastify.delete(
    `${DESKTOP_DEVICES_PATH}/:id`,
    {
      schema: {
        operationId: RouteId.DeleteDesktopDevice,
        description:
          "Remove the signed-in user's device. Its device key stops working.",
        tags: ["Desktop Devices"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request) => {
      const device = await DesktopDeviceModel.deleteForUser({
        id: request.params.id,
        userId: request.user.id,
      });
      if (!device) {
        throw new ApiError(404, "Device not found");
      }
      return { success: true };
    },
  );

  fastify.put(
    `${DESKTOP_DEVICES_PATH}/:id/servers/:catalogId`,
    {
      schema: {
        operationId: RouteId.UpdateDesktopDeviceServer,
        description:
          "Start or stop one MCP server on the signed-in user's device. A stopped MCP server stays stopped.",
        tags: ["Desktop Devices"],
        params: ServerParamsSchema,
        body: z.object({ enabled: z.boolean() }),
        response: constructResponseSchema(DesktopDeviceViewSchema),
      },
    },
    async (request) => {
      const device = await getDesktopDeviceOfUser({
        id: request.params.id,
        userId: request.user.id,
      });
      return updateDesktopDeviceServer({
        device,
        catalogId: request.params.catalogId,
        enabled: request.body.enabled,
      });
    },
  );

  fastify.post(
    `${DESKTOP_DEVICES_PATH}/:id/servers/:catalogId/restart`,
    {
      schema: {
        operationId: RouteId.RestartDesktopDeviceServer,
        description:
          "Make the tunnel client stop one MCP server on the signed-in user's device and start it again.",
        tags: ["Desktop Devices"],
        params: ServerParamsSchema,
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request) => {
      const { device, catalogId } = await serverOfCaller(request);
      await desktopBridgeControlService.restartServer({ device, catalogId });
      return { success: true };
    },
  );

  fastify.post(
    `${DESKTOP_DEVICES_PATH}/:id/servers/:catalogId/test`,
    {
      schema: {
        operationId: RouteId.TestDesktopDeviceServer,
        description:
          "Ask one MCP server on the signed-in user's device for its tool list, through the tunnel. Nothing is stored.",
        tags: ["Desktop Devices"],
        params: ServerParamsSchema,
        response: constructResponseSchema(
          z.object({ toolCount: z.number().int(), durationMs: z.number() }),
        ),
      },
    },
    async (request) => {
      const { device, catalogId } = await serverOfCaller(request);
      return desktopBridgeControlService.testServer({ device, catalogId });
    },
  );

  fastify.get(
    `${DESKTOP_DEVICES_PATH}/:id/servers/:catalogId/log`,
    {
      schema: {
        operationId: RouteId.GetDesktopDeviceServerLog,
        description:
          "The last lines one MCP server on the signed-in user's device wrote to stderr.",
        tags: ["Desktop Devices"],
        params: ServerParamsSchema,
        response: constructResponseSchema(
          z.object({ lines: z.array(z.string()) }),
        ),
      },
    },
    async (request) => {
      const { device, catalogId } = await serverOfCaller(request);
      return {
        lines: await desktopBridgeControlService.readServerLog({
          device,
          catalogId,
        }),
      };
    },
  );

  fastify.post(
    DESKTOP_DEVICE_SIGN_IN_PATH,
    {
      schema: {
        operationId: RouteId.StartDesktopDeviceSignIn,
        description:
          "Called by the tunnel client: start a sign-in that its user approves in the browser.",
        tags: ["Desktop Devices"],
        body: z.object({
          /** Hostname of the computer, shown on the approval page. */
          deviceName: z.string().trim().min(1).max(64),
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
      return desktopDeviceSignInService.start(request.body);
    },
  );

  fastify.post(
    `${DESKTOP_DEVICE_SIGN_IN_PATH}/poll`,
    {
      schema: {
        operationId: RouteId.PollDesktopDeviceSignIn,
        description:
          "Called by the tunnel client: poll for the user's answer to its sign-in.",
        tags: ["Desktop Devices"],
        body: z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["pending", "approved", "denied", "expired"]),
            tunnelId: z.string().optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      await rateLimit({ ip: request.ip, action: "poll", maxRequests: 120 });
      reply.header("Cache-Control", "no-store");
      return desktopDeviceSignInService.poll(request.body.deviceCode);
    },
  );

  fastify.get(
    `${DESKTOP_DEVICE_SIGN_IN_PATH}/:id`,
    {
      schema: {
        operationId: RouteId.GetDesktopDeviceSignIn,
        description: "A pending device sign-in, for the approval page.",
        tags: ["Desktop Devices"],
        params: SignInIdSchema,
        response: constructResponseSchema(
          z.object({
            deviceName: z.string(),
            platform: ConnectionSetupPlatformSchema,
            userCode: z.string(),
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return desktopDeviceSignInService.get(request.params.id);
    },
  );

  fastify.post(
    `${DESKTOP_DEVICE_SIGN_IN_PATH}/:id/decision`,
    {
      schema: {
        operationId: RouteId.DecideDesktopDeviceSignIn,
        description:
          "Approve or deny a device sign-in. Approval registers the device for the signed-in user and replaces their earlier device.",
        tags: ["Desktop Devices"],
        params: SignInIdSchema,
        body: z.object({ decision: z.enum(["approve", "deny"]) }),
        response: constructResponseSchema(
          z.object({ status: z.enum(["approved", "denied"]) }),
        ),
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = await desktopDeviceSignInService.decide({
        id: request.params.id,
        decision: request.body.decision,
        userId: request.user.id,
        organizationId: request.organizationId,
      });
      request.auditBefore = { status: "pending" };
      request.auditAfter = result;
      return { status: result.status };
    },
  );
};

export default desktopDeviceRoutes;

// === Internal helpers

const SignInIdSchema = z.object({ id: z.string().regex(/^[a-f0-9]{48}$/) });

const DesktopDeviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: ConnectionSetupPlatformSchema,
  online: z.boolean(),
  lastPolledAt: z.date().nullable(),
  createdAt: z.date(),
  programVersion: z.string().nullable(),
  programUpdate: z.object({ version: z.string().nullable() }).nullable(),
  programAutoUpdate: z.boolean(),
  servers: z.array(
    z.object({
      catalogId: z.string(),
      name: z.string(),
      state: DesktopMcpServerStateSchema.nullable(),
      lastError: z.string().nullable(),
      command: z.string().nullable(),
      url: z.string().nullable(),
      enabled: z.boolean(),
      toolCount: z.number().int(),
    }),
  ),
});

const ServerParamsSchema = z.object({
  id: z.string().uuid(),
  catalogId: z.string().uuid(),
});

/** The caller's own device and one MCP server on it, or a 404. */
async function serverOfCaller(request: {
  params: z.infer<typeof ServerParamsSchema>;
  user: { id: string };
}): Promise<{ device: DesktopDevice; catalogId: string }> {
  const device = await getDesktopDeviceOfUser({
    id: request.params.id,
    userId: request.user.id,
  });
  await assertServerOfDevice(device, request.params.catalogId);
  return { device, catalogId: request.params.catalogId };
}

async function rateLimit(params: {
  ip: string;
  action: string;
  maxRequests: number;
}): Promise<void> {
  if (
    await isRateLimited(
      `${CacheKey.DesktopDeviceSignInRateLimit}-${params.action}-${params.ip}`,
      { windowMs: 60_000, maxRequests: params.maxRequests },
    )
  ) {
    throw new ApiError(
      429,
      "Too many sign-in requests. Try again in one minute.",
    );
  }
}
