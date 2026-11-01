import { createHash } from "node:crypto";
import { DeviceMcpConfigSchema } from "@archestra/shared/device-mcp";
import { and, asc, desc, eq, gt, isNull, lt, ne } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { ApiError } from "@/types";
import type { DeviceMcpConnection } from "@/types/device-mcp";

const devices = schema.deviceMcpConnectionsTable;
const commands = schema.deviceMcpCommandsTable;

/** Durable relay queue: delivery can land on a different API replica. */
export default class DeviceMcpModel {
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: devices.id,
        organizationId: devices.organizationId,
        userId: devices.userId,
        catalogId: devices.catalogId,
        name: devices.name,
        configVersion: devices.configVersion,
        configDigest: devices.configDigest,
        revokedAt: devices.revokedAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(
        and(eq(devices.id, id), eq(devices.organizationId, organizationId)),
      );
    return row ?? null;
  }

  static async enabled(organizationId: string) {
    const [org] = await db
      .select({ enabled: schema.organizationsTable.deviceMcpEnabled })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organizationId));
    return org?.enabled === true;
  }

  static async list(organizationId: string, userId: string, catalogId: string) {
    return db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
          eq(devices.catalogId, catalogId),
        ),
      )
      .orderBy(desc(devices.createdAt))
      .limit(20);
  }

  static async createPairing(
    values: typeof devices.$inferInsert,
    replaceExisting: boolean,
  ) {
    return db.transaction(async (tx) => {
      const [org] = await tx
        .select({ enabled: schema.organizationsTable.deviceMcpEnabled })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, values.organizationId))
        .for("update");
      if (!org?.enabled)
        throw new ApiError(403, "Device MCP servers are disabled");
      // Serialize replacement, including the first pairing where no device row exists.
      await tx
        .select({ id: schema.internalMcpCatalogTable.id })
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, values.catalogId))
        .for("update");
      const [existing] = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.organizationId, values.organizationId),
            eq(devices.userId, values.userId),
            eq(devices.catalogId, values.catalogId),
            isNull(devices.revokedAt),
          ),
        );
      if (existing && !replaceExisting)
        throw new ApiError(
          409,
          "A device is already paired. Confirm replacement to revoke it and pair another device.",
        );
      await tx
        .update(devices)
        .set({
          revokedAt: new Date(),
          tokenHash: null,
          pairingHash: null,
          sessionId: null,
        })
        .where(
          and(
            eq(devices.organizationId, values.organizationId),
            eq(devices.userId, values.userId),
            eq(devices.catalogId, values.catalogId),
            isNull(devices.revokedAt),
          ),
        );
      const [row] = await tx.insert(devices).values(values).returning();
      return row;
    });
  }

  static async findPairing(hash: string) {
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

  static async redeem(id: string, hash: string, tokenHash: string) {
    const [row] = await db
      .update(devices)
      .set({
        pairingHash: null,
        tokenHash,
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .where(
        and(
          eq(devices.id, id),
          eq(devices.pairingHash, hash),
          gt(devices.pairingExpiresAt, new Date()),
          isNull(devices.revokedAt),
        ),
      )
      .returning();
    if (!row)
      throw new ApiError(
        401,
        "Pairing code expired or was already used. Create a new code in the registry.",
      );
    return row;
  }

  static async findToken(hash: string) {
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

  static async revoke(id: string, organizationId: string, userId: string) {
    const [row] = await db
      .update(devices)
      .set({
        revokedAt: new Date(),
        tokenHash: null,
        pairingHash: null,
        sessionId: null,
      })
      .where(
        and(
          eq(devices.id, id),
          eq(devices.organizationId, organizationId),
          eq(devices.userId, userId),
        ),
      )
      .returning();
    if (!row) throw new ApiError(404, "Device connection not found");
    await db
      .update(commands)
      .set({ status: "unknown", arguments: {} })
      .where(and(eq(commands.deviceId, id), ne(commands.status, "completed")));
  }

  static async session(device: DeviceMcpConnection, sessionId: string) {
    return db.transaction(async (tx) => {
      await DeviceMcpModel.lockLive(tx, device);
      await tx
        .update(commands)
        .set({ status: "unknown", arguments: {} })
        .where(
          and(
            eq(commands.deviceId, device.id),
            ne(commands.status, "completed"),
          ),
        );
      await tx
        .update(devices)
        .set({ sessionId, lastSeenAt: new Date() })
        .where(eq(devices.id, device.id));
    });
  }

  static async poll(
    device: DeviceMcpConnection,
    sessionId: string,
    ready: boolean,
  ) {
    return db.transaction(async (tx) => {
      const live = await DeviceMcpModel.lockLive(tx, device, sessionId);
      await tx
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(eq(devices.id, live.id));
      await tx
        .delete(commands)
        .where(lt(commands.expiresAt, new Date(Date.now() - 5 * 60 * 1000)));
      if (!ready) return null;
      const [command] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.deviceId, live.id),
            eq(commands.sessionId, sessionId),
            eq(commands.status, "queued"),
            gt(commands.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(commands.createdAt))
        .limit(1)
        .for("update");
      if (!command) return null;
      await tx
        .update(commands)
        .set({ status: "delivered" })
        .where(eq(commands.id, command.id));
      return command;
    });
  }

  static async enqueue(
    device: DeviceMcpConnection,
    toolName: string,
    args: Record<string, unknown>,
  ) {
    return db.transaction(async (tx) => {
      const live = await DeviceMcpModel.lockLive(
        tx,
        device,
        device.sessionId ?? undefined,
      );
      if (
        !live.sessionId ||
        !live.lastSeenAt ||
        live.lastSeenAt.getTime() < Date.now() - 15_000
      )
        throw new ApiError(
          409,
          "Your device is offline. Start the device companion and reconnect from the registry.",
        );
      const outstanding = await tx
        .select({ id: commands.id })
        .from(commands)
        .where(
          and(
            eq(commands.deviceId, live.id),
            gt(commands.expiresAt, new Date()),
            ne(commands.status, "completed"),
            ne(commands.status, "unknown"),
          ),
        )
        .limit(8);
      if (outstanding.length >= 8)
        throw new ApiError(
          429,
          "Your device is busy. Wait for pending calls to finish.",
        );
      const [row] = await tx
        .insert(commands)
        .values({
          deviceId: live.id,
          sessionId: live.sessionId,
          toolName,
          arguments: args,
          expiresAt: new Date(Date.now() + 30_000),
        })
        .returning();
      return row;
    });
  }

  static async result(
    device: DeviceMcpConnection,
    sessionId: string,
    commandId: string,
    result: Record<string, unknown>,
    resultDigest: string,
  ) {
    await db.transaction(async (tx) => {
      await DeviceMcpModel.lockLive(tx, device, sessionId);
      const [command] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.id, commandId),
            eq(commands.deviceId, device.id),
            eq(commands.sessionId, sessionId),
          ),
        )
        .for("update");
      if (!command) throw new ApiError(404, "Command not found");
      if (command.status === "completed") {
        if (command.resultDigest !== resultDigest)
          throw new ApiError(409, "Command already has a different result");
        return;
      }
      if (
        command.status !== "delivered" ||
        command.expiresAt.getTime() < Date.now()
      )
        throw new ApiError(
          409,
          "Command outcome is unknown. The call will not be replayed.",
        );
      await tx
        .update(commands)
        .set({ status: "completed", result, resultDigest, arguments: {} })
        .where(eq(commands.id, commandId));
    });
  }

  static async readCommand(id: string, deviceId: string) {
    const [row] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.id, id), eq(commands.deviceId, deviceId)));
    return row ?? null;
  }

  static async expireCommand(id: string) {
    await db
      .update(commands)
      .set({ status: "unknown", arguments: {} })
      .where(and(eq(commands.id, id), ne(commands.status, "completed")));
    await db
      .update(commands)
      .set({ arguments: {}, result: null })
      .where(eq(commands.id, id));
  }

  static async cleanupExpired() {
    // Retain only the digest briefly for idempotent response delivery. Payloads
    // are removed even when the waiting API replica or companion has stopped.
    await db
      .update(commands)
      .set({ arguments: {}, result: null })
      .where(lt(commands.expiresAt, new Date()));
    await db
      .delete(commands)
      .where(lt(commands.expiresAt, new Date(Date.now() - 5 * 60 * 1000)));
  }

  private static async lockLive(
    tx: Transaction,
    device: DeviceMcpConnection,
    sessionId?: string,
  ) {
    // Consistent org → catalog → device lock order fences setting changes,
    // reviewed launch updates and token revocation against command delivery.
    const [org] = await tx
      .select({ enabled: schema.organizationsTable.deviceMcpEnabled })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, device.organizationId))
      .for("update");
    const [catalog] = await tx
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, device.catalogId))
      .for("update");
    const parsed = DeviceMcpConfigSchema.safeParse(catalog?.deviceConfig);
    if (
      !catalog ||
      catalog.deletedAt ||
      catalog.organizationId !== device.organizationId ||
      catalog.serverType !== "device" ||
      !parsed.success ||
      createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex") !==
        device.configDigest
    )
      throw new ApiError(
        409,
        "Device configuration changed. Review and pair again.",
      );
    const [member] = await tx
      .select({ id: schema.membersTable.id })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, device.userId),
          eq(schema.membersTable.organizationId, device.organizationId),
        ),
      );
    if (!member)
      throw new ApiError(
        403,
        "Device owner is no longer an organization member",
      );
    const [live] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, device.id))
      .for("update");
    if (
      !org?.enabled ||
      !live ||
      live.revokedAt ||
      live.tokenHash !== device.tokenHash ||
      !live.tokenExpiresAt ||
      live.tokenExpiresAt.getTime() <= Date.now()
    )
      throw new ApiError(
        401,
        "Device access was disabled, revoked or expired. Pair again from the registry.",
      );
    if (sessionId && live.sessionId !== sessionId)
      throw new ApiError(
        409,
        "Device session was replaced. Stop this companion before reconnecting.",
      );
    return live;
  }
}
