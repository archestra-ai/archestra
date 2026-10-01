import { createHash, randomBytes } from "node:crypto";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
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
    const pending = await readConnectionState<Pending>(
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
    const pending = await takeConnectionState<Pending>(
      `${CacheKey.ClientConnection}-pending-${params.id}`,
    );
    if (!pending || pending.expiresAt <= Date.now())
      throw new ApiError(
        410,
        "Connection request expired or already answered. Start the installer again.",
      );
    let approved = false;
    if (params.setupId) {
      try {
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
      } catch (error) {
        await restorePending(pending);
        throw unavailable(error);
      }
    }
    try {
      await publishPoll(pending, approved ? "approved" : "denied");
    } catch (error) {
      if (approved) {
        // The bound ticket is durable; polling can recover without a new approval.
        return {
          status: "approved" as const,
          clientId: pending.clientId,
          platform: pending.platform,
        };
      }
      await restorePending(pending);
      throw unavailable(error);
    }
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
    const key =
      `${CacheKey.ClientConnection}-poll-${hash(deviceCode)}` as const;
    const state = await readConnectionState<PollState>(key);
    if (!state || state.expiresAt <= Date.now()) return { status: "expired" };
    if (state.status !== "pending") return { status: state.status };
    if (!(await durableApproval(deviceCode))) return { status: "pending" };
    try {
      await cacheManager.set(
        key,
        { status: "approved", expiresAt: state.expiresAt },
        Math.max(1, state.expiresAt - Date.now()),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    return { status: "approved" };
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
interface PollState {
  status: "pending" | "approved" | "denied";
  expiresAt: number;
}
const CACHE_UNAVAILABLE =
  "Connection status is temporarily unavailable. Retry this request. Do not start a new installer.";

async function readConnectionState<T>(
  key: AllowedCacheKey,
): Promise<T | undefined> {
  try {
    return await cacheManager.get<T>(key, { throwOnError: true });
  } catch (error) {
    throw unavailable(error);
  }
}

async function takeConnectionState<T>(
  key: AllowedCacheKey,
): Promise<T | undefined> {
  try {
    return await cacheManager.getAndDelete<T>(key, { throwOnError: true });
  } catch (error) {
    throw unavailable(error);
  }
}

function unavailable(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(503, CACHE_UNAVAILABLE);
}

async function publishPoll(
  pending: Pending,
  status: "approved" | "denied",
): Promise<void> {
  await cacheManager.set(
    `${CacheKey.ClientConnection}-poll-${pending.pollHash}`,
    { status, expiresAt: pending.expiresAt },
    Math.max(1, pending.expiresAt - Date.now()),
  );
}

async function restorePending(pending: Pending): Promise<void> {
  const ttl = pending.expiresAt - Date.now();
  if (ttl <= 0) return;
  try {
    await cacheManager.set(
      `${CacheKey.ClientConnection}-pending-${pending.id}`,
      pending,
      ttl,
    );
  } catch {
    return;
  }
}

async function durableApproval(deviceCode: string): Promise<boolean> {
  try {
    const bound = await ConnectionSetupModel.findByToken(
      `archestra_con_${deviceCode}`,
    );
    return Boolean(bound && new Date(bound.expiresAt).getTime() > Date.now());
  } catch (error) {
    throw unavailable(error);
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function userCode(id: string) {
  return `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();
}
