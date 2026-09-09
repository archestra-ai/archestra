import { createHash, randomBytes } from "node:crypto";
import { CacheKey, cacheManager } from "@/cache-manager";
import ConnectionSetupModel from "@/models/connection-setup";
import { ApiError } from "@/types";
import type {
  ConnectionSetupClientId,
  ConnectionSetupPlatform,
} from "@/types/connection-setup";

class ClientConnectionService {
  async start(params: {
    clientId: ConnectionSetupClientId;
    platform: ConnectionSetupPlatform;
  }) {
    const id = randomBytes(24).toString("hex");
    const deviceCode = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + TTL;
    const pending: Pending = {
      ...params,
      id,
      expiresAt,
      pollHash: hash(deviceCode),
      tokenHash: hash(`archestra_con_${deviceCode}`),
      tokenStart: `archestra_con_${deviceCode}`.slice(0, 22),
    };
    await cacheManager.set(
      `${CacheKey.ClientConnection}-pending-${id}`,
      pending,
      TTL,
    );
    await cacheManager.set(
      `${CacheKey.ClientConnection}-poll-${pending.pollHash}`,
      { status: "pending", expiresAt },
      TTL,
    );
    return {
      id,
      deviceCode,
      userCode: userCode(id),
      expiresAt: new Date(expiresAt).toISOString(),
      interval: 3,
      verificationPath: `/connection?clientId=${params.clientId}&platform=${params.platform}&connectRequest=${id}`,
    };
  }

  async get(id: string) {
    const pending = await cacheManager.get<Pending>(
      `${CacheKey.ClientConnection}-pending-${id}`,
    );
    if (!pending || pending.expiresAt <= Date.now())
      throw new ApiError(
        410,
        "Connection request expired or already answered. Start the installer again.",
      );
    return {
      clientId: pending.clientId,
      platform: pending.platform,
      userCode: userCode(id),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async decide(params: {
    id: string;
    setupId?: string;
    userId: string;
    organizationId: string;
  }) {
    // Consuming the browser request serializes competing approvals and denials across replicas.
    const pending = await cacheManager.getAndDelete<Pending>(
      `${CacheKey.ClientConnection}-pending-${params.id}`,
    );
    if (!pending || pending.expiresAt <= Date.now())
      throw new ApiError(
        410,
        "Connection request expired or already answered. Start the installer again.",
      );
    let approved = false;
    if (params.setupId) {
      approved = await ConnectionSetupModel.bindClientConnection({
        setupId: params.setupId,
        userId: params.userId,
        organizationId: params.organizationId,
        clientId: pending.clientId,
        platform: pending.platform,
        tokenHash: pending.tokenHash,
        tokenStart: pending.tokenStart,
        expiresAt: new Date(pending.expiresAt),
      });
    }
    await cacheManager.set(
      `${CacheKey.ClientConnection}-poll-${pending.pollHash}`,
      {
        status: approved ? "approved" : "denied",
        expiresAt: pending.expiresAt,
      },
      Math.max(1, pending.expiresAt - Date.now()),
    );
    if (params.setupId && !approved)
      throw new ApiError(
        400,
        "The setup must be unused, belong to you, and match the requested client and operating system. Start the installer again.",
      );
    return {
      status: approved ? ("approved" as const) : ("denied" as const),
      clientId: pending.clientId,
      platform: pending.platform,
    };
  }

  async poll(
    deviceCode: string,
  ): Promise<{ status: "pending" | "approved" | "denied" | "expired" }> {
    const state = await cacheManager.get<{
      status: "pending" | "approved" | "denied";
      expiresAt: number;
    }>(`${CacheKey.ClientConnection}-poll-${hash(deviceCode)}`);
    return {
      status: state && state.expiresAt > Date.now() ? state.status : "expired",
    };
  }
}

export const clientConnectionService = new ClientConnectionService();

// === Internal helpers
const TTL = 10 * 60 * 1000;
interface Pending {
  id: string;
  clientId: ConnectionSetupClientId;
  platform: ConnectionSetupPlatform;
  expiresAt: number;
  pollHash: string;
  tokenHash: string;
  tokenStart: string;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function userCode(id: string) {
  return `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();
}
