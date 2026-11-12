import { RouteId } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { DESKTOP_TUNNEL_PREFIX } from "@/routes/route-paths";
import { servedProgramService } from "@/services/archestra-cli/served-program";
import {
  DESKTOP_BRIDGE_CHANNEL,
  desktopBridgeControlService,
} from "@/services/desktop-mcp/desktop-bridge-control";
import { removeDesktopDeviceForTunnelClient } from "@/services/desktop-mcp/desktop-device";
import { listDesktopDeviceServerConfigs } from "@/services/desktop-mcp/desktop-device-config";
import { desktopMcpInstallService } from "@/services/desktop-mcp/desktop-mcp-install";
import {
  DESKTOP_TUNNEL_MAX_COMMANDS_PER_POLL,
  desktopTunnelService,
} from "@/services/desktop-mcp/desktop-tunnel";
import {
  ApiError,
  constructResponseSchema,
  type DesktopDevice,
  DesktopMcpJsonRpcMessageSchema,
  type DesktopMcpRequest,
} from "@/types";
import { extractAuditSourceIp } from "@/utils/audit-snapshot";
import { clientDisconnectSignal } from "@/utils/client-disconnect-signal";

/**
 * The endpoints the tunnel client of a desktop device calls. They follow the
 * wire protocol of the OpenAI tunnel-client (its docs/protocol.md), with three
 * differences: the tunnel metadata also lists the desktop MCP catalog items the
 * user installed, it describes the program this deployment serves for the
 * client's target (the client reports its own with the `X-Tunnel-Client-*`
 * headers), and commands carry no shard token. Every request authenticates with
 * the device key as a bearer token; there is no platform session.
 */
const desktopTunnelRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    `${DESKTOP_TUNNEL_PREFIX}/:tunnelId`,
    {
      schema: {
        operationId: RouteId.GetDesktopTunnel,
        description:
          "Tunnel metadata for the tunnel client, with the desktop MCP catalog items its user installed and the command or URL of each.",
        tags: ["Desktop Tunnel"],
        params: TunnelParamsSchema,
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            catalog_items: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                command: z.string().nullable(),
                url: z.string().nullable(),
                enabled: z.boolean(),
              }),
            ),
            // The program this deployment serves for the target in the
            // X-Tunnel-Client-Target header. Null when the header is missing
            // or not a known target, or when there is no file for the target.
            program: z
              .object({
                // From the manifest of the download folder; null without one.
                version: z.string().nullable(),
                // SHA-256 of the served file, in lower-case hex.
                sha256: z.string(),
                auto_update: z.boolean(),
              })
              .nullable(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const device = await authenticate(request);
      const program = await servedProgramService.getServedProgram(
        readHeader(request, "x-tunnel-client-target"),
      );
      reply.header("Cache-Control", "no-store");
      return {
        id: request.params.tunnelId,
        name: device.name,
        description: "",
        catalog_items: (await listDesktopDeviceServerConfigs(device)).map(
          (server) => ({
            id: server.catalogId,
            name: server.name,
            command: server.command,
            url: server.url,
            enabled: server.enabled,
          }),
        ),
        program: program && {
          version: program.version,
          sha256: program.sha256,
          auto_update: config.mcpBridge.autoUpdateEnabled,
        },
      };
    },
  );

  fastify.get(
    `${DESKTOP_TUNNEL_PREFIX}/:tunnelId/poll`,
    {
      schema: {
        operationId: RouteId.PollDesktopTunnel,
        description:
          "Long poll for the MCP messages that wait for the device. Answers 204 when none came before the wait ended.",
        tags: ["Desktop Tunnel"],
        params: TunnelParamsSchema,
        querystring: z.object({
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(DESKTOP_TUNNEL_MAX_COMMANDS_PER_POLL)
            .default(DESKTOP_TUNNEL_MAX_COMMANDS_PER_POLL),
          timeout_ms: z.coerce
            .number()
            .int()
            .min(0)
            .max(MAX_REQUESTED_POLL_WAIT_MS)
            .default(DEFAULT_REQUESTED_POLL_WAIT_MS),
        }),
        response: {
          ...constructResponseSchema(
            z.object({ commands: z.array(PolledCommandSchema) }),
          ),
          // No MCP message came before the wait ended.
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      const device = await authenticate(request);
      desktopMcpInstallService.completeReadyChannels(
        device,
        readReadyChannels(request),
      );
      const commands = await desktopTunnelService.poll({
        device,
        program: {
          version: readHeader(request, "x-tunnel-client-version"),
          target: readHeader(request, "x-tunnel-client-target"),
          sha256: readHeader(request, "x-tunnel-client-sha256"),
        },
        limit: request.query.limit,
        timeoutMs: request.query.timeout_ms,
        signal: clientDisconnectSignal({ request, reply }),
      });
      reply.header("Cache-Control", "no-store");
      if (commands.length === 0) {
        return reply.status(204).send();
      }
      return { commands: commands.map(toPolledCommand) };
    },
  );

  fastify.post(
    `${DESKTOP_TUNNEL_PREFIX}/:tunnelId/response`,
    {
      schema: {
        operationId: RouteId.RespondDesktopTunnel,
        description: "The tunnel client's answer for one polled MCP message.",
        tags: ["Desktop Tunnel"],
        params: TunnelParamsSchema,
        body: z.object({
          request_id: z.string().uuid(),
          channel: z.string().optional(),
          resp_json: DesktopMcpJsonRpcMessageSchema.nullish(),
          resp_headers: z.record(z.string(), z.array(z.string())).optional(),
          resp_code: z.number().int(),
          resp_type: ResponseTypeSchema.default("jsonrpc_response"),
          resp_timing: z.unknown().optional(),
        }),
        response: constructResponseSchema(z.object({ status: z.string() })),
      },
    },
    async (request) => {
      const device = await authenticate(request);
      const { body } = request;
      if (body.resp_type === "jsonrpc_notify") {
        // The tunnel client reports its own state on the reserved channel.
        // Every other notification is progress of a request that is still in
        // operation; progress is not delivered to the caller yet, so there
        // is nothing to store.
        if (body.channel === DESKTOP_BRIDGE_CHANNEL && body.resp_json) {
          await desktopBridgeControlService.recordState({
            device,
            message: body.resp_json,
          });
        }
        return { status: "ok" };
      }
      const acknowledgmentOnly = body.resp_type !== "jsonrpc_response";
      if (!acknowledgmentOnly && !body.resp_json) {
        throw new ApiError(400, "A jsonrpc_response needs resp_json.");
      }
      const stored = await desktopTunnelService.respond({
        device,
        requestId: body.request_id,
        response: body.resp_json ?? null,
        acknowledgmentOnly,
      });
      if (!stored) {
        throw new ApiError(404, "This request is not waiting for a response.");
      }
      return { status: "ok" };
    },
  );

  fastify.delete(
    `${DESKTOP_TUNNEL_PREFIX}/:tunnelId`,
    {
      schema: {
        operationId: RouteId.DeleteDesktopTunnel,
        description:
          "Called by the tunnel client when its user uninstalls it: remove the device. Its device key stops working.",
        tags: ["Desktop Tunnel"],
        params: TunnelParamsSchema,
        response: constructResponseSchema(z.object({ status: z.string() })),
      },
    },
    async (request) => {
      const device = await authenticate(request);
      await removeDesktopDeviceForTunnelClient({
        device,
        request: {
          id: request.id,
          method: request.method,
          path: `${DESKTOP_TUNNEL_PREFIX}/${request.params.tunnelId}`,
          route: request.routeOptions.url ?? null,
          sourceIp: extractAuditSourceIp(request),
          userAgent: request.headers["user-agent"] ?? null,
        },
      });
      return { status: "ok" };
    },
  );
};

export default desktopTunnelRoutes;

// === Internal helpers

/** The poll wait the OpenAI tunnel client asks for when not configured. */
const DEFAULT_REQUESTED_POLL_WAIT_MS = 30_000;
/** The largest poll wait the OpenAI tunnel client can ask for. */
const MAX_REQUESTED_POLL_WAIT_MS = 600_000;
const MAX_READY_CHANNELS = 64;
const MAX_CHANNEL_NAME_LENGTH = 128;

const TunnelParamsSchema = z.object({
  tunnelId: z.string().regex(/^tunnel_[a-z0-9]{32}$/),
});

const ResponseTypeSchema = z.enum([
  "jsonrpc_response",
  "jsonrpc_notify",
  "notify_ack",
  "session_termination_response",
]);

const PolledCommandSchema = z.object({
  request_id: z.string(),
  command_type: z.literal("jsonrpc"),
  channel: z.string(),
  created_at: z.string(),
  response_timeout: z.string(),
  headers: z.record(z.string(), z.array(z.string())),
  jsonrpc: DesktopMcpJsonRpcMessageSchema,
});

const ServerInfoSchema = z.object({
  channels: z
    .array(z.object({ name: z.string().min(1).max(MAX_CHANNEL_NAME_LENGTH) }))
    .max(MAX_READY_CHANNELS),
});

async function authenticate(
  request: FastifyRequest<{ Params: { tunnelId: string } }>,
): Promise<DesktopDevice> {
  const header = request.headers.authorization;
  const deviceKey = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  return desktopTunnelService.authenticate({
    tunnelId: request.params.tunnelId,
    deviceKey,
  });
}

/** The one value of a header, or null when it is missing or sent twice. */
function readHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

/**
 * Channels the tunnel client reports as having an MCP server in operation,
 * from its `X-Tunnel-MCP-Server-Info` header. A missing or malformed header
 * means none, as the tunnel protocol says.
 */
function readReadyChannels(request: FastifyRequest): string[] {
  const header = request.headers["x-tunnel-mcp-server-info"];
  if (typeof header !== "string") return [];
  let json: unknown;
  try {
    json = JSON.parse(header);
  } catch {
    return [];
  }
  const parsed = ServerInfoSchema.safeParse(json);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.channels.map((channel) => channel.name))];
}

function toPolledCommand(
  request: DesktopMcpRequest,
): z.infer<typeof PolledCommandSchema> {
  return {
    request_id: request.id,
    command_type: "jsonrpc",
    channel: request.channel,
    created_at: request.createdAt.toISOString(),
    // The time left until the caller stops waiting, anchored by the tunnel
    // client at the moment this poll answer arrives.
    response_timeout: `${Math.max(0, request.expiresAt.getTime() - Date.now())}ms`,
    headers: {},
    jsonrpc: request.payload,
  };
}
