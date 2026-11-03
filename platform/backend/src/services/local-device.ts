import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import AuditLogModel from "@/models/audit-log";
import LocalDeviceModel from "@/models/local-device";
import { ApiError } from "@/types";
import type { LocalDevice } from "@/types/local-device";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
class LocalDeviceService {
  async human(organizationId: string, userId: string) {
    if (isServiceAccountUserId(userId) || userId === "system")
      throw new ApiError(
        403,
        "Local devices require an authenticated person. Service accounts are not supported.",
      );
    return LocalDeviceModel.assertOwner(organizationId, userId);
  }
  async list(organizationId: string, userId: string) {
    await this.human(organizationId, userId);
    return (await LocalDeviceModel.list(organizationId, userId)).map(status);
  }
  async enroll(organizationId: string, userId: string, name: string) {
    await this.human(organizationId, userId);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const row = await LocalDeviceModel.create({
      organizationId,
      userId,
      name,
      pairingHash: hash(code),
      pairingExpiresAt: expiresAt,
    });
    return { id: row.id, code, expiresAt: expiresAt.toISOString() };
  }
  async rename(
    organizationId: string,
    userId: string,
    id: string,
    name: string,
  ) {
    await this.human(organizationId, userId);
    return status(
      await LocalDeviceModel.rename(id, organizationId, userId, name),
    );
  }
  async revoke(organizationId: string, userId: string, id: string) {
    await this.human(organizationId, userId);
    await LocalDeviceModel.revoke(id, organizationId, userId);
    return { success: true as const };
  }
  async inspect(code: string) {
    const row = await this.pairing(code);
    const owner = await this.proofOwner(row);
    return {
      deviceId: row.id,
      name: row.name,
      organizationName: owner.organizationName,
      ownerName: owner.ownerName,
      capabilities: ["local_mcp" as const],
    };
  }
  async redeem(body: {
    code: string;
    platform: "darwin" | "win32" | "linux";
    arch: "arm64" | "x64";
    appVersion: string;
  }) {
    const row = await this.pairing(body.code);
    const token = randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const device = await this.asProof(() =>
      LocalDeviceModel.redeem(row, hash(body.code), {
        platform: body.platform,
        arch: body.arch,
        appVersion: body.appVersion,
        tokenHash: hash(token),
        tokenExpiresAt: expiresAt,
      }),
    );
    return {
      deviceId: device.id,
      name: device.name,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }
  async revokeCredential(authorization: string | undefined) {
    const { device } = await this.authenticate(authorization);
    await LocalDeviceModel.revoke(
      device.id,
      device.organizationId,
      device.userId,
    );
    return { success: true as const };
  }
  async session(authorization: string | undefined) {
    const { device, tokenHash } = await this.authenticate(authorization);
    const sessionId = randomUUID();
    await this.asProof(() =>
      LocalDeviceModel.session(device, tokenHash, sessionId),
    );
    return { sessionId };
  }
  async heartbeat(authorization: string | undefined, sessionId: string) {
    const { device, tokenHash } = await this.authenticate(authorization);
    const row = await this.asProof(() =>
      LocalDeviceModel.heartbeat(device, tokenHash, sessionId),
    );
    return { success: true as const, name: row.name };
  }
  async disconnect(authorization: string | undefined, sessionId: string) {
    const { device, tokenHash } = await this.authenticate(authorization);
    await this.asProof(() =>
      LocalDeviceModel.disconnect(device, tokenHash, sessionId),
    );
    return { success: true as const };
  }
  async audit(
    device: Pick<LocalDevice, "id" | "organizationId" | "userId" | "name">,
    action: "localDevice.created" | "localDevice.revoked",
  ) {
    await AuditLogModel.create({
      organizationId: device.organizationId,
      actorId: device.userId,
      actorType: "user",
      action,
      outcome: "success",
      occurredAt: new Date(),
      resourceType: "localDevice",
      resourceId: device.id,
      resourceName: device.name,
      httpMethod: "POST",
      httpPath:
        action === "localDevice.created"
          ? "/api/local-devices/install"
          : "/api/local-devices/remove-agent",
      after: { id: device.id, name: device.name },
    });
  }
  private async pairing(code: string) {
    const row = await LocalDeviceModel.pairing(hash(code));
    if (!row)
      throw new ApiError(
        401,
        "This setup expired or was already used. Add the computer again in Local devices.",
      );
    await this.proofOwner(row);
    return row;
  }
  async authenticate(authorization: string | undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(authorization ?? "");
    if (!match) throw new ApiError(401, "A device credential is required");
    const tokenHash = hash(match[1]);
    const device = await LocalDeviceModel.token(tokenHash);
    if (!device)
      throw new ApiError(
        401,
        "Device access was revoked or expired. Connect again in Local devices.",
      );
    await this.proofOwner(device);
    return { device, tokenHash };
  }
  private proofOwner(device: LocalDevice) {
    return this.asProof(() => this.human(device.organizationId, device.userId));
  }
  private async asProof<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403)
        throw new ApiError(
          401,
          "Device access is unavailable. Connect again in Local devices.",
        );
      throw error;
    }
  }
}
function status(device: LocalDevice) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    arch: device.arch,
    appVersion: device.appVersion,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    status: device.revokedAt
      ? ("revoked" as const)
      : !device.tokenExpiresAt
        ? ("pending" as const)
        : device.tokenExpiresAt <= new Date() ||
            !device.sessionId ||
            !device.lastSeenAt ||
            Date.now() - device.lastSeenAt.getTime() > 45_000
          ? ("offline" as const)
          : ("online" as const),
  };
}
export const localDeviceService = new LocalDeviceService();
