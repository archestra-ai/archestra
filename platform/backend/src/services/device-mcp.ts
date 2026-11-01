import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceMcpConfigSchema } from "@archestra/shared/device-mcp";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import DeviceMcpModel from "@/models/device-mcp";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import MemberModel from "@/models/member";
import { ApiError } from "@/types";
import type { DeviceMcpConnection } from "@/types/device-mcp";

class DeviceMcpService {
  async cleanupExpired() {
    await DeviceMcpModel.cleanupExpired();
  }

  async assertEnabled(organizationId: string) {
    if (!(await DeviceMcpModel.enabled(organizationId)))
      throw new ApiError(
        403,
        "Device MCP servers are disabled. An administrator can enable them in MCP settings.",
      );
  }

  async pair(params: {
    organizationId: string;
    userId: string;
    catalogId: string;
    name: string;
    replaceExisting: boolean;
  }) {
    const config = await this.authorizedConfig(params);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const configDigest = digest(config);
    const device = await DeviceMcpModel.createPairing(
      {
        organizationId: params.organizationId,
        userId: params.userId,
        catalogId: params.catalogId,
        name: params.name,
        configDigest,
        configVersion: config.version,
        pairingHash: digest(code),
        pairingExpiresAt: expiresAt,
      },
      params.replaceExisting,
    );
    return {
      id: device.id,
      code,
      expiresAt: expiresAt.toISOString(),
      config,
      configDigest,
    };
  }

  async inspect(code: string) {
    const device = await DeviceMcpModel.findPairing(digest(code));
    if (!device)
      throw new ApiError(
        401,
        "Pairing code expired or was already used. Create a new code in the registry.",
      );
    const config = await this.validateDevice(device);
    return { config, configDigest: device.configDigest };
  }

  async redeem(params: {
    code: string;
    configDigest: string;
    platform: "darwin" | "win32";
    protocolVersion: 1;
  }) {
    const device = await DeviceMcpModel.findPairing(digest(params.code));
    if (!device)
      throw new ApiError(
        401,
        "Pairing code expired or was already used. Create a new code in the registry.",
      );
    const config = await this.validateDevice(device);
    if (params.configDigest !== device.configDigest)
      throw new ApiError(
        409,
        "Launch configuration changed. Review it and create a new pairing code.",
      );
    const token = randomBytes(32).toString("base64url");
    await DeviceMcpModel.redeem(device.id, digest(params.code), digest(token));
    return {
      deviceId: device.id,
      token,
      config,
      configDigest: device.configDigest,
    };
  }

  async authenticate(authorization: string | undefined) {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 256)
      throw new ApiError(401, "Device bearer token required");
    const device = await DeviceMcpModel.findToken(
      digest(authorization.slice(7)),
    );
    if (!device)
      throw new ApiError(
        401,
        "Device token was revoked or expired. Pair again from the registry.",
      );
    await this.validateDevice(device);
    return device;
  }

  async session(device: DeviceMcpConnection, configDigest: string) {
    if (device.configDigest !== configDigest)
      throw new ApiError(
        409,
        "Configuration changed. Review and pair this device again.",
      );
    const sessionId = randomUUID();
    await DeviceMcpModel.session(device, sessionId);
    return { sessionId };
  }

  async poll(device: DeviceMcpConnection, sessionId: string, ready: boolean) {
    const command = await DeviceMcpModel.poll(device, sessionId, ready);
    return {
      command: command
        ? {
            id: command.id,
            toolName: command.toolName,
            arguments: command.arguments,
            expiresAt: command.expiresAt.toISOString(),
          }
        : null,
    };
  }

  async result(
    device: DeviceMcpConnection,
    sessionId: string,
    commandId: string,
    value: unknown,
  ) {
    const parsed = CallToolResultSchema.safeParse(value);
    if (!parsed.success) throw new ApiError(400, "Invalid MCP tool result");
    const result = parsed.data;
    if (JSON.stringify(result).length > 2 * 1024 * 1024)
      throw new ApiError(413, "Device result exceeds 2 MiB");
    await DeviceMcpModel.result(
      device,
      sessionId,
      commandId,
      result,
      digest(result),
    );
    return { success: true as const };
  }

  async list(params: {
    organizationId: string;
    userId: string;
    catalogId: string;
  }) {
    const config = await this.authorizedConfig(params);
    const currentDigest = digest(config);
    return (
      await DeviceMcpModel.list(
        params.organizationId,
        params.userId,
        params.catalogId,
      )
    ).map((device) => ({
      id: device.id,
      name: device.name,
      configVersion: device.configVersion,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      status: device.revokedAt
        ? ("revoked" as const)
        : device.configDigest !== currentDigest
          ? ("update_required" as const)
          : !device.tokenHash ||
              !device.tokenExpiresAt ||
              device.tokenExpiresAt.getTime() <= Date.now()
            ? ("setup_required" as const)
            : device.sessionId &&
                device.lastSeenAt &&
                device.lastSeenAt.getTime() >= Date.now() - 15_000
              ? ("online" as const)
              : ("offline" as const),
    }));
  }

  async revoke(params: { id: string; organizationId: string; userId: string }) {
    // Revocation stays available after an administrator turns the capability off.
    await DeviceMcpModel.revoke(
      params.id,
      params.organizationId,
      params.userId,
    );
    return { success: true as const };
  }

  async callTool(params: {
    organizationId: string;
    userId: string;
    catalogId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }) {
    const config = await this.authorizedConfig(params);
    if (!config.tools.some((tool) => tool.name === params.toolName))
      throw new ApiError(
        404,
        "Tool is not in the approved device configuration",
      );
    if (JSON.stringify(params.arguments).length > 256 * 1024)
      throw new ApiError(413, "Device tool arguments exceed 256 KiB");
    const devices = await DeviceMcpModel.list(
      params.organizationId,
      params.userId,
      params.catalogId,
    );
    const device = devices.find((item) => !item.revokedAt);
    if (!device)
      throw new ApiError(
        409,
        "Connect your own device from this server’s registry entry before using this tool.",
      );
    await this.validateDevice(device);
    if (params.abortSignal?.aborted)
      throw new ApiError(409, "Device call was cancelled before dispatch");
    const command = await DeviceMcpModel.enqueue(
      device,
      params.toolName,
      params.arguments,
    );
    try {
      while (Date.now() < command.expiresAt.getTime()) {
        if (params.abortSignal?.aborted)
          throw new ApiError(
            409,
            "Device call was cancelled. If it already reached the device, its outcome is unknown; it will not be replayed.",
          );
        // Recheck org, membership, registry permissions and launch revision while waiting.
        await this.validateDevice(device);
        const current = await DeviceMcpModel.findToken(device.tokenHash ?? "");
        if (!current || current.sessionId !== command.sessionId)
          throw new ApiError(
            409,
            "Device disconnected or reconnected during the call. Its outcome is unknown; it will not be replayed.",
          );
        const state = await DeviceMcpModel.readCommand(command.id, device.id);
        if (state?.status === "completed")
          return CallToolResultSchema.parse(state.result);
        if (!state || state.status === "unknown")
          throw new ApiError(
            409,
            "Device call outcome is unknown. Inspect the local application before retrying.",
          );
        if (
          !current.lastSeenAt ||
          current.lastSeenAt.getTime() < Date.now() - 15_000
        )
          throw new ApiError(
            409,
            "Device disconnected during the call. Its outcome is unknown; it will not be replayed.",
          );
        await delay(250, undefined, { signal: params.abortSignal });
      }
      throw new ApiError(
        504,
        "Device call timed out. Its outcome is unknown; it will not be replayed. Inspect the local application before retrying.",
      );
    } finally {
      await DeviceMcpModel.expireCommand(command.id);
    }
  }

  private async validateDevice(device: DeviceMcpConnection) {
    const config = await this.authorizedConfig(device);
    if (digest(config) !== device.configDigest)
      throw new ApiError(
        409,
        "Device configuration was updated. Review the new launch instructions and pair again from the registry.",
      );
    return config;
  }

  private async authorizedConfig(params: {
    organizationId: string;
    userId: string;
    catalogId: string;
  }) {
    await this.assertEnabled(params.organizationId);
    if (
      isServiceAccountUserId(params.userId) ||
      params.userId === "system" ||
      !(
        await MemberModel.findByUserIdsInOrganization({
          organizationId: params.organizationId,
          userIds: [params.userId],
        })
      ).length
    )
      throw new ApiError(
        403,
        "A current human organization member is required for device tools",
      );
    const catalog = await InternalMcpCatalogModel.findById(params.catalogId, {
      organizationId: params.organizationId,
      userId: params.userId,
      expandSecrets: false,
      accessAction: "use",
    });
    if (
      !catalog ||
      catalog.organizationId !== params.organizationId ||
      catalog.serverType !== "device"
    )
      throw new ApiError(404, "Device server not found");
    const parsed = DeviceMcpConfigSchema.safeParse(catalog.deviceConfig);
    if (!parsed.success)
      throw new ApiError(
        409,
        "Device server requires approved launch instructions",
      );
    return parsed.data;
  }
}

export const deviceMcpService = new DeviceMcpService();

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
