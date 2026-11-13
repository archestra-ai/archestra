import { createHash, randomBytes } from "node:crypto";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import DesktopDeviceModel from "@/models/desktop-device";
import { ApiError, type ConnectionSetupPlatform } from "@/types";
import {
  DESKTOP_DEVICE_KEY_PREFIX,
  desktopTunnelService,
} from "./desktop-tunnel";

/**
 * Sign-in of a tunnel client, approved by its user in the browser.
 *
 * The tunnel client starts a request and opens the approval page. The user
 * signs in, checks the displayed code, and approves. The tunnel client polls
 * with its device code until then. Its device key is derived from that device
 * code, so the raw key exists only on the device: this service stores hashes.
 *
 * A setup code lets the MCP bridge setup dialog take the place of the
 * approval page. The dialog gets a code for its user and puts it in the
 * command it shows; the tunnel client sends it with its request; the dialog
 * then finds that request and approves it in place. The code only links the
 * request to the dialog: the user still approves, and compares the code.
 *
 * Pending requests live in the shared cache, so each step can land on a
 * different backend copy. The flow mirrors the coding-agent approval in
 * `services/client-connection.ts`.
 */
class DesktopDeviceSignInService {
  /**
   * A setup code for the signed-in user's setup dialog. It goes into the
   * command the dialog shows, and expires after {@link SETUP_CODE_TTL_MS}.
   */
  async createSetupCode(params: { userId: string }) {
    const setupCode = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + SETUP_CODE_TTL_MS;
    await cacheManager.set(
      setupKey(setupCode),
      { userId: params.userId, expiresAt, requestId: null } satisfies Setup,
      SETUP_CODE_TTL_MS,
    );
    return { setupCode, expiresAt: new Date(expiresAt).toISOString() };
  }

  async start(params: {
    deviceName: string;
    platform: ConnectionSetupPlatform;
    /** From the command of a setup dialog; unknown or expired is ignored. */
    setupCode?: string;
  }) {
    const id = randomBytes(24).toString("hex");
    const deviceCode = randomBytes(32).toString("base64url");
    const deviceKey = `${DESKTOP_DEVICE_KEY_PREFIX}${deviceCode}`;
    const expiresAt = Date.now() + TTL_MS;
    const pending: Pending = {
      deviceName: params.deviceName,
      platform: params.platform,
      id,
      expiresAt,
      pollHash: hash(deviceCode),
      keyHash: desktopTunnelService.hashDeviceKey(deviceKey),
    };
    await cacheManager.set(pendingKey(id), pending, TTL_MS);
    await cacheManager.set(
      pollKey(pending.pollHash),
      { status: "pending", expiresAt } satisfies PollState,
      TTL_MS,
    );
    const approveInArchestra = params.setupCode
      ? await this.linkToSetup(params.setupCode, id)
      : false;
    return {
      id,
      deviceCode,
      userCode: userCode(id),
      verificationPath: `/devices/approve?request=${id}`,
      expiresAt: new Date(expiresAt).toISOString(),
      interval: POLL_INTERVAL_SECONDS,
      approveInArchestra,
    };
  }

  /**
   * The sign-in that the command of this setup code started, for the dialog
   * of the user who got the code; null while there is none, and for a code
   * that is not theirs or expired.
   */
  async pendingForSetupCode(params: { setupCode: string; userId: string }) {
    const setup = await readState<Setup>(setupKey(params.setupCode));
    if (
      !setup ||
      setup.expiresAt <= Date.now() ||
      setup.userId !== params.userId ||
      !setup.requestId
    ) {
      return null;
    }
    const pending = await readState<Pending>(pendingKey(setup.requestId));
    if (!pending || pending.expiresAt <= Date.now()) return null;
    return {
      id: pending.id,
      deviceName: pending.deviceName,
      platform: pending.platform,
      userCode: userCode(pending.id),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /** What the approval page shows about a pending request. */
  async get(id: string) {
    const pending = await readState<Pending>(pendingKey(id));
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new ApiError(410, REQUEST_GONE);
    }
    return {
      deviceName: pending.deviceName,
      platform: pending.platform,
      userCode: userCode(id),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * The user's answer. Approval registers the device for that user, which
   * replaces an earlier device of the same user.
   */
  async decide(params: {
    id: string;
    decision: "approve" | "deny";
    userId: string;
    organizationId: string;
  }) {
    // Taking the request serializes competing answers across backend copies.
    const pending = await takeState<Pending>(pendingKey(params.id));
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new ApiError(410, REQUEST_GONE);
    }
    if (params.decision === "deny") {
      await publishPoll(pending, { status: "denied" });
      return { status: "denied" as const, deviceName: pending.deviceName };
    }
    const device = await DesktopDeviceModel.replaceForUser({
      organizationId: params.organizationId,
      userId: params.userId,
      name: pending.deviceName,
      platform: pending.platform,
      keyHash: pending.keyHash,
    });
    // The device row is durable: if this write fails, the next poll of the
    // tunnel client still finds the approval through the row.
    await publishPoll(pending, {
      status: "approved",
      tunnelId: desktopTunnelService.tunnelIdForDevice(device.id),
    }).catch(() => undefined);
    return { status: "approved" as const, deviceName: pending.deviceName };
  }

  /** The tunnel client's poll for the user's answer. */
  async poll(deviceCode: string): Promise<{
    status: "pending" | "approved" | "denied" | "expired";
    tunnelId?: string;
  }> {
    const state = await readState<PollState>(pollKey(hash(deviceCode)));
    if (!state || state.expiresAt <= Date.now()) return { status: "expired" };
    if (state.status === "approved") {
      return { status: "approved", tunnelId: state.tunnelId };
    }
    if (state.status === "denied") return { status: "denied" };
    const device = await DesktopDeviceModel.findByKeyHash(
      desktopTunnelService.hashDeviceKey(
        `${DESKTOP_DEVICE_KEY_PREFIX}${deviceCode}`,
      ),
    );
    if (!device) return { status: "pending" };
    return {
      status: "approved",
      tunnelId: desktopTunnelService.tunnelIdForDevice(device.id),
    };
  }

  /**
   * Links a new request to the setup code it came with, so the dialog of the
   * code finds it. A later request with the same code takes its place: the
   * user ran the command again. False: no such code, or it expired.
   */
  private async linkToSetup(setupCode: string, id: string): Promise<boolean> {
    const key = setupKey(setupCode);
    const setup = await readState<Setup>(key);
    if (!setup || setup.expiresAt <= Date.now()) return false;
    await cacheManager.set(
      key,
      { ...setup, requestId: id } satisfies Setup,
      Math.max(1, setup.expiresAt - Date.now()),
    );
    return true;
  }
}

export const desktopDeviceSignInService = new DesktopDeviceSignInService();

// === Internal helpers

const TTL_MS = 10 * 60 * 1000;
/** A setup dialog gets a new code when this one has half its time left. */
const SETUP_CODE_TTL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;
const REQUEST_GONE =
  "This sign-in request expired or was already answered. Start the MCP bridge again.";
const CACHE_UNAVAILABLE =
  "Sign-in status is temporarily unavailable. Retry this request. Do not start the MCP bridge again.";

interface Pending {
  id: string;
  deviceName: string;
  platform: ConnectionSetupPlatform;
  expiresAt: number;
  pollHash: string;
  keyHash: string;
}

interface Setup {
  userId: string;
  expiresAt: number;
  /** The last sign-in that came with the code. */
  requestId: string | null;
}

type PollState = { expiresAt: number } & (
  | { status: "pending" | "denied" }
  | { status: "approved"; tunnelId: string }
);

function pendingKey(id: string): AllowedCacheKey {
  return `${CacheKey.DesktopDeviceSignIn}-pending-${id}`;
}

/** By the code's hash: the cache does not keep the code itself. */
function setupKey(setupCode: string): AllowedCacheKey {
  return `${CacheKey.DesktopDeviceSignIn}-setup-${hash(setupCode)}`;
}

function pollKey(pollHash: string): AllowedCacheKey {
  return `${CacheKey.DesktopDeviceSignIn}-poll-${pollHash}`;
}

async function readState<T>(key: AllowedCacheKey): Promise<T | undefined> {
  try {
    return await cacheManager.get<T>(key, { throwOnError: true });
  } catch {
    throw new ApiError(503, CACHE_UNAVAILABLE);
  }
}

async function takeState<T>(key: AllowedCacheKey): Promise<T | undefined> {
  try {
    return await cacheManager.getAndDelete<T>(key, { throwOnError: true });
  } catch {
    throw new ApiError(503, CACHE_UNAVAILABLE);
  }
}

async function publishPoll(
  pending: Pending,
  answer: { status: "denied" } | { status: "approved"; tunnelId: string },
): Promise<void> {
  await cacheManager.set(
    pollKey(pending.pollHash),
    { ...answer, expiresAt: pending.expiresAt } satisfies PollState,
    Math.max(1, pending.expiresAt - Date.now()),
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The short code the user compares between the terminal and the browser. */
function userCode(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();
}
