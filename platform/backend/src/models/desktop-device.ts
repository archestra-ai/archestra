import { and, eq, gte } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ConnectionSetupPlatform, DesktopDevice } from "@/types";

class DesktopDeviceModel {
  /**
   * Registers the device of a user. A user has one device: an earlier one is
   * deleted, which makes its key invalid and drops its waiting MCP messages.
   */
  static async replaceForUser(params: {
    organizationId: string;
    userId: string;
    name: string;
    platform: ConnectionSetupPlatform;
    keyHash: string;
  }): Promise<DesktopDevice> {
    return db.transaction(async (tx) => {
      await tx
        .delete(schema.desktopDevicesTable)
        .where(eq(schema.desktopDevicesTable.userId, params.userId));
      const [device] = await tx
        .insert(schema.desktopDevicesTable)
        .values(params)
        .returning();
      return device;
    });
  }

  static async findById(id: string): Promise<DesktopDevice | null> {
    const [device] = await db
      .select()
      .from(schema.desktopDevicesTable)
      .where(eq(schema.desktopDevicesTable.id, id))
      .limit(1);
    return device ?? null;
  }

  static async findByUserId(userId: string): Promise<DesktopDevice | null> {
    const [device] = await db
      .select()
      .from(schema.desktopDevicesTable)
      .where(eq(schema.desktopDevicesTable.userId, userId))
      .limit(1);
    return device ?? null;
  }

  static async findByKeyHash(keyHash: string): Promise<DesktopDevice | null> {
    const [device] = await db
      .select()
      .from(schema.desktopDevicesTable)
      .where(eq(schema.desktopDevicesTable.keyHash, keyHash))
      .limit(1);
    return device ?? null;
  }

  /** The ids of every device of an organization. */
  /** The devices of an organization that polled since the given time. */
  static async findIdsPolledSince(params: {
    organizationId: string;
    since: Date;
  }): Promise<string[]> {
    const devices = await db
      .select({ id: schema.desktopDevicesTable.id })
      .from(schema.desktopDevicesTable)
      .where(
        and(
          eq(schema.desktopDevicesTable.organizationId, params.organizationId),
          gte(schema.desktopDevicesTable.lastPolledAt, params.since),
        ),
      );
    return devices.map((device) => device.id);
  }

  /**
   * The audit snapshot of a device: what it is and whose, and which of its
   * MCP servers its user stopped. Never its key.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [device] = await db
      .select({
        id: schema.desktopDevicesTable.id,
        name: schema.desktopDevicesTable.name,
        platform: schema.desktopDevicesTable.platform,
        userId: schema.desktopDevicesTable.userId,
      })
      .from(schema.desktopDevicesTable)
      .where(
        and(
          eq(schema.desktopDevicesTable.id, id),
          eq(schema.desktopDevicesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!device) return null;
    const servers = await db
      .select({
        catalogId: schema.desktopDeviceServersTable.catalogId,
        enabled: schema.desktopDeviceServersTable.enabled,
      })
      .from(schema.desktopDeviceServersTable)
      .where(eq(schema.desktopDeviceServersTable.deviceId, id))
      .orderBy(schema.desktopDeviceServersTable.catalogId);
    return { ...device, servers };
  }

  /**
   * Stamps a poll: the device is alive. With the program its tunnel client
   * reported, stores that too; a value it did not report becomes null.
   */
  static async recordPoll(
    id: string,
    program?: Pick<
      DesktopDevice,
      "clientVersion" | "clientTarget" | "clientSha256"
    >,
  ): Promise<void> {
    await db
      .update(schema.desktopDevicesTable)
      .set({ lastPolledAt: new Date(), ...program })
      .where(eq(schema.desktopDevicesTable.id, id));
  }

  /** Deletes a user's own device. Returns the deleted row, or null. */
  static async deleteForUser(params: {
    id: string;
    userId: string;
  }): Promise<DesktopDevice | null> {
    const [device] = await db
      .delete(schema.desktopDevicesTable)
      .where(
        and(
          eq(schema.desktopDevicesTable.id, params.id),
          eq(schema.desktopDevicesTable.userId, params.userId),
        ),
      )
      .returning();
    return device ?? null;
  }
}

export default DesktopDeviceModel;
