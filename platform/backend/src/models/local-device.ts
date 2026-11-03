import { and, count, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { ApiError } from "@/types";
import type { LocalDevice } from "@/types/local-device";

const devices = schema.localDevicesTable;
/** Presence credentials are intentionally separate from MCP installation credentials. */
export default class LocalDeviceModel {
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: devices.id,
        organizationId: devices.organizationId,
        userId: devices.userId,
        name: devices.name,
        platform: devices.platform,
        arch: devices.arch,
        appVersion: devices.appVersion,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(
        and(eq(devices.id, id), eq(devices.organizationId, organizationId)),
      );
    return row ?? null;
  }
  static async assertOwner(
    organizationId: string,
    userId: string,
    tx: Transaction | typeof db = db,
  ) {
    const [row] = await tx
      .select({
        organizationName: schema.organizationsTable.name,
        ownerName: schema.usersTable.name,
        banned: schema.usersTable.banned,
        enabled: schema.organizationsTable.deviceMcpEnabled,
      })
      .from(schema.membersTable)
      .innerJoin(
        schema.organizationsTable,
        eq(schema.membersTable.organizationId, schema.organizationsTable.id),
      )
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          eq(schema.membersTable.userId, userId),
        ),
      );
    if (!row || row.banned)
      throw new ApiError(
        403,
        "A current human organization member is required for local devices",
      );
    if (!row.enabled)
      throw new ApiError(
        403,
        "Local devices are disabled. An administrator can enable them in MCP settings.",
      );
    return row;
  }
  static async owned(id: string, organizationId: string, userId: string) {
    const [row] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.id, id),
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
          isNull(devices.revokedAt),
          gt(devices.tokenExpiresAt, new Date()),
        ),
      );
    if (!row)
      throw new ApiError(
        409,
        "This computer is not connected to your account. Run Connect on it first.",
      );
    return row;
  }
  static async list(organizationId: string, userId: string) {
    return db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
          isNull(devices.revokedAt),
          or(
            isNotNull(devices.tokenHash),
            gt(devices.pairingExpiresAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(devices.createdAt))
      .limit(100);
  }
  static async create(values: typeof devices.$inferInsert) {
    return db.transaction(async (tx) => {
      await LocalDeviceModel.lockOrganization(tx, values.organizationId);
      await LocalDeviceModel.assertOwner(
        values.organizationId,
        values.userId,
        tx,
      );
      const [total] = await tx
        .select({ count: count() })
        .from(devices)
        .where(
          and(
            eq(devices.organizationId, values.organizationId),
            eq(devices.userId, values.userId),
            isNull(devices.revokedAt),
            or(
              isNotNull(devices.tokenHash),
              gt(devices.pairingExpiresAt, new Date()),
            ),
          ),
        );
      if (total.count >= 50)
        throw new ApiError(
          409,
          "You can connect up to 50 local devices. Revoke an unused device before adding another.",
        );
      const [row] = await tx.insert(devices).values(values).returning();
      return row;
    });
  }
  static async rename(
    id: string,
    organizationId: string,
    userId: string,
    name: string,
  ) {
    const [row] = await db
      .update(devices)
      .set({ name })
      .where(
        and(
          eq(devices.id, id),
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
          isNull(devices.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new ApiError(404, "Local device not found");
    return row;
  }
  static async revoke(id: string, organizationId: string, userId: string) {
    const [row] = await db
      .update(devices)
      .set({
        revokedAt: new Date(),
        pairingHash: null,
        tokenHash: null,
        tokenExpiresAt: null,
        sessionId: null,
        lastSeenAt: null,
      })
      .where(
        and(
          eq(devices.id, id),
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
        ),
      )
      .returning({ id: devices.id });
    if (!row) throw new ApiError(404, "Local device not found");
  }
  static async pairing(hash: string) {
    const [row] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.pairingHash, hash),
          gt(devices.pairingExpiresAt, new Date()),
          isNull(devices.revokedAt),
        ),
      );
    return row ?? null;
  }
  static async token(hash: string) {
    const [row] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.tokenHash, hash),
          gt(devices.tokenExpiresAt, new Date()),
          isNull(devices.revokedAt),
        ),
      );
    return row ?? null;
  }
  static async redeem(
    device: LocalDevice,
    hash: string,
    values: Pick<
      typeof devices.$inferInsert,
      "platform" | "arch" | "appVersion" | "tokenHash" | "tokenExpiresAt"
    >,
  ) {
    return db.transaction(async (tx) => {
      await LocalDeviceModel.lockOrganization(tx, device.organizationId);
      await LocalDeviceModel.assertOwner(
        device.organizationId,
        device.userId,
        tx,
      );
      const [row] = await tx
        .update(devices)
        .set({ ...values, pairingHash: null })
        .where(
          and(
            eq(devices.id, device.id),
            eq(devices.pairingHash, hash),
            gt(devices.pairingExpiresAt, new Date()),
            isNull(devices.revokedAt),
          ),
        )
        .returning();
      if (!row)
        throw new ApiError(
          401,
          "This setup expired or was already used. Add the computer again in Local devices.",
        );
      return row;
    });
  }
  static async session(
    device: LocalDevice,
    tokenHash: string,
    sessionId: string,
  ) {
    return LocalDeviceModel.updatePresence(device, tokenHash, {
      sessionId,
      lastSeenAt: new Date(),
    });
  }
  static async heartbeat(
    device: LocalDevice,
    tokenHash: string,
    sessionId: string,
  ) {
    return LocalDeviceModel.updatePresence(
      device,
      tokenHash,
      { lastSeenAt: new Date() },
      sessionId,
    );
  }
  static async disconnect(
    device: LocalDevice,
    tokenHash: string,
    sessionId: string,
  ) {
    return LocalDeviceModel.updatePresence(
      device,
      tokenHash,
      { sessionId: null, lastSeenAt: null },
      sessionId,
    );
  }
  private static async updatePresence(
    device: LocalDevice,
    tokenHash: string,
    values: Partial<Pick<LocalDevice, "sessionId" | "lastSeenAt">>,
    expectedSession?: string,
  ) {
    return db.transaction(async (tx) => {
      await LocalDeviceModel.lockOrganization(tx, device.organizationId);
      await LocalDeviceModel.assertOwner(
        device.organizationId,
        device.userId,
        tx,
      );
      const [row] = await tx
        .update(devices)
        .set(values)
        .where(
          and(
            eq(devices.id, device.id),
            eq(devices.tokenHash, tokenHash),
            gt(devices.tokenExpiresAt, new Date()),
            isNull(devices.revokedAt),
            expectedSession
              ? eq(devices.sessionId, expectedSession)
              : undefined,
          ),
        )
        .returning();
      if (!row) {
        const [live] = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.id, device.id),
              eq(devices.tokenHash, tokenHash),
              gt(devices.tokenExpiresAt, new Date()),
              isNull(devices.revokedAt),
            ),
          );
        if (live && expectedSession)
          throw new ApiError(
            409,
            "This connection was replaced by a newer session. Reconnect this computer to continue.",
          );
        throw new ApiError(
          401,
          "This device session is no longer valid. Reconnect in Local devices.",
        );
      }
      return row;
    });
  }
  private static async lockOrganization(
    tx: Transaction,
    organizationId: string,
  ) {
    await tx
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organizationId))
      .for("update");
  }
}
