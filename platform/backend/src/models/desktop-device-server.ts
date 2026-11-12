import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { DesktopDeviceServer, DesktopMcpServerState } from "@/types";

class DesktopDeviceServerModel {
  static async findByDeviceId(
    deviceId: string,
  ): Promise<DesktopDeviceServer[]> {
    return db
      .select()
      .from(schema.desktopDeviceServersTable)
      .where(eq(schema.desktopDeviceServersTable.deviceId, deviceId));
  }

  /** Stores whether the user started or stopped one MCP server on a device. */
  static async saveEnabled(params: {
    deviceId: string;
    catalogId: string;
    enabled: boolean;
  }): Promise<DesktopDeviceServer> {
    const [row] = await db
      .insert(schema.desktopDeviceServersTable)
      .values({
        deviceId: params.deviceId,
        catalogId: params.catalogId,
        enabled: params.enabled,
      })
      .onConflictDoUpdate({
        target: [
          schema.desktopDeviceServersTable.deviceId,
          schema.desktopDeviceServersTable.catalogId,
        ],
        set: { enabled: params.enabled, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /**
   * Stores the states the tunnel client reported. A state for a catalog item
   * that does not exist any more is dropped.
   */
  static async recordStates(params: {
    deviceId: string;
    states: Array<{
      catalogId: string;
      state: DesktopMcpServerState;
      lastError: string | null;
    }>;
  }): Promise<void> {
    if (params.states.length === 0) return;
    const existing = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        inArray(
          schema.internalMcpCatalogTable.id,
          params.states.map((state) => state.catalogId),
        ),
      );
    const existingIds = new Set(existing.map((item) => item.id));
    const rows = params.states
      .filter((state) => existingIds.has(state.catalogId))
      .map((state) => ({ deviceId: params.deviceId, ...state }));
    if (rows.length === 0) return;
    await db
      .insert(schema.desktopDeviceServersTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          schema.desktopDeviceServersTable.deviceId,
          schema.desktopDeviceServersTable.catalogId,
        ],
        set: {
          state: sql`excluded.state`,
          lastError: sql`excluded.last_error`,
        },
      });
  }
}

export default DesktopDeviceServerModel;
