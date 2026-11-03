import { createHash, randomBytes } from "node:crypto";
import { CacheKey, cacheManager } from "@/cache-manager";
import { localDeviceService } from "@/services/local-device";
import { ApiError } from "@/types";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Grant = {
  organizationId: string;
  userId: string;
  name: string;
  expiresAt: number;
  platform: "darwin" | "win32" | "linux";
};
const ttl = 10 * 60 * 1000;
const approvalKey = (tokenHash: string) =>
  `${CacheKey.ClientConnection}-device-approval-${tokenHash}` as const;
const installKey = (code: string) =>
  `${CacheKey.ClientConnection}-device-install-${hash(code)}` as const;

/** One-time browser approval scoped to its owner and the specific setup ticket. */
export const localDeviceInstallService = {
  async approve(tokenHash: string, grant: Grant) {
    await localDeviceService.human(grant.organizationId, grant.userId);
    await cacheManager.set(
      approvalKey(tokenHash),
      grant,
      Math.max(1, grant.expiresAt - Date.now()),
    );
  },
  async discard(tokenHash: string) {
    await cacheManager.delete(approvalKey(tokenHash), { throwOnError: true });
  },
  async claim(rawToken: string, organizationId: string, userId: string) {
    const grant = await cacheManager.getAndDelete<Grant>(
      approvalKey(hash(rawToken)),
      { throwOnError: true },
    );
    if (!grant) return null;
    if (
      grant.organizationId !== organizationId ||
      grant.userId !== userId ||
      grant.expiresAt <= Date.now()
    )
      throw new ApiError(
        410,
        "Background agent approval expired. Run Connect again.",
      );
    await localDeviceService.human(organizationId, userId);
    const code = randomBytes(32).toString("base64url");
    await cacheManager.set(
      installKey(code),
      { ...grant, expiresAt: Date.now() + ttl },
      ttl,
    );
    return { code, userId, name: grant.name };
  },
  async install(
    body: {
      code: string;
      platform: "darwin" | "win32" | "linux";
      arch: "arm64" | "x64";
      appVersion: string;
    },
    authorization?: string,
  ) {
    const grant = await cacheManager.getAndDelete<Grant>(
      installKey(body.code),
      { throwOnError: true },
    );
    if (!grant || grant.expiresAt <= Date.now())
      throw new ApiError(
        410,
        "Background agent approval expired or was already used. Run Connect again.",
      );
    if (body.platform !== grant.platform)
      throw new ApiError(400, "This approval is for another operating system.");
    await localDeviceService.human(grant.organizationId, grant.userId);
    // A repeat Connect from another client reuses the same machine credential.
    // An ID or hostname alone never proves possession of that credential.
    if (authorization) {
      try {
        const { device } = await localDeviceService.authenticate(authorization);
        if (
          device.userId !== grant.userId ||
          device.organizationId !== grant.organizationId
        )
          throw new ApiError(
            403,
            "The saved device belongs to another account.",
          );
        if (!device.tokenExpiresAt)
          throw new ApiError(401, "Device credential expired.");
        return {
          deviceId: device.id,
          name: device.name,
          expiresAt: device.tokenExpiresAt.toISOString(),
          token: authorization.slice(7),
          created: false,
        };
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 401)
          throw error;
      }
    }
    const pending = await localDeviceService.enroll(
      grant.organizationId,
      grant.userId,
      grant.name,
    );
    const credential = await localDeviceService.redeem({
      ...body,
      code: pending.code,
    });
    try {
      await localDeviceService.audit(
        {
          id: credential.deviceId,
          name: credential.name,
          organizationId: grant.organizationId,
          userId: grant.userId,
        },
        "localDevice.created",
      );
    } catch (error) {
      await localDeviceService.revoke(
        grant.organizationId,
        grant.userId,
        credential.deviceId,
      );
      throw error;
    }
    return { ...credential, created: true };
  },
};
